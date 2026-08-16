# Ferrum handoff

Ferrum's canonical target is `Herbertofury/Ferrum-Browser` on `main`. The repository implementation is the source of truth. Older Ferrum Aether/Hypergraph/other Library archives may be inspected for useful ideas but must not be trusted or copied forward without independent verification.

The current architecture is tester-first: Playwright Chromium persistent contexts are the full-fidelity browser/extension lane; Lightpanda is an optional fast web lane; compact agent snapshots/actions and MCP provide low-round-trip control; Electron, generic process/service and Appium runners extend the same evidence model to non-extension apps.

For GameSync extension work, Ferrum is a mandatory acceptance layer. Load the exact new unpacked build, record its SHA-256 inventory and runtime extension ID, exercise the affected real workflow plus background/service-worker and content-script behavior where applicable, inspect runtime diagnostics, restart the browser using the same profile, and confirm the exact build returns. Opera GX and other browser-specific tests remain additional compatibility coverage, not a replacement.

Treat avoidable testing friction as Ferrum work. If a real project test is slow, flaky, hard to observe or impossible because Ferrum lacks a general capability, improve Ferrum at the narrowest reusable boundary, regression-test Ferrum, then rerun the project workload. Never gain speed by reducing steps, evidence, data, fidelity or target coverage.
