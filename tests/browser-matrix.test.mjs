import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCandidates, discoverBrowsers, normalizeBrowserList } from '../src/core/browser-matrix.mjs';

test('browser list is normalized and deduplicated', () => {
  assert.deepEqual(normalizeBrowserList('Chromium,chrome,CHROME,edge'), ['chromium', 'chrome', 'edge']);
  assert.throws(() => normalizeBrowserList('firefox'), /Unknown browser matrix target/);
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
