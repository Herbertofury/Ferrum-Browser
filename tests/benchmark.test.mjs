import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { benchmarkSpec } from '../src/core/benchmark.mjs';

test('benchmark repeats an identical workload and summarizes durations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-bench-'));
  const specPath = path.join(root, 'bench.json');
  await fs.writeFile(specPath, JSON.stringify({
    version: 1,
    name: 'bench-process',
    target: { type: 'process', command: process.execPath, args: ['-e', "console.log('bench-ready')"] },
    steps: [
      { action: 'assert-log', text: 'bench-ready' },
      { action: 'wait-exit', code: 0, timeoutMs: 5000 }
    ]
  }));
  const result = await benchmarkSpec(specPath, { runs: 2, warmup: 0, engines: 'process', artifactsRoot: path.join(root, 'artifacts') });
  assert.equal(result.status, 'passed');
  assert.equal(result.comparisons[0].warmup, 0);
  assert.equal(result.comparisons[0].timings.count, 2);
  assert.equal(result.comparisons[0].failures.length, 0);
});
