import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPlaywright } from './playwright.mjs';
import { attachPageDiagnostics } from './diagnostics.mjs';
import { ensureDir } from '../core/paths.mjs';

export async function launchChromiumSession({ profileDir, headless = false, executablePath, extensionPath, viewport, evidence, browserArgs = [] }) {
  const { chromium } = await getPlaywright();
  const resolvedProfile = profileDir || await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-profile-'));
  await ensureDir(resolvedProfile);
  const args = [...browserArgs];
  if (extensionPath) {
    args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
  }
  const context = await chromium.launchPersistentContext(resolvedProfile, {
    headless,
    channel: !executablePath && headless ? 'chromium' : undefined,
    executablePath: executablePath || undefined,
    viewport: viewport || { width: 1440, height: 1000 },
    args,
    acceptDownloads: true
  });
  const detach = new Map();
  const register = page => {
    if (!detach.has(page)) detach.set(page, attachPageDiagnostics(page, evidence, `page:${page.url() || 'blank'}`));
  };
  context.pages().forEach(register);
  context.on('page', register);
  context.on('serviceworker', worker => evidence.record('service-worker', { url: worker.url() }));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  return {
    engine: 'chromium',
    context,
    profileDir: resolvedProfile,
    async newPage() {
      const page = await context.newPage();
      register(page);
      return page;
    },
    async close(tracePath) {
      try {
        if (tracePath) await context.tracing.stop({ path: tracePath });
        else await context.tracing.stop();
      } catch {}
      for (const fn of detach.values()) fn();
      await context.close();
    }
  };
}
