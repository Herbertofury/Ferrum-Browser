import fs from 'node:fs/promises';
import path from 'node:path';
import { EvidenceWriter } from './evidence.mjs';
import { expandVariables, loadSpec } from './spec.mjs';
import { runSpec } from './runner.mjs';
import { spawnLogged, terminate, waitForExit } from './process-utils.mjs';

function resolvePath(baseDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function summarizePackRuns(runs = []) {
  const targetTypes = [];
  const targetTypeCounts = {};
  let previousTargetType = null;
  let targetTypeTransitions = 0;
  let totalSteps = 0;
  let totalSpecDurationMs = 0;
  let evidenceDirsRetained = 0;
  let passedWithEvidence = 0;
  let failedWithEvidence = 0;

  for (const item of runs) {
    const targetType = item.targetType || null;
    if (targetType) {
      if (!targetTypes.includes(targetType)) targetTypes.push(targetType);
      targetTypeCounts[targetType] = (targetTypeCounts[targetType] || 0) + 1;
      if (previousTargetType && previousTargetType !== targetType) targetTypeTransitions++;
      previousTargetType = targetType;
    }
    const steps = Number(item.steps || 0);
    if (Number.isFinite(steps)) totalSteps += steps;
    const durationMs = Number(item.durationMs || 0);
    if (Number.isFinite(durationMs)) totalSpecDurationMs += durationMs;
    if (item.evidenceDir) evidenceDirsRetained++;
    if (item.status === 'passed' && item.evidenceId && item.evidenceDir) passedWithEvidence++;
    if (item.status === 'failed' && item.evidenceDir) failedWithEvidence++;
  }

  return {
    specCount: runs.length,
    totalSteps,
    targetTypes,
    targetTypeCounts,
    targetTypeTransitions,
    totalSpecDurationMs,
    evidence: {
      evidenceDirsRetained,
      passedWithEvidence,
      failedWithEvidence
    }
  };
}

export async function loadWorkloadPack(packPath, { variables = {} } = {}) {
  const abs = path.resolve(packPath);
  const raw = JSON.parse(await fs.readFile(abs, 'utf8'));
  if (raw.version !== 1) throw new Error(`${abs}: version must be 1`);
  if (!raw.name || typeof raw.name !== 'string') throw new Error(`${abs}: name is required`);
  if (!Array.isArray(raw.specs) || raw.specs.length === 0) throw new Error(`${abs}: specs must be a non-empty array`);
  for (const name of raw.requiredVariables || []) {
    const value = variables[name] ?? process.env[name];
    if (value == null || value === '') throw new Error(`${abs}: required variable ${name} is not set`);
  }
  const expanded = expandVariables(raw, variables, abs);
  const baseDir = path.dirname(abs);
  return {
    ...expanded,
    __file: abs,
    __baseDir: baseDir,
    setup: (expanded.setup || []).map(item => ({ ...item, cwd: resolvePath(baseDir, item.cwd || '.') })),
    specs: expanded.specs.map(spec => resolvePath(baseDir, spec))
  };
}

async function runSetupStep(step, evidence, variables, index) {
  if (!step.command) throw new Error(`pack setup[${index}] requires command`);
  const lines = [];
  const args = step.args || [];
  evidence.record('pack-setup-start', { index, command: step.command, args, cwd: step.cwd });
  const child = spawnLogged(step.command, args, {
    cwd: step.cwd || process.cwd(),
    env: { ...process.env, ...variables, ...(step.env || {}) },
    shell: Boolean(step.shell)
  }, line => {
    lines.push(line);
    evidence.record('pack-setup-log', { index, ...line });
  });
  try {
    const exit = await waitForExit(child, Number(step.timeoutMs || 300000));
    await evidence.writeText(`setup/${index}.log`, lines.map(line => `[${line.source}] ${line.text}`).join('\n') + '\n');
    if (exit.code !== 0) throw new Error(`pack setup[${index}] exited with code ${exit.code}${exit.signal ? ` signal ${exit.signal}` : ''}`);
    evidence.record('pack-setup-pass', { index, exit, lines: lines.length });
    return { index, command: step.command, args, cwd: step.cwd, ...exit, lines: lines.length };
  } catch (error) {
    await terminate(child).catch(() => {});
    await evidence.writeText(`setup/${index}.log`, lines.map(line => `[${line.source}] ${line.text}`).join('\n') + '\n');
    evidence.record('pack-setup-fail', { index, message: error.message });
    throw error;
  }
}

export async function runWorkloadPack(packPath, options = {}) {
  const variables = { ...(options.variables || {}) };
  const pack = await loadWorkloadPack(packPath, { variables });
  const artifactsRoot = options.artifactsRoot || pack.artifacts?.root || 'artifacts';
  const evidence = await new EvidenceWriter({
    root: artifactsRoot,
    name: `pack-${pack.name}`,
    metadata: {
      targetType: 'workload-pack',
      packFile: pack.__file,
      repository: pack.repository || null,
      specCount: pack.specs.length
    }
  }).init();
  await evidence.writeJson('pack.json', Object.fromEntries(Object.entries(pack).filter(([key]) => !key.startsWith('__'))));
  const setup = [];
  const runs = [];
  try {
    for (let index = 0; index < pack.setup.length; index++) setup.push(await runSetupStep(pack.setup[index], evidence, variables, index));
    for (let index = 0; index < pack.specs.length; index++) {
      const specPath = pack.specs[index];
      evidence.record('pack-spec-start', { index, specPath });
      const spec = await loadSpec(specPath, { variables });
      const targetType = spec.target?.type || null;
      const steps = spec.steps?.length || 0;
      const started = performance.now();
      try {
        const result = await runSpec(spec, {
          ...options,
          variables: undefined,
          artifactsRoot,
          spaceMode: options.space ? (options.spaceMode || 'clone') : options.spaceMode
        });
        const item = {
          index,
          specPath,
          status: 'passed',
          targetType,
          steps,
          durationMs: result.durationMs ?? (performance.now() - started),
          evidenceId: result.id,
          evidenceDir: result.evidenceDir,
          result
        };
        runs.push(item);
        evidence.record('pack-spec-pass', {
          index,
          specPath,
          targetType,
          steps,
          durationMs: item.durationMs,
          evidenceId: result.id,
          evidenceDir: result.evidenceDir
        });
      } catch (error) {
        const item = {
          index,
          specPath,
          status: 'failed',
          targetType,
          steps,
          durationMs: performance.now() - started,
          evidenceDir: error.evidenceDir || null,
          error: error.message
        };
        runs.push(item);
        evidence.record('pack-spec-fail', item);
        throw error;
      }
    }
    return await evidence.finalize({
      status: 'passed',
      result: {
        pack: pack.name,
        repository: pack.repository || null,
        setup,
        specs: runs.map(({ result, ...item }) => item),
        passed: runs.filter(item => item.status === 'passed').length,
        failed: 0,
        metrics: summarizePackRuns(runs)
      }
    });
  } catch (error) {
    await evidence.writeText('failure.txt', `${error.stack || error}\n`);
    await evidence.finalize({
      status: 'failed',
      failure: { message: error.message, stack: error.stack },
      result: {
        pack: pack.name,
        repository: pack.repository || null,
        setup,
        specs: runs.map(({ result, ...item }) => item),
        passed: runs.filter(item => item.status === 'passed').length,
        failed: runs.filter(item => item.status === 'failed').length,
        metrics: summarizePackRuns(runs)
      }
    });
    error.evidenceDir = evidence.dir;
    throw error;
  }
}
