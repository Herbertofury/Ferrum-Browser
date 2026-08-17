import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPlaywright } from './playwright.mjs';
import { attachPageDiagnostics, attachServiceWorkerDiagnostics } from './diagnostics.mjs';
import { ensureDir } from '../core/paths.mjs';

export function normalizeBrowserLaunchTimeout(value, fallback = 30000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function withBrowserOperationTimeout(promise, timeoutMs, label) {
  const resolvedTimeout = normalizeBrowserLaunchTimeout(timeoutMs, 10000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${resolvedTimeout}ms`)), resolvedTimeout);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function launchChromiumSession({ profileDir, headless = false, executablePath, channel, browserName, extensionPath, viewport, evidence, browserArgs = [], diagnoseInitialPages = true, launchTimeoutMs = 30000, teardownTimeoutMs = 10000 }) {
  const { chromium } = await getPlaywright();
  const resolvedProfile = profileDir || await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-profile-'));
  await ensureDir(resolvedProfile);
  const launchTimeout = normalizeBrowserLaunchTimeout(launchTimeoutMs);
  const teardownTimeout = normalizeBrowserLaunchTimeout(teardownTimeoutMs, 10000);
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    ...browserArgs
  ];
  if (extensionPath) {
    args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
  }
  const launchChannel = channel || (!executablePath && headless ? 'chromium' : undefined);
  const resolvedBrowserName = browserName || launchChannel || (executablePath ? path.basename(executablePath) : 'chromium');
  evidence.record('browser-launch', {
    browser: resolvedBrowserName,
    channel: launchChannel || null,
    executablePath: executablePath || null,
    profileDir: resolvedProfile,
    headless: Boolean(headless),
    extension: Boolean(extensionPath),
    diagnoseInitialPages: Boolean(diagnoseInitialPages),
    launchTimeoutMs: launchTimeout,
    teardownTimeoutMs: teardownTimeout
  });
  const context = await chromium.launchPersistentContext(resolvedProfile, {
    headless,
    channel: launchChannel,
    executablePath: executablePath || undefined,
    viewport: viewport || { width: 1440, height: 1000 },
    args,
    acceptDownloads: true,
    timeout: launchTimeout
  });
  const detach = new Map();
  const register = page => {
    if (!detach.has(page)) detach.set(page, attachPageDiagnostics(page, evidence, `page:${page.url() || 'blank'}`));
  };
  if (diagnoseInitialPages) context.pages().forEach(register);
  context.on('page', register);
  const serviceWorkerDiagnostics = attachServiceWorkerDiagnostics(context, evidence);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  async function stopTracing(tracePath) {
    try {
      const operation = tracePath ? context.tracing.stop({ path: tracePath }) : context.tracing.stop();
      await withBrowserOperationTimeout(operation, teardownTimeout, 'Browser trace stop');
      return true;
    } catch (error) {
      evidence.record('browser-teardown-warning', { browser: resolvedBrowserName, phase: 'trace-stop', message: error.message });
      return false;
    }
  }

  async function closeContext() {
    try {
      await withBrowserOperationTimeout(context.close(), teardownTimeout, 'Browser context close');
      return true;
    } catch (error) {
      evidence.record('browser-teardown-warning', { browser: resolvedBrowserName, phase: 'context-close', message: error.message });
      const browser = context.browser?.();
      if (browser?.isConnected?.()) {
        try {
          await withBrowserOperationTimeout(browser.close({ reason: 'Ferrum browser context teardown timeout' }), teardownTimeout, 'Browser force close');
          evidence.record('browser-force-close', { browser: resolvedBrowserName, reason: 'context-close-timeout' });
          return true;
        } catch (forceError) {
          evidence.record('browser-teardown-warning', { browser: resolvedBrowserName, phase: 'browser-force-close', message: forceError.message });
        }
      }
      return false;
    }
  }

  return {
    engine: 'chromium',
    browserName: resolvedBrowserName,
    channel: launchChannel || null,
    context,
    profileDir: resolvedProfile,
    serviceWorkerDiagnostics,
    async newPage() {
      const page = await context.newPage();
      register(page);
      return page;
    },
    async closeInitialPages({ except } = {}) {
      const pages = context.pages().filter(page => page !== except);
      for (const page of pages) {
        evidence.record('browser-startup-page', { browser: resolvedBrowserName, url: page.url() });
        detach.get(page)?.();
        detach.delete(page);
        try {
          await withBrowserOperationTimeout(page.close(), teardownTimeout, 'Browser startup page close');
        } catch (error) {
          evidence.record('browser-teardown-warning', { browser: resolvedBrowserName, phase: 'startup-page-close', message: error.message });
        }
      }
      return pages.length;
    },
    async close(tracePath) {
      await stopTracing(tracePath);
      serviceWorkerDiagnostics.detach();
      for (const fn of detach.values()) fn();
      detach.clear();
      await closeContext();
    }
  };
}
