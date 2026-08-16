import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarizeDurations } from '../src/core/stats.mjs';

test('summarizes timing distributions', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], .5), 3);
  assert.deepEqual(summarizeDurations([5, 1, 3]), { count: 3, minMs: 1, medianMs: 3, p95Ms: 5, maxMs: 5 });
});
