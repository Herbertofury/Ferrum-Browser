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

function isSuccess(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'success' || normalized === 'all success' || normalized === 'passed';
}

function workflowFromArray(workflows, name) {
  if (!Array.isArray(workflows)) return null;
  const wanted = String(name).trim().toLowerCase();
  return workflows.find((workflow) => String(workflow?.name ?? '').trim().toLowerCase() === wanted) ?? null;
}

function normalizeVerifiedCheckpoint(entry) {
  const verifiedProduct = entry?.verifiedProduct;
  const proposal = entry?.proposal;
  const verification = entry?.verification;

  const modernCi = workflowFromArray(verification?.workflows, 'Ferrum CI');
  const modernWorkflowRun = Number(modernCi?.runId ?? modernCi?.workflowRun ?? 0);
  const modernVerifiedProof =
    String(entry?.decision ?? '').toUpperCase().includes('VERIFIED') &&
    verifiedProduct?.commit &&
    typeof verifiedProduct?.tree === 'string' && verifiedProduct.tree.length > 0 &&
    verifiedProduct?.proposalTreeParity === true &&
    typeof proposal?.head === 'string' && proposal.head.length > 0 &&
    typeof proposal?.tree === 'string' && proposal.tree === verifiedProduct.tree &&
    isSuccess(modernCi?.conclusion) &&
    Number.isSafeInteger(modernWorkflowRun) &&
    modernWorkflowRun > 0;
  if (modernVerifiedProof) {
    return {
      commit: verifiedProduct.commit,
      workflowRun: modernWorkflowRun,
      verifiedAt: entry?.checkedAt ?? verifiedProduct?.verifiedAt ?? null,
    };
  }

  const verificationWorkflowRun = Number(verification?.workflowRun ?? 0);
  const verificationProof =
    verifiedProduct?.commit &&
    typeof verifiedProduct?.tree === 'string' && verifiedProduct.tree.length > 0 &&
    typeof verifiedProduct?.testedProposalHead === 'string' && verifiedProduct.testedProposalHead.length > 0 &&
    verifiedProduct?.treeParity === true &&
    isSuccess(verification?.workflowConclusion) &&
    Number.isSafeInteger(verificationWorkflowRun) &&
    verificationWorkflowRun > 0;
  const directVerifiedWorkflowRun =
    verifiedProduct?.mainWorkflowRun ?? verifiedProduct?.workflowRun ?? verifiedProduct?.latestFullGate ?? verifiedProduct?.ciRun ?? verifiedProduct?.proposalRun ??
    (verificationProof ? verificationWorkflowRun : undefined);
  const siblingProposalWorkflowRun = Number(proposal?.workflowRun ?? 0);
  const siblingProposalProof =
    verifiedProduct?.commit &&
    typeof verifiedProduct?.treeSha === 'string' && verifiedProduct.treeSha.length > 0 &&
    typeof proposal?.treeSha === 'string' && proposal.treeSha.length > 0 &&
    verifiedProduct.treeSha === proposal.treeSha &&
    isSuccess(proposal?.workflowConclusion) &&
    Number.isSafeInteger(siblingProposalWorkflowRun) &&
    siblingProposalWorkflowRun > 0;
  const verifiedWorkflowRun = Number(
    directVerifiedWorkflowRun ?? (siblingProposalProof ? siblingProposalWorkflowRun : 0)
  );
  const mergedProof = String(verifiedProduct?.proposalConclusion ?? verifiedProduct?.ci ?? '').toLowerCase();
  const verifiedCommit = verifiedProduct?.commit ?? (
    verifiedProduct?.mergedCommit &&
    verifiedProduct?.treeMatches === true &&
    mergedProof === 'success'
      ? verifiedProduct.mergedCommit
      : null
  );
  if (verifiedCommit && Number.isSafeInteger(verifiedWorkflowRun) && verifiedWorkflowRun > 0) {
    return {
      commit: verifiedCommit,
      workflowRun: verifiedWorkflowRun,
      verifiedAt: verifiedProduct?.verifiedAt ?? null,
    };
  }

  const verifiedImprovement = entry?.verifiedImprovement;
  const verifiedImprovementWorkflowRun = Number(verifiedImprovement?.proposalCiRun ?? 0);
  const verifiedImprovementProof =
    verifiedImprovement?.productCommit &&
    verifiedImprovement?.treeMatchesVerifiedProposal === true &&
    typeof verifiedImprovement?.productTree === 'string' && verifiedImprovement.productTree.length > 0 &&
    typeof verifiedImprovement?.proposalTree === 'string' && verifiedImprovement.proposalTree.length > 0 &&
    verifiedImprovement.productTree === verifiedImprovement.proposalTree &&
    isSuccess(verifiedImprovement?.proposalCiConclusion) &&
    Number.isSafeInteger(verifiedImprovementWorkflowRun) &&
    verifiedImprovementWorkflowRun > 0;
  if (verifiedImprovementProof) {
    return {
      commit: verifiedImprovement.productCommit,
      workflowRun: verifiedImprovementWorkflowRun,
      verifiedAt: verifiedImprovement?.verifiedAt ?? null,
    };
  }

  const improvement = entry?.improvement;
  const improvementProof = improvement?.proof ?? entry?.proof ?? {};
  const improvementWorkflowRun = Number(improvementProof?.workflows?.ci ?? improvement?.mainRun ?? 0);
  const improvementTree = improvement?.mergedTree ?? improvement?.tree;
  const improvementExactTreeProof =
    improvement?.product &&
    typeof improvement?.proposal === 'string' && improvement.proposal.length > 0 &&
    typeof improvementTree === 'string' && improvementTree.length > 0 &&
    improvement?.treeParity === true &&
    isSuccess(improvementProof?.conclusion) &&
    Number.isSafeInteger(improvementWorkflowRun) &&
    improvementWorkflowRun > 0;
  if (improvementExactTreeProof) {
    return {
      commit: improvement.product,
      workflowRun: improvementWorkflowRun,
      verifiedAt: improvement?.verifiedAt ?? entry?.checkedAt ?? null,
    };
  }
  if (improvement?.product && Number.isSafeInteger(improvementWorkflowRun) && improvementWorkflowRun > 0 && improvement?.mainRun) {
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

  const finalVerifiedProduct = entry?.finalVerifiedProduct;
  const finalVerifiedWorkflowRun = Number(finalVerifiedProduct?.workflowRun ?? finalVerifiedProduct?.workflow ?? 0);
  const finalVerifiedModernProof =
    finalVerifiedProduct?.product &&
    typeof finalVerifiedProduct?.tree === 'string' && finalVerifiedProduct.tree.length > 0 &&
    typeof finalVerifiedProduct?.proposal === 'string' && finalVerifiedProduct.proposal.length > 0 &&
    finalVerifiedProduct?.treeParity === true &&
    isSuccess(finalVerifiedProduct?.workflowConclusion ?? finalVerifiedProduct?.proof?.conclusion) &&
    Number.isSafeInteger(finalVerifiedWorkflowRun) &&
    finalVerifiedWorkflowRun > 0;
  const finalVerifiedLegacyProof =
    finalVerifiedProduct?.commit &&
    typeof finalVerifiedProduct?.tree === 'string' && finalVerifiedProduct.tree.length > 0 &&
    typeof finalVerifiedProduct?.proposalHead === 'string' && finalVerifiedProduct.proposalHead.length > 0 &&
    Number.isSafeInteger(finalVerifiedWorkflowRun) &&
    finalVerifiedWorkflowRun > 0;
  if (finalVerifiedModernProof || finalVerifiedLegacyProof) {
    return {
      commit: finalVerifiedProduct.product ?? finalVerifiedProduct.commit,
      workflowRun: finalVerifiedWorkflowRun,
      verifiedAt: finalVerifiedProduct?.verifiedAt ?? entry?.checkedAt ?? null,
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
      state: 'VERIFIED_IMPROVEMENT_MERGED',
      checkedAt: '2026-08-19T06:00:00Z',
      improvement: {
        product: 'run39-product',
        proposal: 'run39-proposal',
        tree: 'run39-tree',
        mergedTree: 'run39-tree',
        treeParity: true,
        proof: { workflows: { ci: 431 }, conclusion: 'all success' },
      },
    }),
    { commit: 'run39-product', workflowRun: 431, verifiedAt: '2026-08-19T06:00:00Z' },
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      state: 'VERIFIED_IMPROVEMENT_MERGED',
      improvement: {
        product: 'bad-run39-product',
        proposal: 'bad-run39-proposal',
        tree: 'one-tree',
        mergedTree: 'different-tree',
        treeParity: false,
        proof: { workflows: { ci: 432 }, conclusion: 'all success' },
      },
    }),
    null,
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: { commit: 'ci-run-product', ciRun: 44, verifiedAt: '2026-08-17T22:10:29Z' },
    }),
    { commit: 'ci-run-product', workflowRun: 44, verifiedAt: '2026-08-17T22:10:29Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        mergedCommit: 'proposal-run-product',
        proposalRun: 45,
        proposalConclusion: 'success',
        treeMatches: true,
      },
    }),
    { commit: 'proposal-run-product', workflowRun: 45, verifiedAt: null },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        mergedCommit: 'merged-ci-product',
        ciRun: 46,
        ci: 'success',
        treeMatches: true,
      },
    }),
    { commit: 'merged-ci-product', workflowRun: 46, verifiedAt: null },
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        mergedCommit: 'unproven-merged-product',
        proposalRun: 47,
        proposalConclusion: 'failure',
        treeMatches: true,
      },
    }),
    null,
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      proposal: { workflowRun: 48 },
      product: { commit: 'tree-matched-product', treeMatchesVerifiedProposal: true, verifiedAt: '2026-08-18T00:01:10Z' },
    }),
    { commit: 'tree-matched-product', workflowRun: 48, verifiedAt: '2026-08-18T00:01:10Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedImprovement: {
        productCommit: 'verified-improvement-product',
        productTree: 'verified-improvement-tree',
        proposalTree: 'verified-improvement-tree',
        treeMatchesVerifiedProposal: true,
        proposalCiRun: 49,
        proposalCiConclusion: 'success',
      },
    }),
    { commit: 'verified-improvement-product', workflowRun: 49, verifiedAt: null },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      proposal: {
        workflowRun: 50,
        workflowConclusion: 'success',
        treeSha: 'nested-proposal-tree',
      },
      verifiedProduct: {
        commit: 'nested-proposal-product',
        treeSha: 'nested-proposal-tree',
        verifiedAt: '2026-08-18T08:04:43Z',
      },
    }),
    { commit: 'nested-proposal-product', workflowRun: 50, verifiedAt: '2026-08-18T08:04:43Z' },
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      proposal: {
        workflowRun: 51,
        workflowConclusion: 'success',
        treeSha: 'proposal-tree',
      },
      verifiedProduct: {
        commit: 'tree-mismatch-product',
        treeSha: 'different-tree',
      },
    }),
    null,
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      verifiedImprovement: {
        productCommit: 'failed-improvement-product',
        productTree: 'same-tree',
        proposalTree: 'same-tree',
        treeMatchesVerifiedProposal: true,
        proposalCiRun: 52,
        proposalCiConclusion: 'failure',
      },
    }),
    null,
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      checkedAt: '2026-08-18T17:25:18Z',
      finalVerifiedProduct: {
        commit: 'final-product',
        tree: 'final-tree',
        proposalHead: 'final-proposal',
        workflow: 53,
      },
    }),
    { commit: 'final-product', workflowRun: 53, verifiedAt: '2026-08-18T17:25:18Z' },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      checkedAt: '2026-08-19T08:53:30Z',
      finalVerifiedProduct: {
        product: 'run40-product',
        proposal: 'run40-proposal',
        tree: 'run40-tree',
        workflowRun: 54,
        workflowConclusion: 'success',
        treeParity: true,
        proof: { conclusion: 'all success', workflows: { ci: 54 } },
      },
    }),
    { commit: 'run40-product', workflowRun: 54, verifiedAt: '2026-08-19T08:53:30Z' },
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      finalVerifiedProduct: {
        product: 'unproven-run40-product',
        proposal: 'run40-proposal',
        tree: 'run40-tree',
        workflowRun: 54,
        workflowConclusion: 'failure',
        treeParity: true,
      },
    }),
    null,
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        commit: 'run36-product',
        tree: 'run36-tree',
        testedProposalHead: 'run36-proposal',
        treeParity: true,
      },
      verification: { workflowRun: 55, workflowConclusion: 'success' },
    }),
    { commit: 'run36-product', workflowRun: 55, verifiedAt: null },
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        commit: 'unproven-run36-product',
        tree: 'run36-tree',
        testedProposalHead: 'run36-proposal',
        treeParity: true,
      },
      verification: { workflowRun: 56, workflowConclusion: 'failure' },
    }),
    null,
  );

  assert.equal(
    normalizeVerifiedCheckpoint({
      finalVerifiedProduct: {
        commit: 'unproven-final-product',
        proposalHead: 'final-proposal',
        workflow: 54,
      },
    }),
    null,
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      verifiedProduct: {
        commit: 'latest-full-gate-product',
        tree: 'latest-full-gate-tree',
        latestFullGate: 55,
        productCodeChangedThisRun: false,
      },
    }),
    { commit: 'latest-full-gate-product', workflowRun: 55, verifiedAt: null },
  );

  assert.deepEqual(
    normalizeVerifiedCheckpoint({
      decision: 'MERGED_VERIFIED_IMPROVEMENT',
      checkedAt: '2026-08-19T21:35:00-06:00',
      proposal: { head: 'run63-proposal', tree: 'run63-tree' },
      verifiedProduct: { commit: 'run63-product', tree: 'run63-tree', proposalTreeParity: true },
      improvement: { name: 'descriptive metadata' },
      verification: {
        workflows: [
          { name: 'Ferrum CI', runId: 63, conclusion: 'success' },
          { name: 'Perfetto Trace Compatibility', runId: 64, conclusion: 'success' },
        ],
      },
    }),
    { commit: 'run63-product', workflowRun: 63, verifiedAt: '2026-08-19T21:35:00-06:00' },
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