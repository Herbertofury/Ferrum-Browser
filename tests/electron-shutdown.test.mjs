import test from 'node:test';
import assert from 'node:assert/strict';
import { withElectronOperationTimeout } from '../src/runners/electron.mjs';

test('electron operation timeout resolves fast operations and bounds stalled operations', async () => {
  assert.equal(await withElectronOperationTimeout(Promise.resolve('ok'), 50, 'fast electron op'), 'ok');
  await assert.rejects(
    withElectronOperationTimeout(new Promise(() => {}), 15, 'stalled electron op'),
    /stalled electron op timed out after 15ms/
  );
});
