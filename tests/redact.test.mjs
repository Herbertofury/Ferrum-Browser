import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { loadSpec } from '../src/core/spec.mjs';
import { REDACTED, redactSensitive, specForEvidence } from '../src/core/redact.mjs';

test('redacts nested credentials, bearer tokens, and credential-bearing URLs without removing diagnostics', () => {
  const safe = redactSensitive({
    platformName: 'Android',
    authorization: 'Bearer auth-secret',
    'bstack:options': {
      userName: 'private-user',
      accessKey: 'private-access-key',
      projectName: 'Ferrum'
    },
    endpoint: 'https://user:pass@example.test/wd/hub?token=query-secret&build=42',
    message: 'request https://user:pass@example.test/wd/hub?api_key=query-secret failed with Bearer body-secret'
  });

  const serialized = JSON.stringify(safe);
  for (const secret of ['auth-secret', 'private-user', 'private-access-key', 'user:pass', 'query-secret', 'body-secret']) {
    assert.equal(serialized.includes(secret), false, `must redact ${secret}`);
  }
  assert.equal(safe.platformName, 'Android');
  assert.equal(safe['bstack:options'].projectName, 'Ferrum');
  assert.equal(safe.authorization, REDACTED);
  assert.equal(safe['bstack:options'].accessKey, REDACTED);
});

