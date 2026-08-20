import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { evidenceFilePath, listEvidence, readEvidence, readEvidenceText, verifyEvidence, writeEvidenceManifest } from '../src/core/evidence-store.mjs';

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
    assert.equal(item.manifest, null);
    assert.deepEqual(item.files.map(file => file.path).sort(), ['agent-summary.json', 'result.json', 'screenshots/shot.png']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('evidence history bounded parallel scan returns every finalized run and skips incomplete entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-list-'));
  const count = 96;
  try {
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const id = `run-${String(index).padStart(3, '0')}`;
      const dir = path.join(root, id);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'agent-summary.json'), JSON.stringify({
        id,
        status: index % 2 ? 'passed' : 'failed',
        endedAt: new Date(Date.UTC(2026, 7, 18, 0, 0, index)).toISOString()
      }));
    }));
    await fs.mkdir(path.join(root, 'incomplete-run'));
    await fs.mkdir(path.join(root, 'malformed-run'));
    await fs.writeFile(path.join(root, 'malformed-run', 'agent-summary.json'), '{', 'utf8');

    const list = await listEvidence({ root });
    assert.equal(list.length, count);
    assert.equal(new Set(list.map(item => item.id)).size, count);
    assert.equal(list[0].id, `run-${String(count - 1).padStart(3, '0')}`);
    assert.equal(list.at(-1).id, 'run-000');
    assert.ok(list.every(item => /^run-\d{3}$/.test(item.id)));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('finalized evidence gets a content-addressed manifest that detects tampering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-integrity-'));
  try {
    const writer = await new EvidenceWriter({ root, name: 'integrity-fixture' }).init();
    await writer.writeText('logs/output.log', 'verified output\n');
    await writer.finalize({ status: 'passed' });

    const item = await readEvidence(writer.id, { root });
    assert.equal(item.manifest.algorithm, 'sha256');
    assert.ok(item.manifest.totalFiles >= 3);
    assert.match(item.manifestDescriptor.digest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(item.files.some(file => file.path === 'evidence-manifest.json'));
    assert.ok(item.manifest.files.some(file => file.path === 'logs/output.log' && file.mediaType === 'text/plain'));

    const verified = await verifyEvidence(writer.id, { root });
    assert.equal(verified.status, 'passed');
    assert.deepEqual(verified.issues, []);

    await fs.writeFile(path.join(writer.dir, 'logs', 'output.log'), 'tampered output\n', 'utf8');
    const tampered = await verifyEvidence(writer.id, { root });
    assert.equal(tampered.status, 'failed');
    assert.ok(tampered.issues.some(issue => issue.path === 'logs/output.log' && issue.kind === 'digest-mismatch'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('evidence manifest descriptors cover every nested file exactly once in deterministic order', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-descriptors-'));
  const id = 'parallel-descriptor-fixture';
  const dir = path.join(root, id);
  const fileCount = 257;
  try {
    await fs.mkdir(dir, { recursive: true });
    const writes = [];
    for (let index = 0; index < fileCount; index += 1) {
      const shard = path.join(dir, 'nested', String(index % 17).padStart(2, '0'));
      await fs.mkdir(shard, { recursive: true });
      writes.push(fs.writeFile(path.join(shard, `${String(index).padStart(4, '0')}.txt`), `payload-${index}\n`, 'utf8'));
    }
    await Promise.all(writes);

    const manifest = await writeEvidenceManifest(dir);
    const paths = manifest.files.map(file => file.path);
    assert.equal(manifest.totalFiles, fileCount);
    assert.equal(new Set(paths).size, fileCount);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(manifest.files.every(file => /^sha256:[a-f0-9]{64}$/.test(file.digest)));
    assert.ok(manifest.files.every(file => file.mediaType === 'text/plain'));

    const verified = await verifyEvidence(id, { root });
    assert.equal(verified.status, 'passed');
    assert.equal(verified.checkedFiles, fileCount);
    assert.deepEqual(verified.issues, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('legacy evidence without a manifest reports unverifiable instead of fake success', async () => {
  const { root, id } = await fixture();
  try {
    const result = await verifyEvidence(id, { root });
    assert.equal(result.status, 'unverifiable');
    assert.equal(result.manifestPresent, false);
    assert.deepEqual(result.issues, [{ kind: 'manifest-missing', path: 'evidence-manifest.json' }]);
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
