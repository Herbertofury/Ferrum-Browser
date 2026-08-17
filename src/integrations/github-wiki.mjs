import { setTimeout as delay } from 'node:timers/promises';
import { EvidenceWriter } from '../core/evidence.mjs';
import { prepareRunSpace } from '../core/spaces.mjs';
import { launchChromiumSession } from '../browser/chromium.mjs';

const TITLE_SELECTORS = [
  '#gollum-editor-page-title',
  'input[name="wiki[name]"]',
  'input[placeholder*="Page title" i]',
  'input[aria-label*="Page title" i]'
];

const BODY_SELECTORS = [
  '#gollum-editor-body',
  'textarea[name="wiki[body]"]',
  'textarea[aria-label*="body" i]',
  'textarea'
];

const SAVE_SELECTORS = [
  'button[type="submit"]:has-text("Save Page")',
  'button:has-text("Save Page")',
  'input[type="submit"][value*="Save" i]'
];

const CREATE_SELECTORS = [
  'a[href$="/wiki/_new"]:has-text("Create the first page")',
  'a[href$="/wiki/_new"]:has-text("New Page")',
  'a[href$="/wiki/_new"]'
];

export function normalizeGithubRepository(value) {
  const repo = String(value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GitHub repository must be OWNER/REPO or a github.com repository URL');
  }
  return repo;
}

export function buildGithubWikiUrls(repository, serverUrl = 'https://github.com') {
  const repo = normalizeGithubRepository(repository);
  const server = String(serverUrl || 'https://github.com').replace(/\/$/, '');
  const parsed = new URL(server);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('GitHub server URL must use http or https');
  const repositoryUrl = `${server}/${repo}`;
  return {
    repository: repo,
    serverUrl: server,
    repositoryUrl,
    wikiUrl: `${repositoryUrl}/wiki`,
    newPageUrl: `${repositoryUrl}/wiki/_new`,
    wikiGitUrl: `${repositoryUrl}.wiki.git`,
    wikiGitInfoUrl: `${repositoryUrl}.wiki.git/info/refs?service=git-upload-pack`
  };
}

