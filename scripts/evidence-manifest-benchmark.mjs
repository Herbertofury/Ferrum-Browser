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
const minimumMedianGainPct = 35;
const minimumP95GainPct = 30;
const legacySummaryCache = new Map();

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

function legacySummaryIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
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
        const summaryValue = JSON.parse(await fs.readFile(path.join(root, entry.name, 'agent-summary.json'), 'utf8'));
        results[index] = { ...summaryValue, id: entry.name };
      } catch {}
    }
  };

  await Promise.all(Array.from({ length: Math.min(listConcurrency, directories.length) }, () => worker()));
  return results
    .filter(Boolean)
    .sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')));
}

async function legacyCachedListEvidence(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory());
  const results = new Array(directories.length);
  const seen = new Set();
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= directories.length) return;
      const entry = directories[index];
      const file = path.join(root, entry.name, 'agent-summary.json');
      seen.add(file);
      try {
        const stat = await fs.stat(file, { bigint: true });
        if (!stat.isFile()) continue;
        const identity = legacySummaryIdentity(stat);
        const cached = legacySummaryCache.get(file);
        let parsed;
        if (cached?.identity === identity) parsed = structuredClone(cached.summary);
        else {
          let summaryValue = null;
          try { summaryValue = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
          legacySummaryCache.set(file, { identity, summary: summaryValue });
          parsed = summaryValue == null ? null : structuredClone(summaryValue);
        }
        if (parsed) results[index] = { ...parsed, id: entry.name };
      } catch {}
    }
  };

  await Promise.all(Array.from({ length: Math.min(listConcurrency, directories.length) }, () => worker()));
  for (const file of legacySummaryCache.keys()) {
    if (!seen.has(file)) legacySummaryCache.delete(file);
  }
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
  const legacyWarm = await legacyCachedListEvidence(historyRoot);
  const candidateWarm = await listEvidence({ root: historyRoot });
  assert.equal(control.length, historyRunCount);
  assert.deepEqual(legacyWarm, control);
  assert.deepEqual(candidateWarm, control);

  const runners = [
    { kind: 'baseline', run: () => baselineListEvidence(historyRoot) },
    { kind: 'legacy', run: () => legacyCachedListEvidence(historyRoot) },
    { kind: 'candidate', run: () => listEvidence({ root: historyRoot }) }
  ];
  const baselineSamples = [];
  const legacySamples = [];
  const candidateSamples = [];
  for (let index = 0; index < measuredRuns; index += 1) {
    const offset = index % runners.length;
    const ordered = [...runners.slice(offset), ...runners.slice(0, offset)];
    for (const runner of ordered) {
      const measured = await timed(runner.run);
      if (runner.kind === 'candidate') candidateSamples.push(measured.ms);
      else if (runner.kind === 'legacy') legacySamples.push(measured.ms);
      else baselineSamples.push(measured.ms);
    }
  }

  const changedId = 'run-00010';
  const changedPath = path.join(historyRoot, changedId, 'agent-summary.json');
  const changed = JSON.parse(await fs.readFile(changedPath, 'utf8'));
  const originalStat = fs.stat;
  const frozenStat = await originalStat(changedPath, { bigint: true });
  const beforeBytes = await fs.readFile(changedPath);
  const afterBytes = Buffer.from(JSON.stringify({ ...changed, status: changed.status === 'passed' ? 'failed' : 'passed' }));
  assert.equal(afterBytes.length, beforeBytes.length, 'collision benchmark requires same-size rewrite');
  await fs.writeFile(changedPath, afterBytes);
  fs.stat = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(changedPath)) return frozenStat;
    return originalStat(target, options);
  };
  let legacyCollisionStatus;
  let candidateCollisionStatus;
  try {
    legacyCollisionStatus = (await legacyCachedListEvidence(historyRoot)).find(item => item.id === changedId)?.status;
    candidateCollisionStatus = (await listEvidence({ root: historyRoot })).find(item => item.id === changedId)?.status;
  } finally {
    fs.stat = originalStat;
  }
  const expectedChangedStatus = changed.status === 'passed' ? 'failed' : 'passed';
  assert.equal(legacyCollisionStatus, changed.status, 'legacy stat-only cache control should reproduce stale result under forced identity collision');
  assert.equal(candidateCollisionStatus, expectedChangedStatus, 'collision-safe cache must observe changed bytes under forced stat collision');

  const baseline = summary(baselineSamples);
  const legacyCachedWarm = summary(legacySamples);
  const collisionSafeCachedWarm = summary(candidateSamples);
  const medianGainPct = gainPercent(baseline.medianMs, collisionSafeCachedWarm.medianMs);
  const p95GainPct = gainPercent(baseline.p95Ms, collisionSafeCachedWarm.p95Ms);
  assert.ok(medianGainPct >= minimumMedianGainPct, `collision-safe cache median gain ${medianGainPct}% is below ${minimumMedianGainPct}%`);
  assert.ok(p95GainPct >= minimumP95GainPct, `collision-safe cache p95 gain ${p95GainPct}% is below ${minimumP95GainPct}%`);

  return {
    fixtureRuns: historyRunCount,
    measuredRuns,
    baseline,
    legacyCachedWarm,
    collisionSafeCachedWarm,
    legacyMedianGainPct: gainPercent(baseline.medianMs, legacyCachedWarm.medianMs),
    legacyP95GainPct: gainPercent(baseline.p95Ms, legacyCachedWarm.p95Ms),
    medianGainPct,
    p95GainPct,
    medianDeltaVsLegacyPct: gainPercent(legacyCachedWarm.medianMs, collisionSafeCachedWarm.medianMs),
    p95DeltaVsLegacyPct: gainPercent(legacyCachedWarm.p95Ms, collisionSafeCachedWarm.p95Ms),
    deterministicCollision: {
      sameSizeBytes: beforeBytes.length,
      frozenIdentity: legacySummaryIdentity(frozenStat),
      legacyStatus: legacyCollisionStatus,
      candidateStatus: candidateCollisionStatus,
      expectedChangedStatus
    },
    baselineSamplesMs: baselineSamples.map(value => Number(value.toFixed(3))),
    legacyCachedSamplesMs: legacySamples.map(value => Number(value.toFixed(3))),
    collisionSafeCachedSamplesMs: candidateSamples.map(value => Number(value.toFixed(3)))
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
    schemaVersion: 3,
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
