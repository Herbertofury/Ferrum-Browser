import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EvidenceWriter } from './evidence.mjs';
import { FERRUM_VERSION } from '../version.mjs';
import { prepareRunSpace } from './spaces.mjs';
import { specForEvidence } from './redact.mjs';
import { runWebTarget } from '../runners/web.mjs';
import { runExtensionTarget } from '../runners/extension.mjs';
import { runProcessTarget } from '../runners/process.mjs';
import { runElectronTarget } from '../runners/electron.mjs';
import { runAppiumTarget } from '../runners/appium.mjs';
import { runWebDriverTarget } from '../runners/webdriver.mjs';

const execFileAsync = promisify(execFile);
const ELECTRON_WORKER = fileURLToPath(new URL('../../scripts/electron-run-worker.mjs', import.meta.url));

const RUNNERS = {
  web: runWebTarget,
  extension: runExtensionTarget,
  process: runProcessTarget,
  electron: runElectronTarget,
  appium: runAppiumTarget,
  webdriver: runWebDriverTarget
};

export function normalizeElectronRunTimeout(value, fallback = 120000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function terminateWorkerTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function serializableOptions(options) {
  return JSON.parse(JSON.stringify(options, (_key, value) => typeof value === 'function' ? undefined : value));
}

async function runElectronSpecIsolated(spec, options) {
  const timeoutMs = normalizeElectronRunTimeout(options.electronRunTimeoutMs ?? spec.timeouts?.runMs);
  const child = spawn(process.execPath, [ELECTRON_WORKER], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  child.stdin.end(JSON.stringify({ spec, options: serializableOptions(options) }));

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;

  return await new Promise(resolve => {
    const finish = async payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateWorkerTree(child);
      resolve(payload);
    };

    const parseLine = line => {
      if (!line.trim()) return false;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === 'ferrum-electron-worker-result') {
          void finish(parsed);
          return true;
        }
      } catch {}
      return false;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) parseLine(line);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => void finish({ type: 'ferrum-electron-worker-result', ok: false, error: `Electron worker failed to start: ${error.message}` }));
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (parseLine(stdout.trim())) return;
      void finish({
        type: 'ferrum-electron-worker-result',
        ok: false,
        error: `Electron worker exited before reporting a result (code=${code}, signal=${signal || 'none'}${stderr.trim() ? `): ${stderr.trim().slice(-2000)}` : ')'}`
      });
    });
    timer = setTimeout(() => void finish({
      type: 'ferrum-electron-worker-result',
      ok: false,
      error: `Electron worker timed out after ${timeoutMs}ms`
    }), timeoutMs);
  }).then(payload => {
    if (payload.ok) return payload.result;
    const error = new Error(payload.error || 'Electron worker failed');
    if (payload.evidenceDir) error.evidenceDir = payload.evidenceDir;
    if (payload.stack) error.stack = payload.stack;
    throw error;
  });
}

export async function runSpec(spec, options = {}) {
  if (spec.target.type === 'electron' && !options.__directElectron) {
    return await runElectronSpecIsolated(spec, options);
  }

  const spaceName = options.space ?? spec.target.space ?? null;
  const spaceMode = options.spaceMode ?? spec.target.spaceMode ?? 'persistent';
  const evidence = await new EvidenceWriter({
    root: options.artifactsRoot || spec.artifacts?.root || 'artifacts',
    name: spec.name,
    redactValues: spec.__redactValues || [],
    metadata: {
      specFile: spec.__file || null,
      targetType: spec.target.type,
      ferrumVersion: FERRUM_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      browser: options.browser || spec.target.browser || null,
      space: spaceName ? { name: spaceName, mode: spaceMode } : null
    }
  }).init();
  await evidence.writeJson('spec.json', specForEvidence(spec));
  const runner = RUNNERS[spec.target.type];
  if (!runner) throw new Error(`No runner for target type ${spec.target.type}`);
  let preparedSpace = null;
  try {
    preparedSpace = await prepareRunSpace({
      name: spaceName,
      root: options.spacesRoot || spec.spaces?.root,
      mode: spaceMode,
      runId: evidence.id,
      keepClone: options.keepSpaceClone ?? spec.target.keepSpaceClone ?? false
    });
    const runOptions = preparedSpace ? { ...options, profileDir: preparedSpace.profileDir, spaceInfo: preparedSpace.info } : options;
    if (preparedSpace) evidence.record('space-prepared', { ...preparedSpace.info, profileDir: preparedSpace.profileDir });
    const result = await runner(spec, evidence, runOptions);
    if (preparedSpace) {
      await preparedSpace.cleanup();
      evidence.record('space-released', { name: preparedSpace.info.name, mode: preparedSpace.info.mode, keepClone: preparedSpace.info.keepClone || false });
    }
    return await evidence.finalize({ status: 'passed', result: { ...result, space: preparedSpace?.info || null } });
  } catch (error) {
    if (preparedSpace) {
      try {
        await preparedSpace.cleanup();
        evidence.record('space-released', { name: preparedSpace.info.name, mode: preparedSpace.info.mode, keepClone: preparedSpace.info.keepClone || false });
      } catch (cleanupError) {
        evidence.record('space-cleanup-error', { message: cleanupError.message });
      }
    }
    await evidence.writeText('failure.txt', `${error.stack || error}\n`);
    await evidence.finalize({ status: 'failed', failure: { message: error.message, stack: error.stack, step: error.ferrumStep || null } });
    error.evidenceDir = evidence.dir;
    throw error;
  }
}
