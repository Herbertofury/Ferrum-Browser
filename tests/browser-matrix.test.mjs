import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCandidates, browserWorkerEnvironment, discoverBrowsers, normalizeBrowserList, normalizeBrowserWorkerTimeout } from '../src/core/browser-matrix.mjs';

test('browser list is normalized and deduplicated', () => {
  assert.deepEqual(normalizeBrowserList('Chromium,chrome,CHROME,edge'), ['chromium', 'chrome', 'edge']);
  assert.throws(() => normalizeBrowserList('firefox'), /Unknown browser matrix target/);
});

test('browser worker timeout is bounded and configurable', () => {
  assert.equal(normalizeBrowserWorkerTimeout(undefined), 90000);
  assert.equal(normalizeBrowserWorkerTimeout(0), 90000);
  assert.equal(normalizeBrowserWorkerTimeout('120000'), 120000);
});

test('Opera GX worker uses Playwright legacy screenshot transport without mutating caller environment', () => {
  const base = { PATH: 'test-path' };
  const opera = browserWorkerEnvironment({ name: 'opera-gx' }, base);
  assert.equal(opera.PLAYWRIGHT_LEGACY_SCREENSHOT, '1');
  assert.equal(base.PLAYWRIGHT_LEGACY_SCREENSHOT, undefined);

  const chromium = browserWorkerEnvironment({ name: 'chromium' }, base);
  assert.equal(chromium.PLAYWRIGHT_LEGACY_SCREENSHOT, undefined);

  const explicit = browserWorkerEnvironment({ name: 'opera-gx' }, { PLAYWRIGHT_LEGACY_SCREENSHOT: 'caller-value' });
  assert.equal(explicit.PLAYWRIGHT_LEGACY_SCREENSHOT, 'caller-value');
});

test('windows candidates include browser-specific standard locations', () => {
  const candidates = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\bert\\AppData\\Local' });
  assert.ok(candidates.chrome.some(value => value.endsWith('Google\\Chrome\\Application\\chrome.exe')));
  assert.ok(candidates.edge.some(value => value.endsWith('Microsoft\\Edge\\Application\\msedge.exe')));
  assert.ok(candidates.brave.some(value => value.endsWith('BraveSoftware\\Brave-Browser\\Application\\brave.exe')));
  assert.ok(candidates['opera-gx'].some(value => value.endsWith('Programs\\Opera GX\\opera.exe')));
});

test('discovery marks Chromium available and detects installed branded browsers', async () => {
  const installed = new Set(['/usr/bin/google-chrome', '/usr/bin/brave-browser']);
  const browsers = await discoverBrowsers('chromium,chrome,edge,brave,opera-gx', {
    platform: 'linux',
    env: {},
    access: async value => { if (!installed.has(value)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
  });
  assert.equal(browsers.find(item => item.name === 'chromium').available, true);
  assert.equal(browsers.find(item => item.name === 'chrome').channel, 'chrome');
  assert.equal(browsers.find(item => item.name === 'chrome').available, true);
  assert.equal(browsers.find(item => item.name === 'edge').available, false);
  assert.equal(browsers.find(item => item.name === 'brave').executablePath, '/usr/bin/brave-browser');
  assert.equal(browsers.find(item => item.name === 'opera-gx').available, false);
});
