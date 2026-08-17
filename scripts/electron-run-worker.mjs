import { runSpec } from '../src/core/runner.mjs';

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ type: 'ferrum-electron-worker-result', ...payload })}\n`);
}

async function readRequest() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error('Electron worker request is required');
  return JSON.parse(input);
}

async function main() {
  const request = await readRequest();
  try {
    const result = await runSpec(request.spec, { ...(request.options || {}), __directElectron: true });
    emit({ ok: true, result });
  } catch (error) {
    emit({
      ok: false,
      error: error.message,
      stack: error.stack,
      evidenceDir: error.evidenceDir || null
    });
  }
}

main().catch(error => {
  emit({ ok: false, error: error.message, stack: error.stack, evidenceDir: error.evidenceDir || null });
});
