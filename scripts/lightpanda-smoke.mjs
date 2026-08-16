import http from 'node:http';
import { runSpec } from '../src/core/runner.mjs';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Ferrum Lightpanda</title><button id="go">Go</button><output id="out">idle</output><script>document.querySelector('#go').onclick=()=>document.querySelector('#out').textContent='passed'</script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
try {
  const result = await runSpec({
    version: 1,
    name: 'ferrum-lightpanda-smoke',
    target: { type: 'web', engine: 'lightpanda', executable: process.env.FERRUM_LIGHTPANDA || 'lightpanda' },
    timeouts: { stepMs: 15000 },
    steps: [
      { action: 'open', url: `http://127.0.0.1:${port}/` },
      { action: 'snapshot', name: 'lightpanda', interactiveOnly: true },
      { action: 'click', selector: '#go' },
      { action: 'assert-text', selector: '#out', text: 'passed' },
      { action: 'assert-console-clean' }
    ]
  }, { engine: 'lightpanda', headless: true });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
