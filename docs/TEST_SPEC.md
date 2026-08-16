# Ferrum test spec v1

A test is a JSON document with `version`, `name`, `target`, optional timeouts/artifacts, and ordered `steps`.

Supported targets:

- `web`: Chromium or Lightpanda.
- `extension`: unpacked Manifest V3 extension in a persistent Chromium profile.
- `electron`: an Electron application driven with Playwright.
- `process`: an arbitrary process or service with captured logs and optional health URL.
- `appium`: a native/mobile application reachable through an Appium WebDriver server.

Common browser steps include `open`, `wait`, `click`, `fill`, `press`, `snapshot`, `screenshot`, `assert-text`, `assert-visible`, `assert-url`, `evaluate`, `vitals`, and `assert-console-clean`.

Extension-only steps include `extension-page`, `assert-service-worker`, and `restart`.

Each step is recorded with start/end timing and failure context. Browser failures preserve a Playwright trace.
