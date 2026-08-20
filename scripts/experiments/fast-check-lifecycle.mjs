import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { terminate, waitForClose, waitForExit } from '../../src/core/process-utils.mjs';

const FIXED_SEED = 0x61f311;
const MAX_COMMANDS = 10;
const PRODUCTION_RUNS = 100;

class PlantSpawn {
  check(model) { return model.phase === 'idle'; }
  async run(model, real) {
    model.phase = 'running';
    real.phase = 'running';
  }
  toString() { return 'spawn'; }
}

class PlantTerminate {
  check(model) { return model.phase === 'running'; }
  async run(model, real) {
    model.phase = 'terminal';
    // Deliberately planted defect: signal delivery is incorrectly treated as
    // equivalent to process termination, so the real state remains running.
    real.signalSent = true;
    assert.equal(real.phase, model.phase, 'planted lifecycle defect must be detected');
  }
  toString() { return 'terminate'; }
}

function plantedProperty() {
  const commandArbitrary = fc.commands([
    fc.constant(new PlantSpawn()),
    fc.constant(new PlantTerminate())
  ], { maxCommands: 8 });
  return fc.asyncProperty(commandArbitrary, async commands => {
    await fc.asyncModelRun(
      () => ({ model: { phase: 'idle' }, real: { phase: 'idle', signalSent: false } }),
      commands
    );
  });
}

function semanticCounterexample(value) {
  return fc.stringify(value).replace(/\s*\/\*replayPath="[^"]*"\*\//g, '');
}

async function proveShrinkingAndReplay() {
  const first = await fc.check(plantedProperty(), {
    seed: FIXED_SEED,
    numRuns: 200,
    interruptAfterTimeLimit: 15_000
  });
  assert.equal(first.failed, true, 'fast-check must detect the planted lifecycle defect');
  assert.ok(first.counterexamplePath, 'failing run must expose a replay path');
  const counterexample = fc.stringify(first.counterexample);
  const semantic = semanticCounterexample(first.counterexample);

  const replay = await fc.check(plantedProperty(), {
    seed: first.seed,
    path: first.counterexamplePath,
    numRuns: 1,
    endOnFailure: true,
    interruptAfterTimeLimit: 5_000
  });
  assert.equal(replay.failed, true, 'seed/path replay must reproduce the planted defect');
  assert.equal(
    semanticCounterexample(replay.counterexample),
    semantic,
    'seed/path replay must reproduce the same minimized semantic command sequence'
  );

  return {
    seed: first.seed,
    path: first.counterexamplePath,
    numRuns: first.numRuns,
    numShrinks: first.numShrinks,
    numSkips: first.numSkips,
    counterexample,
    semanticCounterexample: semantic,
    replayCounterexample: fc.stringify(replay.counterexample)
  };
}

function childScript() {
  return [
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { if (chunk.includes('exit')) process.exit(7) })",
    "process.on('SIGTERM', () => process.exit(0))",
    "setInterval(() => {}, 1000)"
  ].join(';');
}

