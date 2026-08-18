import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts', 'service-fixture');
const serverSource = `
const http = require('node:http');
const port = Number(process.env.PORT || 8080);
let count = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    if (request.method === 'POST' && request.url === '/echo') {
      count += 1;
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch {}
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ count, received: parsed }));
      return;
    }
    if (request.method === 'GET' && request.url === '/state') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ count }));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('missing');
  });
});
server.listen(port, '0.0.0.0', () => console.log('READY ' + port));
`;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function evidenceDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

async function runFerrumSpec(tempRoot, name, spec) {
  const specPath = path.join(tempRoot, `${name}.json`);
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  const before = new Set(await evidenceDirectories(artifactsRoot));
  const started = performance.now();
  const runResult = await run(process.execPath, [
    path.join(repoRoot, 'bin', 'ferrum.mjs'),
    'test',
    specPath,
    '--compact',
    '--artifacts',
    artifactsRoot
  ]);
  const wallMs = performance.now() - started;
  assert.equal(runResult.code, 0, `${name} Ferrum run exited ${runResult.code ?? runResult.signal}: ${runResult.stderr || runResult.stdout}`);
  const created = (await evidenceDirectories(artifactsRoot)).filter(entry => !before.has(entry));
  assert.equal(created.length, 1, `${name} expected one evidence directory, found ${created.length}: ${created.join(', ')}`);
  const evidenceDir = path.join(artifactsRoot, created[0]);
  const result = JSON.parse(await fs.readFile(path.join(evidenceDir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', `${name} result did not pass`);
  const responses = result.events.filter(event => event.type === 'process-http-response');
  assert.equal(responses.length, 2, `${name} expected two HTTP response evidence events`);
  assert.ok(result.events.some(event => event.type === 'process-start'), `${name} missing process-start evidence`);
  for (const response of responses) {
    assert.ok(response.path, `${name} response evidence missing path`);
    const body = await fs.readFile(path.join(evidenceDir, response.path), 'utf8');
    assert.ok(body.length > 0, `${name} retained an empty response artifact`);
  }
  return {
    evidenceId: created[0],
    evidenceDir,
    durationMs: result.durationMs ?? result.result?.durationMs ?? null,
    wallMs,
    responseBytes: responses.map(response => response.responseBytes),
    statuses: responses.map(response => response.status)
  };
}

function serviceSpec(name, target, origin, source) {
  return {
    version: 1,
    name,
    target,
    timeouts: { startupMs: 15000, stepMs: 5000 },
    steps: [
      {
        action: 'http-request',
        method: 'POST',
        url: `${origin}/echo`,
        json: { source },
        status: 200,
        text: `\"source\":\"${source}\"`
      },
      {
        action: 'http-request',
        method: 'GET',
        url: `${origin}/state`,
        status: 200,
        text: '\"count\":1'
      }
    ]
  };
}

await fs.mkdir(artifactsRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-testcontainers-service-'));
let container = null;
let containerId = null;
let cleanupRemoved = false;
try {
  const localPort = await freePort();
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const local = await runFerrumSpec(tempRoot, 'local-process-service', serviceSpec(
    'ferrum-local-process-service-smoke',
    {
      type: 'process',
      command: process.execPath,
      args: ['-e', serverSource],
      env: { PORT: String(localPort) },
      healthUrl: `${localOrigin}/health`
    },
    localOrigin,
    'local'
  ));

  const provisionStarted = performance.now();
  container = await new GenericContainer('node:24-alpine')
    .withEnvironment({ PORT: '8080' })
    .withCommand(['node', '-e', serverSource])
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forLogMessage('READY 8080'))
    .withStartupTimeout(60000)
    .start();
  const provisionMs = performance.now() - provisionStarted;
  containerId = container.getId();
  const containerOrigin = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  const nodeVersionResult = await container.exec(['node', '--version']);
  assert.equal(nodeVersionResult.exitCode, 0, `container node --version failed: ${nodeVersionResult.output}`);
  const imageInspect = await run('docker', ['inspect', '--format={{.Image}}', containerId]);
  assert.equal(imageInspect.code, 0, `docker inspect failed: ${imageInspect.stderr || imageInspect.stdout}`);
  const imageId = imageInspect.stdout.trim();
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/i, `unexpected container image identity: ${imageId}`);

  const containerRun = await runFerrumSpec(tempRoot, 'testcontainers-service', serviceSpec(
    'ferrum-testcontainers-service-smoke',
    {
      type: 'process',
      command: 'docker',
      args: ['logs', '-f', containerId],
      healthUrl: `${containerOrigin}/health`
    },
    containerOrigin,
    'container'
  ));

  assert.deepEqual(local.statuses, [200, 200]);
  assert.deepEqual(containerRun.statuses, [200, 200]);

  await container.stop({ remove: true, timeout: 10000 });
  container = null;
  const afterStop = await run('docker', ['inspect', containerId]);
  cleanupRemoved = afterStop.code !== 0;
  assert.equal(cleanupRemoved, true, 'Testcontainers service container still exists after explicit stop/remove');

  const testcontainersPackage = JSON.parse(await fs.readFile(path.join(repoRoot, 'node_modules', 'testcontainers', 'package.json'), 'utf8'));
  const summary = {
    status: 'passed',
    testcontainersVersion: testcontainersPackage.version,
    image: 'node:24-alpine',
    imageId,
    containerId,
    containerNodeVersion: nodeVersionResult.stdout.trim(),
    containerProvisionMs: provisionMs,
    cleanupRemoved,
    local,
    container: containerRun,
    capability: {
      sameFerrumHttpAssertions: true,
      fullResponseEvidenceRetained: true,
      explicitContainerImageIdentity: true,
      explicitContainerCleanupProof: true
    }
  };
  const summaryPath = path.join(artifactsRoot, 'testcontainers-service-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary));
} finally {
  if (container) await container.stop({ remove: true, timeout: 10000 }).catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
