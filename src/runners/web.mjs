import path from 'node:path';
import { launchChromiumSession } from '../browser/chromium.mjs';
import { launchLightpandaSession } from '../browser/lightpanda.mjs';
import { StepEngine } from './step-engine.mjs';

export async function runWebTarget(spec, evidence, options = {}) {
  const engine = options.engine || spec.target.engine || 'chromium';
  const headless = options.headless ?? spec.target.headless ?? false;
  let session;
  let page;
  if (engine === 'lightpanda') {
    session = await launchLightpandaSession({ executable: spec.target.executable, evidence });
    page = session.page;
  } else {
    if (options.browserCompatibility) evidence.record('browser-compatibility', options.browserCompatibility);
    session = await launchChromiumSession({
      profileDir: options.profileDir || spec.target.profileDir,
      headless,
      executablePath: options.browserExecutable || spec.target.executable,
      channel: options.browserChannel || spec.target.channel,
      browserName: options.browser || spec.target.browser,
      browserArgs: spec.target.args || [],
      diagnoseInitialPages: false,
      launchTimeoutMs: options.browserLaunchTimeoutMs ?? spec.target.launchTimeoutMs ?? spec.timeouts?.startupMs ?? 30000,
      evidence
    });
    page = await session.newPage();
    const closedStartupPages = await session.closeInitialPages({ except: page });
    evidence.record('browser-workload-page', { browser: session.browserName, closedStartupPages, url: page.url() });
  }
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
