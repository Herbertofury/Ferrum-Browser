import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../src/browser/cdp-client.mjs';

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(payload) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: JSON.stringify(payload) });
    this.dispatchEvent(event);
  }
}

test('CDP client correlates session commands and dispatches events', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, { timeoutMs: 1000 });
  const seen = [];
  client.on('Runtime.consoleAPICalled', params => seen.push(params.type));
  const pending = client.send('Runtime.enable', {}, 'S1');
  assert.deepEqual(socket.sent[0], { id: 1, method: 'Runtime.enable', params: {}, sessionId: 'S1' });
  socket.message({ id: 1, sessionId: 'S1', result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  socket.message({ method: 'Runtime.consoleAPICalled', sessionId: 'S1', params: { type: 'log' } });
  assert.deepEqual(seen, ['log']);
  await client.close();
});
