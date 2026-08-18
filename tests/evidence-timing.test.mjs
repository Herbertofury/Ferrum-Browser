import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compactRunResult } from '../src/core/agent-result.mjs';
import { EvidenceWriter } from '../src/core/evidence.mjs';

test('evidence records monotonic elapsed time and direct run duration for agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-timing-'));
  const evidence = await new EvidenceWriter({ root, name: 'timing-test' }).init();

  const first = evidence.record('timing-first');
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = evidence.record('timing-second');
  const result = await evidence.finalize({ status: 'passed', result: {} });

  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(second.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Number.isFinite(first.elapsedMs), true);
  assert.equal(Number.isFinite(second.elapsedMs), true);
  assert.ok(first.elapsedMs >= 0);
  assert.ok(second.elapsedMs > first.elapsedMs);
  assert.ok(result.durationMs >= second.elapsedMs);

  const summary = JSON.parse(await fs.readFile(path.join(evidence.dir, 'agent-summary.json'), 'utf8'));
  assert.equal(summary.durationMs, result.durationMs);
  assert.equal(summary.startedAt, result.startedAt);
  assert.equal(summary.endedAt, result.endedAt);

  const compact = compactRunResult(result);
  assert.equal(compact.durationMs, result.durationMs);
});
