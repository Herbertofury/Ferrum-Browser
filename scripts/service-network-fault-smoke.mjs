import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(repoRoot, 'artifacts', 'service-network-fault');
const ferrumArtifactsRoot = path.join(artifactsRoot, 'ferrum');
const serviceImage = 'node:24-alpine';
const toxiproxyImage = 'ghcr.io/shopify/toxiproxy:2.12.0';
const latencyMs = 350;
const minimumObservedLatencyMs = 250;

const serverSource = String.raw`
const http = require('node:http');
const port = Number(process.env.PORT || 8080);
let count = 0;
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }
  if (request.method === 'POST' && request.url === '/echo') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      count += 1;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ count, body }));
    });
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

function mappedPort(output) {
  const line = output.trim().split(/\r?\n/).find(Boolean) || '';
  const match = line.match(/:(\d+)$/);
  assert.ok(match, `Could not parse Docker mapped port from: ${output}`);
  return Number(match[1]);
}

async function waitHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now()))) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'timeout'}`);
}

async function controlRequest(origin, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: body == null ? undefined : { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  const text = await response.text();
  assert.ok(response.ok, `Toxiproxy ${method} ${route} failed with HTTP ${response.status}: ${text}`);
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: response.status, body: parsed };
}

async function evidenceDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function requestElapsedMs(result) {
  const started = result.events.find(event => event.type === 'process-start');
  const response = result.events.find(event => event.type === 'process-http-response');
  assert.ok(started && Number.isFinite(started.elapsedMs), 'Ferrum result is missing process-start elapsedMs');
  assert.ok(response && Number.isFinite(response.elapsedMs), 'Ferrum result is missing process-http-response elapsedMs');
  return response.elapsedMs - started.elapsedMs;
}

async function runFerrumSpec(tempRoot, name, { serviceContainerId, healthOrigin, proxyOrigin, expectedStatus = 'passed' }) {
  const specPath = path.join(tempRoot, `${name}.json`);
  const spec = {
    version: 1,
    name: `ferrum-service-network-${name}`,
    target: {
      type: 'process',
      command: 'docker',
      args: ['logs', '-f', serviceContainerId],
      healthUrl: `${healthOrigin}/health`
    },
    timeouts: { startupMs: 15000, stepMs: 2500 },
    steps: [
      {
        action: 'http-request',
        method: 'GET',
        url: `${proxyOrigin}/state`,
        status: 200,
        text: '\"count\":0',
        timeoutMs: 1800
      }
    ]
  };
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  const before = new Set(await evidenceDirectories(ferrumArtifactsRoot));
  const startedAt = performance.now();
  const processResult = await run(process.execPath, [
    path.join(repoRoot, 'bin', 'ferrum.mjs'),
    'test',
    specPath,
    '--compact',
    '--artifacts',
    ferrumArtifactsRoot
  ], { timeoutMs: 30000 });
  const wallMs = performance.now() - startedAt;
  assert.equal(processResult.timedOut, false, `${name} Ferrum invocation timed out`);
  const created = (await evidenceDirectories(ferrumArtifactsRoot)).filter(entry => !before.has(entry));
  assert.equal(created.length, 1, `${name} expected exactly one Ferrum evidence directory, found ${created.length}`);
  const evidenceId = created[0];
  const evidenceDir = path.join(ferrumArtifactsRoot, evidenceId);
  const result = JSON.parse(await fs.readFile(path.join(evidenceDir, 'result.json'), 'utf8'));
  assert.equal(result.status, expectedStatus, `${name} expected Ferrum status ${expectedStatus}, got ${result.status}`);
  if (expectedStatus === 'passed') {
    assert.equal(processResult.code, 0, `${name} Ferrum CLI exited ${processResult.code}: ${processResult.stderr || processResult.stdout}`);
    const responses = result.events.filter(event => event.type === 'process-http-response');
    assert.equal(responses.length, 1, `${name} expected one HTTP response event`);
    assert.equal(responses[0].status, 200, `${name} expected HTTP 200`);
    assert.ok(responses[0].path, `${name} response evidence is missing its artifact path`);
    const retained = await fs.readFile(path.join(evidenceDir, responses[0].path), 'utf8');
    assert.match(retained, /\"count\":0/, `${name} retained response does not contain service state`);
    return {
      name,
      evidenceId,
      status: result.status,
      wallMs,
      durationMs: result.durationMs ?? null,
      requestElapsedMs: requestElapsedMs(result),
      responseBytes: responses[0].responseBytes,
      responsePath: responses[0].path
    };
  }
  assert.notEqual(processResult.code, 0, `${name} expected Ferrum CLI failure during injected outage`);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /HTTP request (?:failed|timed out|response failed)|fetch failed|ECONNREFUSED/i, `${name} failure evidence did not preserve a network transport error`);
  return {
    name,
    evidenceId,
    status: result.status,
    wallMs,
    durationMs: result.durationMs ?? null,
    error: result.error ?? result.result?.error ?? null
  };
}

