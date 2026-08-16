# Ferrum roadmap

The current source is the first real tester-first implementation. Priority order for future work is evidence-driven:

1. GameSync production workload packs for both repositories and every supported site/feature path changed by a PR.
2. Direct CDP target inspector for service-worker console/network logs across every extension target.
3. Browser matrix orchestration for Chromium, Opera GX, Chrome, Edge and Brave without weakening the Chromium sideload correctness lane.
4. Built-in benchmark runner compatible with the Lightpanda agent-benchmarks methodology, including fixed tool budgets and median/p95/timeout reporting.
5. Isolated parallel test Spaces with persistent authenticated profiles and safe per-task cloning.
6. Session replay viewer for trace, screenshots, console, network and step timeline in the dashboard.
7. Semantic locator fallback inspired by Stagehand only after deterministic selectors/refs fail, with every fallback recorded as test friction.
8. Native desktop adapters hardened through Appium platform drivers and platform-specific accessibility bridges.
9. Ferrum packaged desktop shell after the tester core is proven, without replacing the full-fidelity external Chromium runtime used for extension correctness.
