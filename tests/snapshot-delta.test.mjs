import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/browser/agent-surface.mjs';

test('diffSnapshots reports stable-ref additions removals and field changes without copying unchanged elements', () => {
  const before = {
    url: 'https://example.test/app',
    title: 'Before',
    elements: [
      { ref: 'e1', tag: 'button', role: null, type: null, name: 'Save', href: null, disabled: false, checked: null },
      { ref: 'e2', tag: 'button', role: null, type: null, name: 'Delete', href: null, disabled: false, checked: null },
      { ref: 'e3', tag: 'input', role: null, type: 'checkbox', name: 'Enabled', href: null, disabled: false, checked: false }
    ]
  };
  const after = {
    url: 'https://example.test/app?updated=1',
    title: 'After',
    elements: [
      { ref: 'e1', tag: 'button', role: null, type: null, name: 'Saved', href: null, disabled: true, checked: null },
      { ref: 'e3', tag: 'input', role: null, type: 'checkbox', name: 'Enabled', href: null, disabled: false, checked: false },
      { ref: 'e4', tag: 'link', role: 'link', type: null, name: 'Details', href: 'https://example.test/details', disabled: false, checked: null }
    ]
  };

  const delta = diffSnapshots(before, after);
  assert.equal(delta.before.count, 3);
  assert.equal(delta.after.count, 3);
  assert.deepEqual(delta.added.map(item => item.ref), ['e4']);
  assert.deepEqual(delta.removed.map(item => item.ref), ['e2']);
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.changed[0].ref, 'e1');
  assert.deepEqual(delta.changed[0].changes, {
    name: { before: 'Save', after: 'Saved' },
    disabled: { before: false, after: true }
  });
  assert.equal(delta.unchangedCount, 1);
  assert.deepEqual(delta.page, {
    url: { before: 'https://example.test/app', after: 'https://example.test/app?updated=1' },
    title: { before: 'Before', after: 'After' }
  });
  assert.equal(JSON.stringify(delta).includes('Enabled'), false, 'unchanged element payload must not be copied into the delta');
});
