import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeElectronRunTimeout } from '../src/core/runner.mjs';

test('electron isolated worker timeout is bounded and configurable', () => {
  assert.equal(normalizeElectronRunTimeout(undefined), 120000);
  assert.equal(normalizeElectronRunTimeout(0), 120000);
  assert.equal(normalizeElectronRunTimeout(-1), 120000);
  assert.equal(normalizeElectronRunTimeout('90000'), 90000);
  assert.equal(normalizeElectronRunTimeout(30000), 30000);
});
