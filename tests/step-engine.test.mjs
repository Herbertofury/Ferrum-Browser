import test from 'node:test';
import assert from 'node:assert/strict';
import { terminateExtensionServiceWorker, waitForLocatorText } from '../src/runners/step-engine.mjs';

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

test('terminateExtensionServiceWorker closes only the exact extension service-worker target', async () => {
  const page = { name: 'extension-popup' };
  const calls = [];
  let detached = false;
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { targetId: 'page-1', type: 'page', url: 'chrome-extension://abc/popup.html' },
            { targetId: 'other-worker', type: 'service_worker', url: 'chrome-extension://other/background.js' },
            { targetId: 'worker-abc', type: 'service_worker', url: 'chrome-extension://abc/background.js' }
          ]
        };
      }
      if (method === 'Target.closeTarget') return { success: true };
      throw new Error(`unexpected CDP command ${method}`);
    },
    async detach() {
      detached = true;
    }
  };
  const context = {
    async newCDPSession(receivedPage) {
      assert.equal(receivedPage, page);
      return cdp;
    }
  };

  const result = await terminateExtensionServiceWorker(context, page, 'abc');
  assert.deepEqual(result, {
    extensionId: 'abc',
    targetId: 'worker-abc',
    url: 'chrome-extension://abc/background.js',
    closed: true
  });
  assert.deepEqual(calls, [
    { method: 'Target.getTargets', params: undefined },
    { method: 'Target.closeTarget', params: { targetId: 'worker-abc' } }
  ]);
  assert.equal(detached, true);
});

test('terminateExtensionServiceWorker refuses ambiguous matching workers', async () => {
  let detached = false;
  const context = {
    async newCDPSession() {
      return {
        async send(method) {
          assert.equal(method, 'Target.getTargets');
          return {
            targetInfos: [
              { targetId: 'one', type: 'service_worker', url: 'chrome-extension://abc/one.js' },
              { targetId: 'two', type: 'service_worker', url: 'chrome-extension://abc/two.js' }
            ]
          };
        },
        async detach() {
          detached = true;
        }
      };
    }
  };

  await assert.rejects(
    terminateExtensionServiceWorker(context, {}, 'abc'),
    /Refusing ambiguous service-worker termination for extension abc: 2 matching targets/
  );
  assert.equal(detached, true);
});
