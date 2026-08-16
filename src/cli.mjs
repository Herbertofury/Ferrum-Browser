import path from 'node:path';
import { loadSpec } from './core/spec.mjs';
import { runSpec } from './core/runner.mjs';
import { collectDoctor } from './core/doctor.mjs';
import { startDashboard } from './server/dashboard.mjs';
import { startMcpStdio } from './mcp/server.mjs';

function usage() {
  return `Ferrum 0.1.0\n\nUsage:\n  ferrum doctor\n  ferrum test <spec.json> [--headless] [--engine chromium|lightpanda] [--artifacts <dir>]\n  ferrum dashboard [--port 8788] [--no-open]\n  ferrum mcp\n`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
    const result = await runSpec(spec, {
      headless: args.includes('--headless') ? true : undefined,
      engine: argValue(args, '--engine'),
      artifactsRoot: argValue(args, '--artifacts')
    });
    console.log(JSON.stringify(result, null, 2));
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
