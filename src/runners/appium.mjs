import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeDurations } from '../core/stats.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeName(value) { return String(value || 'appium').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); }

export class AppiumClient {
  constructor(baseUrl, { timeoutMs = 30000, evidence = null } = {}) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:4723').replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.evidence = evidence;
    this.sessionId = null;
  }

  async request(method, endpoint, body, { timeoutMs = this.timeoutMs } = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let payload = null;
    const text = await response.text();
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
      await sleep(300);
    }
    throw new Error(`Appium server did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
  }

  async createSession(capabilities, { timeoutMs = this.timeoutMs } = {}) {
    const response = await this.request('POST', '/session', { capabilities: { alwaysMatch: capabilities || {} } }, { timeoutMs });
    this.sessionId = response?.value?.sessionId || response?.sessionId;
    if (!this.sessionId) throw new Error('Appium did not return a session id');
    return response;
  }

  async deleteSession() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    await this.request('DELETE', `/session/${id}`, undefined, { timeoutMs: 10000 });
  }

  sessionPath(suffix = '') {
    if (!this.sessionId) throw new Error('Appium session is not active');
    return `/session/${this.sessionId}${suffix}`;
  }

  async findAll(using, value) {
    const response = await this.request('POST', this.sessionPath('/elements'), { using, value });
    return Array.isArray(response?.value) ? response.value : [];
  }

  async find(using, value, { timeoutMs = this.timeoutMs, index = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;
    while (Date.now() < deadline) {
      const elements = await this.findAll(using, value);
      lastCount = elements.length;
      const element = elements[Number(index) || 0];
      const id = element?.[ELEMENT_KEY] || element?.ELEMENT;
      if (id) return id;
      await sleep(250);
    }
    throw new Error(`Appium element not found using ${using}=${value} at index ${index}; last count ${lastCount}`);
  }
}

async function elementFor(client, step, aliases, timeoutMs) {
  if (step.element) {
    const id = aliases.get(String(step.element));
    if (!id) throw new Error(`Unknown Appium element alias: ${step.element}`);
    return id;
  }
  if (!step.using || step.value == null) throw new Error(`${step.action} requires using/value or element alias`);
  return await client.find(String(step.using), String(step.value), { timeoutMs: step.timeoutMs || timeoutMs, index: step.index || 0 });
}

async function captureScreenshot(client, evidence, name) {
  const response = await client.request('GET', client.sessionPath('/screenshot'));
  const buffer = Buffer.from(String(response?.value || ''), 'base64');
  if (!buffer.length) throw new Error('Appium returned an empty screenshot');
  const relative = `screenshots/${safeName(name)}.png`;
  const target = path.join(evidence.dir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  evidence.record('screenshot', { path: relative, bytes: buffer.length, source: 'appium' });
  return { file: relative, bytes: buffer.length };
}

async function captureSource(client, evidence, name) {
  const response = await client.request('GET', client.sessionPath('/source'));
  const source = String(response?.value || '');
  const relative = `appium/${safeName(name)}.xml`;
  await evidence.writeText(relative, source);
  evidence.record('appium-source', { path: relative, bytes: Buffer.byteLength(source) });
  return { file: relative, bytes: Buffer.byteLength(source) };
}

export async function runAppiumTarget(spec, evidence) {
  const timeoutMs = spec.timeouts?.stepMs || 30000;
  const startupMs = spec.timeouts?.startupMs || 30000;
  const client = new AppiumClient(spec.target.server || 'http://127.0.0.1:4723', { timeoutMs, evidence });
  const aliases = new Map();
  const durations = [];
  const outputs = [];
  const serverStatus = await client.waitUntilReady(startupMs);
  evidence.record('appium-server-ready', { server: client.baseUrl, status: serverStatus?.value || serverStatus });
  const created = await client.createSession(spec.target.capabilities || {}, { timeoutMs: startupMs });
  const capabilities = created?.value?.capabilities || created?.capabilities || spec.target.capabilities || {};
  evidence.record('appium-session-start', { sessionId: client.sessionId, capabilities, startupTimeoutMs: startupMs });
  await evidence.writeJson('appium-session.json', { sessionId: client.sessionId, server: client.baseUrl, capabilities, serverStatus: serverStatus?.value || serverStatus, startupTimeoutMs: startupMs });

  try {
    for (let index = 0; index < spec.steps.length; index++) {
      const step = spec.steps[index];
      const started = performance.now();
      evidence.record('step-start', { index, action: step.action, step });
      try {
        let output;
        switch (step.action) {
          case 'find': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            if (step.as) aliases.set(String(step.as), id);
            output = { element: id, alias: step.as || null };
            break;
          }
          case 'find-all': {
            if (!step.using || step.value == null) throw new Error('find-all requires using/value');
            const elements = await client.findAll(String(step.using), String(step.value));
            const count = elements.length;
            if (step.min != null && count < Number(step.min)) throw new Error(`Appium find-all count ${count} is below required minimum ${step.min}`);
            if (step.max != null && count > Number(step.max)) throw new Error(`Appium find-all count ${count} exceeds allowed maximum ${step.max}`);
            output = { count };
            break;
          }
          case 'click': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            await client.request('POST', client.sessionPath(`/element/${id}/click`), {});
            output = { element: id };
            break;
          }
          case 'clear': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            await client.request('POST', client.sessionPath(`/element/${id}/clear`), {});
            output = { element: id };
            break;
          }
          case 'fill': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const text = String(step.text ?? step.input ?? '');
            if (step.clear !== false) await client.request('POST', client.sessionPath(`/element/${id}/clear`), {}).catch(() => {});
            await client.request('POST', client.sessionPath(`/element/${id}/value`), { text, value: [...text] });
            output = { element: id, length: text.length };
            break;
          }
          case 'get-text': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/text`));
            output = { element: id, text: String(response?.value ?? '') };
            break;
          }
          case 'get-attribute': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/attribute/${encodeURIComponent(String(step.name))}`));
            output = { element: id, name: step.name, value: response?.value ?? null };
            break;
          }
          case 'assert-text': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/text`));
            const actual = String(response?.value ?? '');
            const expected = String(step.text ?? '');
            if (step.equals ? actual !== expected : !actual.includes(expected)) throw new Error(`Appium text mismatch: expected ${step.equals ? 'exactly ' : ''}${expected}, got ${actual}`);
            output = { element: id, text: actual };
            break;
          }
          case 'assert-visible': {
            const id = await elementFor(client, step, aliases, timeoutMs);
            const response = await client.request('GET', client.sessionPath(`/element/${id}/displayed`));
            if (response?.value !== true) throw new Error('Appium element is not displayed');
            output = { element: id, displayed: true };
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
            await client.request('POST', client.sessionPath('/back'), {});
            output = { back: true };
            break;
          case 'screenshot':
            output = await captureScreenshot(client, evidence, step.name || `appium-${index}`);
            break;
          case 'source':
            output = await captureSource(client, evidence, step.name || `source-${index}`);
            break;
          case 'assert-session': {
            const response = await client.request('GET', client.sessionPath());
            output = { sessionId: client.sessionId, capabilities: response?.value?.capabilities || response?.value || null };
            break;
          }
          default:
            throw new Error(`Unsupported Appium step: ${step.action}`);
        }
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        outputs.push({ index, action: step.action, ok: true, durationMs, output });
        evidence.record('step-pass', { index, action: step.action, durationMs, output });
      } catch (error) {
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        evidence.record('step-fail', { index, action: step.action, durationMs, message: error.message, stack: error.stack });
        await captureSource(client, evidence, `failure-${index}`).catch(captureError => evidence.record('appium-capture-error', { kind: 'source', message: captureError.message }));
        await captureScreenshot(client, evidence, `failure-${index}`).catch(captureError => evidence.record('appium-capture-error', { kind: 'screenshot', message: captureError.message }));
        throw Object.assign(error, { ferrumStep: { index, step } });
      }
    }
    return { engine: 'appium', session: { id: client.sessionId, server: client.baseUrl, capabilities }, outputs, timings: summarizeDurations(durations) };
  } finally {
    const sessionId = client.sessionId;
    await client.deleteSession().then(() => evidence.record('appium-session-end', { sessionId })).catch(error => evidence.record('appium-session-cleanup-error', { sessionId, message: error.message }));
  }
}
