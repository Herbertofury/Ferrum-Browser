# Ferrum handoff

Ferrum's canonical target is `Herbertofury/Ferrum-Browser` on `main`. Repository source is authoritative. Older Aether, Hypergraph, and other Library archives are reference material only and must never be promoted over current repository source without independent verification.

## Current verified checkpoint

Ferrum 0.2.0 product code at `536bbc23dfee068e26eda8b32574f06ce19a43f1` passed GitHub Actions run `31987413168` on 2026-08-17 across unit/syntax/MCP, Lightpanda, Ubuntu Chromium, Windows Chromium, the real Chromium Workbench, Manifest V3 restart testing, and real Electron applications on both operating systems. The durable memory commits after that product checkpoint only update `.agents-memory/**`, which is excluded from product CI.

The unit lane passed the complete Node test suite, whole-module syntax checking, and MCP surface smoke. New regression coverage now exercises service-worker diagnostics, compact CLI evidence output, compact-by-default MCP responses with an explicit full-output escape hatch, and benchmark machine/workload/reliability metadata.

Both Chromium operating systems load the real MV3 fixture, exercise popup-to-worker messaging, require the extension service worker to make a real request, capture worker console plus worker-owned request/response/failure/interception evidence, assert those diagnostic counters, restart Chromium using the same persistent profile, rediscover the extension, repeat the messaging path, and repeat the worker diagnostic proof after restart. Page, worker, HTTP, request, screenshot, and trace evidence remain unified under the same run bundle.

The visible Ferrum Workbench remains part of the acceptance gate on Ubuntu and Windows. CI exercises the real browser-facing Doctor/spec/Headless/Run/result workflow rather than treating those controls as presentation-only UI.

Electron is now runtime-qualified instead of implementation-only. Ferrum launches a real Electron application with context isolation and a preload bridge, records Electron/Chrome/Node runtime identity, captures main-process console and process streams, observes renderer diagnostics, clicks the renderer control, verifies the renderer-to-preload-to-main IPC result, captures a screenshot, and closes cleanly. This path passes on Ubuntu and Windows.

Agent-facing output is now cheaper without losing evidence. Successful runs carry the exact `evidenceDir`, every finalized bundle contains the full `result.json` plus compact `agent-summary.json`, CLI supports compact output, and MCP run/suite/benchmark tools return compact actionable results by default. MCP callers can request `fullOutput: true` when they need the complete event stream. Compactness changes serialization only; it does not reduce steps, diagnostics, target coverage, fidelity, or stored evidence.

Benchmarks now retain median/p95 timing and additionally report host platform/release/architecture, Node/V8, CPU model/count, total memory, workload name/type, steps per run, requested/successful/failed runs, success rate, timeout count, warmup failures, attempted/completed measured step budgets, and per-sample evidence directories. This makes cross-host agent performance comparisons materially more reproducible.

Lightpanda 0.3.7 remains a real additive fast lane. CI downloads the official Linux x86_64 release and checks SHA-256 `895339b02205171a181dde743ae0068bb4564884076feac8482baca9c212aa5a` before use. Ferrum drives it directly through Lightpanda's native CDP server rather than through Playwright.

## Historical byte-verified evidence retained

The earlier product checkpoint `b94902e34db716ffc88395909108901cd4de415a` in GitHub Actions run `31964792142` was independently round-tripped from GitHub artifacts. The downloaded Linux, Windows, and Lightpanda archives exactly matched provider digests: Linux `9b7230a88f23b939f0719a1e5cfc6bba83b27ed60c6c827c34a4d641ea407a6f`, Windows `d677c0519a0d262e85b6312544c3d9e8029cadaa0e7bff0b1fcb0fa913c27502`, and Lightpanda `146fc1bd68ed559300909465bc6ed7964d9ba37843cde2f33114cb41a1e7d672`.

