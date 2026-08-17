import fs from 'node:fs/promises';
import path from 'node:path';
import { startDashboard } from '../src/server/dashboard.mjs';
import { getPlaywright } from '../src/browser/playwright.mjs';
import { ensureDir } from '../src/core/paths.mjs';

const errors = [];
let browser;
let server;
let restartedServer;
const artifactsRoot = path.resolve('artifacts', 'workbench-replay');

try {
  await fs.rm(artifactsRoot, { recursive: true, force: true });
  const started = await startDashboard({ port: 0, open: false, artifactsRoot });
  server = started.server;
  const { chromium } = await getPlaywright();
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  page.on('console', message => { if (['error', 'assert'].includes(message.type())) errors.push(`console:${message.type()}: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => errors.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));

  const response = await page.goto(started.url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`Workbench HTTP load failed: ${response?.status()}`);
  if ((await page.title()) !== 'Ferrum Test Workbench') throw new Error(`Unexpected workbench title: ${await page.title()}`);

  await page.locator('#doctor').click();
  await page.waitForFunction(() => document.querySelector('#doctorOut')?.textContent?.includes('"ferrum": "0.2.0"'));

  const spec = page.locator('#spec');
  await spec.fill('examples/self-test-web.json');
  await page.locator('#headless').check();
  await page.locator('#run').click();
  await page.locator('#runs .passed').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#evidence .evidence-run').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#evidence .evidence-run').first().click();
  await page.locator('#replay .event').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#replay .screenshots img').first().waitFor({ state: 'visible', timeout: 10000 });
  const replayText = await page.locator('#replay').innerText();
  if (!replayText.includes('locator-fallback')) throw new Error('Replay did not expose semantic fallback evidence');

  const outDir = path.resolve('artifacts', 'workbench');
  await ensureDir(outDir);
  const screenshot = path.join(outDir, `workbench-${process.platform}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const stat = await fs.stat(screenshot);
  if (!stat.isFile() || stat.size < 1000) throw new Error(`Workbench screenshot is missing or unexpectedly small: ${stat.size}`);

  await new Promise(resolve => server.close(resolve));
  server = null;
  const restarted = await startDashboard({ port: 0, open: false, artifactsRoot });
  restartedServer = restarted.server;
  await page.goto(restarted.url, { waitUntil: 'domcontentloaded' });
  await page.locator('#evidence .evidence-run').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#evidence .evidence-run').first().click();
  await page.locator('#replay .event').first().waitFor({ state: 'visible', timeout: 10000 });
  const persistedReplay = await page.locator('#replay').innerText();
  if (!persistedReplay.includes('locator-fallback')) throw new Error('Evidence replay did not persist across Workbench restart');
  if (errors.length) throw new Error(`Workbench browser diagnostics contain ${errors.length} error(s): ${errors.join(' | ')}`);

  console.log(JSON.stringify({
    status: 'passed',
    initialUrl: started.url,
    restartedUrl: restarted.url,
    title: await page.title(),
    doctor: 'passed',
    selectedSpec: await spec.inputValue().catch(() => 'examples/self-test-web.json'),
    replay: 'passed',
    replayRestartPersistence: 'passed',
    browserErrors: errors,
    screenshot,
    screenshotBytes: stat.size
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (restartedServer) await new Promise(resolve => restartedServer.close(resolve));
}
