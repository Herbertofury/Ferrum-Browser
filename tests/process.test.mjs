import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { runProcessTarget } from '../src/runners/process.mjs';

test('process runner captures logs and exit code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-test' }).init();
  const spec = { target: { command: process.execPath, args: ['-e', "console.log('ready')"] }, timeouts: { stepMs: 5000 }, steps: [{ action: 'assert-log', text: 'ready' }, { action: 'wait-exit', code: 0 }] };
  const result = await runProcessTarget(spec, evidence);
  assert.ok(result.logs >= 1);
});

test('process runner enforces startup deadline when a health request responds too late', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-health-deadline-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-health-deadline-test' }).init();
  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    }, 650);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const spec = {
    target: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      healthUrl: `http://127.0.0.1:${address.port}/health`
    },
    timeouts: { startupMs: 120, stepMs: 5000 },
    steps: []
  };
  const startedAt = performance.now();
  try {
    await assert.rejects(
      runProcessTarget(spec, evidence),
      /Health URL did not become ready: .* after \d+ attempts: timeout/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.ok(performance.now() - startedAt < 500, 'startup timeout should bound an individual slow health request');
});

test('process runner can drive stdin without recording raw input in process-input evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-stdin-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-stdin-test' }).init();
  const script = "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>console.log('input:'+data.trim()))";
  const spec = {
    target: { command: process.execPath, args: ['-e', script] },
    timeouts: { stepMs: 5000 },
    steps: [
      { action: 'write-stdin', text: 'hello ferrum', newline: true },
      { action: 'close-stdin' },
      { action: 'assert-log', text: 'input:hello ferrum' },
      { action: 'wait-exit', code: 0 }
    ]
  };
  const result = await runProcessTarget(spec, evidence);
  assert.ok(result.logs >= 1);
  const inputEvent = evidence.events.find(event => event.type === 'process-input');
  assert.deepEqual(inputEvent && { bytes: inputEvent.bytes, newline: inputEvent.newline }, { bytes: 13, newline: true });
  assert.equal(Object.prototype.hasOwnProperty.call(inputEvent, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(inputEvent, 'value'), false);
  assert.equal(evidence.events.some(event => event.type === 'process-stdin-closed'), true);
});

test('process runner fails log assertions promptly with exit details after the child closes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-early-exit-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-early-exit-test' }).init();
  const spec = {
    target: { command: process.execPath, args: ['-e', 'process.exit(17)'] },
    timeouts: { stepMs: 5000 },
    steps: [{ action: 'assert-log', text: 'ready' }]
  };
  const startedAt = performance.now();
  await assert.rejects(runProcessTarget(spec, evidence), /Process exited before output contained expected text: ready \(code 17, signal none\)/);
  assert.ok(performance.now() - startedAt < 3000, 'expected child exit to short-circuit the 5000ms log assertion timeout');
});

test('process runner checks final unterminated output before treating process close as a missing log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-tail-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-tail-test' }).init();
  const spec = {
    target: { command: process.execPath, args: ['-e', "process.stdout.write('tail-ready')"] },
    timeouts: { stepMs: 5000 },
    steps: [{ action: 'assert-log', text: 'tail-ready' }, { action: 'wait-exit', code: 0 }]
  };
  const result = await runProcessTarget(spec, evidence);
  assert.ok(result.logs >= 1);
});

test('process runner captures a secret-safe structured Node diagnostic report on uncaught exception', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-node-report-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-node-report-test' }).init();
  const secret = 'ferrum-report-secret-value';
  const spec = {
    target: {
      command: process.execPath,
      args: ['-e', "throw new Error('ferrum-node-diagnostic-boom')"],
      env: { FERRUM_NODE_REPORT_SECRET: secret },
      nodeDiagnosticReport: true
    },
    timeouts: { stepMs: 5000 },
    steps: [{ action: 'wait-exit', code: 1 }]
  };
  const result = await runProcessTarget(spec, evidence);
  assert.equal(result.nodeReports, 1);
  const reportEvent = evidence.events.find(event => event.type === 'node-diagnostic-report');
  assert.ok(reportEvent?.path, 'expected node-diagnostic-report evidence');
  const report = JSON.parse(await fs.readFile(path.join(evidence.dir, reportEvent.path), 'utf8'));
  const serialized = JSON.stringify(report);
  assert.equal(report.schemaVersion, 1);
  assert.equal(String(report.header.event).toLowerCase(), 'exception');
  assert.equal(report.header.processId, reportEvent.processId);
  assert.ok(Array.isArray(report.javascriptStack?.stack));
  assert.ok(report.javascriptStack.stack.some(line => line.includes('ferrum-node-diagnostic-boom')));
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'environmentVariables'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.header, 'networkInterfaces'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.header, 'commandLine'), false);
  assert.equal(serialized.includes('localEndpoint'), false);
  assert.equal(serialized.includes('remoteEndpoint'), false);
  assert.equal(serialized.includes(secret), false);
});

test('process runner keeps diagnostic report safety flags Ferrum-owned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-node-report-flags-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-node-report-flags-test' }).init();
  const spec = {
    target: {
      command: process.execPath,
      args: ['--report-directory=elsewhere', '-e', 'process.exit(0)'],
      nodeDiagnosticReport: true
    },
    steps: []
  };
  await assert.rejects(
    runProcessTarget(spec, evidence),
    /nodeDiagnosticReport owns Node report flags; remove conflicting argument: --report-directory=elsewhere/
  );
});
