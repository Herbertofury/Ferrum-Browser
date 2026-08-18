import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('resolve exact published web-vitals 6.1.0 registry metadata for GameSync lock repair', () => {
  const raw = execFileSync('npm', [
    'view',
    'web-vitals@6.1.0',
    'version',
    'dist.integrity',
    'dist.tarball',
    'dependencies',
    '--json',
  ], { encoding: 'utf8', timeout: 30000 });
  const data = JSON.parse(raw);
  const integrity = data['dist.integrity'] ?? data.dist?.integrity;
  const tarball = data['dist.tarball'] ?? data.dist?.tarball;
  assert.equal(data.version, '6.1.0');
  assert.ok(integrity, 'registry metadata must include dist.integrity');
  assert.ok(tarball, 'registry metadata must include dist.tarball');
  assert.deepEqual(data.dependencies ?? {}, {}, 'web-vitals 6.1.0 should not add runtime dependencies');
  console.log(`WEB_VITALS_REGISTRY_RESULT=${JSON.stringify({ version: data.version, integrity, tarball, dependencies: data.dependencies ?? {} })}`);
});
