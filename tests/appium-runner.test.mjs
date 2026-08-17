import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAppiumTarget } from '../src/runners/appium.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

function respond(res, value) {
  const body = JSON.stringify({ value });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function startFakeAppium({ sessionDelayMs = 0, emptyElementResponses = 0 } = {}) {
  const calls = [];
  let elementRequests = 0;
  let sessionCapabilities = { platformName: 'Android', automationName: 'UiAutomator2' };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsedBody = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, body: parsedBody });
    if (req.method === 'GET' && req.url === '/status') return respond(res, { ready: true, build: { version: '3.6.0' } });
    if (req.method === 'POST' && req.url === '/session') {
      if (sessionDelayMs) await new Promise(resolve => setTimeout(resolve, sessionDelayMs));
      sessionCapabilities = parsedBody?.capabilities?.alwaysMatch || sessionCapabilities;
      return respond(res, { sessionId: 's1', capabilities: sessionCapabilities });
    }
    if (req.method === 'POST' && req.url === '/session/s1/elements') {
      elementRequests += 1;
      if (elementRequests <= emptyElementResponses) return respond(res, []);
      return respond(res, [{ [ELEMENT]: 'e1' }]);
    }
    if (req.method === 'POST' && req.url === '/session/s1/element/e1/click') return respond(res, null);
    if (req.method === 'GET' && req.url === '/session/s1/element/e1/text') return respond(res, 'Network & internet');
    if (req.method === 'GET' && req.url === '/session/s1/element/e1/displayed') return respond(res, true);
    if (req.method === 'GET' && req.url === '/session/s1/screenshot') return respond(res, Buffer.from('fake-png').toString('base64'));
    if (req.method === 'GET' && req.url === '/session/s1/source') return respond(res, '<hierarchy><node text="Settings"/></hierarchy>');
    if (req.method === 'POST' && req.url === '/session/s1/back') return respond(res, null);
    if (req.method === 'GET' && req.url === '/session/s1') return respond(res, { capabilities: sessionCapabilities });
    if (req.method === 'DELETE' && req.url === '/session/s1') return respond(res, null);
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, calls, url: `http://127.0.0.1:${address.port}` };
}

async function fakeEvidence() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-appium-evidence-'));
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true });
  const events = [];
  return {
    dir,
    events,
    record(type, data = {}) { events.push({ type, ...data }); },
    async writeJson(name, value) { const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); return file; },
    async writeText(name, value) { const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); return file; }
  };
}

async function cleanup(fake, evidence) {
  await new Promise(resolve => fake.server.close(resolve));
  await fs.rm(evidence.dir, { recursive: true, force: true });
}

