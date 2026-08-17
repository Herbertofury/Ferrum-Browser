#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const inspectorPackage = '@modelcontextprotocol/inspector@2.2.0';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const baseArgs = [
  '--yes',
  inspectorPackage,
  '--cli',
  'node',
  './bin/ferrum.mjs',
  'mcp',
  '--'
];

function runInspector(args, label) {
  const startedAt = performance.now();
  const result = spawnSync(npx, [...baseArgs, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      CI: process.env.CI || '1',
      MCP_AUTO_OPEN_ENABLED: 'false'
    }
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (result.error) {
    throw new Error(`${label} failed to execute after ${elapsedMs}ms: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited ${result.status} after ${elapsedMs}ms\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  const stdout = result.stdout.trim();
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned non-JSON stdout after ${elapsedMs}ms: ${error.message}\n${stdout}`);
  }
  return { payload, elapsedMs };
}

function resultOf(payload, label) {
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    throw new Error(`${label} did not return the Inspector JSON result envelope`);
  }
  return payload.result;
}

const initialize = runInspector(['--method', 'initialize', '--format', 'json'], 'Inspector initialize');
const initializeResult = resultOf(initialize.payload, 'Inspector initialize');
if (!initializeResult?.serverInfo || !initializeResult?.protocolVersion || !initializeResult?.capabilities) {
  throw new Error('Inspector initialize did not expose Ferrum serverInfo, protocolVersion and capabilities');
}

const tools = runInspector(['--method', 'tools/list', '--format', 'json'], 'Inspector tools/list');
const toolsResult = resultOf(tools.payload, 'Inspector tools/list');
const toolList = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
const toolNames = new Set(toolList.map(tool => tool?.name).filter(Boolean));
for (const expected of [
  'ferrum_doctor',
  'ferrum_run',
  'ferrum_run_suite',
  'ferrum_browser_matrix',
  'ferrum_run_pack',
  'ferrum_verify_evidence'
]) {
  if (!toolNames.has(expected)) {
    throw new Error(`Inspector tools/list is missing required Ferrum tool ${expected}`);
  }
}

const doctor = runInspector(
  ['--method', 'tools/call', '--tool-name', 'ferrum_doctor', '--format', 'json'],
  'Inspector ferrum_doctor'
);
const doctorResult = resultOf(doctor.payload, 'Inspector ferrum_doctor');
if (doctorResult?.isError === true || !Array.isArray(doctorResult?.content) || doctorResult.content.length === 0) {
  throw new Error('Inspector ferrum_doctor call did not return a successful MCP content payload');
}

const summary = {
  inspector: inspectorPackage,
  protocolVersion: initializeResult.protocolVersion,
  server: initializeResult.serverInfo,
  advertisedToolCount: toolList.length,
  checkedTools: 6,
  elapsedMs: {
    initialize: initialize.elapsedMs,
    toolsList: tools.elapsedMs,
    doctor: doctor.elapsedMs,
    total: initialize.elapsedMs + tools.elapsedMs + doctor.elapsedMs
  }
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
