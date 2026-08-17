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
