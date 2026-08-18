import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnLogged, terminate } from '../core/process-utils.mjs';
import { CdpClient } from './cdp-client.mjs';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Lightpanda CDP did not become ready at ${url}: ${last?.message || 'timeout'}`);
}

function jsLiteral(value) {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : json;
}

function expressionFor(fnOrString, arg) {
  if (typeof fnOrString === 'function') return `(${fnOrString.toString()})(${jsLiteral(arg)})`;
  return String(fnOrString);
}

function valueFromRemote(result) {
  if (!result) return undefined;
  if (Object.hasOwn(result, 'value')) return result.value;
  if (result.unserializableValue === 'NaN') return Number.NaN;
  if (result.unserializableValue === 'Infinity') return Number.POSITIVE_INFINITY;
  if (result.unserializableValue === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (result.unserializableValue === '-0') return -0;
  return result.description ?? undefined;
}

function consoleText(args = []) {
  return args.map(item => {
    const value = valueFromRemote(item);
    if (typeof value === 'string') return value;
    if (value !== undefined) {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return item.description || item.type || '';
  }).join(' ');
}

class LightpandaLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async click() {
    return await this.page.evaluate(({ selector }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Element not found: ${selector}`);
      if (element.disabled) throw new Error(`Element is disabled: ${selector}`);
      element.focus?.();
      element.click();
      return true;
    }, { selector: this.selector });
  }

  async fill(value) {
    return await this.page.evaluate(({ selector, value }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Element not found: ${selector}`);
      element.focus?.();
      if ('value' in element) element.value = value;
      else if (element.isContentEditable) element.textContent = value;
      else throw new Error(`Element cannot be filled: ${selector}`);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { selector: this.selector, value: String(value ?? '') });
  }

  async innerText() {
    return await this.page.evaluate(({ selector }) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Element not found: ${selector}`);
      return element.innerText ?? element.textContent ?? '';
    }, { selector: this.selector });
  }

  async waitFor({ state = 'visible', timeout = 15000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const matched = await this.page.evaluate(({ selector, state }) => {
        const element = document.querySelector(selector);
        const visible = element && !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
        if (state === 'attached') return Boolean(element);
        if (state === 'detached') return !element;
        if (state === 'hidden') return !element || !visible;
        return Boolean(visible);
      }, { selector: this.selector, state }).catch(() => false);
      if (matched) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${this.selector} to be ${state}`);
  }
}

class LightpandaPage {
  constructor(client, sessionId, evidence) {
    this.client = client;
    this.sessionId = sessionId;
    this.evidence = evidence;
    this._url = 'about:blank';
    this._nextFerrumRef = 1;
    this.keyboard = {
      press: async key => {
        const parts = String(key).split('+');
        const name = parts.pop();
        let modifiers = 0;
        for (const part of parts.map(value => value.toLowerCase())) {
          if (part === 'alt') modifiers |= 1;
          if (part === 'control' || part === 'ctrl') modifiers |= 2;
          if (part === 'meta' || part === 'command') modifiers |= 4;
          if (part === 'shift') modifiers |= 8;
        }
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, modifiers }, this.sessionId);
        await this.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, modifiers }, this.sessionId);
      }
    };
  }

  async init() {
    const disposers = [];
    this._disposeEvents = () => disposers.splice(0).forEach(dispose => dispose());

    disposers.push(this.client.on('Runtime.consoleAPICalled', params => {
      this.evidence.record('console', {
        target: 'lightpanda',
        level: params.type === 'warning' ? 'warning' : params.type,
        text: consoleText(params.args),
        location: null
      });
    }));
    disposers.push(this.client.on('Runtime.exceptionThrown', params => {
      const details = params.exceptionDetails || {};
      this.evidence.record('pageerror', {
        target: 'lightpanda',
        message: details.exception?.description || details.text || 'Runtime exception',
        stack: details.stackTrace || null
      });
    }));
    disposers.push(this.client.on('Network.loadingFailed', params => {
      this.evidence.record('requestfailed', {
        target: 'lightpanda',
        method: null,
        url: params.url || null,
        failure: { errorText: params.errorText || 'Network loading failed', canceled: Boolean(params.canceled) }
      });
    }));
    disposers.push(this.client.on('Network.responseReceived', params => {
      const response = params.response || {};
      if (Number(response.status) >= 400) {
        this.evidence.record('response-error', { target: 'lightpanda', status: response.status, url: response.url || null });
      }
    }));

    await this.client.send('Runtime.enable', {}, this.sessionId);
    await this.client.send('Page.enable', {}, this.sessionId);
    await this.client.send('Network.enable', {}, this.sessionId).catch(() => {});
  }

  url() { return this._url; }

  locator(selector) { return new LightpandaLocator(this, selector); }

  async waitForTimeout(ms) { await new Promise(resolve => setTimeout(resolve, Number(ms || 0))); }

  async waitForFunction(fn, arg, { timeout = 15000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(fn, arg).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for JavaScript condition after ${timeout}ms`);
  }

  async goto(url, { timeout = 15000 } = {}) {
    const result = await this.client.send('Page.navigate', { url: String(url) }, this.sessionId, timeout);
    this._url = String(url);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const state = await this.evaluate(() => ({ readyState: document.readyState, url: location.href })).catch(() => null);
      if (state?.url) this._url = state.url;
      if (state && state.readyState !== 'loading') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { status: () => null, cdp: result };
  }

  async evaluate(fnOrString, arg) {
    const response = await this.client.send('Runtime.evaluate', {
      expression: expressionFor(fnOrString, arg),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }, this.sessionId);
    if (response.exceptionDetails) {
      const message = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Runtime.evaluate failed';
      throw new Error(message);
    }
    return valueFromRemote(response.result);
  }

  async ferrumSnapshot({ interactiveOnly = false, max } = {}) {
    const snapshot = await this.evaluate(({ interactiveOnly, max, nextStart }) => {
      const requestedMax = Number(max);
      const limit = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : null;
      const interactiveSelector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"],[tabindex]';
      const all = [...document.querySelectorAll(interactiveOnly ? interactiveSelector : 'body *')];
      const refOwners = new Map();
      const reservedRefs = new Set();
      const requestedNext = Number(nextStart);
      let next = Number.isSafeInteger(requestedNext) && requestedNext > 0 ? requestedNext : 1;
      for (const element of document.querySelectorAll('[data-ferrum-ref]')) {
        const ref = element.getAttribute('data-ferrum-ref');
        const match = /^e(\d+)$/.exec(ref || '');
        if (!match) continue;
        const numeric = Number(match[1]);
        if (!Number.isSafeInteger(numeric) || numeric < 1) continue;
        if (!refOwners.has(ref)) refOwners.set(ref, element);
        reservedRefs.add(ref);
        next = Math.max(next, numeric + 1);
      }
      const results = [];
      for (const element of all) {
        if (element.hidden) continue;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const interactive = element.matches(interactiveSelector);
        const text = (element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 180);
        if (!interactive && !text) continue;
        let ref = element.getAttribute('data-ferrum-ref');
        if (!/^e\d+$/.test(ref || '') || refOwners.get(ref) !== element) {
          do {
            ref = `e${next++}`;
          } while (reservedRefs.has(ref));
          element.setAttribute('data-ferrum-ref', ref);
          refOwners.set(ref, element);
          reservedRefs.add(ref);
        }
        results.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || null,
          type: element.getAttribute('type') || null,
          name: text,
          href: element.tagName === 'A' ? element.href : null,
          disabled: 'disabled' in element ? Boolean(element.disabled) : false,
          checked: 'checked' in element ? Boolean(element.checked) : null
        });
        if (limit != null && results.length >= limit) break;
      }
      return { url: location.href, title: document.title, elements: results, nextRef: next };
    }, { interactiveOnly, max, nextStart: this._nextFerrumRef });
    if (Number.isSafeInteger(snapshot?.nextRef) && snapshot.nextRef > 0) this._nextFerrumRef = snapshot.nextRef;
    const { nextRef: _nextRef, ...result } = snapshot;
    return result;
  }

  async screenshot() {
    throw new Error('Lightpanda is a non-visual fast lane; Ferrum will not present placeholder CDP screenshots as visual test evidence. Use the Chromium fidelity lane for screenshots.');
  }

  dispose() { this._disposeEvents?.(); }
}

