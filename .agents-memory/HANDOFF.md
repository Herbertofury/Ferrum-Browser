# Ferrum handoff

Ferrum's canonical target is `Herbertofury/Ferrum-Browser` on `main`. Repository source is authoritative. Older Aether, Hypergraph, and Library archives are reference material only and must never replace current repository source without independent verification.

## Current verified product checkpoint

Ferrum 0.2.0 product code at `d76744e8add89dc099695b700762f5cf91a956e8` passed GitHub Actions run `32003270111` on 2026-08-17. This is the verified product commit even if `main` later contains a memory-only `.agents-memory/**` checkpoint commit. The workflow completed successfully across all five jobs: unit/syntax/shell/MCP, Lightpanda, Ubuntu full runtime, Windows full runtime, and real Android/Appium.

The exact head passed web smoke, cloned Space isolation, MV3 extension restart coverage, workload-pack orchestration, replay-capable Workbench smoke, generic Electron, source desktop Workbench, native desktop packaging, and a smoke of the freshly packaged desktop executable on both Linux and Windows. Windows additionally passed the full required Chromium, Chrome, Edge, Brave, and Opera GX browser matrix without skipping a browser.

Appium is now runtime-qualified. Ferrum used Appium 3.6.0 with UiAutomator2 8.4.0 against an accelerated Android 15 emulator and the real system Settings application. The retained evidence proves W3C session creation, real element lookup and visibility/text use, navigation into a Settings detail page, page-source capture, screenshots before/detail/return, back navigation, and deterministic session cleanup. Appium server readiness and session creation use the declared startup budget rather than the shorter per-step budget.

## Current byte-verified publication evidence

GitHub Actions run `32003270111` published the tested product artifacts. The Linux desktop artifact `9279151828` is 131,033,072 bytes with provider SHA-256 `216c378a97e2f9c3e5221b402124e1722b938e167d62c9695f7d633256cca016`. It was independently downloaded, hashed to the same digest, passed a full ZIP integrity test, and contains `Ferrum-linux-x64/Ferrum`.

The Windows desktop artifact `9279216434` is 151,526,282 bytes with provider SHA-256 `42166f7b44ac8415ccf257f6370b72208d9c1d07f50846da8e0dd62241606fea`. It was independently downloaded, hashed to the same digest, passed a full ZIP integrity test, and contains `Ferrum-win32-x64/Ferrum.exe`.

The Windows evidence artifact `9279211226` is 1,860,916 bytes with provider SHA-256 `48adbeaf09e872f0d3d077290af038585117b05e6c575f623969121c8a34be22`; the downloaded archive matched the same digest and passed ZIP integrity. The Appium evidence artifact `9279171480` is 120,819 bytes with provider SHA-256 `e82400f107d7e60b591b78274e77169a6898b659493967d78c2327102e037832`; its downloaded archive matched exactly, passed ZIP integrity, and contains `appium-session.json`, the Settings detail XML source, `result.json`, and the `settings-home`, `settings-detail`, and `settings-returned` screenshots.

The final Windows evidence has zero `electron-force-close` events and zero `electron-shutdown-warning` events. Opera GX records one bounded `browser-teardown-warning` because its vendor startup page did not close within 10 seconds. This is explicitly retained rather than hidden: diagnostics are isolated from the workload page, the Opera GX workload passed, the five-browser matrix passed 5/5, final browser context teardown completed, and the warning did not affect product acceptance.

## Shipped control plane and runtime architecture

Full Chromium remains the unpacked MV3 correctness lane. Chrome, Edge, Brave, and Opera GX are additive real-browser web compatibility lanes. Lightpanda 0.3.7 remains the pinned direct-CDP fast lane. Electron covers generic real desktop applications plus the Ferrum Workbench. Appium covers native/mobile W3C workflows. Generic process/service targets cover CLIs and services.

Persistent Spaces support safe cloned isolation and locking for authenticated/profile-based work. Deterministic selectors remain primary, with explicit semantic fallback only after deterministic failure and a retained `locator-fallback` evidence event. Legitimate multi-match selectors can explicitly choose `first` or `nth`.

