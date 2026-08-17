import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSpec } from './spec.mjs';

const execFileAsync = promisify(execFile);
const KNOWN = new Set(['chromium', 'chrome', 'edge', 'brave', 'opera-gx']);
const WORKER_SCRIPT = fileURLToPath(new URL('../../scripts/browser-matrix-worker.mjs', import.meta.url));

export function normalizeBrowserList(value) {
  const values = Array.isArray(value) ? value : String(value || 'chromium,chrome,edge,brave,opera-gx').split(',');
  const names = [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  for (const name of names) if (!KNOWN.has(name)) throw new Error(`Unknown browser matrix target: ${name}`);
  return names;
}

export function normalizeBrowserWorkerTimeout(value, fallback = 90000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function joiner(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function compact(values) {
  return values.filter(Boolean);
}

export function browserCandidates(platform = process.platform, env = process.env) {
  const p = joiner(platform);
  if (platform === 'win32') {
    const pf = env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    return {
      chrome: compact([env.FERRUM_CHROME, p.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), p.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), local && p.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
      edge: compact([env.FERRUM_EDGE, p.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), p.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), local && p.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
      brave: compact([env.FERRUM_BRAVE, p.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), p.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), local && p.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]),
      'opera-gx': compact([env.FERRUM_OPERA_GX, p.join(pf, 'Opera GX', 'opera.exe'), p.join(pf, 'Opera GX', 'launcher.exe'), p.join(pf86, 'Opera GX', 'opera.exe'), p.join(pf86, 'Opera GX', 'launcher.exe'), local && p.join(local, 'Programs', 'Opera GX', 'opera.exe'), local && p.join(local, 'Programs', 'Opera GX', 'launcher.exe')])
    };
  }
  if (platform === 'darwin') {
    return {
      chrome: compact([env.FERRUM_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
      edge: compact([env.FERRUM_EDGE, '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']),
      brave: compact([env.FERRUM_BRAVE, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']),
      'opera-gx': compact([env.FERRUM_OPERA_GX, '/Applications/Opera GX.app/Contents/MacOS/Opera GX'])
    };
  }
  return {
    chrome: compact([env.FERRUM_CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']),
    edge: compact([env.FERRUM_EDGE, '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']),
    brave: compact([env.FERRUM_BRAVE, '/usr/bin/brave-browser', '/usr/bin/brave-browser-stable']),
    'opera-gx': compact([env.FERRUM_OPERA_GX, '/usr/bin/opera-gx'])
  };
}

async function firstExisting(candidates, access) {
  for (const candidate of candidates || []) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

export async function discoverBrowsers(value, { platform = process.platform, env = process.env, access = fs.access } = {}) {
  const names = normalizeBrowserList(value);
  const candidates = browserCandidates(platform, env);
  const results = [];
  for (const name of names) {
    if (name === 'chromium') {
      results.push({ name, available: true, channel: 'chromium', executablePath: null, source: 'playwright' });
      continue;
    }
    const executablePath = await firstExisting(candidates[name], access);
    results.push({
      name,
      available: Boolean(executablePath),
      channel: name === 'chrome' ? 'chrome' : name === 'edge' ? 'msedge' : null,
      executablePath,
      source: executablePath ? (env[`FERRUM_${name.toUpperCase().replaceAll('-', '_')}`] === executablePath ? 'environment' : 'system') : null
    });
  }
  return results;
}

function serializableRunOptions(options, profileDir) {
  return {
    headless: options.headless,
    artifactsRoot: options.artifactsRoot,
    variables: options.variables || {},
    spacesRoot: options.spacesRoot,
    space: options.space,
    spaceMode: options.spaceMode,
    keepSpaceClone: options.keepSpaceClone,
    browserLaunchTimeoutMs: options.browserLaunchTimeoutMs,
    profileDir
  };
}

async function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function workerRequest(specPath, browser, options, profileDir) {
  return {
    specPath,
    browser,
    options: serializableRunOptions(options, profileDir)
  };
}

async function runBrowserWorker(specPath, browser, options) {
  const timeoutMs = normalizeBrowserWorkerTimeout(options.browserRunTimeoutMs);
  const profileDir = options.space ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), `ferrum-matrix-${browser.name}-`));
  const request = workerRequest(specPath, browser, options, profileDir);
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
  const child = spawn(process.execPath, [WORKER_SCRIPT, encoded], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let timer;

  const result = await new Promise(resolve => {
    const finish = async value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await terminateProcessTree(child);
      resolve(value);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === 'ferrum-browser-worker-result') void finish(parsed.result);
        } catch {}
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => void finish({ status: 'failed', error: `Browser worker failed to start: ${error.message}`, evidenceDir: null }));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const tail = stdout.trim();
      if (tail) {
        try {
          const parsed = JSON.parse(tail);
          if (parsed?.type === 'ferrum-browser-worker-result') return void finish(parsed.result);
        } catch {}
      }
      void finish({
        status: 'failed',
        error: `Browser worker exited before reporting a result (code=${code}, signal=${signal || 'none'}${stderr.trim() ? `): ${stderr.trim().slice(-2000)}` : ')'}`,
        evidenceDir: null
      });
    });
    timer = setTimeout(() => void finish({
      status: 'failed',
      error: `Browser worker timed out after ${timeoutMs}ms`,
      evidenceDir: null
    }), timeoutMs);
  });

  if (profileDir) await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  return result;
}

export async function runBrowserMatrix(specPath, options = {}) {
  const definitions = await discoverBrowsers(options.browsers, options.discovery || {});
  const workers = Math.max(1, Math.min(Number(options.workers || 1), definitions.length || 1));
  const requireAll = Boolean(options.requireAll);
  const queue = definitions.map((browser, index) => ({ browser, index }));
  const results = new Array(queue.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const slot = cursor++;
      if (slot >= queue.length) return;
      const item = queue[slot];
      const browser = item.browser;
      if (!browser.available) {
        results[item.index] = { browser: browser.name, status: 'skipped', reason: 'browser-not-installed', discovery: browser };
        continue;
      }
      const spec = await loadSpec(specPath, { variables: options.variables || {} });
      if (!['web', 'extension'].includes(spec.target.type)) {
        results[item.index] = { browser: browser.name, status: 'skipped', reason: `target-${spec.target.type}-does-not-use-browser-matrix`, discovery: browser };
        continue;
      }
      if (spec.target.type === 'extension' && browser.name !== 'chromium') {
        results[item.index] = { browser: browser.name, status: 'skipped', reason: 'extension-sideload-correctness-is-chromium-only', discovery: browser };
        continue;
      }
      const started = performance.now();
      const childResult = await runBrowserWorker(specPath, browser, {
        ...options,
        spaceMode: options.space ? (options.spaceMode || 'clone') : options.spaceMode
      });
      results[item.index] = {
        browser: browser.name,
        status: childResult.status,
        durationMs: performance.now() - started,
        evidenceId: childResult.evidenceId || null,
        evidenceDir: childResult.evidenceDir || null,
        error: childResult.error || null,
        discovery: browser
      };
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  const passed = results.filter(item => item.status === 'passed').length;
  const failed = results.filter(item => item.status === 'failed').length;
  const skipped = results.filter(item => item.status === 'skipped').length;
  return {
    status: failed || (requireAll && skipped) ? 'failed' : 'passed',
    specPath,
    workers,
    requireAll,
    total: results.length,
    passed,
    failed,
    skipped,
    results
  };
}
