import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandVariables, loadSpec } from '../src/core/spec.mjs';
import { loadWorkloadPack, runWorkloadPack, summarizePackRuns } from '../src/core/workload-pack.mjs';

async function tempDir() { return await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-pack-test-')); }

test('explicit spec variables expand recursively and missing variables fail loudly', () => {
  const value = expandVariables({ path: '${VAR:ROOT}/dist', nested: ['${ENV:ROOT}/file'] }, { ROOT: '/tmp/project' });
  assert.deepEqual(value, { path: '/tmp/project/dist', nested: ['/tmp/project/file'] });
  assert.throws(() => expandVariables('${VAR:MISSING}/dist', {}), /required variable MISSING is not set/);
});

test('loadSpec expands variables before resolving target paths', async () => {
  const root = await tempDir();
  try {
    const specPath = path.join(root, 'spec.json');
    await fs.writeFile(specPath, JSON.stringify({
      version: 1,
      name: 'variable-spec',
      target: { type: 'extension', path: '${VAR:EXTENSION_DIR}' },
      steps: []
    }));
    const spec = await loadSpec(specPath, { variables: { EXTENSION_DIR: path.join(root, 'extension') } });
    assert.equal(spec.target.path, path.join(root, 'extension'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('standalone GameSync production pack invokes the canonical build script', async () => {
  const root = path.resolve('packs');
  const fakeRepo = await tempDir();
  try {
    const pack = await loadWorkloadPack(path.join(root, 'gamesync-current-extension.pack.json'), { variables: { GAMESYNC_REPO: fakeRepo } });
    assert.equal(pack.setup.length, 1);
    assert.equal(pack.setup[0].command, 'npm');
    assert.deepEqual(pack.setup[0].args, ['run', 'build']);
    assert.equal(pack.setup[0].cwd, fakeRepo);
  } finally { await fs.rm(fakeRepo, { recursive: true, force: true }); }
});

test('workload pack metrics preserve complete target, step, transition, timing and evidence accounting', () => {
  const metrics = summarizePackRuns([
    { status: 'passed', targetType: 'web', steps: 4, durationMs: 10, evidenceId: 'web-1', evidenceDir: '/e/web-1' },
    { status: 'passed', targetType: 'process', steps: 3, durationMs: 20, evidenceId: 'proc-1', evidenceDir: '/e/proc-1' },
    { status: 'failed', targetType: 'web', steps: 5, durationMs: 30, evidenceDir: '/e/web-2' }
  ]);

  assert.equal(metrics.specCount, 3);
  assert.equal(metrics.totalSteps, 12);
  assert.deepEqual(metrics.targetTypes, ['web', 'process']);
  assert.deepEqual(metrics.targetTypeCounts, { web: 2, process: 1 });
  assert.equal(metrics.targetTypeTransitions, 2);
  assert.equal(metrics.totalSpecDurationMs, 60);
  assert.deepEqual(metrics.evidence, {
    evidenceDirsRetained: 3,
    passedWithEvidence: 2,
    failedWithEvidence: 1
  });
});

test('workload pack runs real setup and member specs with parent and child evidence', async () => {
  const root = await tempDir();
  try {
    const specPath = path.join(root, 'process.json');
    const packPath = path.join(root, 'pack.json');
    const artifacts = path.join(root, 'artifacts');
    await fs.writeFile(specPath, JSON.stringify({
      version: 1,
      name: 'pack-process',
      target: { type: 'process', command: '${VAR:NODE_BIN}', args: ['-e', "console.log('pack member ok')"] },
      steps: [{ action: 'assert-log', text: 'pack member ok' }, { action: 'wait-exit', code: 0 }]
    }));
    await fs.writeFile(packPath, JSON.stringify({
      version: 1,
      name: 'fixture-pack',
      requiredVariables: ['NODE_BIN'],
      setup: [{ command: '${VAR:NODE_BIN}', args: ['-e', "console.log('setup ok')"], cwd: '.', timeoutMs: 10000 }],
      specs: ['process.json']
    }));
    const loaded = await loadWorkloadPack(packPath, { variables: { NODE_BIN: process.execPath } });
    assert.equal(loaded.setup[0].command, process.execPath);
    const result = await runWorkloadPack(packPath, { artifactsRoot: artifacts, variables: { NODE_BIN: process.execPath } });
    assert.equal(result.status, 'passed');
    assert.equal(result.result.passed, 1);
    assert.equal(result.result.failed, 0);
    assert.equal(result.result.setup.length, 1);
    assert.equal(result.result.specs.length, 1);
    assert.equal(result.result.specs[0].status, 'passed');
    assert.equal(result.result.specs[0].targetType, 'process');
    assert.equal(result.result.specs[0].steps, 2);
    assert.ok(result.result.specs[0].durationMs >= 0);
    assert.deepEqual(result.result.metrics.targetTypes, ['process']);
    assert.deepEqual(result.result.metrics.targetTypeCounts, { process: 1 });
    assert.equal(result.result.metrics.specCount, 1);
    assert.equal(result.result.metrics.totalSteps, 2);
    assert.equal(result.result.metrics.targetTypeTransitions, 0);
    assert.equal(result.result.metrics.evidence.evidenceDirsRetained, 1);
    assert.equal(result.result.metrics.evidence.passedWithEvidence, 1);
    await fs.access(path.join(result.evidenceDir, 'setup', '0.log'));
    await fs.access(result.result.specs[0].evidenceDir);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
