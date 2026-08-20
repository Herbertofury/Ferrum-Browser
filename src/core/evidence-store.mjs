import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_NAME = 'evidence-manifest.json';
const LIST_EVIDENCE_CONCURRENCY = 32;
const EVIDENCE_DESCRIPTOR_CONCURRENCY = 32;

export function resolveEvidenceRoot(root) {
  return path.resolve(root || 'artifacts');
}

function validateId(id) {
  const value = String(id || '');
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('Invalid evidence id');
  return value;
}

function runDir(root, id) {
  return path.join(resolveEvidenceRoot(root), validateId(id));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function mediaTypeFor(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  if (ext === '.json' || ext === '.har') return 'application/json';
  if (ext === '.jsonl' || ext === '.ndjson') return 'application/x-ndjson';
  if (ext === '.txt' || ext === '.log') return 'text/plain';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.gz') return 'application/gzip';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function fileDescriptor(base, file) {
  const stat = await fs.stat(file);
  const relativePath = path.relative(base, file).replaceAll('\\', '/');
  return {
    path: relativePath,
    bytes: stat.size,
    digest: await sha256File(file),
    mediaType: mediaTypeFor(relativePath)
  };
}

async function walkFiles(base, dir = base, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(base, file, out);
    else if (entry.isFile()) {
      const stat = await fs.stat(file);
      out.push({ path: path.relative(base, file).replaceAll('\\', '/'), bytes: stat.size });
    }
  }
  return out;
}

async function collectDescriptorFiles(base, dir = base, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectDescriptorFiles(base, file, out);
    else if (entry.isFile()) {
      const relativePath = path.relative(base, file).replaceAll('\\', '/');
      if (relativePath !== MANIFEST_NAME) out.push(file);
    }
  }
  return out;
}

async function walkDescriptors(base) {
  const files = await collectDescriptorFiles(base);
  const descriptors = new Array(files.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;
      descriptors[index] = await fileDescriptor(base, files[index]);
    }
  };

  const workerCount = Math.min(EVIDENCE_DESCRIPTOR_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return descriptors;
}

async function readManifest(dir) {
  try { return await readJson(path.join(dir, MANIFEST_NAME)); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function writeEvidenceManifest(dir) {
  const base = path.resolve(dir);
  const files = await walkDescriptors(base);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files
  };
  await fs.writeFile(path.join(base, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

export async function listEvidence({ root } = {}) {
  const base = resolveEvidenceRoot(root);
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }

  const directories = entries.filter(entry => entry.isDirectory());
  const results = new Array(directories.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= directories.length) return;
      const entry = directories[index];
      const dir = path.join(base, entry.name);
      try {
        const summary = await readJson(path.join(dir, 'agent-summary.json'));
        results[index] = { ...summary, id: entry.name };
      } catch {}
    }
  };

  const workerCount = Math.min(LIST_EVIDENCE_CONCURRENCY, directories.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results
    .filter(Boolean)
    .sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')));
}

export async function readEvidence(id, { root } = {}) {
  const dir = runDir(root, id);
  const result = await readJson(path.join(dir, 'result.json'));
  const manifest = await readManifest(dir);
  if (!manifest) {
    const files = await walkFiles(dir);
    return { id: validateId(id), dir, result, files, manifest: null, manifestDescriptor: null };
  }
  const manifestDescriptor = await fileDescriptor(dir, path.join(dir, MANIFEST_NAME));
  return {
    id: validateId(id),
    dir,
    result,
    files: [...manifest.files, manifestDescriptor],
    manifest,
    manifestDescriptor
  };
}

export async function verifyEvidence(id, { root } = {}) {
  const dir = runDir(root, id);
  const manifest = await readManifest(dir);
  if (!manifest) {
    return {
      id: validateId(id),
      dir,
      status: 'unverifiable',
      manifestPresent: false,
      issues: [{ kind: 'manifest-missing', path: MANIFEST_NAME }]
    };
  }

  const expected = new Map((manifest.files || []).map(file => [file.path, file]));
  const actualFiles = await walkDescriptors(dir);
  const actual = new Map(actualFiles.map(file => [file.path, file]));
  const issues = [];

  for (const [filePath, descriptor] of expected) {
    const found = actual.get(filePath);
    if (!found) {
      issues.push({ kind: 'missing', path: filePath });
      continue;
    }
    if (found.bytes !== descriptor.bytes) {
      issues.push({ kind: 'size-mismatch', path: filePath, expected: descriptor.bytes, actual: found.bytes });
    }
    if (found.digest !== descriptor.digest) {
      issues.push({ kind: 'digest-mismatch', path: filePath, expected: descriptor.digest, actual: found.digest });
    }
  }
  for (const filePath of actual.keys()) {
    if (!expected.has(filePath)) issues.push({ kind: 'unexpected', path: filePath });
  }

  const manifestDescriptor = await fileDescriptor(dir, path.join(dir, MANIFEST_NAME));
  return {
    id: validateId(id),
    dir,
    status: issues.length ? 'failed' : 'passed',
    manifestPresent: true,
    manifestDescriptor,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    checkedFiles: actualFiles.length,
    issues
  };
}

export function evidenceFilePath(id, relativePath, { root } = {}) {
  const dir = runDir(root, id);
  const rel = String(relativePath || '').replaceAll('\\', '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('Invalid evidence file path');
  const target = path.resolve(dir, rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Evidence file path escapes run directory');
  return target;
}

export async function readEvidenceText(id, relativePath, { root, maxBytes = 1024 * 1024 } = {}) {
  const target = evidenceFilePath(id, relativePath, { root });
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Evidence path is not a file');
  if (stat.size > maxBytes) throw new Error(`Evidence text file exceeds ${maxBytes} bytes`);
  return await fs.readFile(target, 'utf8');
}
