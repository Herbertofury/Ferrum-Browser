import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForLocatorText } from '../src/runners/step-engine.mjs';

test('waitForLocatorText retries until asynchronous expected text appears', async () => {
  const samples = ['idle', 'waiting', 'ok:runtime'];
  let calls = 0;
  const locator = {
    async innerText() {
      const value = samples[Math.min(calls, samples.length - 1)];
      calls += 1;
      return value;
    }
  };

  const result = await waitForLocatorText(locator, 'ok:', 100, { pollMs: 1 });
  assert.equal(result.matched, 'ok:');
  assert.equal(result.text, 'ok:runtime');
  assert.ok(calls >= 3);
});

test('waitForLocatorText times out with the last observed text', async () => {
  let calls = 0;
  const locator = {
    async innerText() {
      calls += 1;
      return 'idle';
    }
  };

  await assert.rejects(
    waitForLocatorText(locator, 'ok:', 20, { pollMs: 1 }),
    error => {
      assert.match(error.message, /Expected text not found within 20ms: ok:/);
      assert.match(error.message, /last text: "idle"/);
      return true;
    }
  );
  assert.ok(calls > 1);
});
