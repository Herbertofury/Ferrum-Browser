import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REQUIRED_SUCCESS_ARTIFACTS = Object.freeze([
  'ferrum-evidence-Linux',
  'ferrum-evidence-Windows',
  'ferrum-evidence-Windows-brave',
  'ferrum-evidence-Windows-opera-gx',
  'ferrum-evidence-WebDriver-Grid',
  'ferrum-evidence-Lightpanda',
  'ferrum-evidence-Appium-Android',
  'ferrum-desktop-Linux.tar.gz',
  'ferrum-desktop-Windows.tar.gz',
  'ferrum-provenance-Linux',
  'ferrum-provenance-Windows'
]);

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function sha256Digest(value, label) {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} must be a sha256 digest`);
  return digest;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findFiles(root, fileName, found = []) {
  if (!root || !fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(fullPath, fileName, found);
    else if (entry.isFile() && entry.name === fileName) found.push(fullPath);
  }
  return found;
}

export function loadProvenanceSummaries(root) {
  return findFiles(root, 'summary.json')
    .sort()
    .map((filePath) => ({ filePath, ...readJson(filePath) }));
}

export function buildWorkflowEvidenceIndex({ run, artifactsPayload, provenanceSummaries = [] }) {
  const runId = positiveInteger(run?.id, 'workflow run id');
  const sourceSha = requiredString(run?.head_sha, 'workflow run head sha');
  const conclusion = requiredString(run?.conclusion, 'workflow run conclusion');
  const repository = requiredString(run?.repository?.full_name ?? process.env.GITHUB_REPOSITORY, 'repository');

  if (!Array.isArray(artifactsPayload?.artifacts)) throw new Error('artifact metadata payload must contain an artifacts array');

  const artifacts = artifactsPayload.artifacts
    .filter((artifact) => typeof artifact?.name === 'string' && artifact.name.startsWith('ferrum-'))
    .map((artifact) => {
      const artifactRun = artifact.workflow_run ?? {};
      if (artifactRun.id !== runId) throw new Error(`artifact ${artifact.name} belongs to workflow run ${artifactRun.id}, expected ${runId}`);
      if (artifactRun.head_sha !== sourceSha) throw new Error(`artifact ${artifact.name} belongs to source ${artifactRun.head_sha}, expected ${sourceSha}`);
      return {
        id: positiveInteger(artifact.id, `artifact ${artifact.name} id`),
        name: artifact.name,
        sizeBytes: positiveInteger(artifact.size_in_bytes, `artifact ${artifact.name} size`),
        digest: sha256Digest(artifact.digest, `artifact ${artifact.name} digest`),
        expired: Boolean(artifact.expired),
        createdAt: artifact.created_at ?? null,
        expiresAt: artifact.expires_at ?? null
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const provenance = provenanceSummaries
    .map((summary) => {
      const artifactId = Number(summary.artifactId);
      const artifact = byId.get(artifactId);
      if (!artifact) throw new Error(`provenance summary references unknown artifact id ${summary.artifactId}`);
      const summaryDigest = `sha256:${requiredString(summary.sha256, 'provenance sha256').toLowerCase()}`;
      if (artifact.digest !== summaryDigest) {
        throw new Error(`provenance digest mismatch for artifact ${artifact.name}: ${summaryDigest} != ${artifact.digest}`);
      }
      if (summary.verification !== 'passed') throw new Error(`provenance verification is not passed for artifact ${artifact.name}`);
      return {
        runnerOs: requiredString(summary.runnerOs, 'provenance runnerOs'),
        artifactId,
        artifactName: artifact.name,
        digest: artifact.digest,
        attestationId: positiveInteger(Number(summary.attestationId), 'attestation id'),
        attestationUrl: requiredString(summary.attestationUrl, 'attestation url'),
        verification: 'passed'
      };
    })
    .sort((a, b) => a.runnerOs.localeCompare(b.runnerOs));

  const names = new Set(artifacts.map((artifact) => artifact.name));
  const missingRequiredArtifacts = REQUIRED_SUCCESS_ARTIFACTS.filter((name) => !names.has(name));
  if (conclusion === 'success' && missingRequiredArtifacts.length > 0) {
    throw new Error(`successful Ferrum CI run is missing required artifacts: ${missingRequiredArtifacts.join(', ')}`);
  }
  if (conclusion === 'success' && provenance.length !== 2) {
    throw new Error(`successful Ferrum CI run must contain two verified desktop provenance summaries, found ${provenance.length}`);
  }

  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  return {
    schemaVersion: 1,
    kind: 'ferrum-workflow-evidence-index',
    generatedAt: new Date().toISOString(),
    source: {
      repository,
      workflow: run.name ?? 'Ferrum CI',
      runId,
      runAttempt: run.run_attempt ?? null,
      event: run.event ?? null,
      branch: run.head_branch ?? null,
      sha: sourceSha,
      conclusion,
      htmlUrl: run.html_url ?? null
    },
    summary: {
      artifactCount: artifacts.length,
      totalBytes,
      evidenceArtifactCount: artifacts.filter((artifact) => artifact.name.startsWith('ferrum-evidence-')).length,
      desktopArtifactCount: artifacts.filter((artifact) => artifact.name.startsWith('ferrum-desktop-')).length,
      provenanceArtifactCount: artifacts.filter((artifact) => artifact.name.startsWith('ferrum-provenance-')).length,
      verifiedAttestationCount: provenance.length
    },
    requiredSuccessArtifacts: REQUIRED_SUCCESS_ARTIFACTS,
    missingRequiredArtifacts,
    artifacts,
    provenance
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid arguments near ${key ?? '<end>'}`);
    values.set(key.slice(2), value);
  }
  for (const key of ['run-json', 'artifacts-json', 'provenance-root', 'output']) {
    if (!values.has(key)) throw new Error(`missing --${key}`);
  }
  return Object.fromEntries(values);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = buildWorkflowEvidenceIndex({
    run: readJson(args['run-json']),
    artifactsPayload: readJson(args['artifacts-json']),
    provenanceSummaries: loadProvenanceSummaries(args['provenance-root'])
  });
  const serialized = `${JSON.stringify(index, null, 2)}\n`;
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, serialized);
  const digest = crypto.createHash('sha256').update(serialized).digest('hex');
  process.stdout.write(`${JSON.stringify({ output: args.output, bytes: Buffer.byteLength(serialized), sha256: digest, ...index.summary })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
