import { loadSpec } from './spec.mjs';
import { runSpec } from './runner.mjs';

export async function runSuite(specPaths, options = {}) {
  if (!Array.isArray(specPaths) || specPaths.length === 0) throw new Error('suite requires at least one spec path');
  const workers = Math.max(1, Math.min(Number(options.workers || 1), specPaths.length));
  const queue = specPaths.map((specPath, index) => ({ specPath, index }));
  const results = new Array(queue.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const slot = cursor++;
      if (slot >= queue.length) return;
      const item = queue[slot];
      const started = performance.now();
      try {
        const spec = await loadSpec(item.specPath, { variables: options.variables || {} });
        const result = await runSpec(spec, options);
        results[item.index] = {
          specPath: item.specPath,
          status: 'passed',
          durationMs: performance.now() - started,
          evidenceId: result.id,
          result
        };
      } catch (error) {
        results[item.index] = {
          specPath: item.specPath,
          status: 'failed',
          durationMs: performance.now() - started,
          evidenceDir: error.evidenceDir || null,
          error: error.message
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  const passed = results.filter(item => item.status === 'passed').length;
  const failed = results.length - passed;
  return { status: failed ? 'failed' : 'passed', workers, total: results.length, passed, failed, results };
}
