import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evidenceFilePath, listEvidence, readEvidence, readEvidenceText } from '../src/core/evidence-store.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-store-'));
  const id = '2026-08-17-run-abc123';
  const dir = path.join(root, id);
  await fs.mkdir(path.join(dir, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(dir, 'agent-summary.json'), JSON.stringify({ id, name: 'fixture', status: 'passed', endedAt: '2026-08-17T02:00:00Z' }));
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ id, name: 'fixture', status: 'passed', events: [{ type: 'step-pass' }] }));
  await fs.writeFile(path.join(dir, 'screenshots', 'shot.png'), 'png');
  return { root, id, dir };
}

test('evidence history lists finalized runs and reads every retained file', async () => {
  const { root, id } = await fixture();
  try {
    const list = await listEvidence({ root });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    const item = await readEvidence(id, { root });
    assert.equal(item.result.status, 'passed');
    assert.deepEqual(item.files.map(file => file.path).sort(), ['agent-summary.json', 'result.json', 'screenshots/shot.png']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('evidence file paths cannot escape the selected run', async () => {
  const { root, id } = await fixture();
  try {
    assert.throws(() => evidenceFilePath(id, '../outside.txt', { root }), /Invalid evidence file path/);
    assert.throws(() => evidenceFilePath('../bad', 'result.json', { root }), /Invalid evidence id/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('text evidence can be read with an explicit byte ceiling', async () => {
  const { root, id } = await fixture();
  try {
    const text = await readEvidenceText(id, 'result.json', { root, maxBytes: 4096 });
    assert.match(text, /step-pass/);
    await assert.rejects(readEvidenceText(id, 'result.json', { root, maxBytes: 1 }), /exceeds 1 bytes/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
