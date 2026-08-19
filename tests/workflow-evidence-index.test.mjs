import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkflowEvidenceIndex } from '../scripts/workflow-evidence-index.mjs';

const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);

function artifact(id, name, digest, size = 10) {
  return {
    id,
    name,
    size_in_bytes: size,
    digest: `sha256:${digest}`,
    expired: false,
    created_at: '2026-08-19T02:00:00Z',
    expires_at: '2026-11-17T02:00:00Z',
    workflow_run: {
      id: 123,
      head_sha: 'f'.repeat(40)
    }
  };
}

function successArtifacts() {
  return [
    artifact(1, 'ferrum-evidence-Linux', shaA),
    artifact(2, 'ferrum-evidence-Windows', shaA),
    artifact(3, 'ferrum-evidence-Windows-brave', shaA),
    artifact(4, 'ferrum-evidence-Windows-opera-gx', shaA),
    artifact(5, 'ferrum-evidence-WebDriver-Grid', shaA),
    artifact(6, 'ferrum-evidence-Lightpanda', shaA),
    artifact(7, 'ferrum-evidence-Appium-Android', shaA),
    artifact(8, 'ferrum-desktop-Linux.tar.gz', shaB, 100),
    artifact(9, 'ferrum-desktop-Windows.tar.gz', shaC, 200),
    artifact(10, 'ferrum-provenance-Linux', shaA),
    artifact(11, 'ferrum-provenance-Windows', shaA)
  ];
}

const run = {
  id: 123,
  name: 'Ferrum CI',
  run_attempt: 1,
  event: 'pull_request',
  head_branch: 'evolution/test',
  head_sha: 'f'.repeat(40),
  conclusion: 'success',
  html_url: 'https://github.com/example/Ferrum/actions/runs/123',
  repository: { full_name: 'example/Ferrum' }
};

const provenance = [
  {
    runnerOs: 'Linux',
    artifactId: '8',
    sha256: shaB,
    attestationId: '81',
    attestationUrl: 'https://example.test/attestations/81',
    verification: 'passed'
  },
  {
    runnerOs: 'Windows',
    artifactId: '9',
    sha256: shaC,
    attestationId: '91',
    attestationUrl: 'https://example.test/attestations/91',
    verification: 'passed'
  }
];

test('buildWorkflowEvidenceIndex links source, artifacts, digests, and attestations', () => {
  const index = buildWorkflowEvidenceIndex({
    run,
    artifactsPayload: { artifacts: successArtifacts() },
    provenanceSummaries: provenance
  });

  assert.equal(index.kind, 'ferrum-workflow-evidence-index');
  assert.equal(index.source.runId, 123);
  assert.equal(index.source.sha, run.head_sha);
  assert.equal(index.summary.artifactCount, 11);
  assert.equal(index.summary.totalBytes, 390);
  assert.equal(index.summary.evidenceArtifactCount, 7);
  assert.equal(index.summary.desktopArtifactCount, 2);
  assert.equal(index.summary.provenanceArtifactCount, 2);
  assert.equal(index.summary.verifiedAttestationCount, 2);
  assert.deepEqual(index.missingRequiredArtifacts, []);
  assert.equal(index.provenance[0].artifactName, 'ferrum-desktop-Linux.tar.gz');
  assert.equal(index.provenance[0].attestationId, 81);
  assert.equal(index.provenance[1].artifactName, 'ferrum-desktop-Windows.tar.gz');
});

test('successful workflow cannot silently omit a required Ferrum artifact', () => {
  const artifacts = successArtifacts().filter((entry) => entry.name !== 'ferrum-evidence-Appium-Android');
  assert.throws(
    () => buildWorkflowEvidenceIndex({ run, artifactsPayload: { artifacts }, provenanceSummaries: provenance }),
    /missing required artifacts: ferrum-evidence-Appium-Android/
  );
});

test('provenance digest must match the indexed immutable desktop artifact', () => {
  const bad = provenance.map((entry) => ({ ...entry }));
  bad[0].sha256 = shaC;
  assert.throws(
    () => buildWorkflowEvidenceIndex({ run, artifactsPayload: { artifacts: successArtifacts() }, provenanceSummaries: bad }),
    /provenance digest mismatch/
  );
});

test('foreign workflow artifacts are rejected instead of entering the index', () => {
  const artifacts = successArtifacts();
  artifacts[0] = {
    ...artifacts[0],
    workflow_run: { ...artifacts[0].workflow_run, head_sha: '0'.repeat(40) }
  };
  assert.throws(
    () => buildWorkflowEvidenceIndex({ run, artifactsPayload: { artifacts }, provenanceSummaries: provenance }),
    /belongs to source/
  );
});
