# Ferrum test spec v1

A test is a JSON document with `version`, `name`, `target`, optional timeouts/artifacts, and ordered `steps`.

Supported targets:

- `web`: Chromium or Lightpanda.
- `extension`: unpacked Manifest V3 extension in a persistent Chromium profile.
- `electron`: an Electron application driven with Playwright.
- `process`: an arbitrary process or service with captured logs and optional health URL.
- `appium`: a native/mobile application reachable through an Appium WebDriver server.

Common browser steps include `open`, `wait`, `click`, `fill`, `press`, `snapshot`, `screenshot`, `assert-text`, `assert-visible`, `assert-url`, `evaluate`, `vitals`, and `assert-console-clean`.

Extension-only steps include `extension-page`, `assert-service-worker`, `service-worker-diagnostics`, `assert-service-worker-diagnostics`, and `restart`.

`service-worker-diagnostics` returns the currently observed worker count, console-event count, worker-owned request/response/failure counts, intercepted page-response count, and closed-worker count. Add `name` to persist the snapshot as `diagnostics/<name>.json`.

`assert-service-worker-diagnostics` can require `minWorkers`, `minConsole`, `minRequests`, `minResponses`, `minInterceptedResponses`, and `maxFailedRequests`. These checks operate on real Chromium service-worker activity and are included in the extension self-test before and after browser restart.

`assert-console-clean` covers page and service-worker console errors, page/worker request failures, and HTTP 5xx diagnostic responses while preserving the raw events in the evidence bundle.

Each step is recorded with start/end timing and failure context. Browser failures preserve a Playwright trace. Every finalized run also records its exact `evidenceDir` and writes `agent-summary.json`, a compact machine-readable index beside the full `result.json`; the full event stream remains intact.
