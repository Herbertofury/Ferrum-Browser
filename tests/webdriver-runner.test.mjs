import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { runSpec } from '../src/core/runner.mjs';
import { WebDriverClient } from '../src/runners/webdriver.mjs';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4gAAAABJRU5ErkJggg==';

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

async function startFixture() {
  const state = { input: '', output: 'idle', currentUrl: 'about:blank', deleted: false, requests: [] };
  const elementMap = new Map([
    ['#name', 'name'],
    ['#go', 'go'],
    ['#out', 'out'],
    ['button', 'go']
  ]);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = await readJsonBody(request);
    state.requests.push({ method: request.method, path: url.pathname, body });
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ value }));
    };

    if (request.method === 'GET' && url.pathname === '/status') return send(200, { ready: true, message: 'fixture ready' });
    if (request.method === 'POST' && url.pathname === '/session') return send(200, { sessionId: 'session-1', capabilities: { browserName: 'chrome', browserVersion: 'fixture' } });
    if (request.method === 'DELETE' && url.pathname === '/session/session-1') {
      state.deleted = true;
      return send(200, null);
    }
    if (request.method === 'GET' && url.pathname === '/session/session-1') return send(200, { capabilities: { browserName: 'chrome' } });
    if (request.method === 'POST' && url.pathname === '/session/session-1/url') {
      state.currentUrl = body.url;
      return send(200, null);
    }
    if (request.method === 'GET' && url.pathname === '/session/session-1/url') return send(200, state.currentUrl);
    if (request.method === 'GET' && url.pathname === '/session/session-1/title') return send(200, 'Ferrum WebDriver');
    if (request.method === 'POST' && url.pathname === '/session/session-1/elements') {
      const id = elementMap.get(body.value);
      return send(200, id ? [{ 'element-6066-11e4-a52e-4f735466cecf': id }] : []);
    }
    const valueMatch = url.pathname.match(/^\/session\/session-1\/element\/([^/]+)\/value$/);
    if (request.method === 'POST' && valueMatch) {
      if (valueMatch[1] === 'name') state.input = body.text;
      return send(200, null);
    }
    const clearMatch = url.pathname.match(/^\/session\/session-1\/element\/([^/]+)\/clear$/);
    if (request.method === 'POST' && clearMatch) {
      if (clearMatch[1] === 'name') state.input = '';
      return send(200, null);
    }
    const clickMatch = url.pathname.match(/^\/session\/session-1\/element\/([^/]+)\/click$/);
    if (request.method === 'POST' && clickMatch) {
      if (clickMatch[1] === 'go') state.output = `hello ${state.input}`;
      return send(200, null);
    }
    const textMatch = url.pathname.match(/^\/session\/session-1\/element\/([^/]+)\/text$/);
    if (request.method === 'GET' && textMatch) {
      const text = textMatch[1] === 'out' ? state.output : textMatch[1] === 'name' ? state.input : 'Go';
      return send(200, text);
    }
    if (request.method === 'GET' && /\/displayed$/.test(url.pathname)) return send(200, true);
    if (request.method === 'GET' && /\/attribute\//.test(url.pathname)) return send(200, 'fixture');
    if (request.method === 'GET' && url.pathname === '/session/session-1/source') return send(200, '<html><body>Ferrum fixture</body></html>');
    if (request.method === 'GET' && url.pathname === '/session/session-1/screenshot') return send(200, PNG_1X1);
    if (request.method === 'POST' && ['/session/session-1/back', '/session/session-1/forward', '/session/session-1/refresh'].includes(url.pathname)) return send(200, null);
    if (request.method === 'POST' && url.pathname === '/session/session-1/execute/sync') return send(200, { script: body.script, args: body.args });
    return send(404, { error: 'unknown command', message: `${request.method} ${url.pathname}` });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    state,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { server.close(); await once(server, 'close'); }
  };
}

test('WebDriver target exercises a W3C session end to end and finalizes evidence', async () => {
  const fixture = await startFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-webdriver-'));
  try {
    const spec = {
      version: 1,
      name: 'webdriver-fixture',
      target: { type: 'webdriver', server: fixture.baseUrl, capabilities: { browserName: 'chrome' } },
      timeouts: { startupMs: 2000, stepMs: 1000 },
      steps: [
        { action: 'navigate', url: 'data:text/html,fixture' },
        { action: 'find', using: 'css selector', value: '#name', as: 'name' },
        { action: 'fill', element: 'name', text: 'Ferrum' },
        { action: 'find', using: 'css selector', value: '#go', as: 'go' },
        { action: 'click', element: 'go' },
        { action: 'assert-text', using: 'css selector', value: '#out', text: 'hello Ferrum' },
        { action: 'find-all', using: 'css selector', value: 'button', min: 1, max: 1 },
        { action: 'assert-visible', element: 'go' },
        { action: 'title' },
        { action: 'url' },
        { action: 'execute', script: 'return arguments[0]', args: ['ok'] },
        { action: 'screenshot', name: 'webdriver-fixture' },
        { action: 'source', name: 'webdriver-fixture' },
        { action: 'assert-session' }
      ]
    };
    const result = await runSpec(spec, { artifactsRoot: root });
    assert.equal(result.status, 'passed');
    assert.equal(result.result.engine, 'webdriver');
    assert.equal(result.result.session.capabilities.browserName, 'chrome');
    assert.equal(fixture.state.deleted, true);
    assert.ok(fixture.state.requests.some(entry => entry.method === 'POST' && entry.path === '/session'));
    assert.ok(fixture.state.requests.some(entry => entry.path === '/session/session-1/screenshot'));
    const manifest = JSON.parse(await fs.readFile(path.join(result.evidenceDir, 'evidence-manifest.json'), 'utf8'));
    assert.ok(manifest.files.some(file => file.path === 'webdriver-session.json'));
    assert.ok(manifest.files.some(file => file.path === 'screenshots/webdriver-fixture.png'));
    assert.ok(manifest.files.some(file => file.path === 'webdriver/webdriver-fixture.html'));
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('WebDriver element lookup remains bounded and reports the final count', async () => {
  const fixture = await startFixture();
  try {
    const client = new WebDriverClient(fixture.baseUrl, { timeoutMs: 100 });
    await client.waitUntilReady(500);
    await client.createSession({ browserName: 'chrome' });
    await assert.rejects(
      client.find('css selector', '#missing', { timeoutMs: 80 }),
      /last count 0/
    );
    await client.deleteSession();
  } finally {
    await fixture.close();
  }
});
