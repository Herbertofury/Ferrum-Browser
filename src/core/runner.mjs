import { EvidenceWriter } from './evidence.mjs';
import { FERRUM_VERSION } from '../version.mjs';
import { prepareRunSpace } from './spaces.mjs';
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
  const spaceName = options.space ?? spec.target.space ?? null;
  const spaceMode = options.spaceMode ?? spec.target.spaceMode ?? 'persistent';
  const evidence = await new EvidenceWriter({
    root: options.artifactsRoot || spec.artifacts?.root || 'artifacts',
    name: spec.name,
    metadata: {
      specFile: spec.__file || null,
      targetType: spec.target.type,
      ferrumVersion: FERRUM_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      browser: options.browser || spec.target.browser || null,
      space: spaceName ? { name: spaceName, mode: spaceMode } : null
    }
  }).init();
  await evidence.writeJson('spec.json', stripInternal(spec));
  const runner = RUNNERS[spec.target.type];
  if (!runner) throw new Error(`No runner for target type ${spec.target.type}`);
  let preparedSpace = null;
  try {
    preparedSpace = await prepareRunSpace({
      name: spaceName,
      root: options.spacesRoot || spec.spaces?.root,
      mode: spaceMode,
      runId: evidence.id,
      keepClone: options.keepSpaceClone ?? spec.target.keepSpaceClone ?? false
    });
    const runOptions = preparedSpace ? { ...options, profileDir: preparedSpace.profileDir, spaceInfo: preparedSpace.info } : options;
    if (preparedSpace) evidence.record('space-prepared', { ...preparedSpace.info, profileDir: preparedSpace.profileDir });
    const result = await runner(spec, evidence, runOptions);
    if (preparedSpace) {
      await preparedSpace.cleanup();
      evidence.record('space-released', { name: preparedSpace.info.name, mode: preparedSpace.info.mode, keepClone: preparedSpace.info.keepClone || false });
    }
    return await evidence.finalize({ status: 'passed', result: { ...result, space: preparedSpace?.info || null } });
  } catch (error) {
    if (preparedSpace) {
      try {
        await preparedSpace.cleanup();
        evidence.record('space-released', { name: preparedSpace.info.name, mode: preparedSpace.info.mode, keepClone: preparedSpace.info.keepClone || false });
      } catch (cleanupError) {
        evidence.record('space-cleanup-error', { message: cleanupError.message });
      }
    }
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
