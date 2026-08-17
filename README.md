# Ferrum

Ferrum is an **agent-native full application tester** built to make extension, browser, desktop, process, and native/mobile verification fast enough for continuous use without sacrificing real runtime fidelity or evidence.

Its first-class workload is GameSync. Ferrum can build or accept the exact unpacked Manifest V3 artifact, hash the loaded bytes, resolve the runtime extension identity, exercise foreground and service-worker behavior, capture console/network/background evidence, restart the browser with the same persistent profile, and retain a complete replayable evidence bundle.

## Verified architecture

Ferrum uses several complementary lanes instead of pretending one runtime covers everything:

- **Full Playwright Chromium** is the unpacked Manifest V3 correctness lane.
- **Chrome, Edge, Brave, and Opera GX** are additive real-browser web compatibility lanes through browser-matrix orchestration.
- **Lightpanda** is the independently pinned direct-CDP fast web lane.
- **Electron** covers real desktop application flows and the packaged Ferrum Workbench itself.
- **Appium + UiAutomator2** covers native/mobile flows through the same evidence model.
- **Process/service targets** cover CLIs, daemons, local services, and build/test helpers.

Ferrum also provides persistent authenticated **Spaces** with safe per-task cloning, deterministic selectors with recorded semantic recovery, bounded parallel suites, reproducible median/p95 benchmarks, durable replay, compact agent outputs, and MCP tools over the same core runner.

See `docs/UPSTREAMS.md` for upstream references and `docs/ROADMAP.md` for the current convergence state.

## Install

Requires Node 24+.

```bash
npm install
npx playwright install chromium
```

Lightpanda, branded system browsers, Appium drivers, and Android tooling are optional unless you use those lanes.

## Core commands

Inspect the environment:

```bash
npx ferrum doctor
```

Run a real MV3 extension workload:

```bash
npx ferrum test examples/self-test-extension.json --headless
```

Run a web workload with compact agent output while preserving full evidence on disk:

```bash
npx ferrum test examples/self-test-web.json --headless --compact
```

Run the same web workload across real discovered browsers:

```bash
npx ferrum matrix examples/self-test-web.json --browsers chromium,chrome,edge,brave,opera-gx --workers 2 --headless --compact
```

Create and clone a persistent authenticated Space:

```bash
npx ferrum spaces create bert-auth
npx ferrum spaces clone bert-auth isolated-task
```

Use a Space directly or clone it safely for concurrent work:

```bash
npx ferrum test path/to/spec.json --space bert-auth --space-mode clone --headless
```

Run a reusable production workload pack, including its real setup/build commands:

```bash
npx ferrum pack packs/gamesync-current-extension.pack.json --var GAMESYNC_REPO=/path/to/Gamesync --headless --compact
```

GameSync V2 uses its own grounded WXT pack:

```bash
npx ferrum pack packs/gamesync-next-extension.pack.json --var GAMESYNC_NEXT_REPO=/path/to/GameSync-Next --headless --compact
```

Run multiple independent specs concurrently:

```bash
npx ferrum suite examples/self-test-web.json examples/self-test-extension.json --workers 2 --headless
```

Benchmark an identical workload with machine, step-budget, success-rate, and timeout context:

```bash
npx ferrum bench path/to/benchmark-spec.json --engines chromium,lightpanda --runs 7 --warmup 1 --headless
```

Open the replay-capable Workbench:

```bash
npx ferrum dashboard
```

Inspect retained evidence after the original process has exited or restarted:

```bash
npx ferrum evidence list
npx ferrum evidence show <evidence-id>
```

Expose Ferrum to an agent over MCP stdio:

```bash
npx ferrum mcp
```

The MCP surface includes doctor, single-run, suite, browser-matrix, benchmark, workload-pack, Space, and durable-evidence tools. Compact results are the default for high-volume run operations; full evidence remains on disk and full payloads can be requested explicitly.

## Production GameSync packs

Ferrum includes separate baseline production packs for both canonical GameSync repositories:

- `packs/gamesync-current-extension.pack.json` builds the current standalone extension with its canonical `build` script (`vite build`) and verifies the resulting `dist` MV3 runtime.
- `packs/gamesync-next-extension.pack.json` builds the WXT V2 extension workspace and verifies `.output/chrome-mv3`.

Both baseline specs prove service-worker discovery, popup loading, screenshots, clean diagnostics, browser restart, rediscovery, and post-restart UI loading. Per-change GameSync acceptance should extend the appropriate baseline with the exact sites, controls, content-script paths, persistence behavior, and background interactions changed by that work. A generic baseline is never a substitute for exercising a changed feature.

## Locator recovery

Selectors and Ferrum refs remain primary. A step may define a semantic `fallback`, but Ferrum attempts it only after the deterministic locator fails. The deterministic probe is intentionally short when fallback is available, while the fallback retains the full step timeout. Every successful recovery records a `locator-fallback` evidence event so flaky or stale deterministic selectors remain visible rather than being silently hidden.

Explicit `first` or `nth` disambiguation is available when a deterministic selector legitimately matches several elements.

## Evidence and replay

Each finalized run creates a unique evidence directory containing the normalized spec, full `result.json`, compact `agent-summary.json`, timed event stream, screenshots, traces where applicable, runtime diagnostics, extension inventory/identity, Appium source/screenshots, and process output appropriate to that target.

The Workbench reads finalized evidence from disk rather than relying on process memory. Its replay view shows the full retained event timeline, screenshots, and file inventory, and the same run remains replayable after the Workbench server restarts. Evidence paths are constrained to the selected run directory.

## Desktop Workbench

Ferrum includes a real Electron desktop shell around the same local Workbench and evidence APIs. CI packages native Linux and Windows desktop bundles, launches the freshly packaged executable, exercises Doctor, a real workload, persisted evidence history, replay, screenshots, and runtime diagnostics, then uploads the tested package.

## Native/mobile

Ferrum's Appium runner implements W3C session lifecycle, element lookup/actions, text/visibility assertions, screenshots, page-source capture, failure capture, and guaranteed session cleanup. CI qualifies the lane against Android's real system Settings application in an accelerated Android emulator using pinned Appium and UiAutomator2 versions.

## Self-test

```bash
npm test
npm run smoke:web
npm run smoke:extension
npm run smoke:dashboard
npm run smoke:electron
npm run smoke:desktop
npm run package:desktop
npm run smoke:packaged-desktop
```

GitHub CI additionally exercises the browser matrix, cloned Spaces, workload-pack orchestration, Lightpanda, and the real Android/Appium lane. A passing source build alone is not treated as a passing Ferrum release; the fresh packaged desktop and real runtime lanes must pass too.
