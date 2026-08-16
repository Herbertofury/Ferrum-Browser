import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../src/server/dashboard.mjs';

test('dashboard binds an ephemeral port and serves its real UI/API', async () => {
  const { server, url } = await startDashboard({ port: 0, open: false });
  try {
    const parsed = new URL(url);
    assert.notEqual(parsed.port, '0');
    assert.ok(Number(parsed.port) > 0);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ferrum Test Workbench/);

    const doctor = await fetch(`${url}/api/doctor`);
    assert.equal(doctor.status, 200);
    const payload = await doctor.json();
    assert.equal(payload.ferrum, '0.2.0');

    const missing = await fetch(`${url}/missing-workbench-resource.js`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not found' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
