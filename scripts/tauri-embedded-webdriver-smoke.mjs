import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { runSpec } from '../src/core/runner.mjs';

const appPath = path.resolve(process.env.FERRUM_TAURI_APP || '');
const artifactsRoot = path.resolve(process.env.FERRUM_TAURI_ARTIFACTS || 'artifacts/tauri-embedded');
const server = process.env.FERRUM_TAURI_SERVER || 'http://127.0.0.1:4445';
const startupMs = Number(process.env.FERRUM_TAURI_STARTUP_MS || 90000);
const stepMs = Number(process.env.FERRUM_TAURI_STEP_MS || 15000);
const fixtureCommit = process.env.FERRUM_TAURI_FIXTURE_COMMIT || 'e4c2607cd60287a0ceb69458a0d69d0b676f39a6';
const pluginVersion = process.env.FERRUM_TAURI_EMBEDDED_PLUGIN_VERSION || '1.3.0';

if (!process.env.FERRUM_TAURI_APP) {
  throw new Error('FERRUM_TAURI_APP must point to a built Tauri application binary');
}

const appStat = await fs.stat(appPath).catch(() => null);
if (!appStat?.isFile()) {
  throw new Error(`Tauri application binary not found: ${appPath}`);
}

const applicationSha256 = createHash('sha256').update(await fs.readFile(appPath)).digest('hex');
const serverUrl = new URL(server);
const port = Number(serverUrl.port || (serverUrl.protocol === 'https:' ? 443 : 80));
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid embedded WebDriver port: ${server}`);

await fs.mkdir(artifactsRoot, { recursive: true });
const appLogPath = path.join(artifactsRoot, 'tauri-embedded-app.log');
const appLog = await fs.open(appLogPath, 'w');
const app = spawn(appPath, [], {
  cwd: path.dirname(appPath),
  env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
  stdio: ['ignore', appLog.fd, appLog.fd],
  windowsHide: true
});

let terminal = null;
let resolveTerminal;
const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
app.once('error', error => {
  terminal = { type: 'error', error };
  resolveTerminal(terminal);
});
app.once('close', (code, signal) => {
  if (!terminal) {
    terminal = { type: 'close', code, signal };
    resolveTerminal(terminal);
  }
});

function terminalError() {
  if (!terminal) return null;
  if (terminal.type === 'error') return new Error(`Embedded Tauri app failed before WebDriver readiness: ${terminal.error.message}`);
  return new Error(`Embedded Tauri app exited before WebDriver readiness (code ${terminal.code ?? 'none'}, signal ${terminal.signal || 'none'})`);
}

async function waitReady() {
  const deadline = Date.now() + startupMs;
  let attempts = 0;
  let lastError = null;
  while (Date.now() < deadline) {
    const ended = terminalError();
    if (ended) throw ended;
    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    const request = fetch(`${server.replace(/\/$/, '')}/status`, {
      signal: AbortSignal.timeout(Math.min(3000, remainingMs))
    }).then(async response => ({ type: 'response', response, text: await response.text() })).catch(error => ({ type: 'error', error }));
    const outcome = await Promise.race([
      request,
      terminalPromise.then(value => ({ type: 'terminal', value }))
    ]);
    if (outcome.type === 'terminal') throw terminalError();
    if (outcome.type === 'response' && outcome.response.ok) {
      let payload = null;
      try { payload = JSON.parse(outcome.text); } catch {}
      if (payload?.value?.ready !== false) return { attempts, payload };
      lastError = new Error(`WebDriver status not ready: ${outcome.text}`);
    } else if (outcome.type === 'error') {
      lastError = outcome.error;
    } else {
      lastError = new Error(`WebDriver status HTTP ${outcome.response.status}: ${outcome.text}`);
    }
    const waitMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      const waited = await Promise.race([
        new Promise(resolve => setTimeout(() => resolve(null), waitMs)),
        terminalPromise.then(value => ({ terminal: value }))
      ]);
      if (waited?.terminal) throw terminalError();
    }
  }
  throw new Error(`Embedded Tauri WebDriver did not become ready within ${startupMs}ms after ${attempts} attempts${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopApp() {
  if (app.exitCode != null || app.signalCode != null) return;
  app.kill('SIGTERM');
  const exited = await Promise.race([
    once(app, 'close').then(() => true).catch(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000))
  ]);
  if (!exited && app.exitCode == null && app.signalCode == null) {
    app.kill('SIGKILL');
    await Promise.race([
      once(app, 'close').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
}

try {
  const readiness = await waitReady();
  const spec = {
    version: 1,
    name: 'tauri-embedded-webdriver-real-app',
    target: {
      type: 'webdriver',
      server,
      capabilities: { browserName: 'tauri' },
      identity: {
        fixture: 'tauri-apps/webdriver-example',
        fixtureCommit,
        applicationSha256,
        provider: 'webdriverio/desktop-mobile',
        embeddedPlugin: 'tauri-plugin-wdio-webdriver',
        embeddedPluginVersion: pluginVersion,
        capabilityModel: 'embedded-w3c-existing-app'
      }
    },
    timeouts: { startupMs: Math.min(startupMs, 60000), stepMs },
    steps: [
      { action: 'assert-text', using: 'css selector', value: 'body h1', text: 'Welcome to Tauri + Solid!' },
      { action: 'find', using: 'css selector', value: '#greet-input', as: 'greet-input' },
      { action: 'fill', element: 'greet-input', text: 'Ferrum' },
      { action: 'find', using: 'css selector', value: 'button[type="submit"]', as: 'greet-button' },
      { action: 'click', element: 'greet-button' },
      { action: 'assert-text', using: 'css selector', value: 'form + p', text: "Hello, Ferrum! You've been greeted from Rust!" },
      { action: 'screenshot', name: 'tauri-embedded-real-app' },
      { action: 'source', name: 'tauri-embedded-real-app' },
      { action: 'assert-session' }
    ]
  };

  const result = await runSpec(spec, { artifactsRoot });
  const summary = {
    id: result.id,
    status: result.status,
    engine: result.result?.engine,
    durationMs: result.durationMs,
    evidenceDir: result.evidenceDir,
    application: appPath,
    applicationSha256,
    fixtureCommit,
    embeddedPlugin: 'tauri-plugin-wdio-webdriver',
    embeddedPluginVersion: pluginVersion,
    capabilityModel: 'embedded-w3c-existing-app',
    server,
    readinessAttempts: readiness.attempts
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} finally {
  await stopApp();
  await appLog.close().catch(() => {});
}
