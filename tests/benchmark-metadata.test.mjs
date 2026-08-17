import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { benchmarkSpec } from '../src/core/benchmark.mjs';
import { compactBenchmarkResult } from '../src/core/agent-result.mjs';

test('benchmark records workload budget, reliability, evidence, and machine context', async () => {
  const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-bench-'));
  const result = await benchmarkSpec('examples/process-app.json', {
    engines: 'chromium',
    runs: 2,
    warmup: 0,
    artifactsRoot
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.workload.name, 'process-example');
  assert.equal(result.workload.targetType, 'process');
  assert.equal(result.workload.stepsPerRun, 2);
  assert.equal(result.workload.requestedMeasuredRuns, 2);
  assert.equal(result.workload.warmupRuns, 0);
  assert.equal(result.machine.platform, process.platform);
  assert.equal(result.machine.arch, process.arch);
  assert.equal(result.machine.logicalCpuCount > 0, true);
  assert.equal(result.machine.totalMemoryBytes > 0, true);

  const comparison = result.comparisons[0];
  assert.equal(comparison.measurement.requestedRuns, 2);
  assert.equal(comparison.measurement.successfulRuns, 2);
  assert.equal(comparison.measurement.failedRuns, 0);
  assert.equal(comparison.measurement.successRate, 1);
  assert.equal(comparison.measurement.timeoutCount, 0);
  assert.equal(comparison.measurement.attemptedMeasuredSteps, 4);
  assert.equal(comparison.measurement.completedMeasuredSteps, 4);
  assert.equal(comparison.samples.every(sample => sample.evidenceDir?.startsWith(artifactsRoot)), true);

  const compact = compactBenchmarkResult(result);
  assert.deepEqual(compact.workload, result.workload);
  assert.deepEqual(compact.machine, result.machine);
  assert.deepEqual(compact.comparisons[0].measurement, comparison.measurement);
});
