import test from 'node:test';
import assert from 'node:assert/strict';
import { performWithLocatorFallback } from '../src/browser/agent-surface.mjs';

function makeLocator() {
  const state = { first: 0, nth: [] };
  const locator = {
    state,
    first() { state.first += 1; return this; },
    nth(index) { state.nth.push(index); return this; }
  };
  return locator;
}

test('deterministic locators support explicit first disambiguation', async () => {
  const locator = makeLocator();
  const page = { locator: () => locator };
  const result = await performWithLocatorFallback(page, { action: 'wait', selector: '.row', first: true, timeoutMs: 1000 }, async target => target);
  assert.equal(result.value, locator);
  assert.equal(locator.state.first, 1);
  assert.deepEqual(locator.state.nth, []);
});

test('deterministic locators support explicit nth disambiguation', async () => {
  const locator = makeLocator();
  const page = { locator: () => locator };
  const result = await performWithLocatorFallback(page, { action: 'click', selector: '.row', nth: 2, timeoutMs: 1000 }, async target => target);
  assert.equal(result.value, locator);
  assert.equal(locator.state.first, 0);
  assert.deepEqual(locator.state.nth, [2]);
});
