import { loadSpec } from '../src/core/spec.mjs';
import { runSpec } from '../src/core/runner.mjs';

function emit(result) {
  process.stdout.write(`${JSON.stringify({ type: 'ferrum-browser-worker-result', result })}\n`);
}

async function main() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error('Browser matrix worker request is required');
  const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const spec = await loadSpec(request.specPath, { variables: request.options?.variables || {} });
  const browser = request.browser;
  try {
    const result = await runSpec(spec, {
      ...request.options,
      engine: 'chromium',
      browser: browser.name,
      browserChannel: browser.channel,
      browserExecutable: browser.channel ? undefined : browser.executablePath
    });
    emit({
      status: 'passed',
      evidenceId: result.id,
      evidenceDir: result.evidenceDir,
      error: null
    });
  } catch (error) {
    emit({
      status: 'failed',
      evidenceId: null,
      evidenceDir: error.evidenceDir || null,
      error: error.message
    });
  }
  setInterval(() => {}, 60000);
}

main().catch(error => {
  emit({ status: 'failed', evidenceId: null, evidenceDir: error.evidenceDir || null, error: error.stack || error.message });
  setInterval(() => {}, 60000);
});
