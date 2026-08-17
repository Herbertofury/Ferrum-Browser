import { loadSpec } from './spec.mjs';
import { runSpec } from './runner.mjs';
import { summarizeDurations } from './stats.mjs';
import { collectRuntimeMetadata } from './runtime-metadata.mjs';

function isTimeout(error) {
  return error?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(String(error?.message || ''));
}

export async function benchmarkSpec(specPath, options = {}) {
  const runs = Math.max(1, Number(options.runs ?? 5));
  const warmup = Math.max(0, Number(options.warmup ?? 1));
  const engines = String(options.engines || options.engine || 'chromium').split(',').map(value => value.trim()).filter(Boolean);
  const specOptions = { variables: options.variables || {} };
  const referenceSpec = await loadSpec(specPath, specOptions);
  const stepsPerRun = referenceSpec.steps?.length || 0;
  const comparisons = [];

  for (const engine of engines) {
    const samples = [];
    const failures = [];
    for (let index = 0; index < warmup + runs; index++) {
      const spec = await loadSpec(specPath, specOptions);
      const started = performance.now();
      try {
        const result = await runSpec(spec, {
          ...options,
          engine,
          artifactsRoot: options.artifactsRoot
        });
        const durationMs = performance.now() - started;
        if (index >= warmup) samples.push({ durationMs, evidenceId: result.id, evidenceDir: result.evidenceDir });
      } catch (error) {
        failures.push({
          iteration: index + 1,
          warmup: index < warmup,
          timeout: isTimeout(error),
          message: error.message,
          evidenceDir: error.evidenceDir || null
        });
      }
    }
    const measuredFailures = failures.filter(item => !item.warmup);
    const successfulRuns = samples.length;
    const failedRuns = measuredFailures.length;
    comparisons.push({
      engine,
      status: failures.length ? 'failed' : 'passed',
      warmup,
      runs,
      timings: summarizeDurations(samples.map(sample => sample.durationMs)),
      measurement: {
        requestedRuns: runs,
        successfulRuns,
        failedRuns,
        successRate: runs ? successfulRuns / runs : 0,
        timeoutCount: measuredFailures.filter(item => item.timeout).length,
        warmupRuns: warmup,
        warmupFailureCount: failures.filter(item => item.warmup).length,
        stepsPerRun,
        attemptedMeasuredSteps: runs * stepsPerRun,
        completedMeasuredSteps: successfulRuns * stepsPerRun
      },
      samples,
      failures
    });
  }

  const valid = comparisons.filter(item => item.status === 'passed' && item.timings.medianMs != null);
  const fastest = valid.length ? [...valid].sort((a, b) => a.timings.medianMs - b.timings.medianMs)[0].engine : null;
  return {
    status: comparisons.some(item => item.status === 'failed') ? 'failed' : 'passed',
    specPath,
    workload: {
      name: referenceSpec.name,
      targetType: referenceSpec.target?.type || null,
      stepsPerRun,
      requestedMeasuredRuns: runs,
      warmupRuns: warmup
    },
    machine: collectRuntimeMetadata(),
    fastestMedianEngine: fastest,
    comparisons
  };
}
