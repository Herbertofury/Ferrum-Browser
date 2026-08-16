import { loadSpec } from './spec.mjs';
import { runSpec } from './runner.mjs';
import { summarizeDurations } from './stats.mjs';

export async function benchmarkSpec(specPath, options = {}) {
  const runs = Math.max(1, Number(options.runs ?? 5));
  const warmup = Math.max(0, Number(options.warmup ?? 1));
  const engines = String(options.engines || options.engine || 'chromium').split(',').map(value => value.trim()).filter(Boolean);
  const comparisons = [];

  for (const engine of engines) {
    const samples = [];
    const failures = [];
    for (let index = 0; index < warmup + runs; index++) {
      const spec = await loadSpec(specPath);
      const started = performance.now();
      try {
        const result = await runSpec(spec, {
          ...options,
          engine,
          artifactsRoot: options.artifactsRoot
        });
        const durationMs = performance.now() - started;
        if (index >= warmup) samples.push({ durationMs, evidenceId: result.id });
      } catch (error) {
        failures.push({ iteration: index + 1, warmup: index < warmup, message: error.message, evidenceDir: error.evidenceDir || null });
      }
    }
    comparisons.push({
      engine,
      status: failures.length ? 'failed' : 'passed',
      warmup,
      runs,
      timings: summarizeDurations(samples.map(sample => sample.durationMs)),
      samples,
      failures
    });
  }

  const valid = comparisons.filter(item => item.status === 'passed' && item.timings.medianMs != null);
  const fastest = valid.length ? [...valid].sort((a, b) => a.timings.medianMs - b.timings.medianMs)[0].engine : null;
  return {
    status: comparisons.some(item => item.status === 'failed') ? 'failed' : 'passed',
    specPath,
    fastestMedianEngine: fastest,
    comparisons
  };
}