async function spawnLifecycleChild() {
  const child = spawn(process.execPath, ['-e', childScript()], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

function terminalResult(child) {
  return { code: child.exitCode, signal: child.signalCode };
}

function assertTerminal(child, message) {
  assert.ok(child.exitCode !== null || child.signalCode !== null, message);
}

class StartChild {
  check(model) { return model.phase === 'idle'; }
  async run(model, real) {
    real.child = await spawnLifecycleChild();
    model.phase = 'running';
    model.result = null;
    real.result = null;
  }
  toString() { return 'start-child'; }
}

class ExitViaStdin {
  check(model) { return model.phase === 'running'; }
  async run(model, real) {
    assert.ok(real.child?.stdin?.writable, 'running child stdin must be writable');
    real.child.stdin.write('exit\n');
    const result = await waitForExit(real.child, 1_500);
    assert.equal(result.code, 7, 'stdin exit command must preserve the expected exit code');
    model.phase = 'terminal';
    model.result = result;
    real.result = result;
  }
  toString() { return 'exit-via-stdin'; }
}

class TerminateChild {
  check(model) { return model.phase === 'running'; }
  async run(model, real) {
    await terminate(real.child, 250);
    assertTerminal(real.child, 'terminate must not resolve before the child is terminal');
    const result = await waitForExit(real.child, 1_500);
    model.phase = 'terminal';
    model.result = result;
    real.result = result;
  }
  toString() { return 'terminate-child'; }
}

class WaitExitAgain {
  check(model) { return model.phase === 'terminal'; }
  async run(model, real) {
    const result = await waitForExit(real.child, 250);
    assert.deepEqual(result, model.result, 'waitForExit must return a stable terminal result');
  }
  toString() { return 'wait-exit-again'; }
}

class WaitClose {
  check(model) { return model.phase === 'terminal'; }
  async run(model, real) {
    const result = await waitForClose(real.child, 1_500);
    assert.deepEqual(result, model.result, 'waitForClose must preserve the terminal result');
    model.phase = 'closed';
  }
  toString() { return 'wait-close'; }
}

class TerminateAgain {
  check(model) { return model.phase === 'terminal' || model.phase === 'closed'; }
  async run(model, real) {
    const before = terminalResult(real.child);
    await terminate(real.child, 50);
    assert.deepEqual(terminalResult(real.child), before, 'terminate must be idempotent after termination');
  }
  toString() { return 'terminate-again'; }
}

class ResetLifecycle {
  check(model) { return model.phase === 'terminal' || model.phase === 'closed'; }
  async run(model, real) {
    const result = await waitForClose(real.child, 1_500);
    assert.deepEqual(result, model.result, 'reset must observe the same terminal result');
    real.child = null;
    real.result = null;
    model.phase = 'idle';
    model.result = null;
  }
  toString() { return 'reset'; }
}

function productionProperty() {
  const commandArbitrary = fc.commands([
    fc.constant(new StartChild()),
    fc.constant(new ExitViaStdin()),
    fc.constant(new TerminateChild()),
    fc.constant(new WaitExitAgain()),
    fc.constant(new WaitClose()),
    fc.constant(new TerminateAgain()),
    fc.constant(new ResetLifecycle())
  ], { maxCommands: MAX_COMMANDS });

  return fc.asyncProperty(commandArbitrary, async commands => {
    const state = {
      model: { phase: 'idle', result: null },
      real: { child: null, result: null }
    };
    try {
      await fc.asyncModelRun(() => state, commands);
    } finally {
      const child = state.real.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        await terminate(child, 250).catch(() => {});
      }
      if (child) await waitForClose(child, 1_500).catch(() => {});
    }
  });
}

async function verifyFerrumLifecycle() {
  const started = performance.now();
  const result = await fc.check(productionProperty(), {
    seed: FIXED_SEED,
    numRuns: PRODUCTION_RUNS,
    interruptAfterTimeLimit: 45_000
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.failed, false, result.error || 'Ferrum lifecycle model unexpectedly failed');
  assert.equal(result.interrupted, false, 'Ferrum lifecycle model exceeded its fixed runtime budget');
  return {
    seed: result.seed,
    numRuns: result.numRuns,
    numShrinks: result.numShrinks,
    numSkips: result.numSkips,
    elapsedMs
  };
}

const packageJson = JSON.parse(await fs.readFile(new URL('../../node_modules/fast-check/package.json', import.meta.url), 'utf8'));
const experimentStarted = performance.now();
const planted = await proveShrinkingAndReplay();
const production = await verifyFerrumLifecycle();
const summary = {
  schemaVersion: 1,
  experiment: 'fast-check-process-lifecycle-model',
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  fastCheckVersion: packageJson.version,
  fastCheckHeadChecked: 'f4b2f3a2f90a0fb08ccfa07b46bb7f1a5a35caec',
  fixedSeed: FIXED_SEED,
  maxCommands: MAX_COMMANDS,
  planted,
  production,
  totalElapsedMs: performance.now() - experimentStarted,
  conclusion: 'planted defect minimized and replayed; Ferrum production lifecycle invariants remained clean'
};
await fs.mkdir('.ferrum/experiments', { recursive: true });
await fs.writeFile('.ferrum/experiments/fast-check-lifecycle-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
