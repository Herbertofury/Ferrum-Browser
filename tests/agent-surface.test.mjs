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

test('snapshotPage never reuses a live Ferrum ref when the DOM gains a new element', async () => {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    location: globalThis.location
  };

  const elements = [];
  const makeElement = name => {
    const attributes = new Map();
    return {
      tagName: 'BUTTON',
      innerText: name,
      disabled: false,
      checked: false,
      getAttribute: key => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value),
      matches: selector => selector.includes('button'),
      getBoundingClientRect: () => ({ width: 100, height: 24 })
    };
  };

  const first = makeElement('First');
  const second = makeElement('Second');
  elements.push(first, second);

  globalThis.document = {
    title: 'Dynamic page',
    querySelectorAll: () => elements
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  globalThis.HTMLAnchorElement = class HTMLAnchorElement {};
  globalThis.location = { href: 'https://example.test/' };

  const page = {
    evaluate: async (fn, args) => fn(args)
  };

  try {
    const initial = await snapshotPage(page, { interactiveOnly: true });
    assert.deepEqual(initial.elements.map(element => element.ref), ['e1', 'e2']);

    elements.unshift(makeElement('Inserted later'));
    const updated = await snapshotPage(page, { interactiveOnly: true });
    const refs = updated.elements.map(element => element.ref);

    assert.equal(new Set(refs).size, refs.length, `snapshot refs must stay unique after DOM mutation: ${refs.join(', ')}`);
    assert.equal(updated.elements.find(element => element.name === 'First').ref, 'e1');
    assert.equal(updated.elements.find(element => element.name === 'Second').ref, 'e2');
    assert.notEqual(updated.elements.find(element => element.name === 'Inserted later').ref, 'e1');
    assert.notEqual(updated.elements.find(element => element.name === 'Inserted later').ref, 'e2');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('snapshotPage replaces forged unsafe numeric refs without corrupting allocation', async () => {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    location: globalThis.location
  };

  const attributes = new Map([['data-ferrum-ref', 'e999999999999999999999999999999999999']]);
  const element = {
    tagName: 'BUTTON',
    innerText: 'Forged',
    disabled: false,
    checked: false,
    getAttribute: key => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value),
    matches: selector => selector.includes('button'),
    getBoundingClientRect: () => ({ width: 100, height: 24 })
  };

  globalThis.document = {
    title: 'Forged ref',
    querySelectorAll: () => [element]
  };
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  globalThis.HTMLAnchorElement = class HTMLAnchorElement {};
  globalThis.location = { href: 'https://example.test/' };

  const page = { evaluate: async (fn, args) => fn(args) };

  try {
    const result = await snapshotPage(page, { interactiveOnly: true });
    assert.equal(result.elements.length, 1);
    assert.equal(result.elements[0].ref, 'e1');
    assert.equal(element.getAttribute('data-ferrum-ref'), 'e1');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
