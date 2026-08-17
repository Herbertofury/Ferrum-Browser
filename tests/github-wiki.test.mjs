import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGithubRepository,
  buildGithubWikiUrls,
  probeGithubWiki
} from '../src/integrations/github-wiki.mjs';

test('normalizes GitHub repository slugs and URLs', () => {
  assert.equal(normalizeGithubRepository('Herbertofury/ProjectDump'), 'Herbertofury/ProjectDump');
  assert.equal(normalizeGithubRepository('https://github.com/Herbertofury/ProjectDump.git'), 'Herbertofury/ProjectDump');
  assert.throws(() => normalizeGithubRepository('ProjectDump'), /OWNER\/REPO/);
  assert.throws(() => normalizeGithubRepository('../bad/repo'), /OWNER\/REPO/);
});

test('builds the separate GitHub Wiki Git remote URLs', () => {
  const urls = buildGithubWikiUrls('Herbertofury/ProjectDump');
  assert.equal(urls.wikiUrl, 'https://github.com/Herbertofury/ProjectDump/wiki');
  assert.equal(urls.newPageUrl, 'https://github.com/Herbertofury/ProjectDump/wiki/_new');
  assert.equal(urls.wikiGitUrl, 'https://github.com/Herbertofury/ProjectDump.wiki.git');
  assert.equal(urls.wikiGitInfoUrl, 'https://github.com/Herbertofury/ProjectDump.wiki.git/info/refs?service=git-upload-pack');
});

test('wiki probe distinguishes initialized and missing Git remotes', async () => {
  const calls = [];
  const initialized = await probeGithubWiki('Herbertofury/ProjectDump', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 200 };
    }
  });
  assert.equal(initialized.exists, true);
  assert.equal(initialized.missing, false);
  assert.match(calls[0].url, /ProjectDump\.wiki\.git\/info\/refs/);
  assert.equal(calls[0].options.method, 'GET');

  const missing = await probeGithubWiki('Herbertofury/NewRepo', {
    fetchImpl: async () => ({ status: 404 })
  });
  assert.equal(missing.exists, false);
  assert.equal(missing.missing, true);
});

test('wiki probe reports transport failures without fabricating existence', async () => {
  const result = await probeGithubWiki('Herbertofury/ProjectDump', {
    fetchImpl: async () => { throw new Error('network down'); }
  });
  assert.equal(result.exists, false);
  assert.equal(result.missing, false);
  assert.equal(result.reachable, false);
  assert.equal(result.error, 'network down');
});