Browser matrix lanes are isolated in killable worker processes. Browser launch, vendor startup-page close, trace stop, context close, and force-close paths are bounded and evidence-visible. This prevents Chrome-family runtimes from holding the control plane indefinitely while preserving the required browser set.

Electron targets also execute behind a killable worker boundary. The Workbench desktop server closes idle/all connections during shutdown, Electron close is bounded, and Windows Workbench startup waits for the first real Electron window before main-process runtime identity is queried. These safeguards fixed the Windows lifecycle deadlocks and the asynchronous identity race without weakening the Workbench workflow.

Durable evidence replay reads finalized evidence from disk, survives Workbench restart, exposes the complete retained event timeline, screenshots, and file inventory, and constrains reads to the selected evidence directory. CLI and MCP expose the same durable evidence, Spaces, matrix, workload-pack, suite, benchmark, and run primitives over the shared core.

Production workload packs are grounded against both canonical GameSync repositories. `packs/gamesync-current-extension.pack.json` targets `Herbertofury/Gamesync`, invokes the canonical `npm run build`, and verifies the resulting `dist` MV3 runtime. `packs/gamesync-next-extension.pack.json` targets `Herbertofury/GameSync-Next` and verifies its WXT `.output/chrome-mv3` output. Baseline packs are not substitutes for change-specific GameSync workflow acceptance.

## Resolved failures that must not be reintroduced

Do not use a nonexistent `build:extension` command for standalone GameSync. The canonical repository exposes `npm run build`.

Do not let Android emulator-runner interpret a compound multiline shell loop as separate commands. The real Appium lane uses `scripts/appium-android-smoke.sh`, which is shell-syntax checked in CI.

Do not allow `noReset` to leave Android Settings in the background. The qualified fixture uses `appium:forceAppLaunch`.

Do not apply the short per-step timeout to Appium session creation. UiAutomator2 installation/startup can exceed 20 seconds; server readiness and `POST /session` use `startupMs`.

Do not let any branded browser or Electron runtime leak hold the parent runner indefinitely. Browser matrix and Electron targets have process isolation plus bounded lifecycle operations.

Do not diagnose Opera GX's vendor startup page as if it were the workload page. Startup surfaces are isolated and bounded; workload diagnostics remain scoped to the real page under test.

Do not query Workbench Electron main-process identity before its asynchronous dashboard startup produces the first real window. Identity capture occurs after `firstWindow()`.

Do not weaken MV3, browser, replay, packaging, desktop, Appium, or evidence gates to make CI pass. The final product checkpoint was accepted with all required lanes present.

## GameSync operating rule

For every applicable GameSync extension bug fix, performance proposal, stack proposal, or behavior/build change, Ferrum is the mandatory full end-to-end acceptance layer. Build the exact changed extension, load the exact unpacked artifact, retain SHA-256/runtime identity, exercise the affected user flow and background/service-worker/content-script paths where applicable, inspect diagnostics, repeat meaningful use, reload/restart as appropriate, verify persistence and loaded-build identity, and keep the evidence bundle.

When GameSync testing exposes general Ferrum friction, repair Ferrum at the reusable boundary, regression-test Ferrum, and rerun the GameSync flow rather than routing around the tester.

## Final closeout state

GitHub issues #1 (standalone GameSync pack build command) and #2 (Windows/Opera GX matrix stall) are closed as completed with verification comments pointing to product commit `d76744e8add89dc099695b700762f5cf91a956e8` and workflow run `32003270111`.

The hostile audit on the final product head found no repository TODO markers, no FIXME markers, and no common private-key, GitHub token, or API-key marker matches. Compared with the previous verified product checkpoint `536bbc23dfee068e26eda8b32574f06ce19a43f1`, the final product is 21 commits ahead with no deleted files. No product blockers remain.

Future Ferrum changes should preserve this checkpoint's breadth and only advance the verified product SHA after the changed exact head again clears the relevant real-runtime and artifact gates.
