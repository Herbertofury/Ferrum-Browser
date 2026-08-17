import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSensitive, redactUrl } from '../core/redact.mjs';
import { summarizeDurations } from '../core/stats.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeName(value) { return String(value || 'webdriver').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }
function elementId(element) { return element?.[ELEMENT_KEY] || element?.ELEMENT || null; }
function safeDecode(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}
function hasAuthorizationHeader(headers) {
  return Object.keys(headers || {}).some(key => key.toLowerCase() === 'authorization');
}
function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key), String(value)]));
}
function normalizeServer(baseUrl, headers = {}) {
  const raw = String(baseUrl || 'http://127.0.0.1:4444');
  const requestHeaders = normalizeHeaders(headers);
  try {
    const parsed = new URL(raw);
    if ((parsed.username || parsed.password) && !hasAuthorizationHeader(requestHeaders)) {
      const credential = `${safeDecode(parsed.username)}:${safeDecode(parsed.password)}`;
      requestHeaders.authorization = `Basic ${Buffer.from(credential).toString('base64')}`;
    }
    parsed.username = '';
    parsed.password = '';
    return { baseUrl: parsed.toString().replace(/\/$/, ''), headers: requestHeaders };
  } catch {
    return { baseUrl: raw.replace(/\/$/, ''), headers: requestHeaders };
  }
}

export class WebDriverClient {
  constructor(baseUrl, { timeoutMs = 30000, headers = {} } = {}) {
    const normalized = normalizeServer(baseUrl, headers);
    this.baseUrl = normalized.baseUrl;
    this.headers = normalized.headers;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
  }

  async request(method, endpoint, body, { timeoutMs = this.timeoutMs } = {}) {
    const headers = body === undefined ? { ...this.headers } : { ...this.headers, 'content-type': 'application/json' };
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = { value: text }; }
    }
    const webdriverError = payload?.value?.error;
    if (!response.ok || webdriverError) {
      const message = payload?.value?.message || payload?.message || `${method} ${endpoint} failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.webdriverError = webdriverError || null;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async waitUntilReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const status = await this.request('GET', '/status', undefined, { timeoutMs: Math.min(5000, Math.max(500, deadline - Date.now())) });
        if (status?.value?.ready !== false) return status;
      } catch (error) { lastError = error; }
      const waitMs = Math.min(300, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await sleep(waitMs);
    }
    throw new Error(`WebDriver server did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
  }

  async createSession(capabilities, { timeoutMs = this.timeoutMs } = {}) {
    const response = await this.request('POST', '/session', { capabilities: { alwaysMatch: capabilities || {} } }, { timeoutMs });
    this.sessionId = response?.value?.sessionId || response?.sessionId;
    if (!this.sessionId) throw new Error('WebDriver did not return a session id');
    return response;
  }

  async deleteSession() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    await this.request('DELETE', `/session/${id}`, undefined, { timeoutMs: 10000 });
  }

  sessionPath(suffix = '') {
    if (!this.sessionId) throw new Error('WebDriver session is not active');
    return `/session/${this.sessionId}${suffix}`;
  }

  async findAll(using, value, { timeoutMs = this.timeoutMs } = {}) {
    const response = await this.request('POST', this.sessionPath('/elements'), { using, value }, { timeoutMs });
    return Array.isArray(response?.value) ? response.value : [];
  }

  async find(using, value, { timeoutMs = this.timeoutMs, index = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const elements = await this.findAll(using, value, { timeoutMs: Math.min(this.timeoutMs, remainingMs) });
      lastCount = elements.length;
      const id = elementId(elements[Number(index) || 0]);
      if (id) return id;
      const waitMs = Math.min(250, Math.max(0, deadline - Date.now()));
      if (waitMs > 0) await sleep(waitMs);
    }
    throw new Error(`WebDriver element not found using ${using}=${value} at index ${index}; last count ${lastCount}`);
  }
}

async function elementFor(client, step, aliases, timeoutMs) {
  if (step.element) {
    const id = aliases.get(String(step.element));
    if (!id) throw new Error(`Unknown WebDriver element alias: ${step.element}`);
    return id;
  }
  if (!step.using || step.value == null) throw new Error(`${step.action} requires using/value or element alias`);
  return await client.find(String(step.using), String(step.value), { timeoutMs: step.timeoutMs || timeoutMs, index: step.index || 0 });
}

