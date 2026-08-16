import readline from 'node:readline';
import { loadSpec } from '../core/spec.mjs';
import { runSpec } from '../core/runner.mjs';
import { collectDoctor } from '../core/doctor.mjs';

const tools = [
  { name: 'ferrum_doctor', description: 'Inspect Ferrum browser/app testing prerequisites.', inputSchema: { type: 'object', properties: {} } },
  { name: 'ferrum_run_spec', description: 'Run a Ferrum JSON test spec and return its evidence summary.', inputSchema: { type: 'object', required: ['specPath'], properties: { specPath: { type: 'string' }, headless: { type: 'boolean' } } } }
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
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
        reply.result = { protocolVersion: req.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ferrum', version: '0.1.0' } };
      } else if (req.method === 'tools/list') {
        reply.result = { tools };
      } else if (req.method === 'tools/call') {
        const name = req.params?.name;
        const args = req.params?.arguments || {};
        let value;
        if (name === 'ferrum_doctor') value = await collectDoctor();
        else if (name === 'ferrum_run_spec') value = await runSpec(await loadSpec(args.specPath), { headless: args.headless });
        else throw new Error(`Unknown tool: ${name}`);
        reply.result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
      } else if (req.method?.startsWith('notifications/')) {
        continue;
      } else {
        reply.error = { code: -32601, message: `Method not found: ${req.method}` };
      }
    } catch (error) {
      reply.error = { code: -32000, message: error.message };
    }
    if (req.id !== undefined) send(reply);
  }
}
