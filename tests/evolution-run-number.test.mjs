import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolutionRunNumber } from '../scripts/evolution-run-number.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('evolution run number prefers the explicit legacy run field', () => {
  assert.equal(
    evolutionRunNumber({ run: 41, runId: '2026-08-19-56-verified' }, 'EVOLUTION_RUN_2026-08-19_57.json'),
    41,
  );
});

test('evolution run number derives modern checkpoints from runId', () => {
  assert.equal(evolutionRunNumber({ runId: '2026-08-19-56-verified' }), 56);
});

test('evolution run number falls back to the filename suffix', () => {
  assert.equal(evolutionRunNumber({}, 'EVOLUTION_RUN_2026-08-19_57_VERIFIED.json'), 57);
});

test('run 56 verified checkpoint orders as run 56 instead of run zero', async () => {
  const filename = 'EVOLUTION_RUN_2026-08-19_56_VERIFIED.json';
  const record = JSON.parse(await fs.readFile(path.join(repoRoot, '.agents-memory', filename), 'utf8'));
  assert.equal(record.run, undefined);
  assert.equal(record.runId, '2026-08-19-56-verified');
  assert.equal(evolutionRunNumber(record, filename), 56);
});

test('evolution run number fails closed to zero when no run identity exists', () => {
  assert.equal(evolutionRunNumber({ run: 'not-a-number', runId: 'verified' }, 'EVOLUTION_RUN_UNKNOWN.json'), 0);
});
