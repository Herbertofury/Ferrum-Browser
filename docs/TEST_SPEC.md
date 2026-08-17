# Ferrum test spec v1

A test is a JSON document with `version`, `name`, `target`, optional timeouts/artifacts, and ordered `steps`.

Supported targets:

- `web`: Chromium, a discovered Chromium-family browser, or Lightpanda.
- `extension`: unpacked Manifest V3 extension in a persistent full-Chromium profile.
- `electron`: an Electron application driven with Playwright.
- `process`: an arbitrary process or service with captured logs and optional health URL.
- `appium`: a native/mobile application reachable through an Appium WebDriver server.

## Variables

Specs and workload packs support explicit `${VAR:NAME}` placeholders. CLI callers provide them with repeatable `--var NAME=value`; MCP callers provide a `variables` object. `${ENV:NAME}` is also accepted and resolves from the supplied variable map first, then the process environment. Missing required variables fail before execution. Variable expansion happens before target path resolution.

## Browser steps

Common browser steps include `open`, `wait`, `click`, `fill`, `press`, `snapshot`, `screenshot`, `assert-text`, `assert-visible`, `assert-url`, `evaluate`, `vitals`, and `assert-console-clean`.

Selectors and Ferrum refs are deterministic primitives. For legitimately ambiguous deterministic selectors, `first: true` or `nth: N` explicitly selects an element.

Locator steps may also provide a semantic `fallback`, for example:

```json
{
  "action": "click",
  "selector": "#save",
  "fallback": { "role": "button", "name": "Save", "exact": true }
}
```

Fallback supports role/name, label, placeholder, text, title, alt, and test id. Ferrum never uses a semantic fallback as the primary locator. When a fallback exists, the deterministic locator receives a short probe by default and the semantic fallback receives the full step timeout. Every successful recovery records `locator-fallback`; `assert-locator-fallbacks` can place minimum or maximum bounds on that friction.

## Extensions

Extension-only steps include `extension-page`, `assert-service-worker`, `service-worker-diagnostics`, `assert-service-worker-diagnostics`, and `restart`.

`service-worker-diagnostics` returns the observed worker count, console-event count, worker-owned request/response/failure counts, intercepted page-response count, and closed-worker count. Add `name` to persist the snapshot as `diagnostics/<name>.json`.

`assert-service-worker-diagnostics` can require `minWorkers`, `minConsole`, `minRequests`, `minResponses`, `minInterceptedResponses`, and `maxFailedRequests`. These checks operate on real Chromium service-worker activity and are included in the extension self-test before and after browser restart.

`assert-console-clean` covers page and service-worker console errors, page/worker request failures, and HTTP 5xx diagnostic responses while preserving the raw events in the evidence bundle.

## Appium

Appium steps include `find`, `find-all`, `click`, `clear`, `fill`, `get-text`, `get-attribute`, `assert-text`, `assert-visible`, `wait`, `back`, `screenshot`, `source`, and `assert-session`. A `find` step may assign an element alias with `as`; later actions can use `element` to reference that alias. Source and screenshot evidence are attempted automatically after a failed Appium step before the session is cleaned up.

## Workload packs

A workload pack is a separate JSON document with `version`, `name`, optional `repository`, optional `requiredVariables`, optional ordered `setup` commands, and one or more `specs`. Setup commands execute for real with stdout/stderr retained as parent evidence. Member specs run through normal Ferrum runners and retain independent child evidence directories. The parent pack result records the exact child evidence ids/directories.

Use packs when a meaningful acceptance flow includes a required build or setup phase. Do not replace an already-built target with ceremonial setup work.

## Evidence

Each step is recorded with start/end timing and failure context. Browser failures preserve a Playwright trace. Every finalized run records its exact `evidenceDir` and writes `agent-summary.json`, a compact machine-readable index beside the full `result.json`; the complete event stream remains intact.

Finalized runs are discoverable from disk through the CLI, MCP, and Workbench after the original Ferrum process exits. Replay exposes the complete retained timeline, screenshots, and file inventory without changing the evidence bundle.
