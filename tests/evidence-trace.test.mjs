import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvidenceWriter } from '../src/core/evidence.mjs';

test('finalized evidence emits a complete redacted Chrome Trace Event sidecar', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ferrum-evidence-trace-'));
  try {
    const evidence = await new EvidenceWriter({
      root,
      name: 'trace-sidecar',
      redactValues: ['top-secret-value']
    }).init();

    const first = evidence.record('process-start', {
      pid: 123,
      token: 'top-secret-value',
      wallClockAt: 'forged-value'
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = evidence.record('process-http-response', {
      status: 200,
      path: 'http/001-response.txt'
    });

    const result = await evidence.finalize({ status: 'passed' });
    const trace = JSON.parse(await fs.readFile(path.join(result.evidenceDir, 'trace-event.json'), 'utf8'));
    const events = trace.traceEvents.filter(event => event.cat === 'ferrum');

    assert.deepEqual(events.map(event => event.name), ['process-start', 'process-http-response']);
    assert.equal(events.length, result.events.length);
    assert.equal(events[0].ph, 'i');
    assert.equal(events[0].s, 't');
    assert.equal(events[0].pid, 1);
    assert.equal(events[0].tid, 1);
    assert.equal(events[0].ts, Math.round(first.elapsedMs * 1000));
    assert.equal(events[1].ts, Math.round(second.elapsedMs * 1000));
    assert.ok(events[1].ts >= events[0].ts);
    assert.equal(events[0].args.token, '[REDACTED]');
    assert.equal(events[0].args.wallClockAt, first.at);
    assert.equal(events[1].args.status, 200);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
