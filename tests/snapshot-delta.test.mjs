import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../src/browser/agent-surface.mjs';
import { StepEngine } from '../src/runners/step-engine.mjs';

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
    { ref: 'e4', tag: 'a', role: 'link', type: null, name: 'Details', href: 'https://example.test/details', disabled: false, checked: null }
  ]
};

test('diffSnapshots reports stable-ref additions removals and field changes without copying unchanged elements', () => {
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

test('StepEngine retains both complete named snapshots and an additive compact delta artifact', async () => {
  const snapshots = [structuredClone(before), structuredClone(after)];
  const writes = new Map();
  const evidence = {
    dir: '/tmp/ferrum-delta-test',
    events: [],
    record() {},
    async writeJson(name, value) { writes.set(name, structuredClone(value)); }
  };
  const page = {
    ferrumSnapshot: async () => snapshots.shift()
  };
  const engine = new StepEngine({ evidence, session: { engine: 'chromium' }, page });

  const baselineResult = await engine.execute({ action: 'snapshot', name: 'before', interactiveOnly: true }, 0);
  const deltaResult = await engine.execute({ action: 'snapshot', name: 'after', compareTo: 'before', interactiveOnly: true }, 1);

  assert.equal(baselineResult.fullSnapshotFile, 'snapshots/before.json');
  assert.equal(deltaResult.fullSnapshotFile, 'snapshots/after.json');
  assert.equal(deltaResult.deltaFile, 'snapshots/after.delta.json');
  assert.deepEqual(writes.get('snapshots/before.json'), before);
  assert.deepEqual(writes.get('snapshots/after.json'), after);
  assert.deepEqual(writes.get('snapshots/after.delta.json'), diffSnapshots(before, after));
  assert.equal(writes.get('snapshots/after.json').elements.some(element => element.name === 'Enabled'), true, 'full snapshot remains authoritative');
  assert.equal(JSON.stringify(writes.get('snapshots/after.delta.json')).includes('Enabled'), false, 'delta excludes unchanged element payload');
  assert.deepEqual(deltaResult.delta, { added: 1, removed: 1, changed: 1, unchanged: 1 });
});

test('StepEngine invalidates named snapshot baselines after a runtime restart', async () => {
  const writes = new Map();
  const evidence = {
    dir: '/tmp/ferrum-delta-restart-test',
    events: [],
    record() {},
    async writeJson(name, value) { writes.set(name, structuredClone(value)); }
  };
  const firstPage = { ferrumSnapshot: async () => structuredClone(before) };
  const restartedPage = { ferrumSnapshot: async () => structuredClone(after) };
  const engine = new StepEngine({
    evidence,
    session: { engine: 'chromium' },
    page: firstPage,
    onRestart: async () => ({ session: { engine: 'chromium' }, page: restartedPage })
  });

  await engine.execute({ action: 'snapshot', name: 'before' }, 0);
  await engine.execute({ action: 'restart' }, 1);
  await assert.rejects(
    () => engine.execute({ action: 'snapshot', name: 'after', compareTo: 'before' }, 2),
    /requires an earlier named snapshot: before/
  );
  assert.deepEqual(writes.get('snapshots/after.json'), after, 'complete post-restart snapshot remains retained evidence');
  assert.equal(writes.has('snapshots/after.delta.json'), false, 'cross-runtime refs must never be treated as a comparable baseline');
});
