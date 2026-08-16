import path from 'node:path';
import { spawnLogged, terminate, waitForExit } from '../core/process-utils.mjs';

async function waitHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return { status: response.status };
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Health URL did not become ready: ${url}: ${last?.message || 'timeout'}`);
}

async function waitForLog(lines, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some(line => line.text.includes(text))) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Process output missing expected text: ${text}`);
}

export async function runProcessTarget(spec, evidence) {
  const command = spec.target.command;
  if (!command) throw new Error('process target requires target.command');
  const args = spec.target.args || [];
  const lines = [];
  const child = spawnLogged(command, args, {
    cwd: spec.target.cwd || process.cwd(),
    env: { ...process.env, ...(spec.target.env || {}) },
    shell: Boolean(spec.target.shell)
  }, line => {
    lines.push(line);
    evidence.record('process-log', line);
  });
  evidence.record('process-start', { command, args, pid: child.pid });
  try {
    if (spec.target.healthUrl) await waitHealth(spec.target.healthUrl, spec.timeouts?.startupMs || 30000);
    for (const [index, step] of spec.steps.entries()) {
      if (step.action === 'wait-exit') {
        const exit = await waitForExit(child, step.timeoutMs || spec.timeouts?.stepMs || 30000);
        if (step.code != null && exit.code !== step.code) throw new Error(`Expected exit code ${step.code}, got ${exit.code}`);
        evidence.record('process-exit', exit);
      } else if (step.action === 'assert-log') {
        await waitForLog(lines, String(step.text), step.timeoutMs || spec.timeouts?.stepMs || 5000);
      } else if (step.action === 'wait') {
        await new Promise(resolve => setTimeout(resolve, Number(step.ms || 0)));
      } else {
        throw new Error(`Unsupported process step ${index}: ${step.action}`);
      }
    }
    return { pid: child.pid, logs: lines.length, running: child.exitCode === null };
  } finally {
    await terminate(child).catch(() => {});
    await evidence.writeText('process.log', lines.map(line => `[${line.source}] ${line.text}`).join('\n') + '\n');
  }
}
