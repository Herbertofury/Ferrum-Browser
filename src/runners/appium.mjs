function endpoint(base, path) {
  return `${String(base || 'http://127.0.0.1:4723').replace(/\/$/, '')}${path}`;
}

async function request(base, path, { method = 'GET', body } = {}) {
  const response = await fetch(endpoint(base, path), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.value?.error) {
    throw new Error(`Appium ${method} ${path} failed: ${payload.value?.message || response.statusText}`);
  }
  return payload.value;
}

export async function runAppiumTarget(spec, evidence) {
  const base = spec.target.server || 'http://127.0.0.1:4723';
  const caps = { alwaysMatch: spec.target.capabilities || {}, firstMatch: [{}] };
  const value = await request(base, '/session', { method: 'POST', body: { capabilities: caps } });
  const sessionId = value.sessionId || value?.capabilities?.sessionId;
  if (!sessionId) throw new Error('Appium did not return a sessionId');
  evidence.record('appium-session', { base, sessionId, capabilities: value.capabilities || caps.alwaysMatch });
  const p = suffix => `/session/${sessionId}${suffix}`;
  try {
    for (const [index, step] of spec.steps.entries()) {
      evidence.record('step-start', { index, action: step.action, step });
      let output;
      if (step.action === 'find') {
        output = await request(base, p('/element'), { method: 'POST', body: { using: step.using || 'accessibility id', value: step.value } });
      } else if (step.action === 'click') {
        const element = await request(base, p('/element'), { method: 'POST', body: { using: step.using || 'accessibility id', value: step.value } });
        const id = element['element-6066-11e4-a52e-4f735466cecf'] || element.ELEMENT;
        await request(base, p(`/element/${id}/click`), { method: 'POST', body: {} });
        output = { element: id };
      } else if (step.action === 'fill') {
        const element = await request(base, p('/element'), { method: 'POST', body: { using: step.using || 'accessibility id', value: step.value } });
        const id = element['element-6066-11e4-a52e-4f735466cecf'] || element.ELEMENT;
        await request(base, p(`/element/${id}/value`), { method: 'POST', body: { text: String(step.text ?? '') } });
        output = { element: id };
      } else if (step.action === 'screenshot') {
        const png = await request(base, p('/screenshot'));
        const file = `appium-${index}.png`;
        await import('node:fs/promises').then(fs => fs.writeFile(`${evidence.dir}/screenshots/${file}`, Buffer.from(png, 'base64')));
        output = { file: `screenshots/${file}` };
      } else if (step.action === 'source') {
        const source = await request(base, p('/source'));
        await evidence.writeText(`appium-source-${index}.xml`, source);
        output = { saved: true };
      } else {
        throw new Error(`Unsupported Appium step ${index}: ${step.action}`);
      }
      evidence.record('step-pass', { index, action: step.action, output });
    }
    return { sessionId };
  } finally {
    await request(base, p(''), { method: 'DELETE' }).catch(() => {});
  }
}
