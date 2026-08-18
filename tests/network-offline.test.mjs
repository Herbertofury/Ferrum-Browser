import test from 'node:test';
import assert from 'node:assert/strict';
import { StepEngine } from '../src/runners/step-engine.mjs';

function evidenceRecorder() {
  const events = [];
  return {
    events,
    record(type, payload) { events.push({ type, ...payload }); }
  };
}

test('network-offline toggles a supported browser context and records the state', async () => {
  const states = [];
  const evidence = evidenceRecorder();
  const session = {
    engine: 'chromium',
    context: {
      async setOffline(value) { states.push(value); }
    }
  };
  const engine = new StepEngine({ evidence, session, page: {}, timeoutMs: 1000 });

  const result = await engine.run([
    { action: 'network-offline', enabled: true },
    { action: 'network-offline', enabled: false }
  ]);

  assert.deepEqual(states, [true, false]);
  assert.equal(result.outputs[0].output.offline, true);
  assert.equal(result.outputs[1].output.offline, false);
  assert.deepEqual(
    evidence.events.filter(event => event.type === 'network-state').map(event => event.offline),
    [true, false]
  );
});

test('network-offline fails truthfully when the target has no offline control', async () => {
  const evidence = evidenceRecorder();
  const engine = new StepEngine({ evidence, session: { engine: 'lightpanda' }, page: {}, timeoutMs: 1000 });

  await assert.rejects(
    engine.run([{ action: 'network-offline', enabled: true }]),
    /network-offline is unavailable for target engine lightpanda/
  );
});
