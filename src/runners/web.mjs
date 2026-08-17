import path from 'node:path';
import { launchChromiumSession } from '../browser/chromium.mjs';
import { launchLightpandaSession } from '../browser/lightpanda.mjs';
import { StepEngine } from './step-engine.mjs';

export async function runWebTarget(spec, evidence, options = {}) {
  const engine = options.engine || spec.target.engine || 'chromium';
  const headless = options.headless ?? spec.target.headless ?? false;
  let session;
  if (engine === 'lightpanda') session = await launchLightpandaSession({ executable: spec.target.executable, evidence });
  else session = await launchChromiumSession({
    profileDir: options.profileDir || spec.target.profileDir,
    headless,
    executablePath: options.browserExecutable || spec.target.executable,
    channel: options.browserChannel || spec.target.channel,
    browserName: options.browser || spec.target.browser,
    browserArgs: spec.target.args || [],
    evidence
  });
  const page = session.page || session.context.pages()[0] || await session.newPage();
  try {
    const stepEngine = new StepEngine({ evidence, session, page, timeoutMs: spec.timeouts?.stepMs || 30000 });
    const result = await stepEngine.run(spec.steps);
    const trace = engine === 'chromium' ? path.join(evidence.dir, 'trace.zip') : null;
    await session.close(trace);
    return { engine, browser: session.browserName || engine, ...result };
  } catch (error) {
    const trace = engine === 'chromium' ? path.join(evidence.dir, 'trace.zip') : null;
    await session.close(trace).catch(() => {});
    throw error;
  }
}
