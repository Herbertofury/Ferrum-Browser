import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { runProcessTarget } from '../src/runners/process.mjs';

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('process runner can exercise a launched HTTP service and retain full response evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-http-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-http-test' }).init();
  const port = await reservePort();
  const service = `
    const http = require('node:http');
    let requests = 0;
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      if (request.url === '/echo' && request.method === 'POST') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          requests += 1;
          const parsed = JSON.parse(body);
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ echo: parsed.message, requests }));
        });
        return;
      }
      if (request.url === '/stats') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ requests }));
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
  `;
  const spec = {
    target: {
      command: process.execPath,
      args: ['-e', service],
      env: { PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}/health`
    },
    timeouts: { startupMs: 5000, stepMs: 5000 },
    steps: [
      {
        action: 'http-request',
        method: 'POST',
        url: `http://127.0.0.1:${port}/echo`,
        json: { message: 'hello ferrum' },
        status: 201,
        text: '"echo":"hello ferrum"'
      },
      {
        action: 'http-request',
        url: `http://127.0.0.1:${port}/stats`,
        status: 200,
        text: '"requests":1'
      }
    ]
  };

  const result = await runProcessTarget(spec, evidence);
  assert.equal(result.httpRequests, 2);
  const responses = evidence.events.filter(event => event.type === 'process-http-response');
  assert.equal(responses.length, 2);
  assert.deepEqual(responses.map(event => event.status), [201, 200]);
  assert.ok(responses.every(event => event.path?.startsWith('http/')));
  assert.equal(await fs.readFile(path.join(evidence.dir, responses[0].path), 'utf8'), '{"echo":"hello ferrum","requests":1}');
  assert.equal(await fs.readFile(path.join(evidence.dir, responses[1].path), 'utf8'), '{"requests":1}');
});

test('process HTTP assertions retain the complete response before failing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-http-failure-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-http-failure-test' }).init();
  const port = await reservePort();
  const service = `
    const http = require('node:http');
    http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-ready', detail: 'fixture response retained' }));
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `;
  const spec = {
    target: {
      command: process.execPath,
      args: ['-e', service],
      env: { PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}/health`
    },
    timeouts: { startupMs: 5000, stepMs: 5000 },
    steps: [{ action: 'http-request', url: `http://127.0.0.1:${port}/fail`, status: 200 }]
  };

  await assert.rejects(runProcessTarget(spec, evidence), /Expected HTTP status 200, got 503/);
  const response = evidence.events.find(event => event.type === 'process-http-response');
  assert.equal(response?.status, 503);
  assert.equal(await fs.readFile(path.join(evidence.dir, response.path), 'utf8'), '{"error":"not-ready","detail":"fixture response retained"}');
});

test('process HTTP request stops promptly when the supervised service exits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-http-exit-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-http-exit-test' }).init();
  const port = await reservePort();
  const service = `
    const http = require('node:http');
    http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      }
      if (request.url === '/hang') {
        setTimeout(() => process.exit(25), 100);
      }
    }).listen(Number(process.env.PORT), '127.0.0.1');
  `;
  const spec = {
    target: {
      command: process.execPath,
      args: ['-e', service],
      env: { PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}/health`
    },
    timeouts: { startupMs: 5000, stepMs: 2500 },
    steps: [{ action: 'http-request', url: `http://127.0.0.1:${port}/hang`, timeoutMs: 2500 }]
  };

  const startedAt = performance.now();
  await assert.rejects(
    runProcessTarget(spec, evidence),
    /Process exited during HTTP request GET .*\/hang \(code 25, signal none\)/
  );
  assert.ok(performance.now() - startedAt < 1200, 'child exit should cancel a hanging HTTP request before the step timeout');
});