function findAllConstraintError(lastCount, min, max, budgetMs, attempts, lastError = null) {
  const requirement = [min == null ? null : `minimum ${min}`, max == null ? null : `maximum ${max}`].filter(Boolean).join(' and ');
  const requestDetail = lastError ? `; last request error: ${lastError.message}` : '';
  return new Error(`WebDriver find-all count ${lastCount} did not satisfy required ${requirement} within ${budgetMs}ms after ${attempts} attempt${attempts === 1 ? '' : 's'}${requestDetail}`);
}

async function findAllWithinConstraints(client, step, timeoutMs) {
  if (!step.using || step.value == null) throw new Error('find-all requires using/value');
  const using = String(step.using);
  const value = String(step.value);
  const min = step.min == null ? null : Number(step.min);
  const max = step.max == null ? null : Number(step.max);
  const budgetMs = Number(step.timeoutMs || timeoutMs);

  if (min == null && max == null) {
    const elements = await client.findAll(using, value, { timeoutMs: budgetMs });
    return { count: elements.length, attempts: 1 };
  }

  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  let lastCount = 0;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw findAllConstraintError(lastCount, min, max, budgetMs, attempts);
    try {
      const elements = await client.findAll(using, value, { timeoutMs: Math.min(client.timeoutMs, Math.max(1, remainingMs)) });
      attempts += 1;
      lastCount = elements.length;
      const minOk = min == null || lastCount >= min;
      const maxOk = max == null || lastCount <= max;
      if (minOk && maxOk) return { count: lastCount, attempts };
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || Date.now() >= deadline) {
        throw findAllConstraintError(lastCount, min, max, budgetMs, attempts, error);
      }
      throw error;
    }
    const waitMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) throw findAllConstraintError(lastCount, min, max, budgetMs, attempts);
    await sleep(waitMs);
  }
}

async function waitForExpectedText(client, step, aliases, timeoutMs) {
  const budgetMs = Number(step.timeoutMs || timeoutMs);
  const deadline = Date.now() + budgetMs;
  const expected = String(step.text ?? '');
  const equals = step.equals === true;
  let last = '';
  let attempts = 0;
  let lastElement = null;
  while (Date.now() < deadline) {
    let remainingMs = Math.max(1, deadline - Date.now());
    if (step.element) {
      lastElement = aliases.get(String(step.element));
      if (!lastElement) throw new Error(`Unknown WebDriver element alias: ${step.element}`);
    } else {
      if (!step.using || step.value == null) throw new Error('assert-text requires using/value or element alias');
      lastElement = await client.find(String(step.using), String(step.value), { timeoutMs: remainingMs, index: step.index || 0 });
    }
    remainingMs = Math.max(1, deadline - Date.now());
    const response = await client.request('GET', client.sessionPath(`/element/${lastElement}/text`), undefined, { timeoutMs: Math.min(client.timeoutMs, remainingMs) });
    last = String(response?.value ?? '');
    attempts += 1;
    if (equals ? last === expected : last.includes(expected)) return { element: lastElement, text: last, attempts };
    const waitMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await sleep(waitMs);
  }
  throw new Error(`WebDriver text mismatch within ${budgetMs}ms after ${attempts} attempt${attempts === 1 ? '' : 's'}: expected ${equals ? 'exactly ' : ''}${expected}, last observed ${last}`);
}

