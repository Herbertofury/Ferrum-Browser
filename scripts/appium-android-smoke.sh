#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${FERRUM_APPIUM_ARTIFACTS:-artifacts/appium}"
mkdir -p "$ARTIFACT_DIR"
adb devices -l | tee "$ARTIFACT_DIR/adb-devices.txt"

appium --log "$ARTIFACT_DIR/appium-server.log" --log-level info > "$ARTIFACT_DIR/appium-stdout.log" 2>&1 &
APPIUM_PID=$!

cleanup() {
  kill "$APPIUM_PID" 2>/dev/null || true
  wait "$APPIUM_PID" 2>/dev/null || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:4723/status > "$ARTIFACT_DIR/status.json"; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  cat "$ARTIFACT_DIR/appium-server.log" || true
  exit 1
fi

node ./bin/ferrum.mjs test ./examples/self-test-appium-android.json --artifacts "$ARTIFACT_DIR/ferrum" --compact
adb shell dumpsys package com.android.settings > "$ARTIFACT_DIR/settings-package.txt"
