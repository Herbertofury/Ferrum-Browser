import path from 'node:path';
import { collectPageVitals } from '../browser/diagnostics.mjs';
import { executeAgentAction, snapshotPage } from '../browser/agent-surface.mjs';
import { summarizeDurations } from '../core/stats.mjs';

export class StepEngine {
  constructor({ evidence, session, page, extensionId = null, extensionManifest = null, timeoutMs = 30000, onRestart = null }) {
    this.evidence = evidence;
    this.session = session;
    this.page = page;
    this.extensionId = extensionId;
    this.extensionManifest = extensionManifest;
    this.timeoutMs = timeoutMs;
    this.onRestart = onRestart;
    this.durations = [];
  }

  async run(steps) {
    const outputs = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const started = performance.now();
      this.evidence.record('step-start', { index, action: step.action, step });
      try {
        const output = await this.execute(step, index);
        const durationMs = performance.now() - started;
        this.durations.push(durationMs);
        this.evidence.record('step-pass', { index, action: step.action, durationMs, output });
        outputs.push({ index, action: step.action, ok: true, durationMs, output });
      } catch (error) {
        const durationMs = performance.now() - started;
        this.durations.push(durationMs);
        this.evidence.record('step-fail', { index, action: step.action, durationMs, message: error.message, stack: error.stack });
        throw Object.assign(error, { ferrumStep: { index, step } });
      }
    }
    return { outputs, timings: summarizeDurations(this.durations) };
  }

  async execute(step, index) {
    switch (step.action) {
      case 'open':
      case 'goto': {
        const response = await this.page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: step.timeoutMs || this.timeoutMs });
        return { url: this.page.url(), status: response?.status() ?? null };
      }
      case 'wait':
        if (step.selector) await this.page.locator(step.selector).waitFor({ state: step.state || 'visible', timeout: step.timeoutMs || this.timeoutMs });
        else await this.page.waitForTimeout(Number(step.ms || 0));
        return { waited: true };
      case 'click':
      case 'fill':
      case 'press':
      case 'text':
        return await executeAgentAction(this.page, { ...step, timeoutMs: step.timeoutMs || this.timeoutMs });
      case 'snapshot': {
        const snapshot = await snapshotPage(this.page, { interactiveOnly: step.interactiveOnly ?? false, max: step.max || 400 });
        if (step.name) await this.evidence.writeJson(`snapshots/${step.name}.json`, snapshot);
        return { elements: snapshot.elements.length, url: snapshot.url };
      }
      case 'screenshot': {
        const file = await this.evidence.screenshot(this.page, step.name || `step-${index}`);
        return { file: path.relative(this.evidence.dir, file).replaceAll('\\', '/') };
      }
      case 'assert-text': {
        const locator = step.selector ? this.page.locator(step.selector) : this.page.locator('body');
        const text = await locator.innerText();
        const expected = String(step.text);
        if (!text.includes(expected)) throw new Error(`Expected text not found: ${expected}`);
        return { matched: expected };
      }
      case 'assert-visible':
        await this.page.locator(step.selector).waitFor({ state: 'visible', timeout: step.timeoutMs || this.timeoutMs });
        return { selector: step.selector };
      case 'assert-url': {
        const value = this.page.url();
        if (step.equals && value !== step.equals) throw new Error(`URL mismatch: expected ${step.equals}, got ${value}`);
        if (step.includes && !value.includes(step.includes)) throw new Error(`URL does not include ${step.includes}: ${value}`);
        return { url: value };
      }
      case 'evaluate':
        return await this.page.evaluate(step.script);
      case 'vitals': {
        const vitals = await collectPageVitals(this.page);
        if (step.name) await this.evidence.writeJson(`vitals/${step.name}.json`, vitals);
        return vitals;
      }
      case 'extension-page': {
        if (!this.extensionId) throw new Error('extension-page requires an extension target');
        const resource = String(step.path || this.extensionManifest?.action?.default_popup || this.extensionManifest?.side_panel?.default_path || '');
        if (!resource) throw new Error('No extension page path supplied or discoverable from manifest');
        await this.page.goto(`chrome-extension://${this.extensionId}/${resource.replace(/^\//, '')}`, { waitUntil: 'domcontentloaded', timeout: step.timeoutMs || this.timeoutMs });
        return { url: this.page.url(), resource };
      }
      case 'assert-service-worker': {
        const context = this.session.context;
        if (!context?.serviceWorkers) throw new Error('Service-worker inspection is unavailable for this target');
        const timeoutMs = step.timeoutMs || this.timeoutMs;
        const deadline = Date.now() + timeoutMs;
        let workers = context.serviceWorkers();
        while (!workers.length && Date.now() < deadline) {
          const remaining = Math.max(1, deadline - Date.now());
          await Promise.race([
            context.waitForEvent?.('serviceworker', { timeout: Math.min(750, remaining) }).catch(() => null),
            new Promise(resolve => setTimeout(resolve, Math.min(150, remaining)))
          ]);
          workers = context.serviceWorkers();
        }
        if (!workers.length) throw new Error(`No extension service worker became active within ${timeoutMs}ms`);
        const urls = workers.map(worker => worker.url());
        if (this.extensionId && !urls.some(url => url.startsWith(`chrome-extension://${this.extensionId}/`))) {
          throw new Error(`Active service worker does not belong to loaded extension ${this.extensionId}: ${urls.join(', ')}`);
        }
        return { workers: urls };
      }
      case 'assert-console-clean': {
        const bad = this.evidence.events.filter(event => event.type === 'pageerror' || event.type === 'requestfailed' || (event.type === 'console' && ['error', 'assert'].includes(event.level)));
        if (bad.length) throw new Error(`Runtime diagnostics contain ${bad.length} error event(s)`);
        return { errors: 0 };
      }
      case 'restart': {
        if (!this.onRestart) throw new Error('restart is not supported for this target');
        const restarted = await this.onRestart();
        this.session = restarted.session;
        this.page = restarted.page;
        if (restarted.extensionId) this.extensionId = restarted.extensionId;
        return { restarted: true, extensionId: this.extensionId };
      }
      default:
        throw new Error(`Unsupported step action: ${step.action}`);
    }
  }
}
