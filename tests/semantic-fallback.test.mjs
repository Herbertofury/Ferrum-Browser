import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAgentAction, semanticLocator } from '../src/browser/agent-surface.mjs';

function locator({ click, fill, innerText, waitFor } = {}) {
  return {
    click: click || (async () => {}),
    fill: fill || (async () => {}),
    innerText: innerText || (async () => 'text'),
    waitFor: waitFor || (async () => {}),
    nth() { return this; },
    first() { return this; }
  };
}

test('semantic fallback is attempted only after deterministic click fails', async () => {
  let fallbackCalls = 0;
  const page = {
    locator: () => locator({ click: async () => { throw new Error('deterministic miss'); } }),
    getByRole: (role, options) => {
      fallbackCalls += 1;
      assert.equal(role, 'button');
      assert.equal(options.name, 'Save');
      return locator();
    }
  };
  const result = await executeAgentAction(page, {
    action: 'click',
    selector: '#missing-save',
    fallback: { role: 'button', name: 'Save', exact: true }
  });
  assert.equal(result.locatorStrategy, 'semantic-fallback');
  assert.equal(result.deterministicError, 'deterministic miss');
  assert.equal(fallbackCalls, 1);
});

test('successful deterministic locator does not invoke fallback', async () => {
  const page = {
    locator: () => locator(),
    getByRole: () => { throw new Error('fallback must not be called'); }
  };
  const result = await executeAgentAction(page, {
    action: 'click',
    selector: '#save',
    fallback: { role: 'button', name: 'Save' }
  });
  assert.equal(result.locatorStrategy, 'deterministic');
  assert.equal(result.fallback, null);
});

test('semantic fallback cannot replace the required deterministic locator', async () => {
  const page = { getByText: () => locator() };
  await assert.rejects(
    executeAgentAction(page, { action: 'click', fallback: { text: 'Continue' } }),
    /requires ref or selector before semantic fallback/
  );
});

test('semantic locator supports explicit nth disambiguation', () => {
  let nthValue = null;
  const base = locator();
  base.nth = value => { nthValue = value; return base; };
  const page = { getByText: () => base };
  assert.equal(semanticLocator(page, { text: 'Item', nth: 2 }), base);
  assert.equal(nthValue, 2);
});
