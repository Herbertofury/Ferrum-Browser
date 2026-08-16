# Upstream reference map

Ferrum uses these projects as design and interoperability references, not as code copied wholesale.

- Lightpanda: https://github.com/lightpanda-io/browser
  - fast non-Chromium headless engine, CDP, native agent/MCP, PandaScript ideas.
- Vercel agent-browser: https://github.com/vercel-labs/agent-browser
  - fast native CLI, stable refs, batching, sessions, CDP-oriented agent control.
- Ego Lite: https://github.com/citrolabs/ego-lite
  - isolated agent Spaces, code-composed actions, real-browser end-to-end test discipline.
- Lightpanda agent benchmarks: https://github.com/lightpanda-io/agent-benchmarks
  - fixed-workload comparisons, strict tool isolation, duration/timeout evidence.
- Browserless: https://github.com/browserless/browserless
  - browser session infrastructure, queueing, persistent sessions, debug/replay patterns.
- Browserbase Stagehand: https://github.com/browserbase/stagehand
  - deterministic locators plus higher-level observe/act/extract and self-healing fallback.
- Playwright: https://github.com/microsoft/playwright
  - current full-fidelity browser/Electron automation foundation.

Ferrum's rule is to keep deterministic low-level automation primary and use semantic recovery as a fallback, so AI convenience never hides a broken exact workflow.
