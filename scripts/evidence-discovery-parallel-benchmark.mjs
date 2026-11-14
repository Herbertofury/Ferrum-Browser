import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const MANIFEST_NAME = 'evidence-manifest.json';
const SAMPLES = 20;
const PARALLEL_CONCURRENCY = 16;

async function collectSequential(base, dir = base, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSequential(base, file, out);
    else if (entry.isFile()) {
      const relativePath = path.relative(base, file).replaceAll('\\', '/');
      if (relativePath !== MANIFEST_NAME) out.push(file);
    }
  }
  return out;
}

async function collectParallel(base) {
  const out = [];
  let directories = [base];

  while (directories.length) {
    const current = directories;
    const results = new Array(current.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= current.length) return;
        const dir = current[index];
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const nested = [];
        const files = [];
        for (const entry of entries) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) nested.push(file);
          else if (entry.isFile()) {
            const relativePath = path.relative(base, file).replaceAll('\\', '/');
            if (relativePath !== MANIFEST_NAME) files.push(file);
          }
        }
        results[index] = { nested, files };
      }
    };

    const workerCount = Math.min(PARALLEL_CONCURRENCY, current.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const next = [];
    for (const result of results) {
      out.push(...result.files);
      next.push(...result.nested);
    }
    directories = next;
  }

  return out;
}

function percentileLinear(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
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

function normalized(base, files) {
  return files
    .map(file => path.relative(base, file).replaceAll('\\', '/'))
    .sort((a, b) => a.localeCompare(b));
}

async function writeFixture(root, fileCount) {
  for (let index = 0; index < fileCount; index += 1) {
    const shard = String(index % 19).padStart(2, '0');
    const depth = String(Math.floor(index / 19) % 5).padStart(2, '0');
    const dir = path.join(root, shard, depth);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${String(index).padStart(5, '0')}.json`), `${index}\n`, 'utf8');
  }
  await fs.writeFile(path.join(root, MANIFEST_NAME), '{}\n', 'utf8');
}

async function measureScenario(fileCount) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-discovery-bench-'));
  try {
    await writeFixture(root, fileCount);
    const sequentialFiles = await collectSequential(root);
    const parallelFiles = await collectParallel(root);
    if (JSON.stringify(normalized(root, sequentialFiles)) !== JSON.stringify(normalized(root, parallelFiles))) {
      throw new Error(`${fileCount} files: discovery equivalence failed`);
    }
    if (sequentialFiles.some(file => path.basename(file) === MANIFEST_NAME) || parallelFiles.some(file => path.basename(file) === MANIFEST_NAME)) {
      throw new Error(`${fileCount} files: manifest exclusion failed`);
    }

    await collectSequential(root);
    await collectParallel(root);
    const samples = { sequential: [], parallel: [] };
    for (let index = 0; index < SAMPLES; index += 1) {
      const order = index % 2 === 0 ? ['sequential', 'parallel'] : ['parallel', 'sequential'];
      for (const variant of order) {
        const started = performance.now();
        if (variant === 'parallel') await collectParallel(root);
        else await collectSequential(root);
        samples[variant].push(performance.now() - started);
      }
    }

    const baseline = summarize(samples.sequential);
    const candidate = summarize(samples.parallel);
    return {
      fileCount,
      directoryConcurrency: PARALLEL_CONCURRENCY,
      baseline,
      candidate,
      improvement: {
        medianPercent: improvement(baseline.medianMs, candidate.medianMs),
        p95Percent: improvement(baseline.p95Ms, candidate.p95Ms)
      }
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const fileCount of [191, 500, 2000, 5000]) results.push(await measureScenario(fileCount));

console.log(JSON.stringify({
  node: process.version,
  platform: process.platform,
  samplesPerVariant: SAMPLES,
  directoryConcurrency: PARALLEL_CONCURRENCY,
  results
}, null, 2));
