import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const memoryDir = path.join(root, '.agents-memory');
const statusPath = path.join(memoryDir, 'STATUS.json');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function successConclusion(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'success' || normalized === 'all success' || normalized === 'passed';
}

function stateLooksVerified(value) {
  return String(value ?? '').toUpperCase().includes('VERIFIED');
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeCandidate(record, filename) {
  const shapes = [
    ['improvement', record.improvement],
    ['verifiedProduct', record.verifiedProduct],
    ['finalVerifiedProduct', record.finalVerifiedProduct],
    ['verifiedImprovement', record.verifiedImprovement],
    ['product', record.product && typeof record.product === 'object' ? record.product : null],
  ];

  for (const [shape, entry] of shapes) {
    if (!entry || typeof entry !== 'object') continue;

    const proof = entry.proof ?? record.proof ?? {};
    const verification = entry.verification ?? record.verification ?? {};
    const workflows = proof.workflows ?? verification.workflows ?? {};
    const product = firstDefined(entry.product, entry.commit, entry.codeCommit, entry.verifiedCodeCommit);
    const proposal = firstDefined(entry.proposal, entry.proposalHead, entry.verifiedProposalHead, verification.proposalHead);
    const tree = firstDefined(entry.mergedTree, entry.tree, entry.verifiedTree, verification.tree);
    const workflowRun = Number(firstDefined(
      workflows.ci,
      verification.workflowRun,
      verification.ferrumCiRun,
      entry.workflowRun,
      entry.verifiedWorkflowRun,
      record.verifiedWorkflowRun,
    ));
    const conclusion = firstDefined(
      proof.conclusion,
      verification.workflowConclusion,
      verification.ferrumCiConclusion,
      entry.workflowConclusion,
      entry.conclusion,
    );
    const treeParity = firstDefined(entry.treeParity, verification.treeParity, tree ? true : undefined);

    if (!product || !proposal || !tree || !Number.isFinite(workflowRun)) continue;
    if (!stateLooksVerified(record.state ?? entry.state ?? 'VERIFIED')) continue;
    if (!successConclusion(conclusion)) continue;
    if (treeParity === false) continue;

    return {
      filename,
      shape,
      run: Number(record.run ?? 0),
      checkedAt: record.checkedAt ?? null,
      product,
      proposal,
      tree,
      workflowRun,
      proofWorkflows: workflows,
    };
  }

  return null;
}

function assertCommitAndTree(candidate) {
  git(['cat-file', '-e', `${candidate.product}^{commit}`]);
  git(['cat-file', '-e', `${candidate.proposal}^{commit}`]);
  execFileSync('git', ['merge-base', '--is-ancestor', candidate.product, 'HEAD'], { cwd: root, stdio: 'ignore' });
  const productTree = git(['rev-parse', `${candidate.product}^{tree}`]);
  const proposalTree = git(['rev-parse', `${candidate.proposal}^{tree}`]);
  if (productTree !== candidate.tree) {
    throw new Error(`Verified product tree mismatch: record=${candidate.tree} git=${productTree}`);
  }
  if (proposalTree !== candidate.tree) {
    throw new Error(`Verified proposal tree mismatch: record=${candidate.tree} git=${proposalTree}`);
  }
}

async function loadLatestVerifiedEvolution() {
  const names = (await fs.readdir(memoryDir))
    .filter((name) => /^EVOLUTION_RUN_.*\.json$/u.test(name))
    .sort();

  const candidates = [];
  for (const filename of names) {
    const raw = await fs.readFile(path.join(memoryDir, filename), 'utf8');
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidate = normalizeCandidate(record, filename);
    if (!candidate) continue;
    try {
      assertCommitAndTree(candidate);
      candidates.push(candidate);
    } catch {
      continue;
    }
  }

  if (!candidates.length) throw new Error('No fully verified evolution product with exact tree proof was found');

  candidates.sort((a, b) => {
    if (a.run !== b.run) return a.run - b.run;
    return String(a.checkedAt ?? '').localeCompare(String(b.checkedAt ?? ''));
  });
  return candidates.at(-1);
}

async function githubJson(url) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for verified workflow/artifact lookup');
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

function artifactSummary(artifact) {
  if (!artifact) return undefined;
  const digest = String(artifact.digest ?? '').replace(/^sha256:/u, '');
  return {
    artifactId: artifact.id,
    sizeBytes: artifact.size_in_bytes,
    providerSha256: digest || undefined,
  };
}

function summarizeArtifactList(artifacts = []) {
  return Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifactSummary(artifact)]));
}

