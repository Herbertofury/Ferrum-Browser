import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPlaywright } from './playwright.mjs';
import { attachPageDiagnostics, attachServiceWorkerDiagnostics } from './diagnostics.mjs';
import { ensureDir } from '../core/paths.mjs';

export async function launchChromiumSession({ profileDir, headless = false, executablePath, channel, browserName, extensionPath, viewport, evidence, browserArgs = [], diagnoseInitialPages = true }) {
  const { chromium } = await getPlaywright();
  const resolvedProfile = profileDir || await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-profile-'));
  await ensureDir(resolvedProfile);
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
    diagnoseInitialPages: Boolean(diagnoseInitialPages)
  });
  const context = await chromium.launchPersistentContext(resolvedProfile, {
    headless,
    channel: launchChannel,
    executablePath: executablePath || undefined,
    viewport: viewport || { width: 1440, height: 1000 },
    args,
    acceptDownloads: true
  });
  const detach = new Map();
  const register = page => {
    if (!detach.has(page)) detach.set(page, attachPageDiagnostics(page, evidence, `page:${page.url() || 'blank'}`));
  };
  if (diagnoseInitialPages) context.pages().forEach(register);
  context.on('page', register);
  const serviceWorkerDiagnostics = attachServiceWorkerDiagnostics(context, evidence);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
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
      const pages = context.pages().filter(page => page !== except && !detach.has(page));
      for (const page of pages) {
        evidence.record('browser-startup-page', { browser: resolvedBrowserName, url: page.url() });
        await page.close().catch(() => {});
      }
      return pages.length;
    },
    async close(tracePath) {
      try {
        if (tracePath) await context.tracing.stop({ path: tracePath });
        else await context.tracing.stop();
      } catch {}
      serviceWorkerDiagnostics.detach();
      for (const fn of detach.values()) fn();
      await context.close();
    }
  };
}
