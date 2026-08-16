import { EvidenceWriter } from './evidence.mjs';
import { FERRUM_VERSION } from '../version.mjs';
import { runWebTarget } from '../runners/web.mjs';
import { runExtensionTarget } from '../runners/extension.mjs';
import { runProcessTarget } from '../runners/process.mjs';
import { runElectronTarget } from '../runners/electron.mjs';
import { runAppiumTarget } from '../runners/appium.mjs';

const RUNNERS = {
  web: runWebTarget,
  extension: runExtensionTarget,
  process: runProcessTarget,
  electron: runElectronTarget,
  appium: runAppiumTarget
};

export async function runSpec(spec, options = {}) {
  const evidence = await new EvidenceWriter({
    root: options.artifactsRoot || spec.artifacts?.root || 'artifacts',
    name: spec.name,
    metadata: {
      specFile: spec.__file || null,
      targetType: spec.target.type,
      ferrumVersion: FERRUM_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  }).init();
  await evidence.writeJson('spec.json', stripInternal(spec));
  const runner = RUNNERS[spec.target.type];
  if (!runner) throw new Error(`No runner for target type ${spec.target.type}`);
  try {
    const result = await runner(spec, evidence, options);
    return await evidence.finalize({ status: 'passed', result });
  } catch (error) {
    await evidence.writeText('failure.txt', `${error.stack || error}\n`);
    await evidence.finalize({ status: 'failed', failure: { message: error.message, stack: error.stack, step: error.ferrumStep || null } });
    error.evidenceDir = evidence.dir;
    throw error;
  }
}

function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')).map(([key, child]) => [key, stripInternal(child)]));
}
