import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(ROOT, 'scripts', 'selenium-grid-smoke.sh'), 'utf8');

test('Selenium Grid smoke uses the current stable dated image release', () => {
  assert.match(script, /selenium\/standalone-chrome:4\.47\.0-20260808/);
});

test('Selenium Grid smoke retains and validates exact runtime image identity', () => {
  for (const required of [
    'image-inspect.json',
    'image-identity.json',
    'container-start-inspect.json',
    'repoDigests',
    'container.Image !== image.imageId',
    'status.json'
  ]) {
    assert.ok(script.includes(required), `missing Selenium Grid identity contract: ${required}`);
  }

  assert.match(script, /@sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(script, /docker image inspect "\$IMAGE"/);
});