async function waitForDisplayed(client, step, aliases, timeoutMs) {
  const budgetMs = Number(step.timeoutMs || timeoutMs);
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  let lastDisplayed = false;
  let lastElement = null;

  while (Date.now() < deadline) {
    let remainingMs = Math.max(1, deadline - Date.now());
    if (step.element) {
      lastElement = aliases.get(String(step.element));
      if (!lastElement) throw new Error(`Unknown WebDriver element alias: ${step.element}`);
    } else {
      if (!step.using || step.value == null) throw new Error('assert-visible requires using/value or element alias');
      lastElement = await client.find(String(step.using), String(step.value), { timeoutMs: remainingMs, index: step.index || 0 });
    }

    remainingMs = Math.max(1, deadline - Date.now());
    try {
      const response = await client.request('GET', client.sessionPath(`/element/${lastElement}/displayed`), undefined, { timeoutMs: Math.min(client.timeoutMs, remainingMs) });
      lastDisplayed = response?.value === true;
      attempts += 1;
      if (lastDisplayed) return { element: lastElement, displayed: true, attempts };
    } catch (error) {
      const retryable = error?.webdriverError === 'stale element reference' || error?.webdriverError === 'no such element';
      if (!retryable) throw error;
      attempts += 1;
      lastDisplayed = false;
      if (step.element) {
        throw new Error(`WebDriver element alias ${step.element} became stale while waiting for visibility`);
      }
    }

    const waitMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await sleep(waitMs);
  }

  throw new Error(`WebDriver element did not become displayed within ${budgetMs}ms after ${attempts} attempt${attempts === 1 ? '' : 's'}; last observed displayed=${lastDisplayed}`);
}

