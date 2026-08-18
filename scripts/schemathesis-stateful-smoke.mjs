import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts', 'api-stateful');
const ferrumArtifactsRoot = path.join(artifactsRoot, 'ferrum');
const schemathesisImage = 'ghcr.io/schemathesis/schemathesis:4.24.2';
const serviceImage = 'node:24-alpine';
const seed = 424242;
const maxExamples = 20;

const serverSource = String.raw`
const http = require('node:http');
const port = Number(process.env.PORT || 8080);
let nextId = 1;
const items = new Map();

function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function openapi() {
  return {
    openapi: '3.0.3',
    info: { title: 'Ferrum planted-state API', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:' + port }],
    paths: {
      '/items': {
        post: {
          operationId: 'createItem',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string', minLength: 1, maxLength: 16 } },
                  additionalProperties: false
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Created item',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name'],
                    properties: {
                      id: { type: 'integer', minimum: 1 },
                      name: { type: 'string' }
                    }
                  }
                }
              },
              links: {
                GetCreatedItem: {
                  operationId: 'getItem',
                  parameters: { id: '$response.body#/id' }
                }
              }
            }
          }
        }
      },
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [{
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer', minimum: 1 }
          }],
          responses: {
            '200': {
              description: 'Existing item',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'name'],
                    properties: {
                      id: { type: 'integer' },
                      name: { type: 'string' }
                    }
                  }
                }
              }
            },
            '404': {
              description: 'Missing item',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (request.method === 'GET' && request.url === '/openapi.json') {
    writeJson(response, 200, openapi());
    return;
  }
  if (request.method === 'POST' && request.url === '/reset') {
    nextId = 1;
    items.clear();
    writeJson(response, 200, { reset: true });
    return;
  }
  if (request.method === 'POST' && request.url === '/items') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        writeJson(response, 400, { error: 'invalid-json' });
        return;
      }
      if (!parsed || typeof parsed.name !== 'string' || parsed.name.length < 1 || parsed.name.length > 16) {
        writeJson(response, 400, { error: 'invalid-name' });
        return;
      }
      const id = nextId++;
      const item = { id, name: parsed.name };
      items.set(id, item);
      writeJson(response, 201, item);
    });
    return;
  }
  const match = request.method === 'GET' && request.url.match(/^\/items\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (!items.has(id)) {
      writeJson(response, 404, { error: 'missing' });
      return;
    }
    // Intentional state-only defect: a directly guessed unknown id behaves correctly,
    // while fetching a resource that was actually created crashes the service API path.
    writeJson(response, 500, { error: 'planted-state-corruption', id });
    return;
  }
  writeJson(response, 404, { error: 'missing' });
});

server.listen(port, '0.0.0.0', () => console.log('READY ' + port));
`;

