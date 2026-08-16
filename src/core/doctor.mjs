import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { FERRUM_VERSION } from '../version.mjs';

const execFileAsync = promisify(execFile);

async function commandVersion(command, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 });
    return { available: true, version: String(stdout || stderr).trim().split('\n')[0] };
  } catch (error) {
    return { available: false, error: error.code || error.message };
  }
}

export async function collectDoctor() {
  const playwright = await import('playwright').then(mod => ({ available: true, chromium: mod.chromium.executablePath() })).catch(error => ({ available: false, error: error.message }));
  if (playwright.available) playwright.chromiumInstalled = await fs.stat(playwright.chromium).then(stat => stat.isFile()).catch(() => false);
  return {
    at: new Date().toISOString(),
    ferrum: FERRUM_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cwd: process.cwd(),
    playwright,
    lightpanda: await commandVersion(process.env.FERRUM_LIGHTPANDA || 'lightpanda', ['version']),
    agentBrowser: await commandVersion('agent-browser', ['--version']),
    appium: await commandVersion('appium', ['--version']),
    git: await commandVersion('git', ['--version']),
    env: {
      FERRUM_LIGHTPANDA: process.env.FERRUM_LIGHTPANDA || null,
      FERRUM_ARTIFACTS: process.env.FERRUM_ARTIFACTS || null
    }
  };
}
