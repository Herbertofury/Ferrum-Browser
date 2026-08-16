import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../src/core/spec.mjs';

test('validates supported target types', () => {
  assert.equal(validateSpec({ version: 1, name: 'x', target: { type: 'web' }, steps: [] }), true);
  assert.throws(() => validateSpec({ version: 1, name: 'x', target: { type: 'unknown' }, steps: [] }), /target.type/);
});

test('rejects malformed steps', () => {
  assert.throws(() => validateSpec({ version: 1, name: 'x', target: { type: 'web' }, steps: [{}] }), /action/);
});
