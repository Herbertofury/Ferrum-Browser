#!/usr/bin/env bash
set -euo pipefail

IMAGE="${SELENIUM_IMAGE:-selenium/standalone-chrome:4.47.0-20260808}"
NAME="ferrum-webdriver-grid-${GITHUB_RUN_ID:-local}-${RANDOM}"
RESULT_FILE="${RUNNER_TEMP:-/tmp}/ferrum-webdriver-result.json"
VERIFY_FILE="${RUNNER_TEMP:-/tmp}/ferrum-webdriver-verify.json"
ARTIFACTS_ROOT="artifacts/webdriver-grid"
GRID_ROOT="$ARTIFACTS_ROOT/grid"

cleanup() {
  mkdir -p "$GRID_ROOT"
  docker inspect "$NAME" > "$GRID_ROOT/container-inspect.json" 2>/dev/null || true
  docker logs "$NAME" > "$GRID_ROOT/selenium.log" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$ARTIFACTS_ROOT"
mkdir -p "$GRID_ROOT"
docker pull "$IMAGE"
docker image inspect "$IMAGE" > "$GRID_ROOT/image-inspect.json"

IMAGE_REF="$IMAGE" IMAGE_INSPECT_FILE="$GRID_ROOT/image-inspect.json" IMAGE_IDENTITY_FILE="$GRID_ROOT/image-identity.json" node <<'NODE'
const fs = require('fs');
const [image] = JSON.parse(fs.readFileSync(process.env.IMAGE_INSPECT_FILE, 'utf8'));
if (!image || typeof image !== 'object') throw new Error('Missing Docker image inspect payload');
if (!/^sha256:[0-9a-f]{64}$/.test(image.Id || '')) throw new Error(`Invalid Docker image ID: ${image.Id || '<missing>'}`);
const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
if (!repoDigests.some((value) => /@sha256:[0-9a-f]{64}$/.test(value))) {
  throw new Error(`Docker image has no immutable repository digest: ${process.env.IMAGE_REF}`);
}
if (!image.Os || !image.Architecture) throw new Error('Docker image OS/architecture identity is incomplete');
const identity = {
  requestedRef: process.env.IMAGE_REF,
  imageId: image.Id,
  repoDigests,
  os: image.Os,
  architecture: image.Architecture
};
fs.writeFileSync(process.env.IMAGE_IDENTITY_FILE, `${JSON.stringify(identity, null, 2)}\n`);
NODE

docker run --detach --rm --name "$NAME" --shm-size=2g -p 4444:4444 "$IMAGE" >/dev/null
docker inspect "$NAME" > "$GRID_ROOT/container-start-inspect.json"

IMAGE_IDENTITY_FILE="$GRID_ROOT/image-identity.json" CONTAINER_INSPECT_FILE="$GRID_ROOT/container-start-inspect.json" node <<'NODE'
const fs = require('fs');
const image = JSON.parse(fs.readFileSync(process.env.IMAGE_IDENTITY_FILE, 'utf8'));
const [container] = JSON.parse(fs.readFileSync(process.env.CONTAINER_INSPECT_FILE, 'utf8'));
if (!container || container.Image !== image.imageId) {
  throw new Error(`Selenium Grid container image mismatch: expected ${image.imageId}, observed ${container?.Image || '<missing>'}`);
}
NODE

ready=0
for _ in $(seq 1 120); do
  if status="$(curl --silent --show-error --fail http://127.0.0.1:4444/status 2>/dev/null)" && \
     STATUS_JSON="$status" node -e "const s=JSON.parse(process.env.STATUS_JSON); process.exit(s?.value?.ready === false ? 1 : 0)"; then
    printf '%s\n' "$status" > "$GRID_ROOT/status.json"
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
