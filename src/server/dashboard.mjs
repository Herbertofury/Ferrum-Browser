import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec } from '../core/spec.mjs';
import { runSpec } from '../core/runner.mjs';
import { collectDoctor } from '../core/doctor.mjs';
import { ensureDir } from '../core/paths.mjs';
import { getPlaywright } from '../browser/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI = path.join(ROOT, 'ui');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

async function openSystemBrowser(url) {
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function openFerrumWorkbench(url) {
  try {
    const { chromium } = await getPlaywright();
    const profileDir = path.join(os.homedir(), '.ferrum', 'workbench-profile');
    await ensureDir(profileDir);
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: [`--app=${url}`, '--no-first-run', '--no-default-browser-check']
    });
    const page = context.pages()[0] || await context.newPage();
    if (page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { mode: 'ferrum-chromium-app', context };
  } catch (error) {
    await openSystemBrowser(url).catch(() => {});
    return { mode: 'system-browser-fallback', error: error.message, context: null };
  }
}

export async function startDashboard({ port = 8788, host = '127.0.0.1', open = true } = {}) {
  const runs = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/doctor' && req.method === 'GET') return json(res, 200, await collectDoctor());
      if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, 200, [...runs.values()].map(run => ({ ...run, task: undefined })));
      if (url.pathname === '/api/runs' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.specPath || typeof body.specPath !== 'string') return json(res, 400, { error: 'specPath is required' });
        const specPath = path.isAbsolute(body.specPath) ? body.specPath : path.resolve(ROOT, body.specPath);
        const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const record = { id, specPath, status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
        runs.set(id, record);
        record.task = loadSpec(specPath).then(spec => runSpec(spec, { headless: Boolean(body.headless) })).then(result => {
          record.status = 'passed'; record.result = result; record.endedAt = new Date().toISOString(); return result;
        }).catch(error => {
          record.status = 'failed'; record.error = error.message; record.evidenceDir = error.evidenceDir || null; record.endedAt = new Date().toISOString();
        });
        return json(res, 202, { id });
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (runMatch && req.method === 'GET') {
        const run = runs.get(runMatch[1]);
        return run ? json(res, 200, { ...run, task: undefined }) : json(res, 404, { error: 'run not found' });
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const file = path.resolve(UI, relative);
      if (!file.startsWith(UI)) return json(res, 403, { error: 'forbidden' });
      const content = await fs.readFile(file);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(content);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  const workbench = open ? await openFerrumWorkbench(url) : { mode: 'disabled', context: null };
  if (workbench.context) server.once('close', () => workbench.context.close().catch(() => {}));
  return { server, url, workbench: { mode: workbench.mode, error: workbench.error || null } };
}
