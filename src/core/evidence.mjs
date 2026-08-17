import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, safeName, timestampId } from './paths.mjs';
import { redactSensitive } from './redact.mjs';
import { writeEvidenceManifest } from './evidence-store.mjs';

function summarizeEvents(events) {
  const eventCounts = {};
  const diagnosticErrors = [];
  for (const event of events) {
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    const isError =
      event.type === 'pageerror' ||
      event.type === 'requestfailed' ||
      event.type === 'service-worker-requestfailed' ||
      ((event.type === 'console' || event.type === 'service-worker-console') && ['error', 'assert'].includes(event.level)) ||
      ((event.type === 'response-error' || event.type === 'service-worker-response') && Number(event.status) >= 500);
    if (isError) diagnosticErrors.push(event);
  }
  return { eventCounts, diagnosticErrorCount: diagnosticErrors.length };
}

export class EvidenceWriter {
  constructor({ root, name, metadata = {}, redactValues = [] }) {
    this.root = path.resolve(root || 'artifacts');
    this.name = safeName(name);
    this.id = `${timestampId()}-${this.name}-${crypto.randomBytes(4).toString('hex')}`;
    this.dir = path.join(this.root, this.id);
    this.events = [];
    this.redactValues = [...new Set((redactValues || []).map(value => String(value)).filter(Boolean))];
    this.metadata = redactSensitive(metadata, null, this.redactValues);
    this.startedAt = new Date().toISOString();
  }

  async init() {
    await ensureDir(this.dir);
    await ensureDir(path.join(this.dir, 'screenshots'));
    await ensureDir(path.join(this.dir, 'downloads'));
    return this;
  }

  record(type, data = {}) {
    const event = { at: new Date().toISOString(), type, ...redactSensitive(data, null, this.redactValues) };
    this.events.push(event);
    return event;
  }

  async writeJson(name, data) {
    const target = path.join(this.dir, name);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, JSON.stringify(redactSensitive(data, null, this.redactValues), null, 2) + '\n', 'utf8');
    return target;
  }

  async writeText(name, text) {
    const target = path.join(this.dir, name);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, redactSensitive(String(text), null, this.redactValues), 'utf8');
    return target;
  }

  async screenshot(page, name = 'page') {
    const target = path.join(this.dir, 'screenshots', `${safeName(name)}.png`);
    await page.screenshot({ path: target, fullPage: true });
    this.record('screenshot', { path: path.relative(this.dir, target).replaceAll('\\', '/') });
    return target;
  }

  async finalize(summary = {}) {
    const endedAt = new Date().toISOString();
    const compact = summarizeEvents(this.events);
    const result = redactSensitive({
      schemaVersion: 1,
      id: this.id,
      name: this.name,
      startedAt: this.startedAt,
      endedAt,
      evidenceDir: this.dir,
      metadata: this.metadata,
      ...summary,
      summary: compact,
      events: this.events
    }, null, this.redactValues);
    await this.writeJson('result.json', result);
    await this.writeJson('agent-summary.json', {
      schemaVersion: 1,
      id: result.id,
      name: result.name,
      status: result.status,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      evidenceDir: result.evidenceDir,
      metadata: result.metadata,
      engine: result.result?.engine || null,
      timings: result.result?.timings || null,
      ...compact,
      failure: result.failure || null
    });
    await writeEvidenceManifest(this.dir);
    return result;
  }
}
