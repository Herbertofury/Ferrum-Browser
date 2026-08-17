import fs from 'node:fs/promises';
import { loadSpec } from './core/spec.mjs';
import { runSpec } from './core/runner.mjs';
import { runSuite } from './core/suite.mjs';
import { benchmarkSpec } from './core/benchmark.mjs';
import { runWorkloadPack } from './core/workload-pack.mjs';
import { collectDoctor } from './core/doctor.mjs';
import { compactRunResult, compactSuiteResult, compactBenchmarkResult, compactBrowserMatrixResult, compactPackResult } from './core/agent-result.mjs';
import { discoverBrowsers, runBrowserMatrix } from './core/browser-matrix.mjs';
import { createSpace, listSpaces } from './core/spaces.mjs';
import { listEvidence, readEvidence, verifyEvidence } from './core/evidence-store.mjs';
import { bootstrapGithubWiki, probeGithubWiki } from './integrations/github-wiki.mjs';
import { startDashboard } from './server/dashboard.mjs';
import { startMcpStdio } from './mcp/server.mjs';
import { FERRUM_VERSION } from './version.mjs';

const VALUE_FLAGS = new Set(['--engine', '--engines', '--artifacts', '--workers', '--runs', '--warmup', '--port', '--browser', '--browsers', '--space', '--space-mode', '--spaces-root', '--var', '--github-server', '--page-title', '--body', '--body-file', '--auth-timeout']);

function usage() {
  return `Ferrum ${FERRUM_VERSION}\n\nUsage:\n  ferrum doctor\n  ferrum test <spec.json> [--headless] [--engine chromium|lightpanda] [--browser chromium|chrome|edge|brave|opera-gx] [--space <name>] [--space-mode persistent|clone] [--var NAME=value] [--artifacts <dir>] [--compact]\n  ferrum suite <spec.json>... [--workers 4] [--headless] [--engine chromium|lightpanda] [--browser <name>] [--space <name>] [--space-mode persistent|clone] [--var NAME=value] [--compact]\n  ferrum matrix <spec.json> [--browsers chromium,chrome,edge,brave,opera-gx] [--workers 2] [--headless] [--require-all] [--var NAME=value] [--compact]\n  ferrum bench <spec.json> [--engines chromium,lightpanda] [--runs 5] [--warmup 1] [--headless] [--var NAME=value] [--compact]\n  ferrum pack <pack.json> [--var NAME=value] [--headless] [--space <name>] [--space-mode persistent|clone] [--artifacts <dir>] [--compact]\n  ferrum spaces list [--spaces-root <dir>]\n  ferrum spaces create <name> [--spaces-root <dir>]\n  ferrum spaces clone <source> <name> [--spaces-root <dir>]\n  ferrum github-wiki probe <owner/repo> [--github-server https://github.com]\n  ferrum github-wiki bootstrap <owner/repo> [--space github] [--browser <name>] [--headless] [--page-title Home] [--body <text>|--body-file <path>] [--auth-timeout 180000] [--artifacts <dir>]\n  ferrum evidence list [--artifacts <dir>]\n  ferrum evidence show <id> [--artifacts <dir>]\n  ferrum evidence verify <id> [--artifacts <dir>]\n  ferrum dashboard [--port 8788] [--no-open]\n  ferrum mcp\n`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function argValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && index + 1 < args.length) values.push(args[index + 1]);
  }
  return values;
}