function run(command, args, options = {}) {
  const { timeoutMs = 120000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
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

async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

async function walkFiles(root) {
  const files = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files;
}

async function runFerrumBaseline(tempRoot, containerId, origin) {
  const specPath = path.join(tempRoot, 'ferrum-api-stateful-baseline.json');
  const spec = {
    version: 1,
    name: 'ferrum-api-stateful-baseline',
    target: {
      type: 'process',
      command: 'docker',
      args: ['logs', '-f', containerId],
      healthUrl: `${origin}/health`
    },
    timeouts: { startupMs: 15000, stepMs: 5000 },
    steps: [
      { action: 'http-request', method: 'GET', url: `${origin}/health`, status: 200, text: 'ok' },
      { action: 'http-request', method: 'GET', url: `${origin}/items/999999`, status: 404, text: 'missing' }
    ]
  };
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  await fs.mkdir(ferrumArtifactsRoot, { recursive: true });
  const before = new Set(await evidenceDirectories(ferrumArtifactsRoot));
  const started = performance.now();
  const result = await run(process.execPath, [
    path.join(repoRoot, 'bin', 'ferrum.mjs'),
    'test', specPath,
    '--compact',
    '--artifacts', ferrumArtifactsRoot
  ], { timeoutMs: 30000 });
  const wallMs = performance.now() - started;
  assert.equal(result.timedOut, false, 'Ferrum baseline timed out');
  assert.equal(result.code, 0, `Ferrum baseline failed: ${result.stderr || result.stdout}`);
  const created = (await evidenceDirectories(ferrumArtifactsRoot)).filter(entry => !before.has(entry));
  assert.equal(created.length, 1, `Expected one Ferrum evidence directory, found ${created.length}`);
  const evidenceId = created[0];
  const resultPath = path.join(ferrumArtifactsRoot, evidenceId, 'result.json');
  const ferrumResult = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  assert.equal(ferrumResult.status, 'passed');
  const responses = ferrumResult.events.filter(event => event.type === 'process-http-response');
  assert.deepEqual(responses.map(event => event.status), [200, 404]);
  for (const response of responses) {
    assert.ok(response.path, 'Ferrum HTTP evidence must retain full response artifacts');
    const body = await fs.readFile(path.join(ferrumArtifactsRoot, evidenceId, response.path), 'utf8');
    assert.ok(body.length > 0, 'Ferrum retained an empty response artifact');
  }
  return {
    evidenceId,
    wallMs,
    durationMs: ferrumResult.durationMs ?? null,
    statuses: responses.map(event => event.status),
    responseBytes: responses.map(event => event.responseBytes)
  };
}

function mappedPort(output) {
  const line = output.trim().split(/\r?\n/).find(Boolean) || '';
  const match = line.match(/:(\d+)$/);
  assert.ok(match, `Could not parse Docker mapped port from: ${output}`);
  return Number(match[1]);
}

async function resetService(origin) {
  const response = await fetch(`${origin}/reset`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200, `Service reset returned ${response.status}`);
  const body = await response.json();
  assert.equal(body.reset, true);
}

function extractLinkedIds(text) {
  return [...new Set([...text.matchAll(/\/items\/(\d+)/g)].map(match => Number(match[1])))]
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b);
}

async function runSchemathesis(origin, runNumber) {
  const reportName = `schemathesis-run-${runNumber}.ndjson`;
  const stdoutName = `schemathesis-run-${runNumber}.stdout.txt`;
  const stderrName = `schemathesis-run-${runNumber}.stderr.txt`;
  const reportPath = path.join(artifactsRoot, reportName);
  const cacheRoot = path.join(artifactsRoot, 'schemathesis-cache');
  await fs.mkdir(cacheRoot, { recursive: true });
  const args = [
    'run', '--rm',
    '--network', 'host',
    '--workdir', '/app',
    '-v', `${artifactsRoot}:/app/reports`,
    '-v', `${cacheRoot}:/app/.schemathesis`,
    schemathesisImage,
    'run',
    '--phases', 'stateful',
    '--checks', 'not_a_server_error,status_code_conformance',
    '--seed', String(seed),
    '--max-examples', String(maxExamples),
    '--generation-database', 'none',
    '--report', 'ndjson',
    '--report-ndjson-path', `/app/reports/${reportName}`,
    '--output-sanitize', 'true',
    '--output-truncate', 'false',
    `${origin}/openapi.json`
  ];
  const started = performance.now();
  const result = await run('docker', args, { timeoutMs: 90000 });
  const wallMs = performance.now() - started;
  await fs.writeFile(path.join(artifactsRoot, stdoutName), result.stdout, 'utf8');
  await fs.writeFile(path.join(artifactsRoot, stderrName), result.stderr, 'utf8');
  assert.equal(result.timedOut, false, `Schemathesis run ${runNumber} timed out`);
  assert.equal(result.code, 1, `Schemathesis run ${runNumber} should detect the planted defect, got code ${result.code}: ${result.stderr || result.stdout}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /Server error|Internal Server Error|not_a_server_error/i, `Schemathesis run ${runNumber} did not report a server error`);
  assert.match(output, /Reproduce with:/i, `Schemathesis run ${runNumber} did not emit reproduction instructions`);
  const reportText = await fs.readFile(reportPath, 'utf8');
  assert.ok(reportText.length > 0, `Schemathesis run ${runNumber} NDJSON report is empty`);
  assert.match(reportText, /500/, `Schemathesis run ${runNumber} report has no 500 evidence`);
  const linkedIds = extractLinkedIds(`${output}\n${reportText}`);
  assert.ok(linkedIds.length > 0, `Schemathesis run ${runNumber} did not retain a concrete linked item id`);
  const reportHash = await hashFile(reportPath);
  return {
    exitCode: result.code,
    wallMs,
    linkedIds,
    report: { path: reportName, ...reportHash },
    stdoutPath: stdoutName,
    stderrPath: stderrName
  };
}

async function removeContainer(containerId) {
  if (!containerId) return;
  await run('docker', ['rm', '-f', containerId], { timeoutMs: 15000 }).catch(() => {});
}

await fs.rm(artifactsRoot, { recursive: true, force: true });
await fs.mkdir(artifactsRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-api-stateful-'));
let containerId = null;
try {
  const dockerVersion = await run('docker', ['version', '--format={{.Server.Version}}'], { timeoutMs: 15000 });
  assert.equal(dockerVersion.code, 0, `Docker server is unavailable: ${dockerVersion.stderr || dockerVersion.stdout}`);

  const pullStarted = performance.now();
  const pullSchemathesis = await run('docker', ['pull', schemathesisImage], { timeoutMs: 120000 });
  const schemathesisPullMs = performance.now() - pullStarted;
  assert.equal(pullSchemathesis.code, 0, `Schemathesis image pull failed: ${pullSchemathesis.stderr || pullSchemathesis.stdout}`);
  const schemathesisVersion = await run('docker', ['run', '--rm', schemathesisImage, '--version'], { timeoutMs: 30000 });
  assert.equal(schemathesisVersion.code, 0, `Schemathesis --version failed: ${schemathesisVersion.stderr || schemathesisVersion.stdout}`);
  assert.match(`${schemathesisVersion.stdout}\n${schemathesisVersion.stderr}`, /4\.24\.2/, 'Unexpected Schemathesis version');
  const schemathesisImageIdResult = await run('docker', ['image', 'inspect', '--format={{.Id}}', schemathesisImage]);
  assert.equal(schemathesisImageIdResult.code, 0, `Schemathesis image identity failed: ${schemathesisImageIdResult.stderr}`);
  const schemathesisRepoDigests = await run('docker', ['image', 'inspect', '--format={{join .RepoDigests ","}}', schemathesisImage]);
  assert.equal(schemathesisRepoDigests.code, 0, `Schemathesis repo digest lookup failed: ${schemathesisRepoDigests.stderr}`);

  const help = await run('docker', ['run', '--rm', schemathesisImage, 'run', '--help'], { timeoutMs: 30000 });
  assert.equal(help.code, 0, `Schemathesis run --help failed: ${help.stderr || help.stdout}`);
  for (const required of ['--phases', '--seed', '--max-examples', '--report-ndjson-path']) {
    assert.ok(help.stdout.includes(required) || help.stderr.includes(required), `Schemathesis 4.24.2 missing required CLI option ${required}`);
  }

  const started = await run('docker', [
    'run', '--detach', '--rm',
    '--publish', '127.0.0.1::8080',
    '--env', 'PORT=8080',
    serviceImage,
    'node', '-e', serverSource
  ], { timeoutMs: 120000 });
  assert.equal(started.code, 0, `Service docker run failed: ${started.stderr || started.stdout}`);
  containerId = started.stdout.trim();
  assert.match(containerId, /^[0-9a-f]{64}$/i, `Unexpected service container ID: ${containerId}`);

  const portResult = await run('docker', ['port', containerId, '8080/tcp']);
  assert.equal(portResult.code, 0, `docker port failed: ${portResult.stderr || portResult.stdout}`);
  const hostPort = mappedPort(portResult.stdout);
  const origin = `http://127.0.0.1:${hostPort}`;

  const serviceImageId = await run('docker', ['inspect', '--format={{.Image}}', containerId]);
  assert.equal(serviceImageId.code, 0, `Service image identity failed: ${serviceImageId.stderr || serviceImageId.stdout}`);
  const serviceRepoDigests = await run('docker', ['image', 'inspect', '--format={{join .RepoDigests ","}}', serviceImage]);
  assert.equal(serviceRepoDigests.code, 0, `Service repo digest lookup failed: ${serviceRepoDigests.stderr}`);
  const containerNodeVersion = await run('docker', ['exec', containerId, 'node', '--version']);
  assert.equal(containerNodeVersion.code, 0, `Service Node identity failed: ${containerNodeVersion.stderr}`);

  const ferrumBaseline = await runFerrumBaseline(tempRoot, containerId, origin);
  await resetService(origin);
  const first = await runSchemathesis(origin, 1);
  await resetService(origin);
  const second = await runSchemathesis(origin, 2);
  assert.deepEqual(second.linkedIds, first.linkedIds, `Fixed-seed stateful linked ids changed between runs: ${first.linkedIds} vs ${second.linkedIds}`);

  const cacheFiles = await walkFiles(path.join(artifactsRoot, 'schemathesis-cache'));
  const crashFiles = cacheFiles.filter(file => file.endsWith('.json'));

  const cleanupStarted = performance.now();
  const removed = await run('docker', ['rm', '-f', containerId], { timeoutMs: 15000 });
  assert.equal(removed.code, 0, `docker rm -f failed: ${removed.stderr || removed.stdout}`);
  const cleanupMs = performance.now() - cleanupStarted;
  const removedId = containerId;
  containerId = null;
  const afterRemove = await run('docker', ['inspect', removedId], { timeoutMs: 15000 });
  const cleanupRemoved = afterRemove.code !== 0;
  assert.equal(cleanupRemoved, true, 'Stateful API fixture still exists after cleanup');

  const summary = {
    status: 'passed',
    benchmark: 'stateful-openapi-planted-defect',
    ferrumBaseCapability: 'process/http-request evidence contract',
    plantedDefect: 'POST /items creates a resource; GET of that created resource returns HTTP 500 while guessed unknown ids correctly return 404',
    seed,
    maxExamples,
    phases: ['stateful'],
    checks: ['not_a_server_error', 'status_code_conformance'],
    deterministicLinkedIds: first.linkedIds,
    repeatedDetection: true,
    ferrumBaseline,
    schemathesis: {
      image: schemathesisImage,
      version: `${schemathesisVersion.stdout}\n${schemathesisVersion.stderr}`.trim(),
      imageId: schemathesisImageIdResult.stdout.trim(),
      repoDigests: schemathesisRepoDigests.stdout.trim().split(',').filter(Boolean),
      imagePullMs: schemathesisPullMs,
      permanentFerrumDependencyAdded: false,
      first,
      second,
      crashFileCount: crashFiles.length,
      crashFiles: crashFiles.map(file => path.relative(artifactsRoot, file))
    },
    service: {
      image: serviceImage,
      imageId: serviceImageId.stdout.trim(),
      repoDigests: serviceRepoDigests.stdout.trim().split(',').filter(Boolean),
      containerNodeVersion: containerNodeVersion.stdout.trim(),
      dockerServerVersion: dockerVersion.stdout.trim(),
      containerId: removedId,
      cleanupMs,
      cleanupRemoved
    },
    acceptance: {
      realDisposableService: true,
      ferrumBaselineEvidenceRetained: true,
      stateOnlyDefectFound: true,
      fixedSeedRepeatedDetection: true,
      structuredNdjsonRetained: true,
      reproductionInstructionsRetained: true,
      exactExternalRuntimeIdentityRetained: true,
      explicitCleanupProof: true
    }
  };
  const summaryPath = path.join(artifactsRoot, 'stateful-api-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary));
} finally {
  await removeContainer(containerId);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
