import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSuite } from '../src/core/suite.mjs';

async function writeProcessSpec(root, name, text) {
  const file = path.join(root, `${name}.json`);
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    name,
    target: { type: 'process', command: process.execPath, args: ['-e', `console.log(${JSON.stringify(text)})`] },
    steps: [
      { action: 'assert-log', text },
      { action: 'wait-exit', code: 0, timeoutMs: 5000 }
    ]
  }));
  return file;
}

test('suite runs independent specs with bounded concurrency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-suite-'));
  const one = await writeProcessSpec(root, 'one', 'one-ready');
  const two = await writeProcessSpec(root, 'two', 'two-ready');
  const result = await runSuite([one, two], { workers: 2, artifactsRoot: path.join(root, 'artifacts') });
  assert.equal(result.status, 'passed');
  assert.equal(result.workers, 2);
  assert.equal(result.total, 2);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 0);
  assert.notEqual(result.results[0].evidenceId, result.results[1].evidenceId);
});
