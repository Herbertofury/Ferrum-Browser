import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnLogged, terminate, waitForClose, waitForExit } from '../core/process-utils.mjs';

function healthTerminalError(url, terminal) {
  if (terminal?.type === 'error') {
    return new Error(`Process failed before health URL became ready: ${url}: ${terminal.error?.message || 'spawn error'}`);
  }
  const code = terminal?.code == null ? 'none' : terminal.code;
  const signal = terminal?.signal || 'none';
  return new Error(`Process exited before health URL became ready: ${url} (code ${code}, signal ${signal})`);
}

async function waitHealth(url, timeoutMs, terminalPromise, getTerminal) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let attempts = 0;
  const terminalOutcome = terminalPromise?.then(terminal => ({ type: 'terminal', terminal }));
  while (Date.now() < deadline) {
    const existingTerminal = getTerminal?.();
    if (existingTerminal) throw healthTerminalError(url, existingTerminal);
    const remainingMs = Math.max(1, deadline - Date.now());
    attempts += 1;
    const requestAbort = new AbortController();
    const requestSignal = AbortSignal.any([AbortSignal.timeout(remainingMs), requestAbort.signal]);
    const requestOutcome = fetch(url, { signal: requestSignal }).then(
      response => ({ type: 'response', response }),
      error => ({ type: 'error', error })
    );
    const outcome = terminalOutcome
      ? await Promise.race([requestOutcome, terminalOutcome])
      : await requestOutcome;
    if (outcome.type === 'terminal') {
      requestAbort.abort();
      await requestOutcome;
      throw healthTerminalError(url, outcome.terminal);
    }
    if (outcome.type === 'response') {
      if (outcome.response.ok) return { status: outcome.response.status, attempts };
      last = new Error(`HTTP ${outcome.response.status}`);
    } else {
      const terminal = getTerminal?.();
      if (terminal) throw healthTerminalError(url, terminal);
      if (outcome.error?.name === 'TimeoutError' || outcome.error?.name === 'AbortError') {
        last = null;
        break;
      }
      last = outcome.error;
    }
    const waitMs = Math.min(200, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      if (terminalOutcome) {
        const waitOutcome = await Promise.race([
          new Promise(resolve => setTimeout(() => resolve(null), waitMs)),
          terminalOutcome
        ]);
        if (waitOutcome?.type === 'terminal') throw healthTerminalError(url, waitOutcome.terminal);
      } else {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
  throw new Error(`Health URL did not become ready: ${url} after ${attempts} attempts: ${last?.message || 'timeout'}`);
}

async function waitForLog(lines, text, timeoutMs, getClosed, getSpawnError) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lines.some(line => line.text.includes(text))) return true;
    const spawnError = getSpawnError?.();
    if (spawnError) throw new Error(`Process failed before output contained expected text: ${text}: ${spawnError.message}`);
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

function processHttpTerminalError(method, url, terminal) {
  if (terminal?.type === 'error') {
    return new Error(`Process failed during HTTP request ${method} ${url}: ${terminal.error?.message || 'spawn error'}`);
  }
  const code = terminal?.code == null ? 'none' : terminal.code;
  const signal = terminal?.signal || 'none';
  return new Error(`Process exited during HTTP request ${method} ${url} (code ${code}, signal ${signal})`);
}

function requestHeaders(step) {
  const headers = { ...(step.headers || {}) };
  const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type');
  if (step.json != null && !hasContentType) headers['content-type'] = 'application/json';
  return headers;
}

async function terminalAfterTransportError(lifecycle, timeoutMs) {
  const existing = lifecycle.getTerminal();
  if (existing) return existing;
  return Promise.race([
    lifecycle.terminalPromise,
    new Promise(resolve => setTimeout(() => resolve(null), Math.min(25, timeoutMs)))
  ]);
}

async function performHttpRequest(step, index, evidence, lifecycle, defaultTimeoutMs) {
  const url = String(step.url || '');
  if (!url) throw new Error(`process http-request step ${index} requires url`);
  if (step.body != null && step.json != null) throw new Error(`process http-request step ${index} cannot define both body and json`);
  const method = String(step.method || 'GET').toUpperCase();
  const body = step.json != null ? JSON.stringify(step.json) : step.body == null ? undefined : String(step.body);
  const timeoutMs = Number(step.timeoutMs || defaultTimeoutMs || 5000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`process http-request step ${index} requires a positive timeout`);

  const existingTerminal = lifecycle.getTerminal();
  if (existingTerminal) throw processHttpTerminalError(method, url, existingTerminal);

  const requestAbort = new AbortController();
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), requestAbort.signal]);
  const requestOutcome = fetch(url, {
    method,
    headers: requestHeaders(step),
    body,
    signal: requestSignal
  }).then(
    response => ({ type: 'response', response }),
    error => ({ type: 'error', error })
  );
  const terminalOutcome = lifecycle.terminalPromise.then(terminal => ({ type: 'terminal', terminal }));
  const outcome = await Promise.race([requestOutcome, terminalOutcome]);
  if (outcome.type === 'terminal') {
    requestAbort.abort();
    await requestOutcome;
    throw processHttpTerminalError(method, url, outcome.terminal);
  }
  if (outcome.type === 'error') {
    const terminal = await terminalAfterTransportError(lifecycle, timeoutMs);
    if (terminal) throw processHttpTerminalError(method, url, terminal);
    if (outcome.error?.name === 'TimeoutError' || outcome.error?.name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw new Error(`HTTP request failed: ${method} ${url}: ${outcome.error?.message || outcome.error}`);
  }

  const bodyOutcome = outcome.response.text().then(
    text => ({ type: 'body', text }),
    error => ({ type: 'error', error })
  );
  const completed = await Promise.race([bodyOutcome, terminalOutcome]);
  if (completed.type === 'terminal') {
    requestAbort.abort();
    await bodyOutcome;
    throw processHttpTerminalError(method, url, completed.terminal);
  }
  if (completed.type === 'error') {
    const terminal = await terminalAfterTransportError(lifecycle, timeoutMs);
    if (terminal) throw processHttpTerminalError(method, url, terminal);
    if (completed.error?.name === 'TimeoutError' || completed.error?.name === 'AbortError') {
      throw new Error(`HTTP response timed out after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw new Error(`HTTP response failed: ${method} ${url}: ${completed.error?.message || completed.error}`);
  }

  const fileName = path.join('http', `${String(index + 1).padStart(3, '0')}-response.txt`);
  const target = await evidence.writeText(fileName, completed.text);
  const relative = path.relative(evidence.dir, target).replaceAll('\\', '/');
  evidence.record('process-http-response', {
    method,
    url,
    status: outcome.response.status,
    ok: outcome.response.ok,
    requestBytes: body == null ? 0 : Buffer.byteLength(body),
    responseBytes: Buffer.byteLength(completed.text),
    contentType: outcome.response.headers.get('content-type'),
    path: relative
  });

  if (step.status != null && outcome.response.status !== Number(step.status)) {
    throw new Error(`Expected HTTP status ${step.status}, got ${outcome.response.status} for ${method} ${url}`);
  }
  if (step.text != null && !completed.text.includes(String(step.text))) {
    throw new Error(`HTTP response missing expected text for ${method} ${url}: ${step.text}`);
  }
  return { status: outcome.response.status, path: relative };
}

function observeProcessLifecycle(child, evidence) {
  let terminal = null;
  let spawnError = null;
  let spawned = false;
  let resolveTerminal;
  let resolveSpawn;
  let rejectSpawn;
  const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
  const spawnPromise = new Promise((resolve, reject) => {
    resolveSpawn = resolve;
    rejectSpawn = reject;
  });
  child.once('spawn', () => {
    spawned = true;
    resolveSpawn();
  });
  child.on('error', error => {
    evidence.record('process-error', { message: error.message, code: error.code ?? null });
    if (!spawned && !spawnError) {
      spawnError = error;
      terminal = { type: 'error', error };
      rejectSpawn(error);
      resolveTerminal(terminal);
    }
  });
  child.once('close', (code, signal) => {
    const closed = { type: 'close', code, signal };
    if (!terminal) {
      terminal = closed;
      resolveTerminal(closed);
    }
  });
  return {
    spawnPromise,
    terminalPromise,
    getTerminal: () => terminal,
    getClosed: () => terminal?.type === 'close' ? { code: terminal.code, signal: terminal.signal } : null,
    getSpawnError: () => spawnError
  };
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
  let outcome = null;
  let httpRequests = 0;
  let primaryError = null;
  const child = spawnLogged(command, args, {
    cwd: spec.target.cwd || process.cwd(),
    env: { ...process.env, ...(spec.target.env || {}) },
    shell: Boolean(spec.target.shell),
    stdio: ['pipe', 'pipe', 'pipe']
  }, line => {
    lines.push(line);
    evidence.record('process-log', line);
  });
  const lifecycle = observeProcessLifecycle(child, evidence);
  try {
    await lifecycle.spawnPromise;
    evidence.record('process-start', { command, args: originalArgs, pid: child.pid, nodeDiagnosticReport });
    if (spec.target.healthUrl) {
      await waitHealth(
        spec.target.healthUrl,
        spec.timeouts?.startupMs || 30000,
        lifecycle.terminalPromise,
        lifecycle.getTerminal
      );
    }
    for (const [index, step] of spec.steps.entries()) {
      if (step.action === 'wait-exit') {
        const spawnError = lifecycle.getSpawnError();
        if (spawnError) throw spawnError;
        const exit = await waitForExit(child, step.timeoutMs || spec.timeouts?.stepMs || 30000);
        if (step.code != null && exit.code !== step.code) throw new Error(`Expected exit code ${step.code}, got ${exit.code}`);
        evidence.record('process-exit', exit);
      } else if (step.action === 'assert-log') {
        await waitForLog(
          lines,
          String(step.text),
          step.timeoutMs || spec.timeouts?.stepMs || 5000,
          lifecycle.getClosed,
          lifecycle.getSpawnError
        );
      } else if (step.action === 'http-request') {
        await performHttpRequest(step, index, evidence, lifecycle, spec.timeouts?.stepMs || 5000);
        httpRequests += 1;
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
    outcome = { pid: child.pid, logs: lines.length, running: child.exitCode === null, nodeReports: 0, httpRequests };
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let closeError = null;
    if (child.pid) {
      await terminate(child).catch(() => {});
      try {
        await waitForClose(child, spec.timeouts?.stepMs || 5000);
      } catch (error) {
        closeError = error;
        evidence.record('process-close-error', { message: error.message });
      }
    }
    const reports = await collectNodeDiagnosticReports(nodeReportDir, evidence);
    if (outcome) outcome.nodeReports = reports.length;
    await evidence.writeText('process.log', lines.map(line => `[${line.source}] ${line.text}`).join('\n') + '\n');
    if (closeError && !primaryError) throw closeError;
  }
}
