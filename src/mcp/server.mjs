import readline from 'node:readline';
import { FERRUM_VERSION } from '../version.mjs';
import { loadSpec } from '../core/spec.mjs';
import { runSpec } from '../core/runner.mjs';
import { runSuite } from '../core/suite.mjs';
import { benchmarkSpec } from '../core/benchmark.mjs';
import { runWorkloadPack } from '../core/workload-pack.mjs';
import { collectDoctor } from '../core/doctor.mjs';
import { compactRunResult, compactSuiteResult, compactBenchmarkResult, compactBrowserMatrixResult, compactPackResult } from '../core/agent-result.mjs';
import { discoverBrowsers, runBrowserMatrix } from '../core/browser-matrix.mjs';
import { createSpace, listSpaces } from '../core/spaces.mjs';
import { listEvidence, readEvidence } from '../core/evidence-store.mjs';
import { bootstrapGithubWiki, probeGithubWiki } from '../integrations/github-wiki.mjs';

const commonRunProperties = {
  headless: { type: 'boolean' },
  engine: { type: 'string' },
  browser: { type: 'string', enum: ['chromium', 'chrome', 'edge', 'brave', 'opera-gx'] },
  artifactsRoot: { type: 'string' },
  space: { type: 'string', description: 'Persistent Ferrum browser profile space name.' },
  spaceMode: { type: 'string', enum: ['persistent', 'clone'], description: 'Use the named space directly with a lock, or clone it per run for safe parallel work.' },
  spacesRoot: { type: 'string' },
  keepSpaceClone: { type: 'boolean' },
  variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Template variables available as ${VAR:NAME} in specs and workload packs.' },
  fullOutput: { type: 'boolean', description: 'Return the complete result payload instead of the compact agent summary. Full evidence is always written on disk.' }
};

