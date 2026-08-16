import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnLogged, terminate } from '../core/process-utils.mjs';
import { getPlaywright } from './playwright.mjs';
import { attachPageDiagnostics } from './diagnostics.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Lightpanda CDP did not become ready at ${url}: ${last?.message || 'timeout'}`);
}

export async function launchLightpandaSession({ executable = process.env.FERRUM_LIGHTPANDA || 'lightpanda', evidence }) {
  const port = await freePort();
  const logFile = path.join(os.tmpdir(), `ferrum-lightpanda-${port}.log`);
  const lines = [];
  const child = spawnLogged(executable, ['serve', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warn'], {}, line => {
    lines.push(`[${line.source}] ${line.text}`);
    evidence.record('lightpanda-log', line);
  });
  try {
    const version = await waitHttp(`http://127.0.0.1:${port}/json/version`);
    const { chromium } = await getPlaywright();
    const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl || `http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    const detach = attachPageDiagnostics(page, evidence, 'lightpanda');
    return {
      engine: 'lightpanda', browser, context, page,
      async newPage() { return page; },
      async close() {
        detach();
        try { await browser.close(); } catch {}
        await terminate(child);
        await fs.writeFile(logFile, lines.join('\n') + '\n', 'utf8').catch(() => {});
      }
    };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}
