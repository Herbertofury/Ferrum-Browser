---
name: evidence-acceptance
description: Qualify Ferrum tester changes against exact target identity, immutable complete evidence, correct runtime lanes, restart/persistence and matched performance workloads.
---

# Ferrum evidence acceptance

Use for runtime adapters, CLI/MCP, evidence storage, failure diagnostics, packaged desktop verification or performance work. Read root `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/TEST_SPEC.md`, and the relevant checked-in examples/tests first.

## Bound the subject and lane

Record source commit, exact workload/spec, runtime versions, artifact/extension digest, browser channel and profile identity. Read `package.json` for current engines and commands rather than copying version assumptions from historical PRs. Inspect open work before changing a shared adapter or benchmark.

- Use full Chromium for MV3/content scripts, extension pages, workers, permission and persistent-profile tests. Lightpanda is an additional compatible web lane, never equivalent proof for Chromium behavior.
- Electron source tests do not prove the packaged desktop executable; test the actual packaged artifact and its identity separately.
- Process stdin pipes do not imply TTY/curses support. Appium/native mobile and WebDriver require their actual endpoints/platform drivers; record absent prerequisites explicitly.
- Do not make a web, process or other independent lane require an unrelated optional target installation. Test missing-adapter and unsupported-target errors, not only successful startup.

## Preserve complete evidence

1. Run `npm test`; inspect the affected tests and add regressions for the real failure boundary. Existing `tests/evidence-store.test.mjs`, `tests/evidence-id-containment.test.mjs`, `tests/evidence-trace.test.mjs` and `tests/evidence-timing.test.mjs` provide storage/integrity coverage.
2. Retain normalized spec, result, events, traces/screenshots, diagnostics and target identity for both success and failure. Check same-name/concurrent runs get distinct evidence IDs and containment checks reject escaping paths.
3. Verify manifest descriptors against actual payload bytes and streaming SHA-256. Exercise missing/tampered/truncated files, nested paths and multi-chunk payloads; complete enumeration must not be reduced to make tests faster.
4. Treat screenshots, worker diagnostics, logs and network events as evidence only when captured from the real target. Synthetic fixtures are useful regression inputs, not native acceptance.
5. Use isolated profiles and non-sensitive fixtures. Avoid credentials in variables, stdin, screenshots or retained logs: even when Ferrum records only input length, the target may echo input to stdout/stderr. Do not publish private evidence bundles.

## Runtime regressions

With actual Playwright Chromium installed, run `npm run smoke:web` and `npm run smoke:extension`. The extension run must record exact unpacked-build digest, resolve runtime extension ID, exercise web/content-script and extension-page paths, then restart with the same profile and confirm recovery. Include worker console/network diagnostics before and after restart; do not accept a UI-only screenshot as proof of worker health.

Choose additional scripts from current `package.json` for affected surfaces: offline/recovery, snapshot deltas, service fixture, dashboard, Electron or packaged desktop. Exercise repeated actions and interrupted navigation/close/restart paths. Keep failure evidence when a target or environment blocks a gate.

## Performance and delivery

Compare before/after with identical workload, versions, evidence completeness and target fidelity. Include warmups, alternating run order where practical, sample count, median/p95, correctness equality and small/large cases. A faster file microbenchmark alone is not proof of faster complete manifest write/verify or whole application acceptance.

Report local tests, exact-head hosted checks, artifact publication and fresh native acceptance separately. Verify the remote commit/tree before claiming delivery, and preserve active branch-only proposals without silently promoting their changes. No browser matrix reduction, skipped diagnostics, fake success or unmeasured superiority claim to get green results.
