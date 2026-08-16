# Ferrum handoff

Ferrum's canonical target is `Herbertofury/Ferrum-Browser` on `main`. Repository source is authoritative. Older Aether, Hypergraph, and other Library archives are reference material only and must never be promoted over current repository source without independent verification.

## Current verified checkpoint

Ferrum 0.2.0 product code at `f39636f89f5b68af38e1dafb87e589b7c77657ab` passed GitHub Actions run `31964361536` across all four required lanes: unit/syntax/MCP, Lightpanda, Ubuntu Chromium, and Windows Chromium. The three downloaded evidence archives were independently SHA-256 checked against GitHub's recorded artifact digests.

Both Chromium operating systems loaded the exact same MV3 fixture bytes with SHA-256 `57024706eed1b4dc2f07ab0f343a0bbc0524bf10c43fb7a2c810c4ddb8bebebb`, resolved runtime extension ID `felmepoiflfponlkemhjaadagpppepgf` from the actual service worker, successfully exercised popup to background messaging, captured screenshots, restarted Chromium using the same persistent profile, rediscovered the same extension, repeated messaging successfully after restart, and finished with zero runtime errors. The after-restart screenshots were visually inspected and show the runtime ID returned by the worker.

Lightpanda 0.3.7 is a real additive fast lane. CI downloads the official Linux x86_64 release and checks SHA-256 `895339b02205171a181dde743ae0068bb4564884076feac8482baca9c212aa5a` before use. Ferrum drives it directly through Lightpanda's native CDP server rather than through Playwright. The verified smoke exercised open, compact snapshot, click, text assertion, and clean runtime diagnostics with no errors.

## Architecture that must not regress

Full Chromium remains the extension correctness lane. Lightpanda is a faster web/agent lane and never substitutes for Chromium-specific behavior. Ferrum also implements Electron, generic process/service, and Appium targets under the same evidence model, but the Electron and Appium lanes still require qualification against real target applications before being described as fully runtime verified.

Ferrum supports unique immutable evidence folders, exact extension build inventories, runtime identity, persistent profiles, restart proof, screenshots and Playwright traces where visual Chromium is used, runtime diagnostics, compact agent refs/actions, bounded parallel suites, repeated median/p95 benchmarks, a local workbench, and MCP tools for doctor, single-run, suite, and benchmark operations.

## Failures that must not be repeated

Do not use Playwright's reduced default headless shell as proof of MV3 extension behavior. Headless extension runs must use the full `chromium` channel unless a future replacement is independently proven equivalent.

Do not wrap Lightpanda navigation in Playwright's Chromium lifecycle model. That timed out even when Lightpanda itself was healthy. Use Ferrum's native direct-CDP Lightpanda adapter.

Do not let performance work reduce test steps, runtime fidelity, diagnostics, evidence, target coverage, or output quality. Do not allow parallel runs to share an evidence directory. Preserve explicit benchmark settings such as warmup zero exactly.

## GameSync operating rule

For every applicable GameSync extension bug fix, performance proposal, stack proposal, or behavior/build change, Ferrum is a mandatory full end-to-end acceptance layer. Load the exact newly built unpacked extension, record its SHA-256/runtime identity, exercise the affected real workflow plus background/service-worker/content-script paths where applicable, inspect available console/network/service-worker diagnostics, repeat meaningful use, reload/restart the browser, verify persistence and loaded-build identity, and retain the evidence bundle. Isolated Opera GX fresh/restart testing remains additional compatibility coverage rather than a substitute.

When GameSync testing exposes Ferrum friction that is generalizable, improve Ferrum at the reusable boundary, regression-test Ferrum, then rerun GameSync rather than routing around the tester. The GameSync Bug Sync automation may merge a verified Ferrum correctness fix only after Ferrum's exact-head unit plus Linux and Windows Chromium web/MV3 restart gates pass. Ferrum Performance and Stack proposals remain advisory for manual review.
