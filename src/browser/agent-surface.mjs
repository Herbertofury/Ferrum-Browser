const REF_ATTR = 'data-ferrum-ref';

export async function snapshotPage(page, { interactiveOnly = false, max = 400 } = {}) {
  return await page.evaluate(({ interactiveOnly, max, attr }) => {
    const visible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const interactiveSelector = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[contenteditable="true"],[tabindex]';
    const all = [...document.querySelectorAll(interactiveOnly ? interactiveSelector : 'body *')];
    const results = [];
    let next = 1;
    for (const el of all) {
      if (!visible(el)) continue;
      const interactive = el.matches(interactiveSelector);
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 180);
      if (!interactive && !text) continue;
      let ref = el.getAttribute(attr);
      if (!ref) {
        ref = `e${next++}`;
        el.setAttribute(attr, ref);
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

export async function executeAgentAction(page, action) {
  const target = action.ref ? locatorForRef(page, action.ref) : action.selector ? page.locator(action.selector) : null;
  switch (action.action) {
    case 'click':
      if (!target) throw new Error('click requires ref or selector');
      await target.click();
      return { ok: true };
    case 'fill':
      if (!target) throw new Error('fill requires ref or selector');
      await target.fill(String(action.value ?? ''));
      return { ok: true };
    case 'press':
      await page.keyboard.press(String(action.key));
      return { ok: true };
    case 'goto':
      await page.goto(String(action.url), { waitUntil: action.waitUntil || 'domcontentloaded' });
      return { ok: true, url: page.url() };
    case 'wait':
      if (action.selector) await page.locator(action.selector).waitFor({ state: action.state || 'visible', timeout: action.timeoutMs });
      else await page.waitForTimeout(Number(action.ms || 0));
      return { ok: true };
    case 'snapshot':
      return await snapshotPage(page, action);
    case 'text':
      if (!target) throw new Error('text requires ref or selector');
      return { text: await target.innerText() };
    default:
      throw new Error(`Unsupported agent action: ${action.action}`);
  }
}