async function captureScreenshot(client, evidence, name) {
  const response = await client.request('GET', client.sessionPath('/screenshot'));
  const buffer = Buffer.from(String(response?.value || ''), 'base64');
  if (!buffer.length) throw new Error('WebDriver returned an empty screenshot');
  const relative = `screenshots/${safeName(name)}.png`;
  const target = path.join(evidence.dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  evidence.record('screenshot', { path: relative, bytes: buffer.length, source: 'webdriver' });
  return { file: relative, bytes: buffer.length };
}

async function captureSource(client, evidence, name) {
  const response = await client.request('GET', client.sessionPath('/source'));
  const source = String(response?.value || '');
  const relative = `webdriver/${safeName(name)}.html`;
  await evidence.writeText(relative, source);
  evidence.record('webdriver-source', { path: relative, bytes: Buffer.byteLength(source) });
  return { file: relative, bytes: Buffer.byteLength(source) };
}

export async function runWebDriverTarget(spec, evidence) {
  const timeoutMs = spec.timeouts?.stepMs || 30000;
  const startupMs = spec.timeouts?.startupMs || 30000;
  const client = new WebDriverClient(spec.target.server || 'http://127.0.0.1:4444', {
    timeoutMs,
    headers: spec.target.headers || {}
  });
  const aliases = new Map();
  const durations = [];
  const outputs = [];
  const statusRaw = await client.waitUntilReady(startupMs);
  const safeServer = redactUrl(client.baseUrl);
  const serverStatus = redactSensitive(statusRaw?.value || statusRaw);
  evidence.record('webdriver-server-ready', { server: safeServer, status: serverStatus });
  const created = await client.createSession(spec.target.capabilities || { browserName: 'chrome' }, { timeoutMs: startupMs });
  const capabilities = redactSensitive(created?.value?.capabilities || created?.capabilities || spec.target.capabilities || {});
  evidence.record('webdriver-session-start', { sessionId: client.sessionId, capabilities, startupTimeoutMs: startupMs });
  await evidence.writeJson('webdriver-session.json', { sessionId: client.sessionId, server: safeServer, capabilities, serverStatus, startupTimeoutMs: startupMs });

  try {
    for (let index = 0; index < spec.steps.length; index++) {
      const step = spec.steps[index];
      const started = performance.now();
      evidence.record('step-start', { index, action: step.action, step: redactSensitive(step) });
      try {
        let output;
        switch (step.action) {
          case 'goto':
          case 'navigate':
            await client.request('POST', client.sessionPath('/url'), { url: String(step.url) }, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { url: String(step.url) };
            break;
          case 'find': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            if (step.as) aliases.set(String(step.as), id);
            output = { element: id, alias: step.as || null };
            break;
          }
          case 'find-all':
            output = await findAllWithinConstraints(client, step, timeoutMs);
            break;
          case 'click': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            await client.request('POST', client.sessionPath(`/element/${id}/click`), {}, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { element: id };
            break;
          }
          case 'clear': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            await client.request('POST', client.sessionPath(`/element/${id}/clear`), {}, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { element: id };
            break;
          }
          case 'fill': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const text = String(step.text ?? step.input ?? '');
            if (step.clear !== false) await client.request('POST', client.sessionPath(`/element/${id}/clear`), {}, { timeoutMs: step.timeoutMs || timeoutMs }).catch(() => {});
            await client.request('POST', client.sessionPath(`/element/${id}/value`), { text, value: [...text] }, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { element: id, length: text.length };
            break;
          }
          case 'get-text': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/text`), undefined, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { element: id, text: String(response?.value ?? '') };
            break;
          }
          case 'get-attribute': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/attribute/${encodeURIComponent(String(step.name))}`), undefined, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { element: id, name: step.name, value: response?.value ?? null };
            break;
          }
          case 'assert-text': {
            const matched = await waitForExpectedText(client, step, aliases, timeoutMs);
            output = { element: matched.element, text: matched.text, attempts: matched.attempts };
            break;
          }
          case 'assert-visible': {
            const matched = await waitForDisplayed(client, step, aliases, timeoutMs);
            output = matched;
            break;
          }
          case 'wait': {
            if (step.using || step.element) {
              const id = await elementFor(client, step, aliases, timeoutMs);
              output = { element: id };
            } else {
              await sleep(Number(step.ms || 0));
              output = { waitedMs: Number(step.ms || 0) };
            }
            break;
          }
          case 'back':
            await client.request('POST', client.sessionPath('/back'), {}, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { back: true };
            break;
          case 'forward':
            await client.request('POST', client.sessionPath('/forward'), {}, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { forward: true };
            break;
          case 'refresh':
            await client.request('POST', client.sessionPath('/refresh'), {}, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { refresh: true };
            break;
          case 'title': {
            const response = await client.request('GET', client.sessionPath('/title'), undefined, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { title: String(response?.value ?? '') };
            break;
          }
          case 'url': {
            const response = await client.request('GET', client.sessionPath('/url'), undefined, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { url: String(response?.value ?? '') };
            break;
          }
          case 'execute': {
            const response = await client.request('POST', client.sessionPath('/execute/sync'), { script: String(step.script || ''), args: Array.isArray(step.args) ? step.args : [] }, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { value: response?.value ?? null };
            break;
          }
          case 'screenshot':
            output = await captureScreenshot(client, evidence, step.name || `webdriver-${index}`);
            break;
          case 'source':
            output = await captureSource(client, evidence, step.name || `source-${index}`);
            break;
          case 'assert-session': {
            const response = await client.request('GET', client.sessionPath('/url'), undefined, { timeoutMs: step.timeoutMs || timeoutMs });
            output = { sessionId: client.sessionId, url: String(response?.value ?? '') };
            break;
          }
          default:
            throw new Error(`Unsupported WebDriver step: ${step.action}`);
        }
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        const safeOutput = redactSensitive(output);
        outputs.push({ index, action: step.action, ok: true, durationMs, output: safeOutput });
        evidence.record('step-pass', { index, action: step.action, durationMs, output: safeOutput });
      } catch (error) {
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        evidence.record('step-fail', { index, action: step.action, durationMs, message: redactSensitive(error.message), stack: redactSensitive(error.stack) });
        await captureSource(client, evidence, `failure-${index}`).catch(captureError => evidence.record('webdriver-capture-error', { kind: 'source', message: redactSensitive(captureError.message) }));
        await captureScreenshot(client, evidence, `failure-${index}`).catch(captureError => evidence.record('webdriver-capture-error', { kind: 'screenshot', message: redactSensitive(captureError.message) }));
        throw Object.assign(error, { ferrumStep: { index, step: redactSensitive(step) } });
      }
    }
    return redactSensitive({ engine: 'webdriver', session: { id: client.sessionId, server: safeServer, capabilities }, outputs, timings: summarizeDurations(durations) });
  } finally {
    const sessionId = client.sessionId;
    await client.deleteSession().then(() => evidence.record('webdriver-session-end', { sessionId })).catch(error => evidence.record('webdriver-session-cleanup-error', { sessionId, message: redactSensitive(error.message) }));
  }
}
