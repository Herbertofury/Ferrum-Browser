const $ = selector => document.querySelector(selector);
const runButton = $('#run');
const status = $('#runStatus');
const runs = $('#runs');
const doctorOut = $('#doctorOut');

async function json(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function refreshRuns() {
  const list = await json('/api/runs');
  runs.innerHTML = list.length ? list.slice().reverse().map(run => `<div class="run ${escapeHtml(run.status)}"><b>${escapeHtml(run.status.toUpperCase())}</b><small>${escapeHtml(run.specPath)}</small>${run.error ? `<div>${escapeHtml(run.error)}</div>` : ''}${run.result?.id ? `<div><code>${escapeHtml(run.result.id)}</code></div>` : ''}</div>`).join('') : '<span>No runs yet.</span>';
  const active = list.some(run => run.status === 'running');
  if (active) setTimeout(refreshRuns, 900);
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }

runButton.onclick = async () => {
  runButton.disabled = true;
  status.textContent = 'Starting real test run…';
  try {
    const run = await json('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ specPath: $('#spec').value, headless: $('#headless').checked }) });
    status.textContent = `Run ${run.id} started.`;
    await refreshRuns();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    runButton.disabled = false;
  }
};

$('#doctor').onclick = async () => {
  doctorOut.textContent = 'Inspecting runtimes…';
  try { doctorOut.textContent = JSON.stringify(await json('/api/doctor'), null, 2); }
  catch (error) { doctorOut.textContent = error.stack || error.message; }
};

refreshRuns().catch(error => status.textContent = error.message);
