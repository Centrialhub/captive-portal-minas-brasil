#!/usr/bin/env bash
set -euo pipefail

for command in npm node docker curl git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FAIL: required command '$command' is unavailable."
    exit 1
  fi
done

for lockfile in bun.lock bun.lockb yarn.lock pnpm-lock.yaml; do
  if [[ -e "$lockfile" ]]; then
    echo "FAIL: $lockfile exists; package-lock.json must be the only package-manager lock."
    exit 1
  fi
done

required_env=(
  VITE_SUPABASE_URL
  VITE_SUPABASE_PUBLISHABLE_KEY
  COMMIT_SHA
  CONCURRENCY_TEST_URL
  CONCURRENCY_TEST_PAYLOAD
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED
  UNIFI_CREDENTIALS_ROTATED
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "FAIL: $name is required for the release gate."
    exit 1
  fi
done

if [[ "$COMMIT_SHA" == "unknown" || "$COMMIT_SHA" == "dev" ]]; then
  echo "FAIL: COMMIT_SHA must identify the release source."
  exit 1
fi
if [[ ! "$COMMIT_SHA" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]]; then
  echo "FAIL: COMMIT_SHA must be a full 40- or 64-character hexadecimal Git revision."
  exit 1
fi
if [[ "$UNIFI_CREDENTIALS_ROTATED" != "true" ]]; then
  echo "FAIL: UNIFI_CREDENTIALS_ROTATED=true is required after rotating the compromised credential."
  exit 1
fi
if [[ "$SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED" != "true" ]]; then
  echo "FAIL: enable leaked-password protection in Supabase Auth and set SUPABASE_LEAKED_PASSWORD_PROTECTION_ENABLED=true."
  exit 1
fi

source_sha="$(git rev-parse HEAD)"
if [[ "$source_sha" != "$COMMIT_SHA" ]]; then
  echo "FAIL: COMMIT_SHA does not match the checked-out source ($source_sha)."
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FAIL: the release source contains uncommitted or untracked files."
  exit 1
fi

echo "[1/6] Clean npm install"
npm ci

echo "[2/6] Dependency audit"
npm audit --audit-level=high

echo "[3/6] Source, migration, Edge Function, test, and build checks"
npm run check

echo "[4/6] Atomic concurrency integration test"
node scripts/verify-concurrency.mjs

image_tag="minas-brasil-wifi:${COMMIT_SHA}"
container_name="minas-brasil-wifi-release-${COMMIT_SHA:0:12}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ -n "${header_file:-}" ]]; then
    rm -f "$header_file"
  fi
}
trap cleanup EXIT

echo "[5/6] Reproducible Docker build (includes nginx -t)"
docker build \
  --build-arg "VITE_SUPABASE_URL=$VITE_SUPABASE_URL" \
  --build-arg "VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY" \
  --build-arg "GIT_SHA=$COMMIT_SHA" \
  --build-arg "COMMIT_SHA=$COMMIT_SHA" \
  --tag "$image_tag" \
  .

echo "[6/6] Container health/readiness smoke test"
docker run --detach --rm --name "$container_name" --publish 127.0.0.1:18080:80 "$image_tag" >/dev/null
for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:18080/ready >/dev/null; then
    break
  fi
  sleep 1
done

curl --fail --silent http://127.0.0.1:18080/health | grep -qx "ok"
curl --fail --silent http://127.0.0.1:18080/ready | grep -qx "ready"
curl --fail --silent http://127.0.0.1:18080/ >/dev/null
curl --fail --silent http://127.0.0.1:18080/build-info.json | grep -q "$COMMIT_SHA"

header_file="$(mktemp)"
curl --fail --silent --dump-header "$header_file" --output /dev/null http://127.0.0.1:18080/
for header in \
  strict-transport-security \
  content-security-policy \
  x-content-type-options \
  x-frame-options \
  referrer-policy \
  permissions-policy; do
  if ! grep -qi "^${header}:" "$header_file"; then
    echo "FAIL: production image is missing the $header security header."
    exit 1
  fi
done

echo "ALL RELEASE GATES PASSED."
