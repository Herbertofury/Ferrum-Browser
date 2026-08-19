import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { evolutionRunNumber } from '../scripts/evolution-run-number.mjs';

const root = process.cwd();
const memoryDir = path.join(root, '.agents-memory');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function ensureMainHistoryForProvenance() {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'true') return;
  execFileSync('git', ['fetch', '--no-tags', '--unshallow', 'origin', 'main'], {
    cwd: root,
    stdio: 'ignore',
  });
}

function successful(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'success' || normalized === 'all success' || normalized === 'passed';
}

function candidateFrom(record, filename) {
  const entry = record.improvement ?? record.verifiedProduct ?? record.finalVerifiedProduct ?? record.verifiedImprovement;
  if (!entry || typeof entry !== 'object') return null;
  if (!String(record.state ?? entry.state ?? '').toUpperCase().includes('VERIFIED')) return null;
  const proof = entry.proof ?? record.proof ?? {};
  const verification = entry.verification ?? record.verification ?? {};
  const product = entry.product ?? entry.commit ?? entry.codeCommit ?? entry.verifiedCodeCommit;
  const proposal = entry.proposal ?? entry.proposalHead ?? entry.verifiedProposalHead ?? verification.proposalHead;
  const tree = entry.mergedTree ?? entry.tree ?? entry.verifiedTree ?? verification.tree;
  const workflowRun = Number(
    proof.workflows?.ci ?? verification.workflowRun ?? verification.ferrumCiRun ?? entry.workflowRun ?? entry.verifiedWorkflowRun,
  );
  const conclusion = proof.conclusion ?? verification.workflowConclusion ?? verification.ferrumCiConclusion ?? entry.conclusion;
  if (!product || !proposal || !tree || !Number.isFinite(workflowRun) || !successful(conclusion)) return null;
  if (entry.treeParity === false || verification.treeParity === false) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', product, 'HEAD'], { cwd: root, stdio: 'ignore' });
    if (git(['rev-parse', `${product}^{tree}`]) !== tree) return null;
    if (git(['rev-parse', `${proposal}^{tree}`]) !== tree) return null;
  } catch {
    return null;
  }
  return {
    filename,
    run: evolutionRunNumber(record, filename),
    checkedAt: record.checkedAt ?? '',
    product,
    proposal,
    tree,
    workflowRun,
  };
}

test('STATUS points at the newest fully verified exact-tree evolution product', async () => {
  ensureMainHistoryForProvenance();
  const status = JSON.parse(await fs.readFile(path.join(memoryDir, 'STATUS.json'), 'utf8'));
  const names = (await fs.readdir(memoryDir)).filter((name) => /^EVOLUTION_RUN_.*\.json$/u.test(name)).sort();
  const candidates = [];
  for (const filename of names) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(memoryDir, filename), 'utf8'));
    } catch {
      continue;
    }
    const candidate = candidateFrom(record, filename);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.run - b.run || a.checkedAt.localeCompare(b.checkedAt));
  const latest = candidates.at(-1);
  assert.ok(latest, 'expected at least one fully verified evolution product');
  assert.equal(status.verifiedCodeCommit, latest.product);
  assert.equal(Number(status.verifiedWorkflowRun), latest.workflowRun);
  assert.equal(status.verified?.latestBuildArtifacts?.codeCommit, latest.product);
  assert.equal(status.verified?.latestBuildArtifacts?.verifiedProposalHead, latest.proposal);
  assert.equal(status.verified?.latestBuildArtifacts?.verifiedTree, latest.tree);
  assert.equal(status.verified?.latestBuildArtifacts?.treeMatchesMergedProduct, true);
});