import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { bootstrapGithubWiki } from '../src/integrations/github-wiki.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-github-wiki-smoke-'));
let initialized = false;
let savedTitle = null;
let savedBody = null;
let privateNewPageVisits = 0;
let privateSavePosts = 0;

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wiki fixture</title></head><body>${body}</body></html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/fixture/private-wiki.wiki.git/info/refs') {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('hidden');
    return;
  }
  if (request.method === 'GET' && url.pathname === '/fixture/private-wiki/wiki') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html('<h1>Existing private wiki</h1><div class="markdown-body">Existing content</div>'));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/fixture/private-wiki/wiki/_new') {
    privateNewPageVisits++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html(`
      <form method="post" action="/fixture/private-wiki/wiki">
        <input id="gollum-editor-page-title" name="wiki[name]">
        <textarea id="gollum-editor-body" name="wiki[body]"></textarea>
        <button type="submit">Save Page</button>
      </form>
    `));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/fixture/private-wiki/wiki') {
    privateSavePosts++;
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('Ferrum must not submit here');
    return;
  }

  if (url.pathname === '/fixture/wiki-test.wiki.git/info/refs') {
    if (!initialized) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    response.end('001e# service=git-upload-pack\n0000');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/fixture/wiki-test/wiki/_new') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html(`
      <form method="post" action="/fixture/wiki-test/wiki">
        <label>Page title <input id="gollum-editor-page-title" name="wiki[name]"></label>
        <label>Body <textarea id="gollum-editor-body" name="wiki[body]"></textarea></label>
        <button type="submit">Save Page</button>
      </form>
    `));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/fixture/wiki-test/wiki') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const form = new URLSearchParams(body);
    savedTitle = form.get('wiki[name]');
    savedBody = form.get('wiki[body]');
    initialized = true;
    response.writeHead(302, { location: `/fixture/wiki-test/wiki/${encodeURIComponent(savedTitle || 'Home')}` });
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/fixture/wiki-test/wiki') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html(initialized
      ? `<h1>${savedTitle || 'Home'}</h1><div class="markdown-body">${savedBody || ''}</div>`
      : '<a href="/fixture/wiki-test/wiki/_new">Create the first page</a>'));
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/fixture/wiki-test/wiki/')) {
    response.writeHead(initialized ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html(initialized ? `<h1>${savedTitle}</h1><div class="markdown-body">${savedBody}</div>` : 'missing'));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
const serverUrl = `http://127.0.0.1:${address.port}`;

try {
  const created = await bootstrapGithubWiki('fixture/wiki-test', {
    serverUrl,
    pageTitle: 'Home',
    body: '# Fixture Wiki\n\nCreated by Ferrum bootstrap smoke.\n',
    space: 'github-smoke',
    spacesRoot: path.join(root, 'spaces'),
    artifactsRoot: path.join(root, 'artifacts'),
    headless: true,
    authTimeoutMs: 1000,
    token: null
  });

  assert.equal(created.status, 'passed');
  assert.equal(created.action, 'created-first-page');
  assert.equal(created.gitRemoteVerified, true);
  assert.equal(savedTitle, 'Home');
  assert.match(savedBody, /Created by Ferrum bootstrap smoke/);
  await fs.access(path.join(created.evidenceDir, 'screenshots', 'before-save.png'));
  await fs.access(path.join(created.evidenceDir, 'screenshots', 'after-save.png'));

  const second = await bootstrapGithubWiki('fixture/wiki-test', {
    serverUrl,
    headless: true,
    spacesRoot: path.join(root, 'spaces'),
    artifactsRoot: path.join(root, 'artifacts'),
    token: null
  });
  assert.equal(second.status, 'already-initialized');
  assert.equal(second.gitRemoteVerified, true);

  const privateSafe = await bootstrapGithubWiki('fixture/private-wiki', {
    serverUrl,
    space: 'private-safe',
    spacesRoot: path.join(root, 'spaces'),
    artifactsRoot: path.join(root, 'artifacts'),
    headless: true,
    authTimeoutMs: 1000,
    token: null
  });
  assert.equal(privateSafe.status, 'passed');
  assert.equal(privateSafe.action, 'already-initialized');
  assert.equal(privateSafe.gitRemoteVerified, false);
  assert.equal(privateNewPageVisits, 0);
  assert.equal(privateSavePosts, 0);

  console.log(JSON.stringify({
    status: 'passed',
    createdAction: created.action,
    secondAction: second.status,
    gitRemoteVerified: created.gitRemoteVerified,
    privateFalse404Safe: privateNewPageVisits === 0 && privateSavePosts === 0,
    evidenceDir: created.evidenceDir
  }, null, 2));
} finally {
  server.close();
  await once(server, 'close').catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
