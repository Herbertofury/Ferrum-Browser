# Upstream reference map

Ferrum uses these projects as design and interoperability references, not as code copied wholesale.

- Lightpanda: https://github.com/lightpanda-io/browser
  - fast non-Chromium headless engine, CDP, native agent/MCP, PandaScript ideas.
- Vercel agent-browser: https://github.com/vercel-labs/agent-browser
  - fast native CLI, stable refs, batching, sessions, CDP-oriented agent control.
- Ego Lite: https://github.com/citrolabs/ego-lite
  - isolated agent Spaces, code-composed actions, real-browser end-to-end test discipline.
- Lightpanda agent benchmarks: https://github.com/lightpanda-io/agent-benchmarks
  - fixed-workload comparisons, strict tool isolation, duration/timeout evidence.
- Browserless: https://github.com/browserless/browserless
  - browser session infrastructure, queueing, persistent sessions, debug/replay patterns.
- Browserbase Stagehand: https://github.com/browserbase/stagehand
  - deterministic locators plus higher-level observe/act/extract and self-healing fallback.
- Playwright: https://github.com/microsoft/playwright
  - current full-fidelity browser/Electron automation foundation.

Ferrum's rule is to keep deterministic low-level automation primary and use semantic recovery as a fallback, so AI convenience never hides a broken exact workflow.


## Competing tools and differentiation
Source review: **2026-11-12**. This extends the upstream map, rather than creating a second competing catalog.

| Tool | Source-backed role | Ferrum comparison target |
| --- | --- | --- |
| [Playwright](https://playwright.dev/) | Browser automation/test runner, traces and agent interfaces | Baseline foundation; measure Ferrum orchestration overhead and evidence completeness on identical browser steps. |
| [Selenium](https://www.selenium.dev/) | W3C WebDriver browser automation | Interoperability, remote failures, lifecycle cleanup and diagnostic parity. |
| [Stagehand](https://github.com/browserbase/stagehand) | Higher-level browser interaction and extraction SDK | Locator failure/recovery, reproducibility, cost and retained explanation versus deterministic-first execution. |

### Proposed differentiators requiring evidence
One replayable evidence model across extension, web, desktop, native/mobile and process targets; exact loaded-artifact identity; persistent-profile restart verification; compact agent output without deleting raw evidence. These are evaluation objectives grounded in this repository's documented architecture, not a fresh claim that every lane is accepted.

- [ ] Pin matched tool/browser versions and run the same application acceptance workload.
- [ ] Report success rate, false-success rate, retries, wall time, p95 latency, CPU/memory and evidence size.
- [ ] Include MV3 service-worker restart, auth-safe cloned sessions, stale locators and failed-process cleanup.
- [ ] Preserve full Chromium fidelity; a faster non-Chromium result cannot substitute for extension correctness.
- [ ] Verify replay after process restart and preserve failed runs. No speed win counts if evidence or coverage is reduced.

## Evidence and refresh rules
Review official release notes, documentation and issue trackers daily when the scheduled review runs. Record the source URL, check date, version/commit, relevant change, user impact and next experiment; retain last-good information and mark inaccessible sources. No change is a valid result. A scheduled review is not continuous monitoring.

This is a source-backed research shortlist, **not a head-to-head benchmark or a claim of feature/performance superiority**. Before recommending adoption, compare the current application and candidate on the same real workloads, machine, versions and correctness requirements. Retain raw timings, p50/p95 latency, CPU/memory, failures and rollback evidence. Check licensing and privacy before reuse; an open repository does not grant unrestricted reuse. New features remain proposals until approved, implemented and accepted.
