import fs from 'node:fs/promises';
import path from 'node:path';

export function resolveEvidenceRoot(root) {
  return path.resolve(root || 'artifacts');
}

function validateId(id) {
  const value = String(id || '');
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('Invalid evidence id');
  return value;
}

function runDir(root, id) {
  return path.join(resolveEvidenceRoot(root), validateId(id));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
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

export async function listEvidence({ root } = {}) {
  const base = resolveEvidenceRoot(root);
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    let summary;
    try { summary = await readJson(path.join(dir, 'agent-summary.json')); }
    catch { continue; }
    results.push({ ...summary, id: entry.name });
  }
  return results.sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')));
}

export async function readEvidence(id, { root } = {}) {
  const dir = runDir(root, id);
  const result = await readJson(path.join(dir, 'result.json'));
  const files = await walkFiles(dir);
  return { id: validateId(id), dir, result, files };
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
