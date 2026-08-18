import { spawn } from 'node:child_process';

export function spawnLogged(command, args = [], options = {}, onLine = () => {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const wire = (stream, source) => {
    let buffer = '';
    stream?.setEncoding('utf8');
    stream?.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine({ source, text: buffer.slice(0, index) });
        buffer = buffer.slice(index + 1);
      }
    });
    stream?.on('end', () => {
      if (buffer) onLine({ source, text: buffer });
    });
  };
  wire(child.stdout, 'stdout');
  wire(child.stderr, 'stderr');
  return child;
}

export async function waitForExit(child, timeoutMs = 0) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => reject(new Error(`Process did not exit within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export async function terminate(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  let graceTimer;
  const graceElapsed = new Promise(resolve => {
    graceTimer = setTimeout(() => resolve(false), graceMs);
    graceTimer.unref?.();
  });
  const exited = await Promise.race([
    waitForExit(child).then(() => true).catch(() => true),
    graceElapsed
  ]);
  clearTimeout(graceTimer);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}
