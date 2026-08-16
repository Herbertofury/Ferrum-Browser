import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashDirectory } from '../src/core/hash.mjs';

test('directory hash changes with content and is order-stable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-hash-'));
  await fs.writeFile(path.join(root, 'b.txt'), 'b');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  const first = await hashDirectory(root);
  const second = await hashDirectory(root);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.files.map(file => file.path), ['a.txt', 'b.txt']);
  await fs.writeFile(path.join(root, 'a.txt'), 'changed');
  const third = await hashDirectory(root);
  assert.notEqual(first.sha256, third.sha256);
});
