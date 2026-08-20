import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWorkloadPack } from '../src/core/workload-pack.mjs';

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-pack-output-test-'));
}

test('workload pack setup retains output written after the setup parent exits but before inherited stdio closes', async () => {
  const root = await tempDir();
  try {
    const specPath = path.join(root, 'process.json');
    const packPath = path.join(root, 'pack.json');
    const artifacts = path.join(root, 'artifacts');
    const grandchildScript = "setTimeout(() => { process.stdout.write('setup late ok\\n'); }, 300);";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });`,
      "grandchild.unref();",
      "console.log('setup parent exiting');"
    ].join('\n');

    await fs.writeFile(specPath, JSON.stringify({
      version: 1,
      name: 'pack-process-output-close',
      target: { type: 'process', command: process.execPath, args: ['-e', "console.log('pack member ok')"] },
      steps: [{ action: 'assert-log', text: 'pack member ok' }, { action: 'wait-exit', code: 0 }]
    }));
    await fs.writeFile(packPath, JSON.stringify({
      version: 1,
      name: 'setup-output-close',
      setup: [{ command: process.execPath, args: ['-e', parentScript], cwd: '.', timeoutMs: 3000 }],
      specs: ['process.json']
    }));

    const result = await runWorkloadPack(packPath, { artifactsRoot: artifacts });
    const setupLog = await fs.readFile(path.join(result.evidenceDir, 'setup', '0.log'), 'utf8');
    assert.match(setupLog, /setup parent exiting/);
    assert.match(setupLog, /setup late ok/, 'setup evidence must not finalize before inherited stdout closes');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
