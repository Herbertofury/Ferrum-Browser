const $ = selector => document.querySelector(selector);
const runButton = $('#run');
const status = $('#runStatus');
const runs = $('#runs');
const evidence = $('#evidence');
const replay = $('#replay');
const replayStatus = $('#replayStatus');
const doctorOut = $('#doctorOut');

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function fileUrl(id, file) { return `/api/evidence/${encodeURIComponent(id)}/file?path=${encodeURIComponent(file)}`; }

async function refreshRuns() {
  const list = await json('/api/runs');
  runs.innerHTML = list.length ? [...list].reverse().map(run => `<div class="run ${escapeHtml(run.status)}"><b>${escapeHtml(run.status.toUpperCase())}</b><small>${escapeHtml(run.specPath)}</small>${run.error ? `<div>${escapeHtml(run.error)}</div>` : ''}${run.result?.id ? `<div><code>${escapeHtml(run.result.id)}</code></div>` : ''}</div>`).join('') : '<span>No live runs yet.</span>';
  const active = list.some(run => run.status === 'running');
  if (active) setTimeout(async () => { await refreshRuns(); await refreshEvidence(); }, 600);
}

async function refreshEvidence() {
  const list = await json('/api/evidence');
  evidence.innerHTML = list.length ? list.map(item => `<button class="evidence-run ${escapeHtml(item.status)}" data-evidence-id="${escapeHtml(item.id)}"><b>${escapeHtml(String(item.status || 'unknown').toUpperCase())}</b><span>${escapeHtml(item.name || item.id)}</span><small>${escapeHtml(item.endedAt || item.startedAt || '')}</small><code>${escapeHtml(item.id)}</code></button>`).join('') : '<span>No retained evidence yet.</span>';
  for (const button of evidence.querySelectorAll('[data-evidence-id]')) button.addEventListener('click', () => showEvidence(button.dataset.evidenceId));
}

function renderEvent(event, index) {
  const detail = Object.fromEntries(Object.entries(event).filter(([key]) => !['at', 'type'].includes(key)));
  return `<div class="event"><div><b>${index + 1}. ${escapeHtml(event.type)}</b><small>${escapeHtml(event.at)}</small></div><pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre></div>`;
}

async function showEvidence(id) {
  replayStatus.textContent = `Loading ${id}…`;
  const item = await json(`/api/evidence/${encodeURIComponent(id)}`);
  const result = item.result;
  const screenshots = item.files.filter(file => /(^|\/)screenshots\/.*\.png$/i.test(file.path));
  const files = item.files.map(file => `<a href="${fileUrl(id, file.path)}" target="_blank" rel="noreferrer"><span>${escapeHtml(file.path)}</span><small>${file.bytes} B</small></a>`).join('');
  const images = screenshots.map(file => `<figure><img src="${fileUrl(id, file.path)}" alt="${escapeHtml(file.path)}"><figcaption>${escapeHtml(file.path)}</figcaption></figure>`).join('');
  const events = (result.events || []).map(renderEvent).join('');
  replay.innerHTML = `
    <div class="replay-summary">
      <div><span>Status</span><b>${escapeHtml(String(result.status || 'unknown').toUpperCase())}</b></div>
      <div><span>Target</span><b>${escapeHtml(result.metadata?.targetType || '')}</b></div>
      <div><span>Engine</span><b>${escapeHtml(result.result?.engine || '')}</b></div>
      <div><span>Diagnostics</span><b>${escapeHtml(result.summary?.diagnosticErrorCount ?? 0)}</b></div>
    </div>
    <details open><summary>Timeline · ${(result.events || []).length} events</summary><div class="timeline">${events || '<span>No events recorded.</span>'}</div></details>
    <details ${screenshots.length ? 'open' : ''}><summary>Screenshots · ${screenshots.length}</summary><div class="screenshots">${images || '<span>No screenshots in this run.</span>'}</div></details>
    <details><summary>Files · ${item.files.length}</summary><div class="files">${files}</div></details>`;
  replayStatus.textContent = `${result.name || id} · ${result.status}`;
}

runButton.onclick = async () => {
  runButton.disabled = true;
  status.textContent = 'Starting real test run…';
  try {
    const run = await json('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ specPath: $('#spec').value, headless: $('#headless').checked }) });
    status.textContent = `Run ${run.id} started.`;
    await refreshRuns();
  } catch (error) { status.textContent = error.message; }
  finally { runButton.disabled = false; }
};

$('#doctor').onclick = async () => {
  doctorOut.textContent = 'Inspecting runtimes…';
  try { doctorOut.textContent = JSON.stringify(await json('/api/doctor'), null, 2); }
  catch (error) { doctorOut.textContent = error.stack || error.message; }
};

Promise.all([refreshRuns(), refreshEvidence()]).catch(error => status.textContent = error.message);
