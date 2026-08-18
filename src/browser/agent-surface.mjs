const REF_ATTR = 'data-ferrum-ref';
const DEFAULT_FALLBACK_PROBE_MS = 1000;

export async function snapshotPage(page, { interactiveOnly = false, max = 400 } = {}) {
  if (typeof page.ferrumSnapshot === 'function') return await page.ferrumSnapshot({ interactiveOnly, max });
  return await page.evaluate(({ interactiveOnly, max, attr }) => {
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const interactiveSelector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"],[tabindex]';
    const all = [...document.querySelectorAll(interactiveOnly ? interactiveSelector : 'body *')];
    const refOwners = new Map();
    const reservedRefs = new Set();
    let next = 1;
    for (const el of document.querySelectorAll(`[${attr}]`)) {
      const ref = el.getAttribute(attr);
      const match = /^e(\d+)$/.exec(ref || '');
      if (!match) continue;
      const numeric = Number(match[1]);
      if (!Number.isSafeInteger(numeric) || numeric < 1) continue;
      if (!refOwners.has(ref)) refOwners.set(ref, el);
      reservedRefs.add(ref);
      next = Math.max(next, numeric + 1);
    }
    const results = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const interactive = el.matches(interactiveSelector);
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 180);
      if (!interactive && !text) continue;
      let ref = el.getAttribute(attr);
      if (!/^e\d+$/.test(ref || '') || refOwners.get(ref) !== el) {
        do {
          ref = `e${next++}`;
        } while (reservedRefs.has(ref));
        el.setAttribute(attr, ref);
        refOwners.set(ref, el);
        reservedRefs.add(ref);
      }
      results.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || null,
        type: el.getAttribute('type') || null,
        name: text,
        href: el instanceof HTMLAnchorElement ? el.href : null,
        disabled: 'disabled' in el ? Boolean(el.disabled) : false,
        checked: 'checked' in el ? Boolean(el.checked) : null
      });
      if (results.length >= max) break;
    }
    return { url: location.href, title: document.title, elements: results };
  }, { interactiveOnly, max, attr: REF_ATTR });
}

export function locatorForRef(page, ref) {
  if (!/^e\d+$/.test(ref)) throw new Error(`Invalid Ferrum ref: ${ref}`);
  return page.locator(`[${REF_ATTR}="${ref}"]`);
}

export function semanticLocator(page, fallback) {
  if (!fallback || typeof fallback !== 'object') throw new Error('Semantic fallback must be an object');
  let locator;
  if (fallback.role) {
    const options = fallback.name == null ? {} : { name: String(fallback.name), exact: Boolean(fallback.exact) };
    locator = page.getByRole(String(fallback.role), options);
  } else if (fallback.label != null) {
    locator = page.getByLabel(String(fallback.label), { exact: Boolean(fallback.exact) });
  } else if (fallback.placeholder != null) {
    locator = page.getByPlaceholder(String(fallback.placeholder), { exact: Boolean(fallback.exact) });
  } else if (fallback.text != null) {
    locator = page.getByText(String(fallback.text), { exact: Boolean(fallback.exact) });
  } else if (fallback.title != null) {
    locator = page.getByTitle(String(fallback.title), { exact: Boolean(fallback.exact) });
  } else if (fallback.alt != null) {
    locator = page.getByAltText(String(fallback.alt), { exact: Boolean(fallback.exact) });
  } else if (fallback.testId != null) {
    locator = page.getByTestId(String(fallback.testId));
  } else {
    throw new Error('Semantic fallback requires role/name, label, placeholder, text, title, alt, or testId');
  }
  if (fallback.nth != null) locator = locator.nth(Number(fallback.nth));
  else if (fallback.first === true) locator = locator.first();
  return locator;
}

function deterministicLocator(page, action) {
  let locator = action.ref ? locatorForRef(page, action.ref) : action.selector ? page.locator(action.selector) : null;
  if (!locator) return null;
  if (action.nth != null) locator = locator.nth(Number(action.nth));
  else if (action.first === true) locator = locator.first();
  return locator;
}

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function locatorTimeouts(action) {
  const fullTimeoutMs = positiveTimeout(action.timeoutMs, 30000);
  if (!action.fallback) return { deterministicTimeoutMs: fullTimeoutMs, fallbackTimeoutMs: fullTimeoutMs };
  const requestedProbe = positiveTimeout(action.fallbackProbeMs, DEFAULT_FALLBACK_PROBE_MS);
  return {
    deterministicTimeoutMs: Math.min(fullTimeoutMs, requestedProbe),
    fallbackTimeoutMs: fullTimeoutMs
  };
}

export async function performWithLocatorFallback(page, action, operation) {
  const deterministic = deterministicLocator(page, action);
  if (!deterministic) throw new Error(`${action.action || 'locator action'} requires ref or selector before semantic fallback`);
  const { deterministicTimeoutMs, fallbackTimeoutMs } = locatorTimeouts(action);
  try {
    return {
      value: await operation(deterministic, deterministicTimeoutMs, 'deterministic'),
      locatorStrategy: 'deterministic',
      fallback: null,
      deterministicError: null,
      deterministicProbeMs: deterministicTimeoutMs
    };
  } catch (deterministicError) {
    if (!action.fallback) throw deterministicError;
    try {
      const semantic = semanticLocator(page, action.fallback);
      const value = await operation(semantic, fallbackTimeoutMs, 'semantic-fallback');
      return {
        value,
        locatorStrategy: 'semantic-fallback',
        fallback: action.fallback,
        deterministicError: deterministicError.message,
        deterministicProbeMs: deterministicTimeoutMs
      };
    } catch (fallbackError) {
      const error = new Error(`Deterministic locator failed (${deterministicError.message}); semantic fallback also failed (${fallbackError.message})`);
      error.cause = fallbackError;
      throw error;
    }
  }
}

export async function executeAgentAction(page, action) {
  switch (action.action) {
    case 'click': {
      const resolved = await performWithLocatorFallback(page, action, (target, timeout) => target.click({ timeout }));
      return { ok: true, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError, deterministicProbeMs: resolved.deterministicProbeMs };
    }
    case 'fill': {
      const resolved = await performWithLocatorFallback(page, action, (target, timeout) => target.fill(String(action.value ?? ''), { timeout }));
      return { ok: true, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError, deterministicProbeMs: resolved.deterministicProbeMs };
    }
    case 'press':
      await page.keyboard.press(String(action.key));
      return { ok: true };
    case 'goto':
      await page.goto(String(action.url), { waitUntil: action.waitUntil || 'domcontentloaded' });
      return { ok: true, url: page.url() };
    case 'wait': {
      if (action.selector || action.ref) {
        const resolved = await performWithLocatorFallback(page, action, (target, timeout) => target.waitFor({ state: action.state || 'visible', timeout }));
        return { ok: true, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError, deterministicProbeMs: resolved.deterministicProbeMs };
      }
      await page.waitForTimeout(Number(action.ms || 0));
      return { ok: true };
    }
    case 'snapshot':
      return await snapshotPage(page, action);
    case 'text': {
      const resolved = await performWithLocatorFallback(page, action, (target, timeout) => target.innerText({ timeout }));
      return { text: resolved.value, locatorStrategy: resolved.locatorStrategy, fallback: resolved.fallback, deterministicError: resolved.deterministicError, deterministicProbeMs: resolved.deterministicProbeMs };
    }
    default:
      throw new Error(`Unsupported agent action: ${action.action}`);
  }
}
