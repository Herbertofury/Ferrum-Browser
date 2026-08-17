import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { runSpec } from '../src/core/runner.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4gAAAABJRU5ErkJggg==';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

async function startVisibilityFixture({ visibleAfter = 3 } = {}) {
  const state = { displayedRequests: 0, deleted: false };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = value => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value }));
    };

    if (request.method === 'GET' && url.pathname === '/status') return send({ ready: true });
    if (request.method === 'POST' && url.pathname === '/session') return send({ sessionId: 'session-visible', capabilities: { browserName: 'chrome' } });
    if (request.method === 'DELETE' && url.pathname === '/session/session-visible') {
      state.deleted = true;
      return send(null);
    }
    if (request.method === 'POST' && url.pathname === '/session/session-visible/elements') {
      return send([{ [ELEMENT_KEY]: 'late' }]);
    }
    if (request.method === 'GET' && url.pathname === '/session/session-visible/element/late/displayed') {
      state.displayedRequests += 1;
      return send(state.displayedRequests >= visibleAfter);
    }
    if (request.method === 'GET' && url.pathname === '/session/session-visible/source') return send('<html><body><div id="late"></div></body></html>');
    if (request.method === 'GET' && url.pathname === '/session/session-visible/screenshot') return send(PNG_1X1);

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: { error: 'unknown command', message: `${request.method} ${url.pathname}` } }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close'); }
  };
}

function visibilitySpec(server, timeoutMs) {
  return {
    version: 1,
    name: 'webdriver-visible-convergence',
    target: { type: 'webdriver', server, capabilities: { browserName: 'chrome' } },
    timeouts: { startupMs: 1000, stepMs: timeoutMs },
    steps: [
      { action: 'assert-visible', using: 'css selector', value: '#late', timeoutMs }
    ]
  };
}

test('WebDriver assert-visible retries within one bounded deadline until displayed', async () => {
  const fixture = await startVisibilityFixture({ visibleAfter: 3 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-webdriver-visible-'));
  try {
    const result = await runSpec(visibilitySpec(fixture.baseUrl, 1000), { artifactsRoot: root });
    assert.equal(result.status, 'passed');
    const step = result.result.outputs[0];
    assert.equal(step.action, 'assert-visible');
    assert.equal(step.output.displayed, true);
    assert.equal(step.output.attempts, 3);
    assert.equal(fixture.state.displayedRequests, 3);
    assert.equal(fixture.state.deleted, true);
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('WebDriver assert-visible timeout reports attempts and final displayed state', async () => {
  const fixture = await startVisibilityFixture({ visibleAfter: Number.MAX_SAFE_INTEGER });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-webdriver-visible-timeout-'));
  try {
    await assert.rejects(
      runSpec(visibilitySpec(fixture.baseUrl, 120), { artifactsRoot: root }),
      /did not become displayed within 120ms after \d+ attempts?; last observed displayed=false/
    );
    assert.ok(fixture.state.displayedRequests >= 1);
    assert.equal(fixture.state.deleted, true);
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