test('Appium runner waits for server, drives a W3C session, retains evidence, and deletes session', async () => {
  const fake = await startFakeAppium();
  const evidence = await fakeEvidence();
  try {
    const result = await runAppiumTarget({
      target: { server: fake.url, capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' } },
      timeouts: { startupMs: 5000, stepMs: 2000 },
      steps: [
        { action: 'find-all', using: 'xpath', value: '//*[@resource-id="android:id/title"]', min: 1 },
        { action: 'find', using: 'xpath', value: '//*[@resource-id="android:id/title"]', as: 'first' },
        { action: 'assert-visible', element: 'first' },
        { action: 'get-text', element: 'first' },
        { action: 'click', element: 'first' },
        { action: 'screenshot', name: 'after-click' },
        { action: 'source', name: 'settings' },
        { action: 'back' },
        { action: 'assert-session' }
      ]
    }, evidence);
    assert.equal(result.engine, 'appium');
    assert.equal(result.outputs.length, 9);
    assert.equal(result.outputs[0].output.attempts, 1);
    assert.equal(result.session.capabilities.platformName, 'Android');
    assert.ok(evidence.events.some(event => event.type === 'appium-server-ready'));
    assert.ok(evidence.events.some(event => event.type === 'screenshot'));
    assert.ok(fake.calls.some(call => call.method === 'DELETE' && call.url === '/session/s1'));
    assert.equal(await fs.readFile(path.join(evidence.dir, 'screenshots', 'after-click.png'), 'utf8'), 'fake-png');
    assert.match(await fs.readFile(path.join(evidence.dir, 'appium', 'settings.xml'), 'utf8'), /Settings/);
  } finally {
    await cleanup(fake, evidence);
  }
});

test('Appium runner redacts remote credential capabilities from outputs and session evidence', async () => {
  const fake = await startFakeAppium();
  const evidence = await fakeEvidence();
  try {
    const result = await runAppiumTarget({
      target: {
        server: fake.url,
        capabilities: {
          platformName: 'Android',
          'bstack:options': {
            userName: 'remote-private-user',
            accessKey: 'remote-private-access-key',
            projectName: 'Ferrum'
          }
        }
      },
      timeouts: { startupMs: 1000, stepMs: 500 },
      steps: [{ action: 'assert-session' }]
    }, evidence);

    const persistedSession = await fs.readFile(path.join(evidence.dir, 'appium-session.json'), 'utf8');
    const serialized = [JSON.stringify(result), JSON.stringify(evidence.events), persistedSession].join('\n');
    assert.equal(serialized.includes('remote-private-user'), false);
    assert.equal(serialized.includes('remote-private-access-key'), false);
    assert.match(serialized, /\[REDACTED\]/);
    assert.equal(result.session.capabilities.platformName, 'Android');
    assert.equal(result.session.capabilities['bstack:options'].projectName, 'Ferrum');
    assert.equal(result.outputs[0].output.capabilities['bstack:options'].accessKey, '[REDACTED]');
  } finally {
    await cleanup(fake, evidence);
  }
});

test('Appium constrained find-all retries transient empty UI state until the minimum is reached', async () => {
  const fake = await startFakeAppium({ emptyElementResponses: 2 });
  const evidence = await fakeEvidence();
  try {
    const result = await runAppiumTarget({
      target: { server: fake.url, capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' } },
      timeouts: { startupMs: 1000, stepMs: 1500 },
      steps: [{ action: 'find-all', using: 'xpath', value: '//*[@resource-id="android:id/title"]', min: 1 }]
    }, evidence);
    assert.equal(result.outputs[0].output.count, 1);
    assert.equal(result.outputs[0].output.attempts, 3);
    assert.equal(fake.calls.filter(call => call.method === 'POST' && call.url === '/session/s1/elements').length, 3);
  } finally {
    await cleanup(fake, evidence);
  }
});

test('Appium constrained find-all fails with the last observed count after its bounded deadline', async () => {
  const fake = await startFakeAppium({ emptyElementResponses: 100 });
  const evidence = await fakeEvidence();
  try {
    const started = performance.now();
    await assert.rejects(
      () => runAppiumTarget({
        target: { server: fake.url, capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' } },
        timeouts: { startupMs: 1000, stepMs: 120 },
        steps: [{ action: 'find-all', using: 'xpath', value: '//*[@resource-id="android:id/title"]', min: 1 }]
      }, evidence),
      /Appium find-all count 0 did not satisfy required minimum 1 within 120ms/
    );
    assert.ok(performance.now() - started < 1000, 'find-all timeout should remain bounded');
    assert.ok(evidence.events.some(event => event.type === 'step-fail' && /count 0/.test(event.message)));
    assert.ok(fake.calls.some(call => call.method === 'DELETE' && call.url === '/session/s1'));
  } finally {
    await cleanup(fake, evidence);
  }
});

test('Appium session creation uses startup timeout instead of the shorter step timeout', async () => {
  const fake = await startFakeAppium({ sessionDelayMs: 120 });
  const evidence = await fakeEvidence();
  try {
    const started = performance.now();
    const result = await runAppiumTarget({
      target: { server: fake.url, capabilities: { platformName: 'Android', 'appium:automationName': 'UiAutomator2' } },
      timeouts: { startupMs: 1000, stepMs: 40 },
      steps: [{ action: 'assert-session' }]
    }, evidence);
    assert.equal(result.engine, 'appium');
    assert.ok(performance.now() - started >= 100);
    const sessionEvent = evidence.events.find(event => event.type === 'appium-session-start');
    assert.equal(sessionEvent?.startupTimeoutMs, 1000);
    assert.ok(fake.calls.some(call => call.method === 'DELETE' && call.url === '/session/s1'));
  } finally {
    await cleanup(fake, evidence);
  }
});