function parseVariables(args) {
  const variables = {};
  for (const value of argValues(args, '--var')) {
    const index = value.indexOf('=');
    if (index <= 0) throw new Error(`--var must use NAME=value syntax: ${value}`);
    const name = value.slice(0, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name: ${name}`);
    variables[name] = value.slice(index + 1);
  }
  return variables;
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
    artifactsRoot: argValue(args, '--artifacts'),
    space: argValue(args, '--space'),
    spaceMode: argValue(args, '--space-mode'),
    spacesRoot: argValue(args, '--spaces-root'),
    keepSpaceClone: args.includes('--keep-space-clone'),
    variables: parseVariables(args)
  };
}

async function resolveSingleBrowserOptions(args, options) {
  const requested = argValue(args, '--browser');
  if (!requested) return options;
  const [browser] = await discoverBrowsers(requested);
  if (!browser?.available) throw new Error(`Requested browser is not installed or discoverable: ${requested}`);
  return {
    ...options,
    engine: 'chromium',
    browser: browser.name,
    browserChannel: browser.channel,
    browserExecutable: browser.channel ? undefined : browser.executablePath
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
    const options = await resolveSingleBrowserOptions(args, commonOptions(args));
    const spec = await loadSpec(specPath, { variables: options.variables });
    const result = await runSpec(spec, options);
    console.log(JSON.stringify(args.includes('--compact') ? compactRunResult(result) : result, null, 2));
    return;
  }
  if (command === 'suite') {
    const specPaths = positional(args);
    const options = await resolveSingleBrowserOptions(args, { ...commonOptions(args), workers: Number(argValue(args, '--workers') || 1) });
    const result = await runSuite(specPaths, options);
    console.log(JSON.stringify(args.includes('--compact') ? compactSuiteResult(result) : result, null, 2));
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'matrix') {
    const specPath = args[1];
    if (!specPath) throw new Error('matrix requires a spec path');
    const result = await runBrowserMatrix(specPath, {
      ...commonOptions(args),
      browsers: argValue(args, '--browsers') || 'chromium,chrome,edge,brave,opera-gx',
      workers: Number(argValue(args, '--workers') || 1),
      requireAll: args.includes('--require-all')
    });
    console.log(JSON.stringify(args.includes('--compact') ? compactBrowserMatrixResult(result) : result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
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
    console.log(JSON.stringify(args.includes('--compact') ? compactBenchmarkResult(result) : result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (command === 'pack') {
    const packPath = args[1];
    if (!packPath) throw new Error('pack requires a workload pack path');
    const result = await runWorkloadPack(packPath, commonOptions(args));
    console.log(JSON.stringify(args.includes('--compact') ? compactPackResult(result) : result, null, 2));
    return;
  }
  if (command === 'spaces') {
    const action = args[1] || 'list';
    const root = argValue(args, '--spaces-root');
    if (action === 'list') {
      console.log(JSON.stringify(await listSpaces({ root }), null, 2));
      return;
    }
    if (action === 'create') {
      const name = args[2];
      if (!name) throw new Error('spaces create requires a name');
      console.log(JSON.stringify(await createSpace(name, { root }), null, 2));
      return;
    }
    if (action === 'clone') {
      const source = args[2];
      const name = args[3];
      if (!source || !name) throw new Error('spaces clone requires source and destination names');
      console.log(JSON.stringify(await createSpace(name, { root, cloneFrom: source }), null, 2));
      return;
    }
    throw new Error(`Unknown spaces action: ${action}`);
  }
  if (command === 'github-wiki') {
    const action = args[1] || 'probe';
    const repository = args[2];
    if (!repository) throw new Error(`github-wiki ${action} requires OWNER/REPO`);
    const serverUrl = argValue(args, '--github-server') || 'https://github.com';
    if (action === 'probe') {
      console.log(JSON.stringify(await probeGithubWiki(repository, { serverUrl }), null, 2));
      return;
    }
    if (action === 'bootstrap') {
      const bodyFile = argValue(args, '--body-file');
      const body = bodyFile ? await fs.readFile(bodyFile, 'utf8') : argValue(args, '--body');
      const options = await resolveSingleBrowserOptions(args, commonOptions(args));
      const result = await bootstrapGithubWiki(repository, {
        serverUrl,
        pageTitle: argValue(args, '--page-title') || 'Home',
        body,
        space: options.space || 'github',
        spacesRoot: options.spacesRoot,
        headless: options.headless ?? false,
        browserName: options.browser,
        browserChannel: options.browserChannel,
        browserExecutable: options.browserExecutable,
        artifactsRoot: options.artifactsRoot,
        authTimeoutMs: Number(argValue(args, '--auth-timeout') || 180000)
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error(`Unknown github-wiki action: ${action}`);
  }
  if (command === 'evidence') {
    const action = args[1] || 'list';
    const root = argValue(args, '--artifacts');
    if (action === 'list') {
      console.log(JSON.stringify(await listEvidence({ root }), null, 2));
      return;
    }
    if (action === 'show') {
      const id = args[2];
      if (!id) throw new Error('evidence show requires an evidence id');
      console.log(JSON.stringify(await readEvidence(id, { root }), null, 2));
      return;
    }
    if (action === 'verify') {
      const id = args[2];
      if (!id) throw new Error('evidence verify requires an evidence id');
      const result = await verifyEvidence(id, { root });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'failed') process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown evidence action: ${action}`);
  }
  if (command === 'dashboard') {
    const port = Number(argValue(args, '--port') || 8788);
    const { url } = await startDashboard({ port, open: !args.includes('--no-open'), artifactsRoot: argValue(args, '--artifacts') });
    console.log(`Ferrum dashboard: ${url}`);
    return;
  }
  if (command === 'mcp') {
    await startMcpStdio(); return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}
