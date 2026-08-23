import test from 'node:test';
import assert from 'node:assert/strict';
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
