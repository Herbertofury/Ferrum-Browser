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
