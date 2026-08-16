# Ferrum

Ferrum is an **agent-native full application tester** built to make browser-extension and app verification fast enough to use continuously without giving up real runtime fidelity.

The first-class workload is GameSync: Ferrum can load the exact unpacked Manifest V3 build into a persistent Chromium profile, hash the build, resolve the real runtime extension ID, test popup/options/content-script/service-worker behavior, capture diagnostics and screenshots, restart the browser, prove the same build returns, and leave a complete evidence bundle.

Ferrum is broader than extensions. The same test-spec system supports web apps, Electron applications, arbitrary processes/services, and Appium-native/mobile sessions.

## Why this architecture

Ferrum deliberately combines the strongest ideas from current agent-browser work instead of rebuilding a web engine:

- **Lightpanda** for the optional ultra-fast headless/CDP lane.
- **Vercel agent-browser** for compact stable refs, batching and low-round-trip agent control.
- **Ego Lite** for isolated task-space thinking and direct code-composed actions.
- **Lightpanda Agent Benchmarks** for honest fixed-workload speed/reliability measurement.
- **Browserless** for session/queue/debug infrastructure patterns.
- **Browserbase Stagehand** for a future semantic recovery layer above deterministic primitives.
- **Playwright Chromium** for the correctness lane that actually supports the browser and extension behaviors under test.

See [docs/UPSTREAMS.md](docs/UPSTREAMS.md) for direct source links.

## Install

Requires Node 24+.

```bash
npm install
npx playwright install chromium
```

## Use

Inspect available runtimes:

```bash
npx ferrum doctor
```

Run the built-in real MV3 extension self-test:

```bash
npx ferrum test examples/self-test-extension.json --headless
```

Run a web-app test:

```bash
npx ferrum test examples/self-test-web.json --headless
```

Open the functional local workbench:

```bash
npx ferrum dashboard
```

Expose Ferrum to an agent over MCP stdio:

```bash
npx ferrum mcp
```

## GameSync

`examples/gamesync-extension.json` is a starting acceptance workload for the current standalone GameSync extension. Point `target.path` at the freshly built `dist` directory. A GameSync change is not fully verified merely because CI or Opera smoke tests pass; Ferrum should exercise the exact changed flow and restart/persistence path as well.

## Evidence

Runs create `artifacts/<timestamp>-<name>/` with:

- normalized `spec.json`
- `result.json` with every timed step
- screenshots
- Playwright trace files
- console/page/network failure events
- extension build SHA-256 inventory
- resolved runtime extension ID
- restart proof when requested
- process/Appium output where applicable

A failed run keeps its artifacts.

## Self-test

```bash
npm test
npm run smoke:web
npm run smoke:extension
```

The smoke commands require Playwright Chromium to be installed.
