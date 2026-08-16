# Ferrum

Ferrum is an **agent-native full application tester** built to make browser-extension and app verification fast enough to use continuously without giving up real runtime fidelity.

The first-class workload is GameSync: Ferrum can load the exact unpacked Manifest V3 build into a persistent Chromium profile, hash the loaded bytes, resolve the real runtime extension ID, test popup/options/content-script/service-worker behavior, capture diagnostics and screenshots, restart the browser, prove the same build returns, and leave a complete evidence bundle.

Ferrum is broader than extensions. The same test-spec system supports web apps, Electron applications, arbitrary processes/services, and Appium-native/mobile sessions. Ferrum 0.2 also adds parallel suites and repeated benchmark runs so agents do not need to reimplement orchestration around the tester.

## Why this architecture

Ferrum combines the strongest ideas from current agent-browser work instead of rebuilding a web engine:

- **Lightpanda** is an actual optional ultra-fast headless/CDP execution lane, with its release binary independently verified in Ferrum CI.
- **Vercel agent-browser** informs compact stable refs, batching and low-round-trip agent control.
- **Ego Lite** informs isolated task-space thinking and code-composed actions.
- **Lightpanda Agent Benchmarks** informs fixed-workload median/p95/timeout measurement instead of subjective speed claims.
- **Browserless** informs session, queue, debug and evidence-infrastructure patterns.
- **Browserbase Stagehand** is the reference for a future semantic recovery layer above deterministic primitives.
- **Playwright Chromium** is the correctness lane for the browser and extension behaviors Lightpanda cannot replace.

See [docs/UPSTREAMS.md](docs/UPSTREAMS.md) for direct source links.

## Install

Requires Node 24+.

```bash
npm install
npx playwright install chromium
```

Lightpanda is optional. Set `FERRUM_LIGHTPANDA` to a verified Lightpanda binary when you want the fast lane.

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

Run independent workloads concurrently while keeping separate evidence bundles:

```bash
npx ferrum suite examples/self-test-web.json examples/self-test-extension.json --workers 2 --headless
```

Repeat an identical workload and report median/p95 timing. A web spec compatible with both engines can compare Chromium and Lightpanda directly:

```bash
npx ferrum bench path/to/benchmark-spec.json --engines chromium,lightpanda --runs 7 --warmup 1 --headless
```

Open the functional local workbench in Ferrum's controlled Chromium app window:

```bash
npx ferrum dashboard
```

Expose Ferrum to an agent over MCP stdio. MCP includes doctor, single-run, suite and benchmark tools:

```bash
npx ferrum mcp
```

## GameSync

`examples/gamesync-extension.json` is a starting acceptance workload for the current standalone GameSync extension. Point `target.path` at the freshly built `dist` directory. A GameSync change is not fully verified merely because generic CI or an Opera smoke test passes. Ferrum must exercise the exact changed flow and restart/persistence path as an additional mandatory acceptance layer.

When real GameSync testing exposes avoidable Ferrum slowness, missing diagnostics, fragile extension discovery, excessive agent round trips or an unsupported reusable workflow, that is treated as Ferrum work: fix Ferrum, regression-test it, then rerun GameSync instead of routing around the tester.

## Evidence

Runs create unique `artifacts/<timestamp>-<name>-<nonce>/` folders with:

- normalized `spec.json`
- `result.json` with every timed step
- screenshots
- Playwright trace files
- console/page/network failure events
- extension build SHA-256 inventory
- resolved runtime extension ID and identity source
- restart proof when requested
- process/Appium output where applicable

A failed run keeps its artifacts. Parallel runs never share an evidence directory.

## Self-test

```bash
npm test
npm run smoke:web
npm run smoke:extension
npm run smoke:lightpanda
```

The Chromium smoke commands require Playwright Chromium. The Lightpanda command requires `FERRUM_LIGHTPANDA` or a `lightpanda` executable on PATH. GitHub CI verifies Chromium on Linux and Windows and separately verifies the pinned current Lightpanda fast lane.
