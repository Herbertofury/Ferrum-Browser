import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
