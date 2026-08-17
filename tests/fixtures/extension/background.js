chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ ferrumFixtureInstalled: true }));
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ferrum-ping') return undefined;
  (async () => {
    const response = await fetch(chrome.runtime.getURL('manifest.json'));
    console.log(`ferrum-worker-ping:${chrome.runtime.id}:manifest-${response.status}`);
    sendResponse({ ok: response.ok, runtimeId: chrome.runtime.id, manifestStatus: response.status });
  })().catch(error => {
    console.error('ferrum-worker-ping-failed', error);
    sendResponse({ ok: false, runtimeId: chrome.runtime.id, error: String(error?.message || error) });
  });
  return true;
});
