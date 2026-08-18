import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const processUtilsUrl = new URL('../src/core/process-utils.mjs', import.meta.url).href;

test('terminate does not keep Node alive for the unused grace period after prompt shutdown', async () => {
  const helper = `
    import { spawn } from 'node:child_process';
    import { performance } from 'node:perf_hooks';
    import { terminate } from ${JSON.stringify(processUtilsUrl)};
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const startedAt = performance.now();
    await terminate(child);
    console.log(JSON.stringify({ terminateAwaitMs: performance.now() - startedAt }));
  `;
  const startedAt = performance.now();
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', helper], {
    timeout: 3000,
    windowsHide: true
  });
  const wallMs = performance.now() - startedAt;
  const result = JSON.parse(stdout.trim());
  assert.ok(result.terminateAwaitMs < 1000, `terminate should observe prompt child exit; terminateAwaitMs=${result.terminateAwaitMs.toFixed(0)}ms`);
  assert.ok(wallMs < 2500, `unused termination grace timer must not keep the helper process alive; wallMs=${wallMs.toFixed(0)}ms`);
});
