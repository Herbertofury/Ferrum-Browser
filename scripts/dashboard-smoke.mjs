import fs from 'node:fs/promises';
import path from 'node:path';
import { startDashboard } from '../src/server/dashboard.mjs';
import { getPlaywright } from '../src/browser/playwright.mjs';
import { ensureDir } from '../src/core/paths.mjs';

const errors = [];
let browser;
let server;

try {
  const started = await startDashboard({ port: 0, open: false });
  server = started.server;
  const { chromium } = await getPlaywright();
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  page.on('console', message => {
    if (['error', 'assert'].includes(message.type())) errors.push(`console:${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', request => errors.push(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText || ''}`));

  const response = await page.goto(started.url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`Workbench HTTP load failed: ${response?.status()}`);
  if ((await page.title()) !== 'Ferrum Test Workbench') throw new Error(`Unexpected workbench title: ${await page.title()}`);

  await page.locator('#doctor').click();
  await page.locator('#doctorOut').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#doctorOut')?.textContent?.includes('"ferrum": "0.2.0"'));

  const spec = page.locator('#spec');
  await spec.fill('examples/process-app.json');
  await page.locator('#headless').check();
  await page.locator('#run').click();
  await page.locator('#runs .passed').waitFor({ state: 'visible', timeout: 15000 });

  const passedText = await page.locator('#runs .passed').first().innerText();
  if (!passedText.includes('PASSED')) throw new Error(`Workbench run did not visibly report PASSED: ${passedText}`);
  if (!passedText.includes('process-app.json')) throw new Error(`Workbench run did not show selected spec: ${passedText}`);
  if (errors.length) throw new Error(`Workbench browser diagnostics contain ${errors.length} error(s): ${errors.join(' | ')}`);

  const outDir = path.resolve('artifacts', 'workbench');
  await ensureDir(outDir);
  const screenshot = path.join(outDir, `workbench-${process.platform}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const stat = await fs.stat(screenshot);
  if (!stat.isFile() || stat.size < 1000) throw new Error(`Workbench screenshot is missing or unexpectedly small: ${stat.size}`);

  console.log(JSON.stringify({
    status: 'passed',
    url: started.url,
    title: await page.title(),
    doctor: 'passed',
    selectedSpec: await spec.inputValue(),
    headlessChecked: await page.locator('#headless').isChecked(),
    visibleRunResult: passedText,
    browserErrors: errors,
    screenshot,
    screenshotBytes: stat.size
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
}
