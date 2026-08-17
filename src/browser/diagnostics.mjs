export function attachPageDiagnostics(page, evidence, label = 'page') {
  const handlers = [];
  const on = (event, fn) => { page.on(event, fn); handlers.push([event, fn]); };

  on('console', msg => evidence.record('console', {
    target: label,
    level: msg.type(),
    text: msg.text(),
    location: msg.location()
  }));
  on('pageerror', error => evidence.record('pageerror', { target: label, message: error.message, stack: error.stack }));
  on('requestfailed', request => evidence.record('requestfailed', {
    target: label,
    method: request.method(),
    url: request.url(),
    failure: request.failure()
  }));
  on('response', response => {
    if (response.status() >= 400) {
      evidence.record('response-error', { target: label, status: response.status(), url: response.url() });
    }
  });
  on('download', download => evidence.record('download', { target: label, suggestedFilename: download.suggestedFilename() }));
  on('dialog', dialog => evidence.record('dialog', { target: label, kind: dialog.type(), message: dialog.message() }));

  return () => {
    for (const [event, fn] of handlers) page.off(event, fn);
  };
}

function workerUrl(worker) {
  try { return worker?.url?.() || 'unknown'; } catch { return 'unknown'; }
}

function requestWorker(request) {
  try { return request?.serviceWorker?.() || null; } catch { return null; }
}

function requestResourceType(request) {
  try { return request?.resourceType?.() || 'other'; } catch { return 'other'; }
}

function requestIsNavigation(request) {
  try { return Boolean(request?.isNavigationRequest?.()); } catch { return false; }
}

export function attachServiceWorkerDiagnostics(context, evidence) {
  const contextHandlers = [];
  const workerDetachers = new Map();
  const stats = {
    workers: 0,
    console: 0,
    requests: 0,
    responses: 0,
    failedRequests: 0,
    interceptedResponses: 0,
    closedWorkers: 0
  };

  const onContext = (event, fn) => {
    context.on(event, fn);
    contextHandlers.push([event, fn]);
  };

  const registerWorker = worker => {
    if (!worker || workerDetachers.has(worker)) return;
    stats.workers += 1;
    const url = workerUrl(worker);
    const target = `service-worker:${url}`;
    evidence.record('service-worker', { target, url });

    const handlers = [];
    const onWorker = (event, fn) => {
      worker.on(event, fn);
      handlers.push([event, fn]);
    };

    onWorker('console', msg => {
      stats.console += 1;
      evidence.record('service-worker-console', {
        target,
        level: msg.type(),
        text: msg.text(),
        location: msg.location()
      });
    });
    onWorker('close', () => {
      stats.closedWorkers += 1;
      evidence.record('service-worker-close', { target, url });
    });

    workerDetachers.set(worker, () => {
      for (const [event, fn] of handlers) worker.off(event, fn);
    });
  };

  for (const worker of context.serviceWorkers?.() || []) registerWorker(worker);
  onContext('serviceworker', registerWorker);
  onContext('request', request => {
    const worker = requestWorker(request);
    if (!worker) return;
    registerWorker(worker);
    stats.requests += 1;
    evidence.record('service-worker-request', {
      target: `service-worker:${workerUrl(worker)}`,
      method: request.method(),
      url: request.url(),
      resourceType: requestResourceType(request),
      navigation: requestIsNavigation(request)
    });
  });
  onContext('response', response => {
    const request = response.request();
    const worker = requestWorker(request);
    const fromServiceWorker = Boolean(response.fromServiceWorker?.());
    if (worker) {
      registerWorker(worker);
      stats.responses += 1;
      evidence.record('service-worker-response', {
        target: `service-worker:${workerUrl(worker)}`,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: requestResourceType(request),
        fromServiceWorker
      });
      return;
    }
    if (fromServiceWorker) {
      stats.interceptedResponses += 1;
      evidence.record('service-worker-intercept', {
        target: 'page-via-service-worker',
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: requestResourceType(request)
      });
    }
  });
  onContext('requestfailed', request => {
    const worker = requestWorker(request);
    if (!worker) return;
    registerWorker(worker);
    stats.failedRequests += 1;
    evidence.record('service-worker-requestfailed', {
      target: `service-worker:${workerUrl(worker)}`,
      method: request.method(),
      url: request.url(),
      resourceType: requestResourceType(request),
      failure: request.failure()
    });
  });

  return {
    snapshot() { return { ...stats }; },
    detach() {
      for (const [event, fn] of contextHandlers) context.off(event, fn);
      for (const detach of workerDetachers.values()) detach();
      workerDetachers.clear();
    }
  };
}

export async function collectPageVitals(page) {
  return await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = Object.fromEntries(performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime]));
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      navigation: nav ? {
        type: nav.type,
        domContentLoadedMs: nav.domContentLoadedEventEnd,
        loadMs: nav.loadEventEnd,
        responseEndMs: nav.responseEnd,
        transferSize: nav.transferSize,
        decodedBodySize: nav.decodedBodySize
      } : null,
      paints
    };
  });
}