async function removeContainer(containerId) {
  if (!containerId) return;
  await run('docker', ['rm', '-f', containerId], { timeoutMs: 30000 }).catch(() => {});
}

async function removeNetwork(networkName) {
  if (!networkName) return;
  await run('docker', ['network', 'rm', networkName], { timeoutMs: 30000 }).catch(() => {});
}

await fs.mkdir(ferrumArtifactsRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-service-network-fault-'));
const suffix = `${process.pid}-${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
const networkName = `ferrum-net-${suffix}`;
const serviceName = `ferrum-service-${suffix}`;
const toxiproxyName = `ferrum-toxiproxy-${suffix}`;
let serviceContainerId = null;
let toxiproxyContainerId = null;
let networkCreated = false;

try {
  const dockerVersion = await run('docker', ['version', '--format={{.Server.Version}}']);
  assert.equal(dockerVersion.code, 0, `Docker server is unavailable: ${dockerVersion.stderr || dockerVersion.stdout}`);

  const network = await run('docker', ['network', 'create', networkName]);
  assert.equal(network.code, 0, `docker network create failed: ${network.stderr || network.stdout}`);
  networkCreated = true;

  const service = await run('docker', [
    'run', '--detach', '--rm',
    '--network', networkName,
    '--name', serviceName,
    '--publish', '127.0.0.1::8080',
    '--env', 'PORT=8080',
    serviceImage,
    'node', '-e', serverSource
  ]);
  assert.equal(service.code, 0, `service docker run failed: ${service.stderr || service.stdout}`);
  serviceContainerId = service.stdout.trim();
  assert.match(serviceContainerId, /^[0-9a-f]{64}$/i, `Unexpected service container ID: ${serviceContainerId}`);

  const toxiproxy = await run('docker', [
    'run', '--detach', '--rm',
    '--network', networkName,
    '--name', toxiproxyName,
    '--publish', '127.0.0.1::8474',
    '--publish', '127.0.0.1::8666',
    toxiproxyImage
  ]);
  assert.equal(toxiproxy.code, 0, `Toxiproxy docker run failed: ${toxiproxy.stderr || toxiproxy.stdout}`);
  toxiproxyContainerId = toxiproxy.stdout.trim();
  assert.match(toxiproxyContainerId, /^[0-9a-f]{64}$/i, `Unexpected Toxiproxy container ID: ${toxiproxyContainerId}`);

  const servicePortResult = await run('docker', ['port', serviceContainerId, '8080/tcp']);
  assert.equal(servicePortResult.code, 0, `docker port service failed: ${servicePortResult.stderr || servicePortResult.stdout}`);
  const servicePort = mappedPort(servicePortResult.stdout);
  const controlPortResult = await run('docker', ['port', toxiproxyContainerId, '8474/tcp']);
  assert.equal(controlPortResult.code, 0, `docker port Toxiproxy control failed: ${controlPortResult.stderr || controlPortResult.stdout}`);
  const proxyPortResult = await run('docker', ['port', toxiproxyContainerId, '8666/tcp']);
  assert.equal(proxyPortResult.code, 0, `docker port Toxiproxy proxy failed: ${proxyPortResult.stderr || proxyPortResult.stdout}`);
  const controlPort = mappedPort(controlPortResult.stdout);
  const proxyPort = mappedPort(proxyPortResult.stdout);
  const healthOrigin = `http://127.0.0.1:${servicePort}`;
  const controlOrigin = `http://127.0.0.1:${controlPort}`;
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;

  await waitHttp(`${healthOrigin}/health`);
  await waitHttp(`${controlOrigin}/version`);

  const version = await controlRequest(controlOrigin, '/version');
  const proxyCreate = await controlRequest(controlOrigin, '/proxies', {
    method: 'POST',
    body: {
      name: 'ferrum_service',
      listen: '0.0.0.0:8666',
      upstream: `${serviceName}:8080`,
      enabled: true
    }
  });
  assert.equal(proxyCreate.body?.name, 'ferrum_service', 'Toxiproxy did not return the configured proxy identity');

  const inspectService = await run('docker', ['inspect', '--format={{.Image}}', serviceContainerId]);
  const inspectToxiproxy = await run('docker', ['inspect', '--format={{.Image}}', toxiproxyContainerId]);
  assert.equal(inspectService.code, 0, `Could not inspect service image: ${inspectService.stderr || inspectService.stdout}`);
  assert.equal(inspectToxiproxy.code, 0, `Could not inspect Toxiproxy image: ${inspectToxiproxy.stderr || inspectToxiproxy.stdout}`);
  const serviceRepoDigests = await run('docker', ['image', 'inspect', '--format={{join .RepoDigests ","}}', serviceImage]);
  const toxiproxyRepoDigests = await run('docker', ['image', 'inspect', '--format={{join .RepoDigests ","}}', toxiproxyImage]);
  assert.equal(serviceRepoDigests.code, 0, `Could not inspect service repo digest: ${serviceRepoDigests.stderr || serviceRepoDigests.stdout}`);
  assert.equal(toxiproxyRepoDigests.code, 0, `Could not inspect Toxiproxy repo digest: ${toxiproxyRepoDigests.stderr || toxiproxyRepoDigests.stdout}`);

  const context = { serviceContainerId, healthOrigin, proxyOrigin };
  const baseline = await runFerrumSpec(tempRoot, 'baseline', context);

  await controlRequest(controlOrigin, '/proxies/ferrum_service/toxics', {
    method: 'POST',
    body: {
      name: 'latency_upstream',
      type: 'latency',
      stream: 'upstream',
      toxicity: 1,
      attributes: { latency: latencyMs, jitter: 0 }
    }
  });
  const upstreamLatency = await runFerrumSpec(tempRoot, 'latency-upstream', context);
  await controlRequest(controlOrigin, '/reset', { method: 'POST' });

  await controlRequest(controlOrigin, '/proxies/ferrum_service/toxics', {
    method: 'POST',
    body: {
      name: 'latency_downstream',
      type: 'latency',
      stream: 'downstream',
      toxicity: 1,
      attributes: { latency: latencyMs, jitter: 0 }
    }
  });
  const downstreamLatency = await runFerrumSpec(tempRoot, 'latency-downstream', context);
  await controlRequest(controlOrigin, '/reset', { method: 'POST' });

  const upstreamDelta = upstreamLatency.requestElapsedMs - baseline.requestElapsedMs;
  const downstreamDelta = downstreamLatency.requestElapsedMs - baseline.requestElapsedMs;
  assert.ok(upstreamDelta >= minimumObservedLatencyMs, `Explicit upstream latency was not observed: baseline=${baseline.requestElapsedMs.toFixed(2)}ms upstream=${upstreamLatency.requestElapsedMs.toFixed(2)}ms delta=${upstreamDelta.toFixed(2)}ms`);
  assert.ok(downstreamDelta >= minimumObservedLatencyMs, `Explicit downstream latency was not observed: baseline=${baseline.requestElapsedMs.toFixed(2)}ms downstream=${downstreamLatency.requestElapsedMs.toFixed(2)}ms delta=${downstreamDelta.toFixed(2)}ms`);

  await controlRequest(controlOrigin, '/proxies/ferrum_service', { method: 'POST', body: { enabled: false } });
  const outage = await runFerrumSpec(tempRoot, 'proxy-disabled', { ...context, expectedStatus: 'failed' });
  await controlRequest(controlOrigin, '/proxies/ferrum_service', { method: 'POST', body: { enabled: true } });
  const recovery = await runFerrumSpec(tempRoot, 'recovery', context);
  assert.ok(upstreamLatency.requestElapsedMs - recovery.requestElapsedMs >= minimumObservedLatencyMs, 'Recovered request did not clear the injected upstream latency');
  assert.ok(downstreamLatency.requestElapsedMs - recovery.requestElapsedMs >= minimumObservedLatencyMs, 'Recovered request did not clear the injected downstream latency');

  const metricsResponse = await fetch(`${controlOrigin}/metrics`, { signal: AbortSignal.timeout(5000) });
  const metricsText = await metricsResponse.text();
  const proxyState = await controlRequest(controlOrigin, '/proxies/ferrum_service');
  assert.equal(proxyState.body?.enabled, true, 'Toxiproxy did not finish in the recovered enabled state');
  assert.deepEqual(proxyState.body?.toxics || [], [], 'Toxiproxy still has active toxics after reset/recovery');

  const cleanupStarted = performance.now();
  const serviceId = serviceContainerId;
  const toxiproxyId = toxiproxyContainerId;
  await removeContainer(toxiproxyContainerId);
  toxiproxyContainerId = null;
  await removeContainer(serviceContainerId);
  serviceContainerId = null;
  await removeNetwork(networkName);
  networkCreated = false;
  const cleanupMs = performance.now() - cleanupStarted;
  const serviceGone = (await run('docker', ['inspect', serviceId])).code !== 0;
  const toxiproxyGone = (await run('docker', ['inspect', toxiproxyId])).code !== 0;
  const networkGone = (await run('docker', ['network', 'inspect', networkName])).code !== 0;
  assert.equal(serviceGone, true, 'Service container still exists after cleanup');
  assert.equal(toxiproxyGone, true, 'Toxiproxy container still exists after cleanup');
  assert.equal(networkGone, true, 'Disposable Docker network still exists after cleanup');

  const summary = {
    status: 'passed',
    fixtureMode: 'toxiproxy-docker-cli-zero-node-dependency',
    dockerServerVersion: dockerVersion.stdout.trim(),
    service: {
      image: serviceImage,
      imageId: inspectService.stdout.trim(),
      repoDigests: serviceRepoDigests.stdout.trim().split(',').filter(Boolean)
    },
    toxiproxy: {
      image: toxiproxyImage,
      imageId: inspectToxiproxy.stdout.trim(),
      repoDigests: toxiproxyRepoDigests.stdout.trim().split(',').filter(Boolean),
      version: version.body,
      upstream: `${serviceName}:8080`,
      proxyName: 'ferrum_service',
      metricsStatus: metricsResponse.status,
      metricsAvailable: metricsResponse.ok && metricsText.length > 0
    },
    faultModel: {
      latencyMs,
      minimumObservedLatencyMs,
      upstreamStream: 'client -> server',
      downstreamStream: 'server -> client',
      outageMechanism: 'proxy enabled=false'
    },
    observations: {
      baseline,
      upstreamLatency,
      downstreamLatency,
      upstreamDeltaMs: upstreamDelta,
      downstreamDeltaMs: downstreamDelta,
      outage,
      recovery
    },
    cleanup: {
      cleanupMs,
      serviceGone,
      toxiproxyGone,
      networkGone
    },
    capability: {
      fullFerrumResponseEvidenceRetainedOnSuccessfulRequests: true,
      explicitDirectionalLatencyProven: true,
      serviceOutageDetected: true,
      recoveryAfterFaultRemovalProven: true,
      explicitServiceAndProxyImageIdentity: true,
      explicitContainerAndNetworkCleanupProof: true,
      additionalNodeDependencyCount: 0
    }
  };
  const summaryPath = path.join(artifactsRoot, 'service-network-fault-summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary));
} finally {
  await removeContainer(toxiproxyContainerId);
  await removeContainer(serviceContainerId);
  if (networkCreated) await removeNetwork(networkName);
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
