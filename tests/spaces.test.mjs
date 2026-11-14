import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSpace, listSpaces, prepareRunSpace } from '../src/core/spaces.mjs';

async function tempRoot() { return await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-spaces-test-')); }

test('spaces can be created, cloned, and listed without mutating the source profile', async () => {
  const root = await tempRoot();
  try {
    const base = await createSpace('auth', { root });
    await fs.writeFile(path.join(base.profileDir, 'cookie.txt'), 'persisted', 'utf8');
    const clone = await createSpace('auth-copy', { root, cloneFrom: 'auth' });
    assert.equal(await fs.readFile(path.join(clone.profileDir, 'cookie.txt'), 'utf8'), 'persisted');
    await fs.writeFile(path.join(clone.profileDir, 'cookie.txt'), 'changed', 'utf8');
    assert.equal(await fs.readFile(path.join(base.profileDir, 'cookie.txt'), 'utf8'), 'persisted');
    assert.deepEqual((await listSpaces({ root })).map(item => item.name), ['auth', 'auth-copy']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('persistent spaces are locked while in use', async () => {
  const root = await tempRoot();
  try {
    await createSpace('locked', { root });
    const first = await prepareRunSpace({ name: 'locked', root, mode: 'persistent', runId: 'one' });
    await assert.rejects(prepareRunSpace({ name: 'locked', root, mode: 'persistent', runId: 'two' }), /already in use/);
    await first.cleanup();
    const second = await prepareRunSpace({ name: 'locked', root, mode: 'persistent', runId: 'three' });
    await second.cleanup();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('clone mode gives each run an isolated disposable profile', async () => {
  const root = await tempRoot();
  try {
    const base = await createSpace('base', { root });
    await fs.writeFile(path.join(base.profileDir, 'state.txt'), 'base', 'utf8');
    const prepared = await prepareRunSpace({ name: 'base', root, mode: 'clone', runId: 'run-1' });
    assert.equal(await fs.readFile(path.join(prepared.profileDir, 'state.txt'), 'utf8'), 'base');
    await fs.writeFile(path.join(prepared.profileDir, 'state.txt'), 'run', 'utf8');
    assert.equal(await fs.readFile(path.join(base.profileDir, 'state.txt'), 'utf8'), 'base');
    const runDir = path.dirname(prepared.profileDir);
    await prepared.cleanup();
    await assert.rejects(fs.access(runDir));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('both clone paths reject a running persistent Space and recover after release', async () => {
  const root = await tempRoot();
  let active;
  try {
    const base = await createSpace('live', { root });
    await fs.writeFile(path.join(base.profileDir, 'state.txt'), 'last-good');
    active = await prepareRunSpace({ name: 'live', root });
    await assert.rejects(createSpace('blocked-copy', { root, cloneFrom: 'live' }), /already in use/);
    await assert.rejects(fs.access(path.join(root, 'blocked-copy')));
    await assert.rejects(prepareRunSpace({ name: 'live', root, mode: 'clone' }), /already in use/);
    assert.equal((await listSpaces({ root }))[0].locked, true);
    assert.equal(await fs.readFile(path.join(base.profileDir, 'state.txt'), 'utf8'), 'last-good');
    await active.cleanup(); active = null;
    const clone = await createSpace('good-copy', { root, cloneFrom: 'live' });
    assert.equal(await fs.readFile(path.join(clone.profileDir, 'state.txt'), 'utf8'), 'last-good');
    const run = await prepareRunSpace({ name: 'live', root, mode: 'clone' });
    await run.cleanup();
    assert.equal((await listSpaces({ root })).find(s => s.name === 'live').locked, false);
  } finally { await active?.cleanup(); await fs.rm(root, { recursive: true, force: true }); }
});


test('profile copy owns the source lock and failed copies leave no clone or lock', async () => {
  const root = await tempRoot();
  const originalCopy = fs.cp;
  try {
    await createSpace('base', { root });
    const copier = mock.method(fs, 'cp', async (...args) => {
      await assert.rejects(prepareRunSpace({ name: 'base', root }), /already in use/);
      return originalCopy(...args);
    });
    await createSpace('copied', { root, cloneFrom: 'base' });
    assert.equal(copier.mock.callCount(), 1);
    copier.mock.restore();
    const failure = mock.method(fs, 'cp', async () => { throw new Error('fixture copy failure'); });
    await assert.rejects(createSpace('failed', { root, cloneFrom: 'base' }), /fixture copy failure/);
    await assert.rejects(fs.access(path.join(root, 'failed')));
    await assert.rejects(prepareRunSpace({ name: 'base', root, mode: 'clone' }), /fixture copy failure/);
    assert.deepEqual(await fs.readdir(path.join(root, '.runs')), []);
    assert.equal((await listSpaces({ root })).find(s => s.name === 'base').locked, false);
    failure.mock.restore();
    const run = await prepareRunSpace({ name: 'base', root });
    await run.cleanup();
  } finally { mock.restoreAll(); await fs.rm(root, { recursive: true, force: true }); }
});

test('repeated old cleanup cannot release a newer persistent run lock', async () => {
  const root = await tempRoot();
  let second;
  try {
    await createSpace('owned', { root });
    const first = await prepareRunSpace({ name: 'owned', root });
    await first.cleanup();
    second = await prepareRunSpace({ name: 'owned', root });
    await Promise.all([first.cleanup(), first.cleanup()]);
    await assert.rejects(prepareRunSpace({ name: 'owned', root }), /already in use/);
    await second.cleanup(); second = null;
    const third = await prepareRunSpace({ name: 'owned', root });
    await third.cleanup();
  } finally { await second?.cleanup(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cleanup does not delete a replacement lock owned by another run', async () => {
  const root = await tempRoot();
  try {
    const base = await createSpace('replaced', { root });
    const prepared = await prepareRunSpace({ name: 'replaced', root });
    const replacement = JSON.stringify({ pid: 99999, host: 'fixture', acquiredAt: 'replacement' });
    await fs.writeFile(path.join(base.dir, '.lock'), replacement);
    await prepared.cleanup();
    assert.equal(await fs.readFile(path.join(base.dir, '.lock'), 'utf8'), replacement);
    await assert.rejects(prepareRunSpace({ name: 'replaced', root }), /already in use/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