test('runtime spec resolves variables while evidence retains unresolved source placeholders and sensitive values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-redact-spec-'));
  const file = path.join(dir, 'remote-appium.json');
  try {
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      name: 'remote-appium',
      target: {
        type: 'appium',
        server: '${ENV:REMOTE_APPIUM_URL}',
        capabilities: {
          platformName: 'Android',
          'bstack:options': {
            userName: '${ENV:REMOTE_USERNAME}',
            accessKey: '${ENV:REMOTE_ACCESS_KEY}'
          }
        }
      },
      steps: [{ action: 'fill', using: 'id', value: 'password', text: '${ENV:TEST_PASSWORD}' }]
    }), 'utf8');

    const spec = await loadSpec(file, { variables: {
      REMOTE_APPIUM_URL: 'https://remote.example.test/wd/hub',
      REMOTE_USERNAME: 'resolved-user',
      REMOTE_ACCESS_KEY: 'resolved-key',
      TEST_PASSWORD: 'resolved-password'
    } });
    assert.equal(spec.target.server, 'https://remote.example.test/wd/hub');
    assert.equal(spec.target.capabilities['bstack:options'].accessKey, 'resolved-key');
    assert.equal(spec.steps[0].text, 'resolved-password');
    assert.ok(spec.__redactValues.includes('resolved-user'));
    assert.ok(spec.__redactValues.includes('resolved-key'));
    assert.ok(spec.__redactValues.includes('resolved-password'));
    assert.equal(spec.__redactValues.includes('https://remote.example.test/wd/hub'), false);

    const safe = specForEvidence(spec);
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes('resolved-user'), false);
    assert.equal(serialized.includes('resolved-key'), false);
    assert.equal(serialized.includes('resolved-password'), false);
    assert.equal(safe.target.server, '${ENV:REMOTE_APPIUM_URL}');
    assert.equal(safe.target.capabilities['bstack:options'].userName, '${ENV:REMOTE_USERNAME}');
    assert.equal(safe.target.capabilities['bstack:options'].accessKey, '${ENV:REMOTE_ACCESS_KEY}');
    assert.equal(safe.steps[0].text, '${ENV:TEST_PASSWORD}');
    assert.equal('__sourceSpec' in safe, false);
    assert.equal('__redactValues' in safe, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('EvidenceWriter sanitizes records, JSON, text, resolved secrets, and returned final results', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-redact-evidence-'));
  try {
    const evidence = await new EvidenceWriter({ root, name: 'secret-safe', redactValues: ['injected-secret'] }).init();
    evidence.record('remote-session', {
      endpoint: 'https://user:pass@example.test/wd/hub?access_token=session-secret',
      capabilities: { accessKey: 'capability-secret', platformName: 'Android' }
    });
    evidence.record('step-start', { step: { action: 'fill', text: 'injected-secret' } });
    await evidence.writeJson('payload.json', { apiKey: 'json-secret', generic: 'injected-secret', ok: true });
    await evidence.writeText('failure.txt', 'failed at https://user:pass@example.test/wd/hub?token=text-secret with Bearer bearer-secret and injected-secret');
    const result = await evidence.finalize({
      status: 'passed',
      result: { engine: 'appium', credentials: { password: 'result-secret' }, platformName: 'Android', note: 'injected-secret' }
    });

    const all = [
      JSON.stringify(result),
      await fs.readFile(path.join(evidence.dir, 'payload.json'), 'utf8'),
      await fs.readFile(path.join(evidence.dir, 'failure.txt'), 'utf8'),
      await fs.readFile(path.join(evidence.dir, 'result.json'), 'utf8')
    ].join('\n');
    for (const secret of ['user:pass', 'session-secret', 'capability-secret', 'json-secret', 'text-secret', 'bearer-secret', 'result-secret', 'injected-secret']) {
      assert.equal(all.includes(secret), false, `must redact ${secret}`);
    }
    assert.equal(result.result.platformName, 'Android');
    assert.equal(result.result.credentials, REDACTED);
    assert.equal(result.result.note, REDACTED);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('template text does not exempt neighboring literal credentials from redaction', () => {
  const safe = redactSensitive({
    message: 'template ${ENV:UNRESOLVED} failed with Bearer literal-bearer and resolved-secret',
    password: 'literal-password ${VAR:UNRESOLVED}',
    endpoint: 'https://example.test/?token=literal-query&hint=${ENV:UNRESOLVED}'
  }, null, ['resolved-secret']);
  const text = JSON.stringify(safe);
  for (const secret of ['literal-bearer', 'resolved-secret', 'literal-password', 'literal-query']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.ok(safe.message.includes('${ENV:UNRESOLVED}'));
  assert.equal(redactSensitive({ password: '${ENV:PASSWORD}' }).password, '${ENV:PASSWORD}');
});

test('EvidenceWriter persists sanitized mixed-template diagnostics through finalize and disk replay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-mixed-template-'));
  try {
    const evidence = await new EvidenceWriter({ root, name: 'mixed-template', redactValues: ['fixture-resolved-secret'] }).init();
    const message = 'request ${ENV:UNRESOLVED} failed with Bearer fixture-bearer-secret and fixture-resolved-secret';
    evidence.record('console', { level: 'error', message });
    await evidence.writeText('failure.txt', message);
    await evidence.writeJson('failure.json', { message });
    const result = await evidence.finalize({ status: 'failed', error: message });
    const files = await fs.readdir(evidence.dir);
    let persisted = JSON.stringify(result);
    for (const file of files) if (/\.(?:json|jsonl|txt)$/.test(file)) persisted += await fs.readFile(path.join(evidence.dir, file), 'utf8');
    assert.equal(persisted.includes('fixture-bearer-secret'), false);
    assert.equal(persisted.includes('fixture-resolved-secret'), false);
    assert.ok(persisted.includes('${ENV:UNRESOLVED}'));
    assert.ok(persisted.includes('request'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('URL query placeholders survive but literal credentials in the same URL do not', () => {
  const safe = redactSensitive('https://example.test/?token=${ENV:TOKEN}&api_key=literal-key&build=42');
  const url = new URL(safe);
  assert.equal(url.searchParams.get('token'), '${ENV:TOKEN}');
  assert.equal(url.searchParams.get('api_key'), REDACTED);
  assert.equal(url.searchParams.get('build'), '42');
  const duplicate = redactSensitive('https://example.test/?token=${ENV:TOKEN}&token=literal-token');
  assert.equal(duplicate.includes('literal-token'), false);
});
