import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function createRpcClient(child) {
  let buffer = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  return (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Timed out waiting for MCP response ${id}`));
    }, 10000);
    waiters.set(id, {
      resolve: message => { clearTimeout(timer); resolve(message); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('MCP legacy initialize counter-offers its supported legacy protocol instead of accepting the modern era', async () => {
  const child = spawn(process.execPath, ['./bin/ferrum.mjs', 'mcp'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const call = createRpcClient(child);
  try {
    const initialized = await call(1, 'initialize', { protocolVersion: '2026-07-28' });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    assert.equal(initialized.result.serverInfo.name, 'ferrum');
  } finally {
    child.stdin.end();
    child.kill();
  }
});

test('MCP defaults to compact evidence summaries and can opt into full output', async () => {
  const artifactsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-mcp-'));
  const child = spawn(process.execPath, ['./bin/ferrum.mjs', 'mcp'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const call = createRpcClient(child);
  try {
    const initialized = await call(1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.result.protocolVersion, '2025-06-18');
    assert.equal(initialized.result.serverInfo.name, 'ferrum');

    const compactReply = await call(2, 'tools/call', {
      name: 'ferrum_run_spec',
      arguments: { specPath: 'examples/process-app.json', artifactsRoot }
    });
    const compact = JSON.parse(compactReply.result.content[0].text);
    assert.equal(compact.status, 'passed');
    assert.equal(compact.targetType, 'process');
    assert.equal(typeof compact.evidenceDir, 'string');
    assert.equal('events' in compact, false);

    const fullReply = await call(3, 'tools/call', {
      name: 'ferrum_run_spec',
      arguments: { specPath: 'examples/process-app.json', artifactsRoot, fullOutput: true }
    });
    const full = JSON.parse(fullReply.result.content[0].text);
    assert.equal(full.status, 'passed');
    assert.equal(Array.isArray(full.events), true);
    assert.equal(full.evidenceDir.startsWith(artifactsRoot), true);
  } finally {
    child.stdin.end();
    child.kill();
  }
});