At that historical checkpoint, both Chromium systems loaded identical MV3 fixture bytes with SHA-256 `57024706eed1b4dc2f07ab0f343a0bbc0524bf10c43fb7a2c810c4ddb8bebebb`, resolved runtime extension ID `felmepoiflfponlkemhjaadagpppepgf`, passed restart/messaging proof, and finished with zero runtime errors. Linux and Windows Workbench screenshots and post-restart popup screenshots were visually inspected. Keep these hashes labeled as historical byte-verified evidence; do not relabel them as artifact hashes from newer runs unless a newer artifact is independently downloaded and hashed.

## Architecture that must not regress

Full Chromium remains the extension correctness lane. Lightpanda is a faster web/agent lane and never substitutes for Chromium-specific behavior. Electron is now a verified real-app lane on Ubuntu and Windows. Generic process/service is verified. Appium exists under the same evidence model but still requires qualification against a real native/mobile target before being described as fully runtime verified.

Ferrum supports unique immutable evidence folders, exact extension build inventories, runtime identity, persistent profiles, restart proof, screenshots and Playwright traces where visual Chromium is used, page and service-worker runtime diagnostics, compact agent refs/actions, bounded parallel suites, reproducible benchmark metadata, a real Chromium Workbench, and MCP tools for doctor, single-run, suite, and benchmark operations.

## Failures that must not be repeated

Do not use Playwright's reduced default headless shell as proof of MV3 extension behavior. Headless extension runs must use the full `chromium` channel unless a future replacement is independently proven equivalent.

Do not wrap Lightpanda navigation in Playwright's Chromium lifecycle model. That timed out even when Lightpanda itself was healthy. Use Ferrum's native direct-CDP Lightpanda adapter.

Do not let performance or agent-context work reduce test steps, runtime fidelity, diagnostics, evidence, target coverage, output quality, or stored event detail. Compact outputs are indexes into the full evidence, not replacements for it. Do not allow parallel runs to share an evidence directory. Preserve explicit benchmark settings such as warmup zero exactly.

Do not treat Workbench controls as decorative. Doctor, spec selection/input, Headless, Run, and visible run status are real product promises and are click-tested on Linux and Windows. Missing static assets must produce truthful 404 responses rather than contaminating browser diagnostics with server 500s.

Do not describe the Appium lane as verified until a real native/mobile application plus device/emulator/server path has been exercised end-to-end and retained evidence proves the session.

## GameSync operating rule

For every applicable GameSync extension bug fix, performance proposal, stack proposal, or behavior/build change, Ferrum is a mandatory full end-to-end acceptance layer. Load the exact newly built unpacked extension, record its SHA-256/runtime identity, exercise the affected real workflow plus background/service-worker/content-script paths where applicable, inspect available console/network/service-worker diagnostics, repeat meaningful use, reload/restart the browser, verify persistence and loaded-build identity, and retain the evidence bundle. Isolated Opera GX fresh/restart testing remains additional compatibility coverage rather than a substitute.

When GameSync testing exposes Ferrum friction that is generalizable, improve Ferrum at the reusable boundary, regression-test Ferrum, then rerun GameSync rather than routing around the tester. The GameSync Bug Sync automation may merge a verified Ferrum correctness fix only after Ferrum's exact-head unit plus Linux and Windows Chromium web/MV3 restart gates pass. Ferrum Performance and Stack proposals remain advisory for manual review.

## Next high-value development tracks

Turn real GameSync workflows into reusable production workload packs. Expand exact runtime qualification across Chrome, Edge, Brave, and Opera GX. Add isolated parallel Spaces/profile cloning for authenticated concurrent work. Build a session replay/evidence viewer. Add semantic locator recovery as an additive fallback above deterministic selectors. Qualify Appium against a real native/mobile target. Continue improving Ferrum at reusable boundaries whenever real agent or GameSync work exposes measurable speed, reliability, observability, setup, orchestration, or coverage friction.
