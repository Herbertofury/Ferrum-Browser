import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationWaitUntil } from '../src/runners/step-engine.mjs';

test('Lightpanda defaults to commit navigation while Chromium keeps DOMContentLoaded', () => {
  assert.equal(navigationWaitUntil('lightpanda'), 'commit');
  assert.equal(navigationWaitUntil('chromium'), 'domcontentloaded');
  assert.equal(navigationWaitUntil('lightpanda', 'load'), 'load');
});
