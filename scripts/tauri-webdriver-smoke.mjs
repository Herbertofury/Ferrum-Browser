import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { runSpec } from '../src/core/runner.mjs';

const appPath = path.resolve(process.env.FERRUM_TAURI_APP || '');
const artifactsRoot = path.resolve(process.env.FERRUM_TAURI_ARTIFACTS || 'artifacts/tauri');
const server = process.env.FERRUM_TAURI_SERVER || 'http://127.0.0.1:4444';
const driverCommand = process.env.FERRUM_TAURI_DRIVER || 'tauri-driver';
const startupMs = Number(process.env.FERRUM_TAURI_STARTUP_MS || 60000);
const stepMs = Number(process.env.FERRUM_TAURI_STEP_MS || 15000);
const fixtureCommit = process.env.FERRUM_TAURI_FIXTURE_COMMIT || 'e4c2607cd60287a0ceb69458a0d69d0b676f39a6';
const driverVersion = process.env.FERRUM_TAURI_DRIVER_VERSION || '2.0.6';
const nativeDriverVersion = process.env.FERRUM_TAURI_NATIVE_DRIVER_VERSION || null;

if (!process.env.FERRUM_TAURI_APP) {
  throw new Error('FERRUM_TAURI_APP must point to a built Tauri application binary');
}

const appStat = await fs.stat(appPath).catch(() => null);
if (!appStat?.isFile()) {
  throw new Error(`Tauri application binary not found: ${appPath}`);
}
const applicationSha256 = createHash('sha256').update(await fs.readFile(appPath)).digest('hex');

await fs.mkdir(artifactsRoot, { recursive: true });
const driverLogPath = path.join(artifactsRoot, 'tauri-driver.log');
const driverLog = await fs.open(driverLogPath, 'w');
const driver = spawn(driverCommand, [], {
  stdio: ['ignore', driverLog.fd, driverLog.fd],
  windowsHide: true
});

let driverSpawnError = null;
driver.once('error', error => { driverSpawnError = error; });

async function stopDriver() {
  if (driver.exitCode != null || driver.signalCode != null) return;
  driver.kill('SIGTERM');
  const exited = await Promise.race([
    once(driver, 'close').then(() => true).catch(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000))
  ]);
  if (!exited && driver.exitCode == null && driver.signalCode == null) {
    driver.kill('SIGKILL');
    await Promise.race([
      once(driver, 'close').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
  }
}

try {
  await new Promise(resolve => setTimeout(resolve, 150));
  if (driverSpawnError) throw driverSpawnError;
  if (driver.exitCode != null) {
    throw new Error(`tauri-driver exited before Ferrum connected with code ${driver.exitCode}`);
  }

  const spec = {
    version: 1,
    name: 'tauri-webdriver-real-app',
    target: {
      type: 'webdriver',
      server,
      capabilities: {
        browserName: 'wry',
        'tauri:options': { application: appPath }
      },
      identity: {
        fixture: 'tauri-apps/webdriver-example',
        fixtureCommit,
        applicationSha256,
        tauriDriverVersion: driverVersion,
        nativeDriverVersion,
        capabilityModel: 'tauri-driver-direct-wry'
      }
    },
    timeouts: { startupMs, stepMs },
    steps: [
      { action: 'assert-text', using: 'css selector', value: 'body h1', text: 'Welcome to Tauri + Solid!' },
      { action: 'find', using: 'css selector', value: '#greet-input', as: 'greet-input' },
      { action: 'fill', element: 'greet-input', text: 'Ferrum' },
      { action: 'find', using: 'css selector', value: 'button[type="submit"]', as: 'greet-button' },
      { action: 'click', element: 'greet-button' },
      { action: 'assert-text', using: 'css selector', value: 'form + p', text: "Hello, Ferrum! You've been greeted from Rust!" },
      { action: 'screenshot', name: 'tauri-real-app' },
      { action: 'source', name: 'tauri-real-app' },
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
    tauriDriverVersion: driverVersion,
    nativeDriverVersion,
    capabilityModel: 'tauri-driver-direct-wry',
    server
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
} finally {
  await stopDriver();
  await driverLog.close().catch(() => {});
}
