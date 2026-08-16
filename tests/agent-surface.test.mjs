import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPage } from '../src/browser/agent-surface.mjs';

test('snapshotPage uses a runtime-native Ferrum snapshot when provided', async () => {
  let called;
  const page = {
    ferrumSnapshot: async options => {
      called = options;
      return { url: 'lp://test', title: 'Lightpanda', elements: [{ ref: 'e1' }] };
    },
    evaluate: async () => { throw new Error('generic evaluate must not be used'); }
  };
  const result = await snapshotPage(page, { interactiveOnly: true, max: 17 });
  assert.deepEqual(called, { interactiveOnly: true, max: 17 });
  assert.equal(result.elements.length, 1);
});
