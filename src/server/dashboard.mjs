import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec } from '../core/spec.mjs';
import { runSpec } from '../core/runner.mjs';
import { collectDoctor } from '../core/doctor.mjs';
import { evidenceFilePath, listEvidence, readEvidence, resolveEvidenceRoot } from '../core/evidence-store.mjs';
import { ensureDir } from '../core/paths.mjs';
import { getPlaywright } from '../browser/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UI = path.join(ROOT, 'ui');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.zip')) return 'application/zip';
  if (file.endsWith('.xml')) return 'application/xml';
  if (file.endsWith('.txt') || file.endsWith('.log')) return 'text/plain';
  return 'application/octet-stream';
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

export async function startDashboard({ port = 8788, host = '127.0.0.1', open = true, artifactsRoot = 'artifacts' } = {}) {
  const runs = new Map();
  const resolvedArtifactsRoot = resolveEvidenceRoot(artifactsRoot);
  await ensureDir(resolvedArtifactsRoot);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/doctor' && req.method === 'GET') return json(res, 200, await collectDoctor());
      if (url.pathname === '/api/runs' && req.method === 'GET') return json(res, 200, [...runs.values()].map(run => ({ ...run, task: undefined })));
      if (url.pathname === '/api/evidence' && req.method === 'GET') return json(res, 200, await listEvidence({ root: resolvedArtifactsRoot }));
      if (url.pathname === '/api/runs' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.specPath || typeof body.specPath !== 'string') return json(res, 400, { error: 'specPath is required' });
        const specPath = path.isAbsolute(body.specPath) ? body.specPath : path.resolve(ROOT, body.specPath);
        const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const record = { id, specPath, status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
        runs.set(id, record);
        record.task = loadSpec(specPath).then(spec => runSpec(spec, { headless: Boolean(body.headless), artifactsRoot: resolvedArtifactsRoot })).then(result => {
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
      const evidenceMatch = /^\/api\/evidence\/([^/]+)$/.exec(url.pathname);
      if (evidenceMatch && req.method === 'GET') {
        try { return json(res, 200, await readEvidence(decodeURIComponent(evidenceMatch[1]), { root: resolvedArtifactsRoot })); }
        catch (error) { if (error?.code === 'ENOENT') return json(res, 404, { error: 'evidence not found' }); throw error; }
      }
      const evidenceFileMatch = /^\/api\/evidence\/([^/]+)\/file$/.exec(url.pathname);
      if (evidenceFileMatch && req.method === 'GET') {
        const file = evidenceFilePath(decodeURIComponent(evidenceFileMatch[1]), url.searchParams.get('path'), { root: resolvedArtifactsRoot });
        let content;
        try { content = await fs.readFile(file); }
        catch (error) { if (error?.code === 'ENOENT') return json(res, 404, { error: 'evidence file not found' }); throw error; }
        res.writeHead(200, { 'content-type': contentType(file), 'content-length': content.length, 'cache-control': 'no-store' });
        return res.end(content);
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const file = path.resolve(UI, relative);
      if (file !== UI && !file.startsWith(UI + path.sep)) return json(res, 403, { error: 'forbidden' });
      let content;
      try { content = await fs.readFile(file); }
      catch (error) { if (error?.code === 'ENOENT') return json(res, 404, { error: 'not found' }); throw error; }
      res.writeHead(200, { 'content-type': `${contentType(file)}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(content);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  const workbench = open ? await openFerrumWorkbench(url) : { mode: 'disabled', context: null };
  if (workbench.context) server.once('close', () => workbench.context.close().catch(() => {}));
  return { server, url, artifactsRoot: resolvedArtifactsRoot, workbench: { mode: workbench.mode, error: workbench.error || null } };
}
