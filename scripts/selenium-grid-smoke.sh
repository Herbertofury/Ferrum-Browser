#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SELENIUM_IMAGE:-selenium/standalone-chrome:4.46.0-20260707}"
NAME="ferrum-webdriver-grid-${GITHUB_RUN_ID:-local}-${RANDOM}"
RESULT_FILE="${RUNNER_TEMP:-/tmp}/ferrum-webdriver-result.json"
VERIFY_FILE="${RUNNER_TEMP:-/tmp}/ferrum-webdriver-verify.json"
ARTIFACTS_ROOT="artifacts/webdriver-grid"

cleanup() {
  mkdir -p "$ARTIFACTS_ROOT/grid"
  docker inspect "$NAME" > "$ARTIFACTS_ROOT/grid/container-inspect.json" 2>/dev/null || true
  docker logs "$NAME" > "$ARTIFACTS_ROOT/grid/selenium.log" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$ARTIFACTS_ROOT"
docker pull "$IMAGE"
docker run --detach --rm --name "$NAME" --shm-size=2g -p 4444:4444 "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 120); do
  if status="$(curl --silent --show-error --fail http://127.0.0.1:4444/status 2>/dev/null)" && \
     STATUS_JSON="$status" node -e "const s=JSON.parse(process.env.STATUS_JSON); process.exit(s?.value?.ready === false ? 1 : 0)"; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "$ready" != "1" ]]; then
  echo "Selenium Grid did not become ready" >&2
  exit 1
fi

export FERRUM_WEBDRIVER_URL="http://127.0.0.1:4444"
node ./bin/ferrum.mjs test ./examples/self-test-webdriver.json --artifacts "$ARTIFACTS_ROOT" --compact > "$RESULT_FILE"
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if(r.status!=='passed'||r.engine!=='webdriver'||!r.id) process.exit(1)" "$RESULT_FILE"
EVIDENCE_ID="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(r.id)" "$RESULT_FILE")"
node ./bin/ferrum.mjs evidence verify "$EVIDENCE_ID" --artifacts "$ARTIFACTS_ROOT" > "$VERIFY_FILE"
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if(r.status!=='passed'||!r.manifestDescriptor?.digest?.startsWith('sha256:')) process.exit(1)" "$VERIFY_FILE"
cat "$RESULT_FILE"