export async function launchLightpandaSession({ executable = process.env.FERRUM_LIGHTPANDA || 'lightpanda', evidence }) {
  const port = await freePort();
  const logFile = path.join(os.tmpdir(), `ferrum-lightpanda-${port}.log`);
  const lines = [];
  const child = spawnLogged(executable, ['serve', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warn'], {
    env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: process.env.LIGHTPANDA_DISABLE_TELEMETRY || 'true' }
  }, line => {
    lines.push(`[${line.source}] ${line.text}`);
    evidence.record('lightpanda-log', line);
  });

  let client;
  let page;
  try {
    const version = await waitHttp(`http://127.0.0.1:${port}/json/version`);
    const wsUrl = version.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/`;
    client = await CdpClient.connect(wsUrl, { timeoutMs: 15000 });
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    if (!targetId || !sessionId) throw new Error('Lightpanda did not return a target/session pair for the direct CDP lane');
    page = new LightpandaPage(client, sessionId, evidence);
    await page.init();
    evidence.record('lightpanda-cdp-ready', {
      transport: 'direct-cdp',
      version: version['Lightpanda-Version'] || null,
      targetId,
      sessionId
    });
    return {
      engine: 'lightpanda',
      transport: 'direct-cdp',
      client,
      page,
      context: null,
      async newPage() { return page; },
      async close() {
        page?.dispose();
        await client?.close().catch(() => {});
        await terminate(child);
        await fs.writeFile(logFile, lines.join('\n') + '\n', 'utf8').catch(() => {});
      }
    };
  } catch (error) {
    page?.dispose?.();
    await client?.close().catch(() => {});
    await terminate(child);
    await fs.writeFile(logFile, lines.join('\n') + '\n', 'utf8').catch(() => {});
    throw error;
  }
}
