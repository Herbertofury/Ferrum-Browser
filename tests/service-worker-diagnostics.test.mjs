import test from 'node:test';
import assert from 'node:assert/strict';
import { attachServiceWorkerDiagnostics } from '../src/browser/diagnostics.mjs';

class FakeEmitter {
  constructor() { this.handlers = new Map(); }
  on(event, handler) {
    const set = this.handlers.get(event) || new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }
  off(event, handler) {
    const set = this.handlers.get(event);
    set?.delete(handler);
    if (set && !set.size) this.handlers.delete(event);
  }
  emit(event, payload) {
    for (const handler of [...(this.handlers.get(event) || [])]) handler(payload);
  }
}

class FakeWorker extends FakeEmitter {
  constructor(url) { super(); this.workerUrl = url; }
  url() { return this.workerUrl; }
}

class FakeContext extends FakeEmitter {
  constructor(workers = []) { super(); this.workers = workers; }
  serviceWorkers() { return this.workers; }
}

function fakeRequest(worker) {
  return {
    serviceWorker: () => worker,
    method: () => 'GET',
    url: () => 'chrome-extension://abc/manifest.json',
    resourceType: () => 'fetch',
    isNavigationRequest: () => false,
    failure: () => ({ errorText: 'boom' })
  };
}

function fakeConsole(type, text) {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: 'chrome-extension://abc/background.js', lineNumber: 1, columnNumber: 1 })
  };
}

test('service-worker diagnostics capture console and worker-owned network evidence', () => {
  const worker = new FakeWorker('chrome-extension://abc/background.js');
  const context = new FakeContext([worker]);
  const events = [];
  const evidence = { record: (type, data) => events.push({ type, ...data }) };
  const diagnostics = attachServiceWorkerDiagnostics(context, evidence);

  worker.emit('console', fakeConsole('log', 'ready'));
  const request = fakeRequest(worker);
  context.emit('request', request);
  context.emit('response', {
    request: () => request,
    fromServiceWorker: () => false,
    url: () => request.url(),
    status: () => 200
  });
  context.emit('requestfailed', request);

  assert.deepEqual(diagnostics.snapshot(), {
    workers: 1,
    console: 1,
    requests: 1,
    responses: 1,
    failedRequests: 1,
    interceptedResponses: 0,
    closedWorkers: 0
  });
  assert.equal(events.filter(event => event.type === 'service-worker-console').length, 1);
  assert.equal(events.filter(event => event.type === 'service-worker-request').length, 1);
  assert.equal(events.filter(event => event.type === 'service-worker-response').length, 1);
  assert.equal(events.filter(event => event.type === 'service-worker-requestfailed').length, 1);

  diagnostics.detach();
  worker.emit('console', fakeConsole('error', 'late'));
  assert.equal(diagnostics.snapshot().console, 1);
});
