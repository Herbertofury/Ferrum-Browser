import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserLaunchTimeout } from '../src/browser/chromium.mjs';

test('browser launch timeout defaults and explicit values are deterministic', () => {
  assert.equal(normalizeBrowserLaunchTimeout(undefined), 30000);
  assert.equal(normalizeBrowserLaunchTimeout(0), 30000);
  assert.equal(normalizeBrowserLaunchTimeout(-1), 30000);
  assert.equal(normalizeBrowserLaunchTimeout('45000'), 45000);
  assert.equal(normalizeBrowserLaunchTimeout(12000), 12000);
});
