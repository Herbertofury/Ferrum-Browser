import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { evidenceFilePath } from '../src/core/evidence-store.mjs';

test('dot evidence ids cannot select the evidence root or its parent', () => {
  const root = path.join(os.tmpdir(), 'ferrum-evidence-id-containment');
  assert.throws(() => evidenceFilePath('.', 'result.json', { root }), /Invalid evidence id/);
  assert.throws(() => evidenceFilePath('..', 'result.json', { root }), /Invalid evidence id/);
});
