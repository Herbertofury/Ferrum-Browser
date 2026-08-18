import path from 'node:path';
import { collectPageVitals } from '../browser/diagnostics.mjs';
import { executeAgentAction, performWithLocatorFallback, snapshotPage } from '../browser/agent-surface.mjs';
import { summarizeDurations } from '../core/stats.mjs';

export function navigationWaitUntil(sessionEngine, requested) {
  if (requested) return requested;
  return sessionEngine === 'lightpanda' ? 'commit' : 'domcontentloaded';
}

export async function waitForLocatorText(locator, expected, timeoutMs, { pollMs = 50 } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  let lastText = '';
  let lastError = null;
  while (true) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      lastText = await locator.innerText({ timeout: remaining });
      lastError = null;
      if (lastText.includes(expected)) return { matched: expected, text: lastText };
    } catch (error) {
      lastError = error;
    }
    const sleepMs = deadline - Date.now();
    if (sleepMs <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), sleepMs)));
  }
  if (lastError) throw lastError;
  throw new Error(`Expected text not found within ${timeoutMs}ms: ${expected}; last text: ${JSON.stringify(lastText.slice(0, 300))}`);
}

export async function terminateExtensionServiceWorker(context, page, extensionId, { timeoutMs = 3000, pollMs = 25 } = {}) {
  if (!extensionId) throw new Error('terminate-service-worker requires an extension target');
  if (typeof context?.newCDPSession !== 'function') {
    throw new Error('terminate-service-worker requires Chromium CDP access');
  }

  const cdp = await context.newCDPSession(page);
  try {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const extensionPrefix = `chrome-extension://${extensionId}/`;
    const matches = targetInfos.filter(target => target.type === 'service_worker' && String(target.url || '').startsWith(extensionPrefix));
    if (!matches.length) {
      throw new Error(`No service_worker target found for loaded extension ${extensionId}`);
    }
    if (matches.length > 1) {
      throw new Error(`Refusing ambiguous service-worker termination for extension ${extensionId}: ${matches.length} matching targets`);
    }

    const target = matches[0];
    const response = await cdp.send('Target.closeTarget', { targetId: target.targetId });
    if (response?.success === false) {
      throw new Error(`Chrome refused to close extension service-worker target ${target.targetId}`);
    }

    const budgetMs = Math.max(1, Number(timeoutMs) || 1);
    const deadline = Date.now() + budgetMs;
    let confirmationAttempts = 0;
    while (true) {
      const current = await cdp.send('Target.getTargets');
      confirmationAttempts += 1;
      const stillPresent = (current?.targetInfos || []).some(candidate => candidate.targetId === target.targetId);
      if (!stillPresent) {
        return {
          extensionId,
          targetId: target.targetId,
          url: target.url,
          closed: true,
          confirmedBy: 'Target.getTargets',
          confirmationAttempts
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(1, Number(pollMs) || 1), remaining)));
    }
    throw new Error(`Extension service-worker target ${target.targetId} remained present after Target.closeTarget within ${budgetMs}ms`);
  } finally {
    try {
      await cdp.detach?.();
    } catch {
      // The target may disappear while the CDP session is detaching; termination evidence remains authoritative.
    }
  }
}

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
        if (output?.locatorStrategy === 'semantic-fallback') {
          this.evidence.record('locator-fallback', {
            index,
            action: step.action,
            deterministic: { ref: step.ref || null, selector: step.selector || null },
            fallback: output.fallback,
            deterministicError: output.deterministicError || null
          });
        }
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
        const waitUntil = navigationWaitUntil(this.session.engine, step.waitUntil);
        const response = await this.page.goto(step.url, { waitUntil, timeout: step.timeoutMs || this.timeoutMs });
        if (this.session.engine === 'lightpanda' && waitUntil === 'commit') {
          await this.page.waitForFunction(() => document.readyState !== 'loading' && document.documentElement != null, null, { timeout: step.readyTimeoutMs || step.timeoutMs || this.timeoutMs }).catch(async () => {
            await this.page.locator('body').waitFor({ state: 'attached', timeout: Math.min(2000, step.readyTimeoutMs || step.timeoutMs || this.timeoutMs) });
          });
        }
        return { url: this.page.url(), status: response?.status() ?? null, waitUntil };
      }
      case 'wait':
        return await executeAgentAction(this.page, { ...step, timeoutMs: step.timeoutMs || this.timeoutMs });
      case 'click':
      case 'fill':
      case 'press':
      case 'text':
        return await executeAgentAction(this.page, { ...step, timeoutMs: step.timeoutMs || this.timeoutMs });
      case 'network-offline': {
        const setOffline = this.session?.context?.setOffline;
        if (typeof setOffline !== 'function') {
          throw new Error(`network-offline is unavailable for target engine ${this.session?.engine || 'unknown'}`);
        }
        const offline = step.enabled == null ? true : Boolean(step.enabled);
        await setOffline.call(this.session.context, offline);
        this.evidence.record('network-state', { engine: this.session.engine || null, offline });
        return { offline };
      }
      case 'terminate-service-worker': {
        const result = await terminateExtensionServiceWorker(this.session?.context, this.page, this.extensionId, {
          timeoutMs: step.timeoutMs || Math.min(this.timeoutMs, 5000),
          pollMs: step.pollMs || 25
        });
        this.evidence.record('service-worker-termination', result);
        return result;
      }
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
        const expected = String(step.text);
        if (!step.selector && !step.ref) {
          const locator = this.page.locator('body');
          return await waitForLocatorText(locator, expected, step.timeoutMs || this.timeoutMs);
        }
        const resolved = await performWithLocatorFallback(this.page, { ...step, action: 'assert-text' }, async (locator, timeout) => {
          return await waitForLocatorText(locator, expected, timeout, { pollMs: step.pollMs || 50 });
        });
        return { ...resolved.value, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError };
      }
      case 'assert-visible': {
        const resolved = await performWithLocatorFallback(this.page, { ...step, action: 'assert-visible' }, locator => locator.waitFor({ state: 'visible', timeout: step.timeoutMs || this.timeoutMs }));
        return { selector: step.selector || null, ref: step.ref || null, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError };
      }
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
      case 'service-worker-diagnostics': {
        const diagnostics = this.session.serviceWorkerDiagnostics?.snapshot?.();
        if (!diagnostics) throw new Error('Service-worker diagnostics are unavailable for this target');
        if (step.name) await this.evidence.writeJson(`diagnostics/${step.name}.json`, diagnostics);
        return diagnostics;
      }
      case 'assert-service-worker-diagnostics': {
        const diagnostics = this.session.serviceWorkerDiagnostics?.snapshot?.();
        if (!diagnostics) throw new Error('Service-worker diagnostics are unavailable for this target');
        const checks = [
          ['workers', step.minWorkers],
          ['console', step.minConsole],
          ['requests', step.minRequests],
          ['responses', step.minResponses],
          ['interceptedResponses', step.minInterceptedResponses],
          ['closedWorkers', step.minClosedWorkers]
        ];
        for (const [field, minimum] of checks) {
          if (minimum != null && diagnostics[field] < Number(minimum)) {
            throw new Error(`Service-worker diagnostics ${field}=${diagnostics[field]} is below required minimum ${minimum}`);
          }
        }
        if (step.maxFailedRequests != null && diagnostics.failedRequests > Number(step.maxFailedRequests)) {
          throw new Error(`Service-worker failedRequests=${diagnostics.failedRequests} exceeds allowed maximum ${step.maxFailedRequests}`);
        }
        return diagnostics;
      }
      case 'assert-locator-fallbacks': {
        const events = this.evidence.events.filter(event => event.type === 'locator-fallback');
        const count = events.length;
        if (step.min != null && count < Number(step.min)) throw new Error(`Locator fallback count ${count} is below required minimum ${step.min}`);
        if (step.max != null && count > Number(step.max)) throw new Error(`Locator fallback count ${count} exceeds allowed maximum ${step.max}`);
        return { count, fallbacks: events.map(event => ({ index: event.index, action: event.action, fallback: event.fallback })) };
      }
      case 'assert-console-clean': {
        const bad = this.evidence.events.filter(event =>
          event.type === 'pageerror' ||
          event.type === 'requestfailed' ||
          event.type === 'service-worker-requestfailed' ||
          ((event.type === 'console' || event.type === 'service-worker-console') && ['error', 'assert'].includes(event.level)) ||
          ((event.type === 'response-error' || event.type === 'service-worker-response') && Number(event.status) >= 500)
        );
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
