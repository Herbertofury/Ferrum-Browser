import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, safeName, timestampId } from './paths.mjs';

export class EvidenceWriter {
  constructor({ root, name, metadata = {} }) {
    this.root = path.resolve(root || 'artifacts');
    this.name = safeName(name);
    this.id = `${timestampId()}-${this.name}-${crypto.randomBytes(4).toString('hex')}`;
    this.dir = path.join(this.root, this.id);
    this.events = [];
    this.metadata = metadata;
    this.startedAt = new Date().toISOString();
  }

  async init() {
    await ensureDir(this.dir);
    await ensureDir(path.join(this.dir, 'screenshots'));
    await ensureDir(path.join(this.dir, 'downloads'));
    return this;
  }

  record(type, data = {}) {
    const event = { at: new Date().toISOString(), type, ...data };
    this.events.push(event);
    return event;
  }

  async writeJson(name, data) {
    const target = path.join(this.dir, name);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return target;
  }

  async writeText(name, text) {
    const target = path.join(this.dir, name);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, String(text), 'utf8');
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
    const result = {
      schemaVersion: 1,
      id: this.id,
      name: this.name,
      startedAt: this.startedAt,
      endedAt,
      metadata: this.metadata,
      ...summary,
      events: this.events
    };
    await this.writeJson('result.json', result);
    return result;
  }
}
