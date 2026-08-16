# Ferrum architecture

Ferrum is a tester-first browser and application control plane. It does not attempt to replace Chromium's rendering engine.

## Execution lanes

1. **Chromium fidelity lane**: Playwright persistent Chromium contexts. This is the mandatory lane for Chrome/Chromium extension behavior, MV3 workers, content scripts, extension pages, permissions, restart and profile persistence. Headless extension runs use Playwright's full `chromium` channel rather than the reduced headless shell.
2. **Lightpanda speed lane**: Lightpanda CDP session for web workloads where a headless DOM/JavaScript engine is sufficient. Ferrum CI downloads the pinned upstream release, verifies its published SHA-256, starts the real CDP server, then runs a Ferrum interaction smoke through it. This lane is never used as proof for Chromium-only behavior.
3. **Electron lane**: Playwright `_electron` connects Ferrum's existing step engine to Electron applications.
4. **Process lane**: launches any CLI/service/desktop process, captures stdout/stderr, optional health checks, exit status and evidence.
5. **Appium lane**: speaks W3C WebDriver directly to an Appium endpoint for native/mobile targets when the platform driver is available.

## Orchestration

`ferrum suite` runs independent specs with bounded concurrency. Every run receives a unique evidence ID, including same-name specs launched in the same millisecond.

`ferrum bench` repeats an identical workload with explicit warmup/run counts and reports median/p95 timing. Web-compatible specs can compare `chromium,lightpanda` without changing the workload itself.

## Agent surface

Ferrum snapshots visible/actionable DOM nodes into compact stable refs and supports click/fill/key/navigation/wait operations. The CLI exposes an MCP stdio server with doctor, single-run, suite and benchmark tools. The design follows the low-round-trip ideas proven useful by agent-browser and Ego Lite while keeping deterministic Playwright/CDP paths underneath.

## Evidence model

Every run creates an immutable timestamped folder containing the normalized spec, result JSON, event stream, screenshots where supported, traces, runtime diagnostics, and target identity. Extension runs additionally store a SHA-256 file inventory and the resolved runtime extension ID. A restart step closes the browser, relaunches the same profile, resolves the extension again, and records proof.

## Extension correctness rule

Ferrum's own Playwright Chromium is preferred for unpacked extension testing because branded Chrome channels increasingly restrict command-line extension sideloading. Opera/Chrome/Edge/Brave can still be attached as extra compatibility lanes when they are launched in a testable configuration.

## Continuous improvement loop

Friction is treated as a tester defect when the target app itself is healthy. When a project test exposes slow discovery, weak diagnostics, flaky selectors, missing target coverage, evidence collisions, unnecessary agent round trips or slow orchestration, improve Ferrum, regression-test Ferrum itself, then rerun the project workload. Performance improvements may not reduce evidence or test scope.
