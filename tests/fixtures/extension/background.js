chrome.runtime.onInstalled.addListener(() => chrome.storage.local.set({ ferrumFixtureInstalled: true }));
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ferrum-ping') sendResponse({ ok: true, runtimeId: chrome.runtime.id });
});