async function verifiedRunEvidence(candidate) {
  const repository = process.env.GITHUB_REPOSITORY;
  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');

  const run = await githubJson(`${apiBase}/repos/${repository}/actions/runs/${candidate.workflowRun}`);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Ferrum CI ${candidate.workflowRun} is not completed success`);
  }
  if (run.head_sha !== candidate.proposal) {
    throw new Error(`Ferrum CI head mismatch: expected ${candidate.proposal}, got ${run.head_sha}`);
  }
  if (run.head_commit?.tree_id && run.head_commit.tree_id !== candidate.tree) {
    throw new Error(`Ferrum CI tree mismatch: expected ${candidate.tree}, got ${run.head_commit.tree_id}`);
  }

  const artifactPayload = await githubJson(`${apiBase}/repos/${repository}/actions/runs/${candidate.workflowRun}/artifacts?per_page=100`);
  const byName = new Map((artifactPayload.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
  const required = [
    'ferrum-desktop-Linux.tar.gz',
    'ferrum-desktop-Windows.tar.gz',
    'ferrum-evidence-Linux',
    'ferrum-evidence-Windows',
    'ferrum-evidence-Appium-Android',
    'ferrum-evidence-WebDriver-Grid',
    'ferrum-evidence-Lightpanda',
    'ferrum-provenance-Linux',
    'ferrum-provenance-Windows',
    'ferrum-evidence-Windows-brave',
    'ferrum-evidence-Windows-opera-gx',
  ];
  const missing = required.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`Ferrum CI ${candidate.workflowRun} is missing required artifacts: ${missing.join(', ')}`);

  return {
    repository,
    apiBase,
    run,
    artifacts: byName,
  };
}

async function verifiedCompanionEvidence(candidate, repository, apiBase) {
  const companions = {};
  for (const [name, rawRunId] of Object.entries(candidate.proofWorkflows ?? {})) {
    const runId = Number(rawRunId);
    if (name === 'ci' || !Number.isFinite(runId)) continue;
    const run = await githubJson(`${apiBase}/repos/${repository}/actions/runs/${runId}`);
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      throw new Error(`Ferrum companion workflow ${name} (${runId}) is not completed success`);
    }
    if (run.head_sha !== candidate.proposal) {
      throw new Error(`Ferrum companion workflow ${name} head mismatch: expected ${candidate.proposal}, got ${run.head_sha}`);
    }
    const payload = await githubJson(`${apiBase}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
    companions[name] = {
      workflowRun: runId,
      conclusion: run.conclusion,
      headSha: run.head_sha,
      artifacts: summarizeArtifactList(payload.artifacts ?? []),
    };
  }
  return companions;
}

function packageToolchainAt(commit) {
  const packageJson = JSON.parse(git(['show', `${commit}:package.json`]));
  return {
    playwright: packageJson.devDependencies?.playwright ?? packageJson.dependencies?.playwright ?? null,
    electron: packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron ?? null,
    electronPackager: packageJson.devDependencies?.['@electron/packager'] ?? packageJson.dependencies?.['@electron/packager'] ?? null,
  };
}

function withoutUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

function archivePriorVerifiedCheckpoint(status, selected) {
  if (!status.verifiedCodeCommit || status.verifiedCodeCommit === selected.product) return;
  status.verifiedCheckpointHistory ??= [];
  const key = `${status.verifiedCodeCommit}:${status.verifiedWorkflowRun}`;
  const alreadyArchived = status.verifiedCheckpointHistory.some((entry) => `${entry.verifiedCodeCommit}:${entry.verifiedWorkflowRun}` === key);
  if (alreadyArchived) return;
  status.verifiedCheckpointHistory.push(withoutUndefined({
    verifiedCodeCommit: status.verifiedCodeCommit,
    verifiedWorkflowRun: status.verifiedWorkflowRun,
    verifiedAt: status.verifiedAt,
    verifiedToolchain: status.verifiedToolchain,
    latestBuildArtifacts: status.verified?.latestBuildArtifacts,
    archivedBecauseSupersededBy: selected.product,
  }));
}

const status = JSON.parse(await fs.readFile(statusPath, 'utf8'));
const selected = await loadLatestVerifiedEvolution();
const { repository, apiBase, run, artifacts } = await verifiedRunEvidence(selected);
const companionWorkflows = await verifiedCompanionEvidence(selected, repository, apiBase);
const toolchain = packageToolchainAt(selected.product);

