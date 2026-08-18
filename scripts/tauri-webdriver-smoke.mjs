import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { runSpec } from '../src/core/runner.mjs';

const appPath = path.resolve(process.env.FERRUM_TAURI_APP || '');
const artifactsRoot = path.resolve(process.env.FERRUM_TAURI_ARTIFACTS || 'artifacts/tauri');
const embedded = process.env.FERRUM_TAURI_EMBEDDED === '1';
const server = process.env.FERRUM_TAURI_SERVER || (embedded ? 'http://127.0.0.1:4445' : 'http://127.0.0.1:4444');
const driverCommand = process.env.FERRUM_TAURI_DRIVER || 'tauri-driver';
const startupMs = Number(process.env.FERRUM_TAURI_STARTUP_MS || 60000);
const stepMs = Number(process.env.FERRUM_TAURI_STEP_MS || 15000);
const fixtureCommit = process.env.FERRUM_TAURI_FIXTURE_COMMIT || 'e4c2607cd60287a0ceb69458a0d69d0b676f39a6';
const driverVersion = process.env.FERRUM_TAURI_DRIVER_VERSION || (embedded ? 'tauri-plugin-wdio-webdriver@1' : '2.0.6');
const nativeDriverVersion = process.env.FERRUM_TAURI_NATIVE_DRIVER_VERSION || null;
const fixtureName = process.env.FERRUM_TAURI_FIXTURE || (embedded ? 'webdriverio/desktop-mobile' : 'tauri-apps/webdriver-example');

if (!process.env.FERRUM_TAURI_APP) {
  throw new Error('FERRUM_TAURI_APP must point to a built Tauri application binary');
}

const appStat = await fs.stat(appPath).catch(() => null);
if (!appStat?.isFile()) {
  throw new Error(`Tauri application binary not found: ${appPath}`);
}
const applicationSha256 = createHash('sha256').update(await fs.readFile(appPath)).digest('hex');

await fs.mkdir(artifactsRoot, { recursive: true });
const processLogPath = path.join(artifactsRoot, embedded ? 'tauri-embedded-app.log' : 'tauri-driver.log');
const processLog = await fs.open(processLogPath, 'w');
let controlledProcess;

if (embedded) {
  const parsed = new URL(server);
  const port = parsed.port || '4445';
  controlledProcess = spawn(appPath, [], {
    env: {
      ...process.env,
      WDIO_EMBEDDED_SERVER: '1',
      TAURI_WEBDRIVER_PORT: port
    },
    stdio: ['ignore', processLog.fd, processLog.fd],
    windowsHide: true
  });
} else {
  controlledProcess = spawn(driverCommand, [], {
    stdio: ['ignore', processLog.fd, processLog.fd],
    windowsHide: true
  });
}

let processSpawnError = null;
controlledProcess.once('error', error => { processSpawnError = error; });

async function stopControlledProcess() {
  if (controlledProcess.exitCode != null || controlledProcess.signalCode != null) return;
  controlledProcess.kill('SIGTERM');
  const exited = await Promise.race([
    once(controlledProcess, 'close').then(() => true).catch(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000))
  ]);
  if (!exited && controlledProcess.exitCode == null && controlledProcess.signalCode == null) {
    controlledProcess.kill('SIGKILL');
    await Promise.race([
      once(controlledProcess, 'close').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
}

try {
  await new Promise(resolve => setTimeout(resolve, 150));
  if (processSpawnError) throw processSpawnError;
  if (controlledProcess.exitCode != null) {
    throw new Error(`${embedded ? 'Tauri embedded app' : 'tauri-driver'} exited before Ferrum connected with code ${controlledProcess.exitCode}`);
  }

  const directSteps = [
    { action: 'assert-text', using: 'css selector', value: 'body h1', text: 'Welcome to Tauri + Solid!' },
    { action: 'find', using: 'css selector', value: '#greet-input', as: 'greet-input' },
    { action: 'fill', element: 'greet-input', text: 'Ferrum' },
    { action: 'find', using: 'css selector', value: 'button[type="submit"]', as: 'greet-button' },
    { action: 'click', element: 'greet-button' },
    { action: 'assert-text', using: 'css selector', value: 'form + p', text: "Hello, Ferrum! You've been greeted from Rust!" },
    { action: 'screenshot', name: 'tauri-real-app' },
    { action: 'source', name: 'tauri-real-app' },
    { action: 'assert-session' }
  ];

  const embeddedSteps = [
    { action: 'assert-text', using: 'css selector', value: 'body h1', text: 'Tauri Basic App' },
    { action: 'find', using: 'css selector', value: '#increment-button', as: 'increment-button' },
    { action: 'click', element: 'increment-button' },
    { action: 'click', element: 'increment-button' },
    { action: 'assert-text', using: 'css selector', value: '#counter', text: '2', equals: true },
    {
      action: 'execute',
      script: "window.__TAURI__.core.invoke('get_platform_info').then((value)=>{document.getElementById('status').textContent='Rust IPC '+value.os;}).catch((error)=>{document.getElementById('status').textContent='Rust IPC ERROR '+error;}); return true;"
    },
    { action: 'assert-text', using: 'css selector', value: '#status', text: 'Rust IPC ' },
    { action: 'screenshot', name: 'tauri-embedded-real-app' },
    { action: 'source', name: 'tauri-embedded-real-app' },
    { action: 'assert-session' }
  ];

  const spec = {
    version: 1,
    name: embedded ? 'tauri-embedded-webdriver-real-app' : 'tauri-webdriver-real-app',
    target: {
      type: 'webdriver',
      server,
      capabilities: embedded ? {} : {
        browserName: 'wry',
        'tauri:options': { application: appPath }
      },
      identity: {
        fixture: fixtureName,
        fixtureCommit,
        applicationSha256,
        tauriDriverVersion: driverVersion,
        nativeDriverVersion,
        capabilityModel: embedded ? 'wdio-embedded-w3c' : 'tauri-driver-direct-wry'
      }
    },
    timeouts: { startupMs, stepMs },
    steps: embedded ? embeddedSteps : directSteps
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
    fixture: fixtureName,
    fixtureCommit,
    tauriDriverVersion: driverVersion,
    nativeDriverVersion,
    capabilityModel: embedded ? 'wdio-embedded-w3c' : 'tauri-driver-direct-wry',
    server
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} finally {
  await stopControlledProcess();
  await processLog.close().catch(() => {});
}
