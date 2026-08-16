import path from 'node:path';
import { getPlaywright } from '../browser/playwright.mjs';
import { attachPageDiagnostics } from '../browser/diagnostics.mjs';
import { StepEngine } from './step-engine.mjs';

export async function runElectronTarget(spec, evidence) {
  const { _electron: electron } = await getPlaywright();
  const args = spec.target.args || [];
  const executablePath = spec.target.executable || undefined;
  const app = await electron.launch({
    args,
    cwd: spec.target.cwd || undefined,
    executablePath,
    env: { ...process.env, ...(spec.target.env || {}) }
  });
  evidence.record('electron-start', { executablePath: executablePath || null, args });
  const windows = [];
  const register = page => {
    if (!windows.includes(page)) {
      windows.push(page);
      attachPageDiagnostics(page, evidence, `electron:${windows.length}`);
    }
  };
  app.windows().forEach(register);
  app.on('window', register);
  const page = await app.firstWindow();
  try {
    const engine = new StepEngine({ evidence, session: { context: page.context() }, page, timeoutMs: spec.timeouts?.stepMs || 30000 });
    const result = await engine.run(spec.steps);
    await app.close();
    return { windows: windows.length, ...result };
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
