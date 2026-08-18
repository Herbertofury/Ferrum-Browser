import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memoryDir = path.join(repoRoot, '.agents-memory');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeVerifiedCheckpoint(entry) {
  const verifiedProduct = entry?.verifiedProduct;
  const verifiedWorkflowRun = Number(
    verifiedProduct?.mainWorkflowRun ?? verifiedProduct?.workflowRun ?? verifiedProduct?.ciRun ?? 0
  );
  if (verifiedProduct?.commit && Number.isSafeInteger(verifiedWorkflowRun) && verifiedWorkflowRun > 0) {
    return {
      commit: verifiedProduct.commit,
      workflowRun: verifiedWorkflowRun,
      verifiedAt: verifiedProduct?.verifiedAt ?? null,
    };
  }

  const improvement = entry?.improvement;
  const improvementWorkflowRun = Number(improvement?.mainRun ?? 0);
  if (improvement?.product && Number.isSafeInteger(improvementWorkflowRun) && improvementWorkflowRun > 0) {
    return {
      commit: improvement.product,
      workflowRun: improvementWorkflowRun,
      verifiedAt: improvement?.verifiedAt ?? null,
    };
  }

  const product = entry?.product;
  const proposalWorkflowRun = Number(entry?.proposal?.workflowRun ?? 0);
  if (product?.commit && product?.treeMatchesVerifiedProposal === true && Number.isSafeInteger(proposalWorkflowRun) && proposalWorkflowRun > 0) {
    return {
      commit: product.commit,
      workflowRun: proposalWorkflowRun,
      verifiedAt: product?.verifiedAt ?? null,
    };
  }

  return null;
}

test('checkpoint normalization recognizes verified product evolution schemas', () => {
  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: { commit: 'verified-product', mainWorkflowRun: 42, verifiedAt: '2026-08-17T20:27:14Z' },
    }),
    { commit: 'verified-product', workflowRun: 42, verifiedAt: '2026-08-17T20:27:14Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      improvement: { product: 'improvement-product', mainRun: 43, verifiedAt: '2026-08-17T21:32:30Z' },
    }),
    { commit: 'improvement-product', workflowRun: 43, verifiedAt: '2026-08-17T21:32:30Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: { commit: 'ci-run-product', ciRun: 44, verifiedAt: '2026-08-17T22:10:29Z' },
    }),
    { commit: 'ci-run-product', workflowRun: 44, verifiedAt: '2026-08-17T22:10:29Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      proposal: { workflowRun: 45 },
      product: { commit: 'tree-matched-product', treeMatchesVerifiedProposal: true, verifiedAt: '2026-08-18T00:01:10Z' },
    }),
    { commit: 'tree-matched-product', workflowRun: 45, verifiedAt: '2026-08-18T00:01:10Z' },
  );
});

test('STATUS points at the newest verified Ferrum product checkpoint', async () => {
  const status = await readJson(path.join(memoryDir, 'STATUS.json'));
  const files = (await fs.readdir(memoryDir))
    .filter(name => name.endsWith('.json') && name !== 'STATUS.json');

  const checkpoints = [];
  for (const name of files) {
    const entry = await readJson(path.join(memoryDir, name));
    const checkpoint = normalizeVerifiedCheckpoint(entry);
    if (checkpoint) {
      checkpoints.push({ name, ...checkpoint });
    }
  }

  assert.ok(checkpoints.length > 0, 'expected at least one verified evolution checkpoint');
  checkpoints.sort((a, b) => b.workflowRun - a.workflowRun || a.name.localeCompare(b.name));
  const latest = checkpoints[0];

  assert.equal(
    status.verifiedWorkflowRun,
    latest.workflowRun,
    `STATUS workflow ${status.verifiedWorkflowRun} lags newest verified evolution workflow ${latest.workflowRun} from ${latest.name}`
  );
  assert.equal(
    status.verifiedCodeCommit,
    latest.commit,
    `STATUS commit ${status.verifiedCodeCommit} does not match newest verified evolution product ${latest.commit} from ${latest.name}`
  );
  assert.equal(status.verified.latestBuildArtifacts.workflowRun, status.verifiedWorkflowRun);
  assert.equal(status.verified.latestBuildArtifacts.codeCommit, status.verifiedCodeCommit);

  if (latest.verifiedAt && status.verifiedAt) {
    assert.ok(
      Date.parse(status.verifiedAt) >= Date.parse(latest.verifiedAt),
      `STATUS verifiedAt ${status.verifiedAt} predates newest product verification ${latest.verifiedAt}`
    );
  }
});

test('package manifest matches verified toolchain or an explicit Stack candidate', async () => {
  const status = await readJson(path.join(memoryDir, 'STATUS.json'));
  const packageJson = await readJson(path.join(repoRoot, 'package.json'));
  const candidate = await readOptionalJson(path.join(memoryDir, 'STACK_CANDIDATE.json'));
  const actualToolchain = {
    playwright: packageJson.dependencies.playwright,
    electron: packageJson.devDependencies.electron,
    electronPackager: packageJson.devDependencies['@electron/packager'],
  };

  if (JSON.stringify(actualToolchain) === JSON.stringify(status.verifiedToolchain)) {
    assert.equal(candidate, null, 'verified package toolchain must not retain a verification-in-progress Stack candidate marker');
    return;
  }

  assert.ok(candidate, 'unverified package toolchain drift requires .agents-memory/STACK_CANDIDATE.json');
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.projectId, 'ferrum-browser');
  assert.equal(candidate.checkpointType, 'stack-candidate');
  assert.equal(candidate.state, 'verification-in-progress');
  assert.deepEqual(candidate.baseVerifiedToolchain, status.verifiedToolchain);
  assert.deepEqual(candidate.proposedToolchain, actualToolchain);
});
