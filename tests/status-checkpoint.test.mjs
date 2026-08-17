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

function verifiedWorkflowRun(entry) {
  return Number(entry?.verifiedProduct?.mainWorkflowRun ?? entry?.verifiedProduct?.workflowRun ?? 0);
}

test('STATUS points at the newest verified Ferrum product checkpoint', async () => {
  const status = await readJson(path.join(memoryDir, 'STATUS.json'));
  const files = (await fs.readdir(memoryDir))
    .filter(name => name.endsWith('.json') && name !== 'STATUS.json');

  const checkpoints = [];
  for (const name of files) {
    const entry = await readJson(path.join(memoryDir, name));
    const workflowRun = verifiedWorkflowRun(entry);
    const commit = entry?.verifiedProduct?.commit;
    if (commit && Number.isSafeInteger(workflowRun) && workflowRun > 0) {
      checkpoints.push({ name, commit, workflowRun, checkedAt: entry.checkedAt ?? null });
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

  if (latest.checkedAt && status.verifiedAt) {
    assert.ok(
      Date.parse(status.verifiedAt) >= Date.parse(latest.checkedAt),
      `STATUS verifiedAt ${status.verifiedAt} predates newest verified checkpoint ${latest.checkedAt}`
    );
  }
});
