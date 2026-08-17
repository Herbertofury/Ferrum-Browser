import test from 'node:test';
import assert from 'node:assert/strict';
import { locatorTimeouts, performWithLocatorFallback } from '../src/browser/agent-surface.mjs';

test('semantic fallback uses a short deterministic probe and preserves the full fallback timeout', () => {
  assert.deepEqual(locatorTimeouts({ timeoutMs: 30000, fallback: { text: 'Save' } }), {
    deterministicTimeoutMs: 1000,
    fallbackTimeoutMs: 30000
  });
  assert.deepEqual(locatorTimeouts({ timeoutMs: 500, fallbackProbeMs: 2000, fallback: { text: 'Save' } }), {
    deterministicTimeoutMs: 500,
    fallbackTimeoutMs: 500
  });
});

test('fallback operation receives full timeout after deterministic probe fails', async () => {
  const calls = [];
  const deterministic = {};
  const semantic = {};
  const page = {
    locator: () => deterministic,
    getByText: () => semantic
  };
  const result = await performWithLocatorFallback(page, {
    action: 'click',
    selector: '#missing',
    timeoutMs: 15000,
    fallbackProbeMs: 250,
    fallback: { text: 'Continue' }
  }, async (locator, timeout, strategy) => {
    calls.push({ locator, timeout, strategy });
    if (locator === deterministic) throw new Error('missing');
    return 'ok';
  });
  assert.equal(result.locatorStrategy, 'semantic-fallback');
  assert.equal(result.deterministicProbeMs, 250);
  assert.deepEqual(calls.map(call => [call.timeout, call.strategy]), [[250, 'deterministic'], [15000, 'semantic-fallback']]);
});
