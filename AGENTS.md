# Ferrum execution contract

Ferrum is a real application-testing workbench. Every visible control and every CLI command must exercise real implementation paths.

## Non-negotiable behavior

- Preserve complete test coverage, evidence, browser fidelity, app behavior, and supported target types when optimizing.
- Never fake a browser result, extension result, screenshot, console record, network result, service-worker result, restart result, or success state.
- Extension verification must load the exact unpacked build, record its directory digest, resolve its runtime extension ID, exercise the configured web/content-script and extension-page paths, restart the browser with the same profile, and confirm the extension returns.
- Keep full-fidelity Chromium tests as the correctness lane. Lightpanda is an additional fast lane, never a replacement where Chromium-only behavior is under test.
- A failed test must preserve its evidence bundle and error details.
- Performance changes require before/after measurements using the same workload and may not reduce data, steps, fidelity, diagnostics, or target coverage.
- Improvements discovered while testing another project should be implemented in Ferrum when they materially improve test speed, reliability, observability, or agent control, then regression-tested before reuse.

## Canonical checks

`npm test`

With Playwright Chromium installed:

`npm run smoke:web`

`npm run smoke:extension`
