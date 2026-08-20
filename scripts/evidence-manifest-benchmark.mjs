import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeEvidenceManifest, verifyEvidence } from '../src/core/evidence-store.mjs';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const artifactsRoot = path.join(repoRoot, 'artifacts', 'evidence-manifest-benchmark');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-manifest-bench-'));
const evidenceId = 'manifest-benchmark';
const evidenceDir = path.join(fixtureRoot, evidenceId);
const smallFileCount = 1500;
const largeFileCount = 16;
const smallBytes = 4096;
const largeBytes = 1024 * 1024;
const measuredRuns = 7;

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summary(values) {
  return {
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    minMs: Number(Math.min(...values).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3))
  };
}

async function createFixture() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const smallPayload = Buffer.alloc(smallBytes, 0x61);
  const largePayload = Buffer.alloc(largeBytes, 0x5a);
  const writes = [];
  for (let index = 0; index < smallFileCount; index += 1) {
    const shard = String(index % 32).padStart(2, '0');
    const dir = path.join(evidenceDir, 'small', shard);
    await fs.mkdir(dir, { recursive: true });
    writes.push(fs.writeFile(path.join(dir, `${String(index).padStart(5, '0')}.bin`), smallPayload));
  }
  for (let index = 0; index < largeFileCount; index += 1) {
    const dir = path.join(evidenceDir, 'large');
    await fs.mkdir(dir, { recursive: true });
    writes.push(fs.writeFile(path.join(dir, `${String(index).padStart(3, '0')}.bin`), largePayload));
  }
  await Promise.all(writes);
}

async function measureOnce() {
  const writeStarted = performance.now();
  const manifest = await writeEvidenceManifest(evidenceDir);
  const writeMs = performance.now() - writeStarted;
  assert.equal(manifest.totalFiles, smallFileCount + largeFileCount);
  assert.equal(manifest.totalBytes, smallFileCount * smallBytes + largeFileCount * largeBytes);
  assert.deepEqual(manifest.files.map(file => file.path), [...manifest.files.map(file => file.path)].sort());

  const verifyStarted = performance.now();
  const verified = await verifyEvidence(evidenceId, { root: fixtureRoot });
  const verifyMs = performance.now() - verifyStarted;
  assert.equal(verified.status, 'passed');
  assert.equal(verified.checkedFiles, smallFileCount + largeFileCount);
  return { writeMs, verifyMs, totalMs: writeMs + verifyMs };
}

try {
  await fs.rm(artifactsRoot, { recursive: true, force: true });
  await fs.mkdir(artifactsRoot, { recursive: true });
  await createFixture();

  await measureOnce();
  const samples = [];
  for (let index = 0; index < measuredRuns; index += 1) samples.push(await measureOnce());

  const result = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    fixture: {
      files: smallFileCount + largeFileCount,
      smallFileCount,
      smallBytes,
      largeFileCount,
      largeBytes,
      totalBytes: smallFileCount * smallBytes + largeFileCount * largeBytes
    },
    measuredRuns,
    writeManifest: summary(samples.map(sample => sample.writeMs)),
    verifyEvidence: summary(samples.map(sample => sample.verifyMs)),
    combined: summary(samples.map(sample => sample.totalMs)),
    samples: samples.map(sample => ({
      writeMs: Number(sample.writeMs.toFixed(3)),
      verifyMs: Number(sample.verifyMs.toFixed(3)),
      totalMs: Number(sample.totalMs.toFixed(3))
    }))
  };
  await fs.writeFile(path.join(artifactsRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
