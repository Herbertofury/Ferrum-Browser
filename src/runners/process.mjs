import fs from 'node:fs/promises';
import os from 'node:os';
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

async function waitForLog(lines, text, timeoutMs, getClosed) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some(line => line.text.includes(text))) return true;
    const closed = getClosed?.();
    if (closed) {
      const code = closed.code == null ? 'none' : closed.code;
      const signal = closed.signal || 'none';
      throw new Error(`Process exited before output contained expected text: ${text} (code ${code}, signal ${signal})`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Process output missing expected text: ${text}`);
}

async function writeStdin(child, text) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Process stdin is not writable');
  await new Promise((resolve, reject) => {
    child.stdin.write(text, error => error ? reject(error) : resolve());
  });
}

function isNodeCommand(command) {
  const name = path.basename(String(command || '')).toLowerCase();
  return name === 'node' || name === 'node.exe';
}

function validateNodeDiagnosticArgs(args) {
  const conflicting = args.find(arg => /^(?:--(?:no-)?report-|--diagnostic-report-)/.test(String(arg)));
  if (conflicting) {
    throw new Error(`process target nodeDiagnosticReport owns Node report flags; remove conflicting argument: ${conflicting}`);
  }
}

function sanitizeLibuvHandles(handles) {
  if (!Array.isArray(handles)) return null;
  return handles.map(handle => ({
    type: handle?.type ?? null,
    is_active: handle?.is_active ?? null,
    is_referenced: handle?.is_referenced ?? null,
    fd: handle?.fd ?? null,
    writeQueueSize: handle?.writeQueueSize ?? null,
    readable: handle?.readable ?? null,
    writable: handle?.writable ?? null,
    sendBufferSize: handle?.sendBufferSize ?? null,
    recvBufferSize: handle?.recvBufferSize ?? null
  }));
}

function sanitizeNodeDiagnosticReport(report) {
  const header = report?.header || {};
  return {
    schemaVersion: 1,
    header: {
      reportVersion: header.reportVersion ?? null,
      event: header.event ?? null,
      trigger: header.trigger ?? null,
      dumpEventTime: header.dumpEventTime ?? null,
      dumpEventTimeStamp: header.dumpEventTimeStamp ?? null,
      processId: header.processId ?? null,
      nodejsVersion: header.nodejsVersion ?? null,
      wordSize: header.wordSize ?? null,
      arch: header.arch ?? null,
      platform: header.platform ?? null,
      componentVersions: header.componentVersions ?? null
    },
    javascriptStack: report?.javascriptStack || null,
    nativeStack: report?.nativeStack || null,
    javascriptHeap: report?.javascriptHeap || null,
    resourceUsage: report?.resourceUsage || null,
    uvthreadResourceUsage: report?.uvthreadResourceUsage || null,
    libuv: sanitizeLibuvHandles(report?.libuv)
  };
}

async function collectNodeDiagnosticReports(tempDir, evidence) {
  if (!tempDir) return [];
  const retained = [];
  try {
    const names = (await fs.readdir(tempDir)).filter(name => name.endsWith('.json')).sort();
    for (const name of names) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(tempDir, name), 'utf8'));
        const report = sanitizeNodeDiagnosticReport(raw);
        const target = await evidence.writeJson(path.join('node-reports', name), report);
        const relative = path.relative(evidence.dir, target).replaceAll('\\', '/');
        evidence.record('node-diagnostic-report', {
          path: relative,
          event: report.header.event,
          trigger: report.header.trigger,
          processId: report.header.processId
        });
        retained.push(relative);
      } catch (error) {
        evidence.record('node-diagnostic-report-error', { file: name, message: error.message });
      }
    }
    return retained;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runProcessTarget(spec, evidence) {
  const command = spec.target.command;
  if (!command) throw new Error('process target requires target.command');
  const nodeDiagnosticReport = Boolean(spec.target.nodeDiagnosticReport);
  if (nodeDiagnosticReport && !isNodeCommand(command)) {
    throw new Error('process target nodeDiagnosticReport requires target.command to be node or node.exe');
  }
  const originalArgs = spec.target.args || [];
  if (nodeDiagnosticReport) validateNodeDiagnosticArgs(originalArgs);
  let nodeReportDir = null;
  if (nodeDiagnosticReport) nodeReportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-node-report-'));
  const args = nodeDiagnosticReport ? [
    '--report-uncaught-exception',
    '--report-on-fatalerror',
    '--report-exclude-env',
    '--report-exclude-network',
    '--report-compact',
    `--report-directory=${nodeReportDir}`,
    ...originalArgs
  ] : originalArgs;
  const lines = [];
  let closed = null;
  let outcome = null;
  const child = spawnLogged(command, args, {
    cwd: spec.target.cwd || process.cwd(),
    env: { ...process.env, ...(spec.target.env || {}) },
    shell: Boolean(spec.target.shell),
    stdio: ['pipe', 'pipe', 'pipe']
  }, line => {
    lines.push(line);
    evidence.record('process-log', line);
  });
  child.once('close', (code, signal) => { closed = { code, signal }; });
  evidence.record('process-start', { command, args: originalArgs, pid: child.pid, nodeDiagnosticReport });
  try {
    if (spec.target.healthUrl) await waitHealth(spec.target.healthUrl, spec.timeouts?.startupMs || 30000);
    for (const [index, step] of spec.steps.entries()) {
      if (step.action === 'wait-exit') {
        const exit = await waitForExit(child, step.timeoutMs || spec.timeouts?.stepMs || 30000);
        if (step.code != null && exit.code !== step.code) throw new Error(`Expected exit code ${step.code}, got ${exit.code}`);
        evidence.record('process-exit', exit);
      } else if (step.action === 'assert-log') {
        await waitForLog(lines, String(step.text), step.timeoutMs || spec.timeouts?.stepMs || 5000, () => closed);
      } else if (step.action === 'write-stdin') {
        const payload = String(step.text ?? step.value ?? '') + (step.newline ? '\n' : '');
        await writeStdin(child, payload);
        evidence.record('process-input', { bytes: Buffer.byteLength(payload), newline: Boolean(step.newline) });
      } else if (step.action === 'close-stdin') {
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Process stdin is not open');
        child.stdin.end();
        evidence.record('process-stdin-closed');
      } else if (step.action === 'wait') {
        await new Promise(resolve => setTimeout(resolve, Number(step.ms || 0)));
      } else {
        throw new Error(`Unsupported process step ${index}: ${step.action}`);
      }
    }
    outcome = { pid: child.pid, logs: lines.length, running: child.exitCode === null, nodeReports: 0 };
    return outcome;
  } finally {
    await terminate(child).catch(() => {});
    const reports = await collectNodeDiagnosticReports(nodeReportDir, evidence);
    if (outcome) outcome.nodeReports = reports.length;
    await evidence.writeText('process.log', lines.map(line => `[${line.source}] ${line.text}`).join('\n') + '\n');
  }
}
