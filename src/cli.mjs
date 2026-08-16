import { loadSpec } from './core/spec.mjs';
import { runSpec } from './core/runner.mjs';
import { runSuite } from './core/suite.mjs';
import { benchmarkSpec } from './core/benchmark.mjs';
import { collectDoctor } from './core/doctor.mjs';
import { startDashboard } from './server/dashboard.mjs';
import { startMcpStdio } from './mcp/server.mjs';
import { FERRUM_VERSION } from './version.mjs';

const VALUE_FLAGS = new Set(['--engine', '--engines', '--artifacts', '--workers', '--runs', '--warmup', '--port']);

function usage() {
  return `Ferrum ${FERRUM_VERSION}\n\nUsage:\n  ferrum doctor\n  ferrum test <spec.json> [--headless] [--engine chromium|lightpanda] [--artifacts <dir>]\n  ferrum suite <spec.json>... [--workers 4] [--headless] [--engine chromium|lightpanda]\n  ferrum bench <spec.json> [--engines chromium,lightpanda] [--runs 5] [--warmup 1] [--headless]\n  ferrum dashboard [--port 8788] [--no-open]\n  ferrum mcp\n`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args, start = 1) {
  const values = [];
  for (let index = start; index < args.length; index++) {
    const value = args[index];
    if (VALUE_FLAGS.has(value)) { index++; continue; }
    if (value.startsWith('--')) continue;
    values.push(value);
  }
  return values;
}

function commonOptions(args) {
  return {
    headless: args.includes('--headless') ? true : undefined,
    engine: argValue(args, '--engine'),
    artifactsRoot: argValue(args, '--artifacts')
  };
}

export async function main(args) {
  const command = args[0] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage()); return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify(await collectDoctor(), null, 2)); return;
  }
  if (command === 'test') {
    const specPath = args[1];
    if (!specPath) throw new Error('test requires a spec path');
    const spec = await loadSpec(specPath);
    const result = await runSpec(spec, commonOptions(args));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'suite') {
    const specPaths = positional(args);
    const result = await runSuite(specPaths, { ...commonOptions(args), workers: Number(argValue(args, '--workers') || 1) });
    console.log(JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'bench') {
    const specPath = args[1];
    if (!specPath) throw new Error('bench requires a spec path');
    const result = await benchmarkSpec(specPath, {
      ...commonOptions(args),
      engines: argValue(args, '--engines') || argValue(args, '--engine') || 'chromium',
      runs: Number(argValue(args, '--runs') || 5),
      warmup: Number(argValue(args, '--warmup') || 1)
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'dashboard') {
    const port = Number(argValue(args, '--port') || 8788);
    const { url } = await startDashboard({ port, open: !args.includes('--no-open') });
    console.log(`Ferrum dashboard: ${url}`);
    return;
  }
  if (command === 'mcp') {
    await startMcpStdio(); return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
