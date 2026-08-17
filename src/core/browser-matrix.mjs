import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSpec } from './spec.mjs';
import { runSpec } from './runner.mjs';

const KNOWN = new Set(['chromium', 'chrome', 'edge', 'brave', 'opera-gx']);

export function normalizeBrowserList(value) {
  const values = Array.isArray(value) ? value : String(value || 'chromium,chrome,edge,brave,opera-gx').split(',');
  const names = [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  for (const name of names) if (!KNOWN.has(name)) throw new Error(`Unknown browser matrix target: ${name}`);
  return names;
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
      const spec = await loadSpec(specPath);
      if (!['web', 'extension'].includes(spec.target.type)) {
        results[item.index] = { browser: browser.name, status: 'skipped', reason: `target-${spec.target.type}-does-not-use-browser-matrix`, discovery: browser };
        continue;
      }
      if (spec.target.type === 'extension' && browser.name !== 'chromium') {
        results[item.index] = { browser: browser.name, status: 'skipped', reason: 'extension-sideload-correctness-is-chromium-only', discovery: browser };
        continue;
      }
      const started = performance.now();
      try {
        const result = await runSpec(spec, {
          ...options,
          spaceMode: options.space ? (options.spaceMode || 'clone') : options.spaceMode,
          engine: 'chromium',
          browser: browser.name,
          browserChannel: browser.channel,
          browserExecutable: browser.channel ? undefined : browser.executablePath
        });
        results[item.index] = {
          browser: browser.name,
          status: 'passed',
          durationMs: performance.now() - started,
          evidenceId: result.id,
          evidenceDir: result.evidenceDir,
          discovery: browser
        };
      } catch (error) {
        results[item.index] = {
          browser: browser.name,
          status: 'failed',
          durationMs: performance.now() - started,
          error: error.message,
          evidenceDir: error.evidenceDir || null,
          discovery: browser
        };
      }
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
