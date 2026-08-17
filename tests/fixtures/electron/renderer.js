document.querySelector('#ping').addEventListener('click', async () => {
  const response = await window.ferrum.ping();
  document.querySelector('#out').textContent = response?.ok ? `ok:${response.electron}` : 'failed';
});
