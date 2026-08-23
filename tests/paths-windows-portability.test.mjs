import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeName } from '../src/core/paths.mjs';

test('safeName avoids Windows reserved device names and trailing-dot output', () => {
  const cases = new Map([
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['PRN', '_PRN'],
    ['AUX.log', '_AUX.log'],
    ['NUL', '_NUL'],
    ['COM1', '_COM1'],
    ['com9.txt', '_com9.txt'],
    ['LPT1', '_LPT1'],
    ['lpt9.json', '_lpt9.json'],
    ['name.', 'name'],
    ['name..', 'name'],
    ['...', 'run'],
    ['normal-name.json', 'normal-name.json']
  ]);

  for (const [input, expected] of cases) {
    assert.equal(safeName(input), expected, input);
  }
});

test('safeName preserves its length bound after Windows reserved-name prefixing', () => {
  const input = `CON.${'x'.repeat(100)}`;
  const output = safeName(input);
  assert.ok(output.startsWith('_CON.'));
  assert.ok(output.length <= 80);
});

test('safeName output is writable for a Windows reserved source name', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-safe-name-'));
  try {
    await assert.rejects(fs.writeFile(path.join(dir, 'CON.txt'), 'unsafe control\n', 'utf8'));
    const portable = safeName('CON.txt');
    const target = path.join(dir, portable);
    await fs.writeFile(target, 'portable\n', 'utf8');
    assert.equal(await fs.readFile(target, 'utf8'), 'portable\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
