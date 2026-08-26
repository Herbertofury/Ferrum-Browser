import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CONCURRENCY = 32;
const SINGLE_PASS_MIN_FILES = 32;
const SAMPLES = 20;

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

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function hashFileWithBytes(file) {
  const hash = crypto.createHash('sha256');
  let stream;
  await new Promise((resolve, reject) => {
    stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { bytes: stream.bytesRead, digest: `sha256:${hash.digest('hex')}` };
}

async function baselineDescriptor(base, file) {
  const stat = await fs.stat(file);
  const relativePath = path.relative(base, file).replaceAll('\\', '/');
  return {
    path: relativePath,
    bytes: stat.size,
    digest: await hashFile(file),
    mediaType: mediaTypeFor(relativePath)
  };
}

async function singlePassDescriptor(base, file) {
  const relativePath = path.relative(base, file).replaceAll('\\', '/');
  const { bytes, digest } = await hashFileWithBytes(file);
  return { path: relativePath, bytes, digest, mediaType: mediaTypeFor(relativePath) };
}

async function mapDescriptors(base, files, mode) {
  const descriptors = new Array(files.length);
  let cursor = 0;
  const descriptor = mode === 'single-pass' && files.length >= SINGLE_PASS_MIN_FILES
    ? singlePassDescriptor
    : baselineDescriptor;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;
      descriptors[index] = await descriptor(base, files[index]);
    }
  };
  const workers = Math.min(CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  descriptors.sort((a, b) => a.path.localeCompare(b.path));
  return descriptors;
}

function percentileLinear(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarize(samples) {
  return {
    medianMs: percentileLinear(samples, 0.5),
    p95Ms: percentileLinear(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples
  };
}

function improvement(before, after) {
  return before === 0 ? 0 : ((before - after) / before) * 100;
}

async function writeFixture(root, fileCount, bytesPerFile) {
  const files = [];
  const seed = Buffer.alloc(bytesPerFile, 0x61);
  for (let index = 0; index < fileCount; index += 1) {
    const shard = path.join(root, String(index % 19).padStart(2, '0'));
    await fs.mkdir(shard, { recursive: true });
    const ext = index % 7 === 0 ? '.json' : index % 5 === 0 ? '.log' : '.txt';
    const file = path.join(shard, `${String(index).padStart(5, '0')}${ext}`);
    const payload = Buffer.from(seed);
    payload.writeUInt32LE(index, 0);
    await fs.writeFile(file, payload);
    files.push(file);
  }
  return files;
}

async function measureScenario({ name, fileCount, bytesPerFile, requireMaterial }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-bench-'));
  try {
    const files = await writeFixture(root, fileCount, bytesPerFile);
    const baseline = await mapDescriptors(root, files, 'baseline');
    const candidate = await mapDescriptors(root, files, 'single-pass');
    if (JSON.stringify(candidate) !== JSON.stringify(baseline)) {
      throw new Error(`${name}: descriptor equivalence failed`);
    }

    await mapDescriptors(root, files, 'baseline');
    await mapDescriptors(root, files, 'single-pass');
    const samples = { baseline: [], candidate: [] };
    for (let index = 0; index < SAMPLES; index += 1) {
      const order = index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const variant of order) {
        const started = performance.now();
        await mapDescriptors(root, files, variant === 'candidate' ? 'single-pass' : 'baseline');
        samples[variant].push(performance.now() - started);
      }
    }

    const baselineStats = summarize(samples.baseline);
    const candidateStats = summarize(samples.candidate);
    const medianGain = improvement(baselineStats.medianMs, candidateStats.medianMs);
    const p95Gain = improvement(baselineStats.p95Ms, candidateStats.p95Ms);
    if (requireMaterial && (medianGain < 10 || p95Gain < 10)) {
      throw new Error(`${name}: material-gain gate failed (${medianGain.toFixed(2)}% median / ${p95Gain.toFixed(2)}% p95)`);
    }
    return {
      name,
      fileCount,
      bytesPerFile,
      totalBytes: fileCount * bytesPerFile,
      strategy: fileCount >= SINGLE_PASS_MIN_FILES ? 'single-pass' : 'baseline-preserved',
      baseline: baselineStats,
      candidate: candidateStats,
      improvement: { medianPercent: medianGain, p95Percent: p95Gain }
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const scenarios = [
  { name: 'run67-web-shaped', fileCount: 9, bytesPerFile: 8192, requireMaterial: false },
  { name: 'run67-extension-shaped', fileCount: 191, bytesPerFile: 14844, requireMaterial: true },
  { name: 'small-evidence-stress', fileCount: 500, bytesPerFile: 1024, requireMaterial: true },
  { name: 'larger-payload-stress', fileCount: 2000, bytesPerFile: 16384, requireMaterial: false }
];

const results = [];
for (const scenario of scenarios) results.push(await measureScenario(scenario));
console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  concurrency: CONCURRENCY,
  singlePassMinFiles: SINGLE_PASS_MIN_FILES,
  samplesPerVariant: SAMPLES,
  results
}, null, 2));
