export function compactRunResult(result) {
  return {
    id: result.id,
    name: result.name,
    status: result.status,
    evidenceDir: result.evidenceDir,
    targetType: result.metadata?.targetType || null,
    engine: result.result?.engine || null,
    timings: result.result?.timings || null,
    summary: result.summary || null,
    failure: result.failure || null
  };
}

export function compactSuiteResult(result) {
  return {
    status: result.status,
    workers: result.workers,
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    results: result.results.map(item => item.status === 'passed' ? {
      specPath: item.specPath,
      durationMs: item.durationMs,
      ...compactRunResult(item.result)
    } : {
      specPath: item.specPath,
      status: 'failed',
      durationMs: item.durationMs,
      evidenceDir: item.evidenceDir,
      error: item.error
    })
  };
}

export function compactBenchmarkResult(result) {
  return {
    status: result.status,
    specPath: result.specPath,
    workload: result.workload,
    machine: result.machine,
    fastestMedianEngine: result.fastestMedianEngine,
    comparisons: result.comparisons.map(item => ({
      engine: item.engine,
      status: item.status,
      warmup: item.warmup,
      runs: item.runs,
      timings: item.timings,
      measurement: item.measurement,
      failureCount: item.failures.length
    }))
  };
}