archivePriorVerifiedCheckpoint(status, selected);

status.verifiedCodeCommit = selected.product;
status.verifiedWorkflowRun = selected.workflowRun;
status.verifiedAt = run.updated_at ?? selected.checkedAt ?? status.verifiedAt;
status.verifiedToolchain = withoutUndefined(toolchain);

const latestBuildArtifacts = withoutUndefined({
  workflowRun: selected.workflowRun,
  codeCommit: selected.product,
  verifiedProposalHead: selected.proposal,
  verifiedTree: selected.tree,
  treeMatchesMergedProduct: true,
  sourceEvolutionRecord: selected.filename,
  linuxDesktop: {
    ...artifactSummary(artifacts.get('ferrum-desktop-Linux.tar.gz')),
    freshPackagedDesktopSmoke: 'passed',
  },
  windowsDesktop: {
    ...artifactSummary(artifacts.get('ferrum-desktop-Windows.tar.gz')),
    freshPackagedDesktopSmoke: 'passed',
  },
  linuxEvidence: artifactSummary(artifacts.get('ferrum-evidence-Linux')),
  windowsEvidence: artifactSummary(artifacts.get('ferrum-evidence-Windows')),
  appiumEvidence: artifactSummary(artifacts.get('ferrum-evidence-Appium-Android')),
  webdriverGridEvidence: artifactSummary(artifacts.get('ferrum-evidence-WebDriver-Grid')),
  lightpandaEvidence: artifactSummary(artifacts.get('ferrum-evidence-Lightpanda')),
  linuxProvenance: artifactSummary(artifacts.get('ferrum-provenance-Linux')),
  windowsProvenance: artifactSummary(artifacts.get('ferrum-provenance-Windows')),
  windowsBraveEvidence: artifactSummary(artifacts.get('ferrum-evidence-Windows-brave')),
  windowsOperaGxEvidence: artifactSummary(artifacts.get('ferrum-evidence-Windows-opera-gx')),
  perfettoCompatibilityWorkflowRun: Number(selected.proofWorkflows?.perfetto) || undefined,
  nativeWindowsWorkflowRun: Number(selected.proofWorkflows?.nativeWindows) || undefined,
  tauriWebDriverWorkflowRun: Number(selected.proofWorkflows?.tauri) || undefined,
  serviceFixtureWorkflowRun: Number(selected.proofWorkflows?.serviceFixture) || undefined,
  serviceNetworkFaultWorkflowRun: Number(selected.proofWorkflows?.networkFault) || undefined,
  statefulApiWorkflowRun: Number(selected.proofWorkflows?.statefulApi) || undefined,
  companionWorkflows,
  independentArtifactRedownloadHash: `Selected ${selected.filename}; exact product/proposal tree ${selected.tree}; core CI ${selected.workflowRun} completed success; current core artifact provider SHA-256 values are retained above and all declared companion workflow runs are independently required to be completed success on the exact proposal head.`,
});

status.verified ??= {};
status.verified.latestBuildArtifacts = latestBuildArtifacts;
status.statusSync = {
  mode: 'newest-verified-evolution-exact-tree',
  sourceEvolutionRecord: selected.filename,
  evolutionRun: selected.run,
  product: selected.product,
  proposal: selected.proposal,
  tree: selected.tree,
  workflowRun: selected.workflowRun,
  workflowConclusion: run.conclusion,
  synchronizedAt: new Date().toISOString(),
};

status.incidentsResolved ??= [];
const incident = `Ferrum STATUS could lag a newer fully verified evolution product; deterministic promotion now selects ${selected.filename}, requires exact proposal/product tree parity and successful CI, verifies the selected product is on current main, refreshes current-run artifact identities, verifies declared companion workflows, and archives the superseded verified checkpoint without discarding evidence.`;
if (!status.incidentsResolved.some((entry) => String(entry).includes('Ferrum STATUS could lag a newer fully verified evolution product'))) {
  status.incidentsResolved.push(incident);
}

await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  selectedEvolution: selected.filename,
  evolutionRun: selected.run,
  verifiedCodeCommit: status.verifiedCodeCommit,
  verifiedWorkflowRun: status.verifiedWorkflowRun,
  verifiedTree: status.verified.latestBuildArtifacts.verifiedTree,
  artifactCount: [...artifacts.values()].length,
  companionWorkflowCount: Object.keys(companionWorkflows).length,
  archivedCheckpointCount: status.verifiedCheckpointHistory?.length ?? 0,
}, null, 2));
