import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_ROOT = path.join(ROOT, '.github', 'workflows');
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

function workflowFiles() {
  return fs
    .readdirSync(WORKFLOWS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(WORKFLOWS_ROOT, entry.name))
    .sort();
}

function externalActionRefs(source) {
  const refs = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (!match) continue;
    const ref = match[1];
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    refs.push({ line: index + 1, ref });
  }
  return refs;
}

function isImmutableRepositoryActionRef(ref) {
  const at = ref.lastIndexOf('@');
  return at > 0 && FULL_COMMIT_SHA.test(ref.slice(at + 1));
}

test('external GitHub Actions are pinned to full immutable commit SHAs', () => {
  const violations = [];
  let checked = 0;

  for (const file of workflowFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const action of externalActionRefs(source)) {
      checked += 1;
      if (!isImmutableRepositoryActionRef(action.ref)) {
        violations.push(`${path.relative(ROOT, file)}:${action.line}: ${action.ref}`);
      }
    }
  }

  assert.ok(checked > 0, 'expected at least one external GitHub Action reference');
  assert.deepEqual(
    violations,
    [],
    `external GitHub Actions must use a full 40-character commit SHA:\n${violations.join('\n')}`
  );
});

test('action-ref policy rejects movable refs and accepts exact commits', () => {
  assert.equal(isImmutableRepositoryActionRef('actions/checkout@v7'), false);
  assert.equal(isImmutableRepositoryActionRef('actions/checkout@main'), false);
  assert.equal(isImmutableRepositoryActionRef('actions/checkout@3d3c42e5'), false);
  assert.equal(
    isImmutableRepositoryActionRef('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'),
    true
  );
  assert.equal(
    isImmutableRepositoryActionRef('owner/repo/.github/workflows/reusable.yml@0123456789abcdef0123456789abcdef01234567'),
    true
  );
});
