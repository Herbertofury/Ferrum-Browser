let cached;

export async function getPlaywright() {
  if (!cached) {
    cached = import('playwright').catch(error => {
      const wrapped = new Error('Playwright is required for browser, extension and Electron targets. Run `npm install` and `npx playwright install chromium`.');
      wrapped.cause = error;
      throw wrapped;
    });
  }
  return cached;
}
