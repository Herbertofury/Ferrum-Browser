import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPlaywright } from '../browser/playwright.mjs';
import { attachPageDiagnostics } from '../browser/diagnostics.mjs';
import { StepEngine } from './step-engine.mjs';

const execFileAsync = promisify(execFile);

function attachProcessStream(stream, evidence, type) {
  if (!stream?.on) return () => {};
  const onData = chunk => evidence.record(type, { text: String(chunk) });
  stream.on('data', onData);
  return () => stream.off?.('data', onData);
}

export async function withElectronOperationTimeout(promise, timeoutMs, label) {
  const resolved = Number(timeoutMs);
  const bounded = Number.isFinite(resolved) && resolved > 0 ? resolved : 10000;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${bounded}ms`)), bounded);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceKillElectron(processHandle, evidence) {
  if (!processHandle?.pid) return;
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } else {
      processHandle.kill?.('SIGKILL');
    }
    evidence.record('electron-force-close', { pid: processHandle.pid });
  } catch (error) {
    evidence.record('electron-shutdown-warning', { phase: 'force-close', pid: processHandle.pid, message: error.message });
  }
}

export async function runElectronTarget(spec, evidence) {
  const { _electron: electron } = await getPlaywright();
  const args = spec.target.args || [];
  const executablePath = spec.target.executable || undefined;
  const app = await electron.launch({
    args,
    cwd: spec.target.cwd || undefined,
    executablePath,
    env: { ...process.env, ...(spec.target.env || {}) },
    artifactsDir: evidence.dir
  });
  const processHandle = app.process();
  const detachStdout = attachProcessStream(processHandle.stdout, evidence, 'electron-process-stdout');
  const detachStderr = attachProcessStream(processHandle.stderr, evidence, 'electron-process-stderr');
  const onMainConsole = message => evidence.record('electron-main-console', {
    level: message.type(),
    text: message.text(),
    location: message.location()
  });
  app.on('console', onMainConsole);

  const identity = await app.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));
  evidence.record('electron-start', { executablePath: executablePath || null, args, pid: processHandle.pid, ...identity });
  await evidence.writeJson('electron-runtime.json', identity);

  const windows = [];
  const pageDetachers = [];
  const register = page => {
    if (windows.includes(page)) return;
    windows.push(page);
    pageDetachers.push(attachPageDiagnostics(page, evidence, `electron:${windows.length}`));
    evidence.record('electron-window', { index: windows.length - 1, url: page.url() });
  };
  app.windows().forEach(register);
  app.on('window', register);
  const page = await app.firstWindow({ timeout: spec.timeouts?.startupMs || 30000 });
  register(page);

  try {
    const engine = new StepEngine({
      evidence,
      session: { engine: 'electron', context: page.context() },
      page,
      timeoutMs: spec.timeouts?.stepMs || 30000
    });
    const result = await engine.run(spec.steps);
    return { engine: 'electron', runtime: identity, windows: windows.length, ...result };
  } finally {
    app.off?.('console', onMainConsole);
    detachStdout();
    detachStderr();
    for (const detach of pageDetachers) detach();
    const shutdownMs = spec.timeouts?.shutdownMs || 10000;
    try {
      await withElectronOperationTimeout(app.close(), shutdownMs, 'Electron app close');
    } catch (error) {
      evidence.record('electron-shutdown-warning', { phase: 'app-close', pid: processHandle.pid, message: error.message });
      await forceKillElectron(processHandle, evidence);
    }
  }
}