export async function probeGithubWiki(repository, { serverUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const urls = buildGithubWikiUrls(repository, serverUrl);
  try {
    const response = await fetchImpl(urls.wikiGitInfoUrl, {
      method: 'GET',
      headers: {
        accept: 'application/x-git-upload-pack-advertisement',
        'user-agent': 'Ferrum-GitHub-Wiki-Probe'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 10000))
    });
    return {
      repository: urls.repository,
      wikiUrl: urls.wikiUrl,
      wikiGitUrl: urls.wikiGitUrl,
      status: response.status,
      exists: response.status === 200,
      missing: response.status === 404,
      reachable: response.status > 0 && response.status < 500
    };
  } catch (error) {
    return {
      repository: urls.repository,
      wikiUrl: urls.wikiUrl,
      wikiGitUrl: urls.wikiGitUrl,
      status: null,
      exists: false,
      missing: false,
      reachable: false,
      error: error.message
    };
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function loginRequired(page) {
  try {
    const url = new URL(page.url());
    if (url.pathname === '/login' || url.pathname.startsWith('/sessions/')) return true;
  } catch {}
  const form = page.locator('form[action="/session"], input[name="login"]').first();
  return (await form.count()) > 0 && await form.isVisible().catch(() => false);
}

async function resolveEditor(page, urls, { headless, authTimeoutMs, evidence }) {
  await page.goto(urls.newPageUrl, { waitUntil: 'domcontentloaded' });
  evidence.record('github-wiki-bootstrap-navigate', { url: page.url() });

  if (await loginRequired(page)) {
    evidence.record('github-wiki-bootstrap-auth-required', { url: page.url() });
    if (headless) throw new Error('GitHub login is required. Run headed with a persistent Ferrum Space once, then reuse that Space for automated wiki bootstrap.');
    const timeout = Math.max(1000, Number(authTimeoutMs) || 180000);
    await page.waitForURL(current => {
      try {
        const path = new URL(current).pathname;
        return path !== '/login' && !path.startsWith('/sessions/');
      } catch {
        return false;
      }
    }, { timeout });
    await page.goto(urls.newPageUrl, { waitUntil: 'domcontentloaded' });
  }

  let title = await firstVisible(page, TITLE_SELECTORS);
  let body = await firstVisible(page, BODY_SELECTORS);
  if (title && body) return { title, body };

  await page.goto(urls.wikiUrl, { waitUntil: 'domcontentloaded' });
  const create = await firstVisible(page, CREATE_SELECTORS);
  if (create) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      create.click()
    ]);
    if (await loginRequired(page)) {
      if (headless) throw new Error('GitHub login is required to create the first wiki page.');
      const timeout = Math.max(1000, Number(authTimeoutMs) || 180000);
      await page.waitForURL(current => {
        try { return new URL(current).pathname !== '/login'; } catch { return false; }
      }, { timeout });
      await page.goto(urls.newPageUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  title = await firstVisible(page, TITLE_SELECTORS);
  body = await firstVisible(page, BODY_SELECTORS);
  if (!title || !body) {
    const probe = await probeGithubWiki(urls.repository, { serverUrl: urls.serverUrl });
    if (probe.exists) return null;
    throw new Error(`GitHub wiki editor was not found at ${page.url()}. Confirm the Ferrum Space is authenticated and has wiki write access.`);
  }
  return { title, body };
}

async function waitForWikiGit(repository, { serverUrl, attempts = 10, intervalMs = 750 } = {}) {
  let probe = await probeGithubWiki(repository, { serverUrl });
  for (let attempt = 1; !probe.exists && attempt < attempts; attempt++) {
    await delay(intervalMs);
    probe = await probeGithubWiki(repository, { serverUrl });
  }
  return probe;
}

export async function bootstrapGithubWiki(repository, {
  serverUrl = 'https://github.com',
  pageTitle = 'Home',
  body,
  space = 'github',
  spacesRoot,
  headless = false,
  browserName,
  browserChannel,
  browserExecutable,
  artifactsRoot,
  authTimeoutMs = 180000
} = {}) {
  const urls = buildGithubWikiUrls(repository, serverUrl);
  const initialProbe = await probeGithubWiki(urls.repository, { serverUrl: urls.serverUrl });
  if (initialProbe.exists) {
    return {
      status: 'already-initialized',
      repository: urls.repository,
      wikiUrl: urls.wikiUrl,
      wikiGitUrl: urls.wikiGitUrl,
      gitRemoteVerified: true,
      probeStatus: initialProbe.status,
      evidenceDir: null
    };
  }

  const evidence = await new EvidenceWriter({
    root: artifactsRoot,
    name: `github-wiki-bootstrap-${urls.repository.replace('/', '-')}`,
    metadata: { integration: 'github-wiki', repository: urls.repository, wikiUrl: urls.wikiUrl, space }
  }).init();
  const runSpace = await prepareRunSpace({ name: space, root: spacesRoot, mode: 'persistent', runId: evidence.id });
  let session;
  let finalResult;
  try {
    session = await launchChromiumSession({
      profileDir: runSpace.profileDir,
      headless,
      executablePath: browserExecutable,
      channel: browserChannel,
      browserName,
      diagnoseInitialPages: false,
      evidence
    });
    const page = await session.newPage();
    await session.closeInitialPages({ except: page });
    const editor = await resolveEditor(page, urls, { headless, authTimeoutMs, evidence });
    if (!editor) {
      const probe = await waitForWikiGit(urls.repository, { serverUrl: urls.serverUrl });
      finalResult = await evidence.finalize({
        status: 'passed',
        action: 'already-initialized',
        repository: urls.repository,
        wikiUrl: urls.wikiUrl,
        gitRemoteVerified: probe.exists,
        probeStatus: probe.status
      });
      return { ...finalResult, evidenceDir: evidence.dir };
    }

    const resolvedBody = body ?? `# ${urls.repository.split('/')[1]}\n\nInitialized by Ferrum so the GitHub Wiki Git repository can be managed automatically.\n`;
    await editor.title.fill(String(pageTitle || 'Home'));
    await editor.body.fill(String(resolvedBody));
    evidence.record('github-wiki-bootstrap-filled', { pageTitle: String(pageTitle || 'Home'), bodyLength: String(resolvedBody).length });
    await evidence.screenshot(page, 'before-save');

    const save = await firstVisible(page, SAVE_SELECTORS);
    if (!save) throw new Error(`GitHub wiki Save Page control was not found at ${page.url()}`);
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      save.click()
    ]);

    const finalUrl = page.url();
    const errorBanner = await firstVisible(page, ['.flash-error', '.flash.flash-error', '[role="alert"].flash-error']);
    if (errorBanner) throw new Error(`GitHub reported a wiki save error: ${(await errorBanner.textContent())?.trim() || 'unknown error'}`);
    if (!finalUrl.includes('/wiki/') || finalUrl.endsWith('/wiki/_new')) {
      throw new Error(`GitHub did not navigate to a saved wiki page after submission: ${finalUrl}`);
    }

    await evidence.screenshot(page, 'after-save');
    const probe = await waitForWikiGit(urls.repository, { serverUrl: urls.serverUrl });
    evidence.record('github-wiki-bootstrap-saved', { finalUrl, gitProbeStatus: probe.status, gitRemoteVerified: probe.exists });
    finalResult = await evidence.finalize({
      status: 'passed',
      action: 'created-first-page',
      repository: urls.repository,
      pageTitle: String(pageTitle || 'Home'),
      wikiUrl: urls.wikiUrl,
      pageUrl: finalUrl,
      wikiGitUrl: urls.wikiGitUrl,
      gitRemoteVerified: probe.exists,
      probeStatus: probe.status
    });
    return { ...finalResult, evidenceDir: evidence.dir };
  } catch (error) {
    evidence.record('github-wiki-bootstrap-failure', { message: error.message });
    await evidence.finalize({
      status: 'failed',
      repository: urls.repository,
      wikiUrl: urls.wikiUrl,
      failure: { message: error.message }
    }).catch(() => {});
    error.evidenceDir = evidence.dir;
    throw error;
  } finally {
    if (session) await session.close().catch(() => {});
    await runSpace.cleanup().catch(() => {});
  }
}
