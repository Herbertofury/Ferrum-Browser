import test from 'node:test';
import assert from 'node:assert/strict';
import { StepEngine, terminateExtensionServiceWorker, waitForLocatorText } from '../src/runners/step-engine.mjs';

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

test('StepEngine snapshots are uncapped by default and preserve explicit caller limits', async () => {
  const calls = [];
  const page = {
    async ferrumSnapshot(options) {
      calls.push(options);
      return { url: 'https://example.test/', title: 'Example', elements: [{ ref: 'e1' }] };
    }
  };
  const engine = new StepEngine({
    evidence: { record() {} },
    session: { engine: 'chromium' },
    page
  });

  const complete = await engine.execute({ action: 'snapshot', interactiveOnly: true }, 0);
  assert.equal(complete.elements, 1);
  assert.equal(calls[0].max, undefined);

  await engine.execute({ action: 'snapshot', interactiveOnly: true, max: 123 }, 1);
  assert.equal(calls[1].max, 123);
});

test('terminateExtensionServiceWorker closes and confirms only the exact extension service-worker target', async () => {
  const page = { name: 'extension-popup' };
  const calls = [];
  let detached = false;
  let targetReads = 0;
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        targetReads += 1;
        return {
          targetInfos: targetReads === 1 ? [
            { targetId: 'page-1', type: 'page', url: 'chrome-extension://abc/popup.html' },
            { targetId: 'other-worker', type: 'service_worker', url: 'chrome-extension://other/background.js' },
            { targetId: 'worker-abc', type: 'service_worker', url: 'chrome-extension://abc/background.js' }
          ] : [
            { targetId: 'page-1', type: 'page', url: 'chrome-extension://abc/popup.html' },
            { targetId: 'other-worker', type: 'service_worker', url: 'chrome-extension://other/background.js' }
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

  const result = await terminateExtensionServiceWorker(context, page, 'abc', { timeoutMs: 20, pollMs: 1 });
  assert.deepEqual(result, {
    extensionId: 'abc',
    targetId: 'worker-abc',
    url: 'chrome-extension://abc/background.js',
    closed: true,
    confirmedBy: 'Target.getTargets',
    confirmationAttempts: 1
  });
  assert.deepEqual(calls, [
    { method: 'Target.getTargets', params: undefined },
    { method: 'Target.closeTarget', params: { targetId: 'worker-abc' } },
    { method: 'Target.getTargets', params: undefined }
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

test('terminateExtensionServiceWorker fails if the closed target never disappears', async () => {
  let detached = false;
  const worker = { targetId: 'worker-abc', type: 'service_worker', url: 'chrome-extension://abc/background.js' };
  const context = {
    async newCDPSession() {
      return {
        async send(method) {
          if (method === 'Target.getTargets') return { targetInfos: [worker] };
          if (method === 'Target.closeTarget') return { success: true };
          throw new Error(`unexpected CDP command ${method}`);
        },
        async detach() {
          detached = true;
        }
      };
    }
  };

  await assert.rejects(
    terminateExtensionServiceWorker(context, {}, 'abc', { timeoutMs: 5, pollMs: 1 }),
    /remained present after Target\.closeTarget within 5ms/
  );
  assert.equal(detached, true);
});
