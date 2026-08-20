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

function ensureCommitAvailable(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return;
  } catch {
    // A shallow PR checkout can contain merged products from main without the
    // original exact proposal commit. Fetch only the recorded immutable commit
    // so exact proposal-tree verification remains strong instead of silently
    // dropping the newest verified evolution candidate.
  }
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', sha], {
    cwd: root,
    stdio: 'ignore',
  });
  git(['cat-file', '-e', `${sha}^{commit}`]);
}

function successful(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'success' || normalized === 'all success' || normalized === 'passed';
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function workflowProofKey(name, index) {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (normalized === 'ferrum ci' || normalized.includes('ferrum ci')) return 'ci';
  if (normalized.includes('evidence') && normalized.includes('benchmark')) return 'evidenceBenchmark';
  if (normalized.includes('perfetto')) return 'perfetto';
  if (normalized.includes('stateful') && normalized.includes('api')) return 'statefulApi';
  if (normalized.includes('network') && normalized.includes('fault')) return 'networkFault';
  if (normalized.includes('service') && normalized.includes('fixture')) return 'serviceFixture';
  if (normalized.includes('native') && normalized.includes('windows')) return 'nativeWindows';
  if (normalized.includes('tauri')) return 'tauri';
  return `workflow${index}`;
}

function normalizeWorkflowProofs(rawWorkflows) {
  if (!Array.isArray(rawWorkflows)) return rawWorkflows && typeof rawWorkflows === 'object' ? rawWorkflows : {};
  const normalized = {};
  for (const [index, workflow] of rawWorkflows.entries()) {
    if (!workflow || typeof workflow !== 'object') continue;
    const runId = Number(firstDefined(workflow.runId, workflow.workflowRun, workflow.id));
    if (!Number.isFinite(runId) || runId <= 0) continue;
    const key = workflowProofKey(workflow.name, index);
    normalized[key] = runId;
    const conclusion = firstDefined(workflow.conclusion, workflow.workflowConclusion, workflow.result);
    if (conclusion !== undefined) normalized[`${key}Conclusion`] = conclusion;
  }
  return normalized;
}

function candidateFrom(record, filename) {
  const entry = record.improvement ?? record.verifiedProduct ?? record.finalVerifiedProduct ?? record.verifiedImprovement;
  if (!entry || typeof entry !== 'object') return null;
  if (!String(record.state ?? record.decision ?? entry.state ?? '').toUpperCase().includes('VERIFIED')) return null;
  const proof = entry.proof ?? record.proof ?? {};
  const verification = entry.verification ?? record.verification ?? {};
  const workflows = normalizeWorkflowProofs(proof.workflows ?? verification.workflows ?? {});
  const product = entry.product ?? entry.commit ?? entry.codeCommit ?? entry.verifiedCodeCommit;
  const proposal = firstDefined(
    entry.proposal,
    entry.proposalHead,
    entry.verifiedProposalHead,
    verification.proposalHead,
    record.proposal?.head,
    record.proposal?.proposalHead,
  );
  const tree = entry.mergedTree ?? entry.tree ?? entry.verifiedTree ?? verification.tree;
  const workflowRun = Number(
    workflows.ci ?? verification.workflowRun ?? verification.ferrumCiRun ?? entry.workflowRun ?? entry.verifiedWorkflowRun,
  );
  const conclusion = workflows.ciConclusion ?? proof.conclusion ?? verification.workflowConclusion ?? verification.ferrumCiConclusion ?? entry.conclusion;
  if (!product || !proposal || !tree || !Number.isFinite(workflowRun) || !successful(conclusion)) return null;
  const treeParity = firstDefined(
    entry.treeParity,
    entry.proposalTreeParity,
    entry.productTreeParity,
    verification.treeParity,
    record.proposal?.tree && tree ? record.proposal.tree === tree : undefined,
    true,
  );
  if (treeParity === false) return null;
  try {
    ensureCommitAvailable(product);
    ensureCommitAvailable(proposal);
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

test('run-63 workflow arrays retain Ferrum CI and companion identities', () => {
  const workflows = normalizeWorkflowProofs([
    { name: 'Ferrum CI', runId: 101, conclusion: 'success' },
    { name: 'Perfetto Trace Compatibility', runId: 102, conclusion: 'success' },
    { name: 'Ferrum stateful API benchmark', runId: 103, conclusion: 'success' },
  ]);
  assert.deepEqual(workflows, {
    ci: 101,
    ciConclusion: 'success',
    perfetto: 102,
    perfettoConclusion: 'success',
    statefulApi: 103,
    statefulApiConclusion: 'success',
  });
});

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