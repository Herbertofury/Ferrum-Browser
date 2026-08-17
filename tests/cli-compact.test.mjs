import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';

test('compact CLI output keeps evidence location and full on-disk result', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-compact-'));
  const lines = [];
  const originalLog = console.log;
  console.log = value => lines.push(String(value));
  try {
    await main(['test', 'examples/process-app.json', '--compact', '--artifacts', root]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 1);
  const compact = JSON.parse(lines[0]);
  assert.equal(compact.status, 'passed');
  assert.equal(compact.targetType, 'process');
  assert.equal(typeof compact.evidenceDir, 'string');
  assert.equal(compact.summary.diagnosticErrorCount, 0);

  const result = JSON.parse(await fs.readFile(path.join(compact.evidenceDir, 'result.json'), 'utf8'));
  const agentSummary = JSON.parse(await fs.readFile(path.join(compact.evidenceDir, 'agent-summary.json'), 'utf8'));
  assert.equal(result.status, 'passed');
  assert.equal(result.evidenceDir, compact.evidenceDir);
  assert.equal(agentSummary.status, 'passed');
  assert.equal(agentSummary.evidenceDir, compact.evidenceDir);
});
