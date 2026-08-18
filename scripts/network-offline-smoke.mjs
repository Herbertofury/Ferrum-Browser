import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts', 'network-offline');

function runFerrum(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'bin', 'ferrum.mjs'), ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

async function evidenceDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/api')) {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end('ok');
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(`<!doctype html>
<meta charset="utf-8">
<title>Ferrum network offline smoke</title>
<button id="probe">Probe</button>
<div id="out">idle</div>
<script>
  probe.addEventListener('click', async () => {
    out.textContent = 'probing';
    try {
      const response = await fetch('/api?nonce=' + Date.now(), { cache: 'no-store' });
      out.textContent = response.ok ? 'online:ok' : 'online:http-' + response.status;
    } catch (error) {
      out.textContent = 'offline';
    }
  });
</script>`);
});

let tempRoot;
try {
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-network-offline-'));
  const specPath = path.join(tempRoot, 'network-offline.json');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const before = new Set(await evidenceDirectories(artifactsRoot));

  await fs.writeFile(specPath, JSON.stringify({
    version: 1,
    name: 'ferrum-network-offline-smoke',
    target: { type: 'web', engine: 'chromium', headless: true },
    timeouts: { stepMs: 5000 },
    steps: [
      { action: 'open', url: origin },
      { action: 'click', selector: '#probe' },
      { action: 'assert-text', selector: '#out', text: 'online:ok' },
      { action: 'network-offline', enabled: true },
      { action: 'click', selector: '#probe' },
      { action: 'assert-text', selector: '#out', text: 'offline' },
      { action: 'network-offline', enabled: false },
      { action: 'click', selector: '#probe' },
      { action: 'assert-text', selector: '#out', text: 'online:ok' }
    ]
  }, null, 2) + '\n', 'utf8');

  const run = await runFerrum(['test', specPath, '--headless', '--compact', '--artifacts', artifactsRoot]);
  assert.equal(run.code, 0, `Ferrum network smoke exited ${run.code ?? run.signal}: ${run.stderr || run.stdout}`);

  const created = (await evidenceDirectories(artifactsRoot)).filter(name => !before.has(name));
  assert.equal(created.length, 1, `Expected one new Ferrum evidence directory, found ${created.length}: ${created.join(', ')}`);
  const evidenceDir = path.join(artifactsRoot, created[0]);
  const result = JSON.parse(await fs.readFile(path.join(evidenceDir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed');

  const networkStates = result.events.filter(event => event.type === 'network-state').map(event => event.offline);
  assert.deepEqual(networkStates, [true, false]);
  assert.ok(result.events.some(event => event.type === 'requestfailed'), 'Offline probe did not produce real browser request-failure evidence');

  const actions = result.result.outputs.map(output => output.action);
  assert.equal(actions.filter(action => action === 'network-offline').length, 2);
  assert.equal(result.result.outputs.at(-1).action, 'assert-text');
  assert.equal(result.result.outputs.at(-1).ok, true);

  console.log(JSON.stringify({
    status: 'passed',
    evidenceDir,
    networkStates,
    requestFailures: result.events.filter(event => event.type === 'requestfailed').length
  }));
} finally {
  await close(server).catch(() => {});
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
