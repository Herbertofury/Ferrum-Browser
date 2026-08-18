import { chromium } from 'playwright';
import { diffSnapshots, snapshotPage } from '../src/browser/agent-surface.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const buttons = Array.from({ length: 400 }, (_, index) => `<button id="b${index}">Button ${index}</button>`).join('');
  await page.setContent(`<!doctype html><html><head><title>Delta Before</title></head><body>${buttons}</body></html>`);

  const before = await snapshotPage(page, { interactiveOnly: true });
  if (before.elements.length !== 400) throw new Error(`Expected complete 400-element baseline, got ${before.elements.length}`);
  const changedBefore = before.elements.find(element => element.name === 'Button 200');
  const removedBefore = before.elements.find(element => element.name === 'Button 201');
  if (!changedBefore || !removedBefore) throw new Error('Baseline refs were not captured for mutation targets');

  await page.evaluate(() => {
    document.title = 'Delta After';
    const changed = document.querySelector('#b200');
    changed.textContent = 'Button 200 updated';
    changed.disabled = true;
    document.querySelector('#b201').remove();
    const added = document.createElement('button');
    added.id = 'new-button';
    added.textContent = 'Brand new';
    document.body.append(added);
  });

  const after = await snapshotPage(page, { interactiveOnly: true });
  if (after.elements.length !== 400) throw new Error(`Expected complete 400-element updated snapshot, got ${after.elements.length}`);
  const changedAfter = after.elements.find(element => element.name === 'Button 200 updated');
  if (changedAfter?.ref !== changedBefore.ref) throw new Error(`Changed element ref drifted from ${changedBefore.ref} to ${changedAfter?.ref || '<missing>'}`);
  if (after.elements.some(element => element.ref === removedBefore.ref)) throw new Error(`Removed ref ${removedBefore.ref} still appears in the current snapshot`);

  const delta = diffSnapshots(before, after);
  if (delta.added.length !== 1 || delta.removed.length !== 1 || delta.changed.length !== 1 || delta.unchangedCount !== 398) {
    throw new Error(`Unexpected delta counts: ${JSON.stringify({ added: delta.added.length, removed: delta.removed.length, changed: delta.changed.length, unchanged: delta.unchangedCount })}`);
  }
  if (delta.changed[0].ref !== changedBefore.ref) throw new Error('Delta did not preserve the stable changed-element ref');

  const fullBytes = Buffer.byteLength(JSON.stringify(after));
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta));
  const reductionPct = Number(((1 - (deltaBytes / fullBytes)) * 100).toFixed(2));
  if (!(deltaBytes < fullBytes * 0.2)) throw new Error(`Delta is not materially compact: full=${fullBytes}, delta=${deltaBytes}`);

  console.log(JSON.stringify({ status: 'passed', elements: after.elements.length, fullBytes, deltaBytes, reductionPct, counts: { added: 1, removed: 1, changed: 1, unchanged: 398 } }));
} finally {
  await browser.close();
}
