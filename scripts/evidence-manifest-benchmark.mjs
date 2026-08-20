import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { listEvidence, writeEvidenceManifest, verifyEvidence } from '../src/core/evidence-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts', 'evidence-manifest-benchmark');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-manifest-bench-'));
const historyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-history-bench-'));
const evidenceId = 'manifest-benchmark';
const evidenceDir = path.join(fixtureRoot, evidenceId);
const smallFileCount = 1500;
const largeFileCount = 16;
const smallBytes = 4096;
const largeBytes = 1024 * 1024;
const historyRunCount = 2000;
const measuredRuns = 7;
const listConcurrency = 32;

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

function gainPercent(baseline, candidate) {
  return Number((((baseline - candidate) / baseline) * 100).toFixed(2));
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

async function createHistoryFixture() {
  const batchSize = 128;
  for (let base = 0; base < historyRunCount; base += batchSize) {
    await Promise.all(Array.from({ length: Math.min(batchSize, historyRunCount - base) }, async (_, offset) => {
      const index = base + offset;
      const id = `run-${String(index).padStart(5, '0')}`;
      const dir = path.join(historyRoot, id);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'agent-summary.json'), JSON.stringify({
        id,
        name: 'history-benchmark',
        status: index % 3 ? 'passed' : 'failed',
        startedAt: new Date(Date.UTC(2026, 7, 19, 0, 0, index % 60)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 7, 19, 0, 1, index % 60)).toISOString(),
        durationMs: 1000 + index,
        metadata: { engine: 'chromium', browser: 'chromium' },
        eventCounts: { step: 5, screenshot: 1 },
        diagnosticErrorCount: 0
      }));
    }));
  }
}

async function baselineListEvidence(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory());
  const results = new Array(directories.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= directories.length) return;
      const entry = directories[index];
      try {
        const summary = JSON.parse(await fs.readFile(path.join(root, entry.name, 'agent-summary.json'), 'utf8'));
        results[index] = { ...summary, id: entry.name };
      } catch {}
    }
  };

  await Promise.all(Array.from({ length: Math.min(listConcurrency, directories.length) }, () => worker()));
  return results
    .filter(Boolean)
    .sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')));
}

async function timed(run) {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

async function measureManifestOnce() {
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

async function measureHistory() {
  const control = await baselineListEvidence(historyRoot);
  const warm = await listEvidence({ root: historyRoot });
  assert.equal(control.length, historyRunCount);
  assert.deepEqual(warm, control);

  const baselineSamples = [];
  const candidateSamples = [];
  for (let index = 0; index < measuredRuns; index += 1) {
    if (index % 2 === 0) {
      const baseline = await timed(() => baselineListEvidence(historyRoot));
      const candidate = await timed(() => listEvidence({ root: historyRoot }));
      assert.deepEqual(candidate.value, baseline.value);
      baselineSamples.push(baseline.ms);
      candidateSamples.push(candidate.ms);
    } else {
      const candidate = await timed(() => listEvidence({ root: historyRoot }));
      const baseline = await timed(() => baselineListEvidence(historyRoot));
      assert.deepEqual(candidate.value, baseline.value);
      baselineSamples.push(baseline.ms);
      candidateSamples.push(candidate.ms);
    }
  }

  const changedId = 'run-00010';
  const changedPath = path.join(historyRoot, changedId, 'agent-summary.json');
  const changed = JSON.parse(await fs.readFile(changedPath, 'utf8'));
  await fs.writeFile(changedPath, JSON.stringify({ ...changed, status: changed.status === 'passed' ? 'failed' : 'passed' }));
  const afterChange = await listEvidence({ root: historyRoot });
  assert.equal(afterChange.find(item => item.id === changedId)?.status, changed.status === 'passed' ? 'failed' : 'passed');

  const baseline = summary(baselineSamples);
  const cachedWarm = summary(candidateSamples);
  return {
    fixtureRuns: historyRunCount,
    measuredRuns,
    baseline,
    cachedWarm,
    medianGainPct: gainPercent(baseline.medianMs, cachedWarm.medianMs),
    p95GainPct: gainPercent(baseline.p95Ms, cachedWarm.p95Ms),
    baselineSamplesMs: baselineSamples.map(value => Number(value.toFixed(3))),
    cachedWarmSamplesMs: candidateSamples.map(value => Number(value.toFixed(3)))
  };
}

try {
  await fs.rm(artifactsRoot, { recursive: true, force: true });
  await fs.mkdir(artifactsRoot, { recursive: true });
  await Promise.all([createFixture(), createHistoryFixture()]);

  await measureManifestOnce();
  const manifestSamples = [];
  for (let index = 0; index < measuredRuns; index += 1) manifestSamples.push(await measureManifestOnce());
  const historyList = await measureHistory();

  const result = {
    schemaVersion: 2,
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
    writeManifest: summary(manifestSamples.map(sample => sample.writeMs)),
    verifyEvidence: summary(manifestSamples.map(sample => sample.verifyMs)),
    combined: summary(manifestSamples.map(sample => sample.totalMs)),
    samples: manifestSamples.map(sample => ({
      writeMs: Number(sample.writeMs.toFixed(3)),
      verifyMs: Number(sample.verifyMs.toFixed(3)),
      totalMs: Number(sample.totalMs.toFixed(3))
    })),
    historyList
  };
  await fs.writeFile(path.join(artifactsRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await Promise.all([
    fs.rm(fixtureRoot, { recursive: true, force: true }),
    fs.rm(historyRoot, { recursive: true, force: true })
  ]);
}
