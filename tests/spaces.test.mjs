import test from 'node:test';
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
