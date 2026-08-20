import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvidenceWriter } from '../src/core/evidence.mjs';
import { runProcessTarget } from '../src/runners/process.mjs';

test('process runner preserves inherited late stdout before finalizing process.log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-process-final-log-'));
  const evidence = await new EvidenceWriter({ root, name: 'process-final-log-test' }).init();
  const lateScript = "setTimeout(() => { console.log('late-descendant-output'); process.exit(0); }, 180)";
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(lateScript)}], { detached: true, stdio: ['ignore', 1, 2] })`,
    "descendant.unref()",
    "console.log('setup-parent-exit')",
    "process.exit(0)"
  ].join(';');
  const spec = {
    target: { command: process.execPath, args: ['-e', parentScript] },
    timeouts: { stepMs: 3000 },
    steps: [
      { action: 'assert-log', text: 'setup-parent-exit' },
      { action: 'wait-exit', code: 0 }
    ]
  };

  await runProcessTarget(spec, evidence);
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.ok(
    evidence.events.some(event => event.type === 'process-log' && event.text.includes('late-descendant-output')),
    'precondition: inherited stdout must deliver the delayed descendant line to Ferrum'
  );
  const persisted = await fs.readFile(path.join(evidence.dir, 'process.log'), 'utf8');
  assert.match(
    persisted,
    /late-descendant-output/,
    'process.log must be finalized only after inherited stdout/stderr reaches the close boundary'
  );
});