const tools = [
  { name: 'ferrum_doctor', description: 'Inspect Ferrum browser/app testing prerequisites.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ferrum_run_spec', description: 'Run a Ferrum JSON test spec and return a compact evidence summary plus exact evidence directory.', inputSchema: { type: 'object', required: ['specPath'], properties: { specPath: { type: 'string' }, ...commonRunProperties } } },
  { name: 'ferrum_run_suite', description: 'Run multiple Ferrum specs with bounded parallel workers and return compact per-run evidence summaries.', inputSchema: { type: 'object', required: ['specPaths'], properties: { specPaths: { type: 'array', items: { type: 'string' }, minItems: 1 }, workers: { type: 'integer', minimum: 1 }, ...commonRunProperties } } },
  { name: 'ferrum_browser_matrix', description: 'Run one web or extension spec across discovered Chromium-family browser targets without weakening the Chromium extension correctness lane.', inputSchema: { type: 'object', required: ['specPath'], properties: { specPath: { type: 'string' }, browsers: { type: 'string', description: 'Comma-separated browser names.' }, workers: { type: 'integer', minimum: 1 }, requireAll: { type: 'boolean' }, ...commonRunProperties } } },
  { name: 'ferrum_benchmark', description: 'Repeat an identical Ferrum workload and return compact median/p95 timing across one or more engines.', inputSchema: { type: 'object', required: ['specPath'], properties: { specPath: { type: 'string' }, engines: { type: 'string' }, runs: { type: 'integer', minimum: 1 }, warmup: { type: 'integer', minimum: 0 }, ...commonRunProperties } } },
  { name: 'ferrum_run_pack', description: 'Run a reusable Ferrum workload pack including its real setup/build commands and all member specs, retaining parent and child evidence.', inputSchema: { type: 'object', required: ['packPath'], properties: { packPath: { type: 'string' }, ...commonRunProperties } } },
  { name: 'ferrum_list_spaces', description: 'List persistent Ferrum browser profile spaces and lock state.', inputSchema: { type: 'object', properties: { spacesRoot: { type: 'string' } } } },
  { name: 'ferrum_create_space', description: 'Create a persistent Ferrum browser profile space, optionally cloned from another space.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, cloneFrom: { type: 'string' }, spacesRoot: { type: 'string' } } } },
  { name: 'ferrum_github_wiki_probe', description: 'Probe whether a repository GitHub Wiki Git remote already exists, without mutating the repository.', inputSchema: { type: 'object', required: ['repository'], properties: { repository: { type: 'string', description: 'OWNER/REPO or github.com repository URL.' }, serverUrl: { type: 'string' } } } },
  { name: 'ferrum_github_wiki_bootstrap', description: 'Create the first GitHub Wiki page through a real authenticated Chromium session when the wiki Git remote does not exist. Uses a persistent Ferrum Space so GitHub login can be reused.', inputSchema: { type: 'object', required: ['repository'], properties: { repository: { type: 'string' }, serverUrl: { type: 'string' }, pageTitle: { type: 'string' }, body: { type: 'string' }, headless: { type: 'boolean' }, browser: { type: 'string', enum: ['chromium', 'chrome', 'edge', 'brave', 'opera-gx'] }, space: { type: 'string', description: 'Authenticated persistent Space. Defaults to github.' }, spacesRoot: { type: 'string' }, artifactsRoot: { type: 'string' }, authTimeoutMs: { type: 'integer', minimum: 1000 } } } },
  { name: 'ferrum_list_evidence', description: 'List all finalized Ferrum evidence bundles from disk, including runs retained across process restarts.', inputSchema: { type: 'object', properties: { artifactsRoot: { type: 'string' } } } },
  { name: 'ferrum_read_evidence', description: 'Read one Ferrum evidence bundle and its complete retained file inventory.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, artifactsRoot: { type: 'string' }, fullOutput: { type: 'boolean' } } } }
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function runOptions(args) {
  const options = {
    headless: args.headless,
    engine: args.engine,
    artifactsRoot: args.artifactsRoot,
    space: args.space,
    spaceMode: args.spaceMode,
    spacesRoot: args.spacesRoot,
    keepSpaceClone: args.keepSpaceClone,
    variables: args.variables || {}
  };
  if (!args.browser) return options;
  const [browser] = await discoverBrowsers(args.browser);
  if (!browser?.available) throw new Error(`Requested browser is not installed or discoverable: ${args.browser}`);
  return {
    ...options,
    engine: 'chromium',
    browser: browser.name,
    browserChannel: browser.channel,
    browserExecutable: browser.channel ? undefined : browser.executablePath
  };
}

export async function startMcpStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    const reply = { jsonrpc: '2.0', id: req.id };
    try {
      if (req.method === 'initialize') {
        reply.result = { protocolVersion: req.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ferrum', version: FERRUM_VERSION } };
      } else if (req.method === 'tools/list') {
        reply.result = { tools };
      } else if (req.method === 'tools/call') {
        const name = req.params?.name;
        const args = req.params?.arguments || {};
        let value;
        if (name === 'ferrum_doctor') {
          value = await collectDoctor();
        } else if (name === 'ferrum_run_spec') {
          const options = await runOptions(args);
          const result = await runSpec(await loadSpec(args.specPath, { variables: options.variables }), options);
          value = args.fullOutput ? result : compactRunResult(result);
        } else if (name === 'ferrum_run_suite') {
          const result = await runSuite(args.specPaths, { ...(await runOptions(args)), workers: args.workers });
          value = args.fullOutput ? result : compactSuiteResult(result);
        } else if (name === 'ferrum_browser_matrix') {
          const result = await runBrowserMatrix(args.specPath, {
            ...(await runOptions({ ...args, browser: undefined })),
            browsers: args.browsers,
            workers: args.workers,
            requireAll: args.requireAll
          });
          value = args.fullOutput ? result : compactBrowserMatrixResult(result);
        } else if (name === 'ferrum_benchmark') {
          const result = await benchmarkSpec(args.specPath, {
            ...(await runOptions({ ...args, browser: undefined })),
            engines: args.engines,
            runs: args.runs,
            warmup: args.warmup
          });
          value = args.fullOutput ? result : compactBenchmarkResult(result);
        } else if (name === 'ferrum_run_pack') {
          const result = await runWorkloadPack(args.packPath, await runOptions({ ...args, browser: undefined }));
          value = args.fullOutput ? result : compactPackResult(result);
        } else if (name === 'ferrum_list_spaces') {
          value = await listSpaces({ root: args.spacesRoot });
        } else if (name === 'ferrum_create_space') {
          value = await createSpace(args.name, { root: args.spacesRoot, cloneFrom: args.cloneFrom });
        } else if (name === 'ferrum_github_wiki_probe') {
          value = await probeGithubWiki(args.repository, { serverUrl: args.serverUrl });
        } else if (name === 'ferrum_github_wiki_bootstrap') {
          const options = await runOptions(args);
          value = await bootstrapGithubWiki(args.repository, {
            serverUrl: args.serverUrl,
            pageTitle: args.pageTitle,
            body: args.body,
            space: options.space || 'github',
            spacesRoot: options.spacesRoot,
            headless: options.headless ?? false,
            browserName: options.browser,
            browserChannel: options.browserChannel,
            browserExecutable: options.browserExecutable,
            artifactsRoot: options.artifactsRoot,
            authTimeoutMs: args.authTimeoutMs
          });
        } else if (name === 'ferrum_list_evidence') {
          value = await listEvidence({ root: args.artifactsRoot });
        } else if (name === 'ferrum_read_evidence') {
          const evidence = await readEvidence(args.id, { root: args.artifactsRoot });
          value = args.fullOutput ? evidence : {
            id: evidence.id,
            dir: evidence.dir,
            result: { ...evidence.result, events: undefined },
            files: evidence.files
          };
        } else {
          throw new Error(`Unknown tool: ${name}`);
        }
        reply.result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
      } else if (req.method?.startsWith('notifications/')) {
        continue;
      } else {
        reply.error = { code: -32601, message: `Method not found: ${req.method}` };
      }
    } catch (error) {
      reply.error = {
        code: -32000,
        message: error.message,
        data: error.evidenceDir ? { evidenceDir: error.evidenceDir } : undefined
      };
    }
    if (req.id !== undefined) send(reply);
  }
}
