import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebDriverClient } from '../src/runners/webdriver.mjs';

test('WebDriver URL credentials become an Authorization header and never remain in the base URL', async () => {
  const expected = `Basic ${Buffer.from('agent:secret-token').toString('base64')}`;
  let observedAuthorization = null;
  const server = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization || null;
    response.writeHead(observedAuthorization === expected ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(observedAuthorization === expected
      ? { value: { ready: true } }
      : { value: { error: 'invalid argument', message: 'missing authorization' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const client = new WebDriverClient(`http://agent:secret-token@127.0.0.1:${port}`, { timeoutMs: 500 });
    assert.equal(client.baseUrl.includes('secret-token'), false);
    assert.equal(client.baseUrl.includes('agent@'), false);
    const status = await client.waitUntilReady(500);
    assert.equal(status.value.ready, true);
    assert.equal(observedAuthorization, expected);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
