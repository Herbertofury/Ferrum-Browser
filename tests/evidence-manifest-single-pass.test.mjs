import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyEvidence, writeEvidenceManifest } from '../src/core/evidence-store.mjs';

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

test('single-pass evidence descriptors preserve exact bytes and digests for large evidence sets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-single-pass-'));
  const id = 'single-pass-fixture';
  const dir = path.join(root, id);
  try {
    await fs.mkdir(path.join(dir, 'nested'), { recursive: true });
    const expected = new Map();
    for (let index = 0; index < 300; index += 1) {
      const relative = index === 299 ? 'nested/multi-chunk.bin' : `nested/${String(index).padStart(3, '0')}.bin`;
      const size = index === 299 ? 256 * 1024 + 137 : 1024 + index * 7;
      const bytes = Buffer.alloc(size, (index % 255) + 1);
      const file = path.join(dir, relative);
      await fs.writeFile(file, bytes);
      expected.set(relative, { bytes: bytes.length, digest: digest(bytes) });
    }

    const manifest = await writeEvidenceManifest(dir);
    assert.equal(manifest.totalFiles, expected.size);
    assert.equal(manifest.totalBytes, [...expected.values()].reduce((sum, item) => sum + item.bytes, 0));
    for (const descriptor of manifest.files) {
      const reference = expected.get(descriptor.path);
      assert.ok(reference, `unexpected manifest path ${descriptor.path}`);
      assert.equal(descriptor.bytes, reference.bytes, `${descriptor.path} byte count`);
      assert.equal(descriptor.digest, reference.digest, `${descriptor.path} digest`);
    }

    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ id, status: 'passed' }));
    await writeEvidenceManifest(dir);
    const verified = await verifyEvidence(id, { root });
    assert.equal(verified.status, 'passed');
    assert.deepEqual(verified.issues, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
