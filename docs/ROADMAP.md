# Ferrum roadmap

Ferrum 0.2 has converged from a tester-first prototype into a cross-runtime agent acceptance platform. The original completion tracks are now implemented in the product and are retained as regression obligations rather than future placeholders.

## Shipped completion tracks

1. **GameSync production workload packs**: separate grounded packs exist for the current GameSync extension and GameSync V2. Packs run real setup/build commands, retain parent and child evidence, and support explicit variables so agents do not hard-code machine-specific repository paths. Future GameSync changes still require feature-specific overlays that exercise the exact changed sites and behavior.
2. **Extension worker observability**: Chromium records service-worker console, worker-owned requests/responses/failures, interception and lifecycle evidence, with assertions before and after restart.
3. **Browser matrix orchestration**: Chromium, Chrome, Edge, Brave and Opera GX are discoverable real-browser targets. Full Chromium remains the unpacked MV3 correctness lane; branded browsers add web compatibility coverage without weakening that rule.
4. **Isolated Spaces**: persistent browser profiles can be created, locked, cloned per task, reused for authenticated state, and safely isolated for concurrent work.
5. **Reproducible benchmarking**: median/p95 results include machine/runtime metadata, workload and step budgets, success rate, timeout accounting, warmup failures, and per-sample evidence directories.
6. **Durable replay**: the Workbench renders retained event timelines, screenshots and files from immutable evidence on disk and proves replay survives a Workbench restart.
7. **Semantic locator recovery**: deterministic selectors/refs always run first; semantic fallback is additive, receives the full timeout after a short deterministic probe, and every recovery is retained as explicit test friction.
8. **Native/mobile Appium**: the W3C runner captures source/screenshots and is qualified in CI against Android's real system Settings application using Appium + UiAutomator2 on an emulator.
9. **Packaged desktop Workbench**: Ferrum packages native Linux and Windows Electron bundles and acceptance-tests each fresh package through its real Doctor, workload, evidence-history and replay flow before publication.

## Ongoing evidence-driven evolution

Ferrum should continue improving only where real workloads expose material friction. Current ongoing directions are not deferred basic functionality; they are continuous hardening and expansion:

- add feature/site-specific GameSync workload overlays whenever a PR changes externally observable behavior;
- broaden branded-browser and OS qualification when new environments are available, while retaining Chromium MV3 fidelity;
- add deeper protocol/runtime diagnostics when a real failure cannot be localized with the current evidence;
- improve Space cloning, orchestration and benchmark efficiency when measured workloads show avoidable cost;
- harden desktop/native adapters as additional production applications and devices become available;
- keep agent interfaces compact and stable while preserving the full evidence bundle and deterministic control primitives.

A new roadmap item should represent a concrete capability gap observed in real use, with an acceptance flow that can be verified. Naming, cosmetic features, or wrappers do not count as Ferrum progress.
