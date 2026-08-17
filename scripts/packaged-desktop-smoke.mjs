import fs from 'node:fs/promises';
import path from 'node:path';
import { runSpec } from '../src/core/runner.mjs';

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function findPackagedExecutable() {
  const dist = path.resolve('dist');
  const dirs = (await fs.readdir(dist, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('Ferrum-'));
  for (const entry of dirs) {
    const base = path.join(dist, entry.name);
    const candidates = process.platform === 'win32'
      ? [path.join(base, 'Ferrum.exe')]
      : process.platform === 'darwin'
        ? [path.join(base, 'Ferrum.app', 'Contents', 'MacOS', 'Ferrum')]
        : [path.join(base, 'Ferrum')];
    for (const candidate of candidates) if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not find packaged Ferrum executable under ${dist}`);
}

const executable = await findPackagedExecutable();
const innerRoot = path.resolve('artifacts', 'packaged-desktop-inner');
const result = await runSpec({
  version: 1,
  name: 'ferrum-packaged-desktop-smoke',
  target: {
    type: 'electron',
    executable,
    env: { FERRUM_ARTIFACTS_ROOT: innerRoot }
  },
  timeouts: { startupMs: 30000, stepMs: 20000 },
  steps: [
    { action: 'wait', selector: '#doctor', state: 'visible' },
    { action: 'click', selector: '#doctor' },
    { action: 'wait', ms: 400 },
    { action: 'assert-text', selector: '#doctorOut', text: '"ferrum": "0.2.0"' },
    { action: 'fill', selector: '#spec', value: 'examples/process-app.json' },
    { action: 'click', selector: '#headless' },
    { action: 'click', selector: '#run' },
    { action: 'wait', selector: '#runs .passed', state: 'visible', first: true, timeoutMs: 15000 },
    { action: 'wait', selector: '#evidence .evidence-run', state: 'visible', first: true, timeoutMs: 15000 },
    { action: 'click', selector: '#evidence .evidence-run', first: true },
    { action: 'wait', selector: '#replay .event', state: 'visible', first: true, timeoutMs: 10000 },
    { action: 'assert-text', selector: '#replay', text: 'step-start' },
    { action: 'screenshot', name: 'packaged-desktop' },
    { action: 'assert-console-clean' }
  ]
}, { artifactsRoot: path.resolve('artifacts', 'packaged-desktop-outer') });

console.log(JSON.stringify({ status: result.status, executable, evidenceDir: result.evidenceDir, runtime: result.result?.runtime || null }, null, 2));
