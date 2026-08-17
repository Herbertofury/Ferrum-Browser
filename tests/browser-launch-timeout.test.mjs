import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrowserLaunchTimeout, withBrowserOperationTimeout } from '../src/browser/chromium.mjs';

test('browser launch timeout defaults and explicit values are deterministic', () => {
  assert.equal(normalizeBrowserLaunchTimeout(undefined), 30000);
  assert.equal(normalizeBrowserLaunchTimeout(0), 30000);
  assert.equal(normalizeBrowserLaunchTimeout(-1), 30000);
  assert.equal(normalizeBrowserLaunchTimeout('45000'), 45000);
  assert.equal(normalizeBrowserLaunchTimeout(12000), 12000);
});

test('browser operation timeout resolves fast operations and bounds stalled operations', async () => {
  assert.equal(await withBrowserOperationTimeout(Promise.resolve('ok'), 50, 'fast operation'), 'ok');
  await assert.rejects(
    withBrowserOperationTimeout(new Promise(() => {}), 15, 'stalled operation'),
    /stalled operation timed out after 15ms/
  );
});
