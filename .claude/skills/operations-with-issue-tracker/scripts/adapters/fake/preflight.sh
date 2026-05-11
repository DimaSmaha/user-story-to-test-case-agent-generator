#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

PARENT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${PARENT_DIR}/_common.sh"

WORKFLOW_DIR="${WORKFLOW_ARTIFACTS_DIR:-${PWD}/.workflow-artifacts}"
CACHE_PATH="${WORKFLOW_DIR}/.tracker-cache.json"

ensure_workflow_dir

response="$(curl -sf "${FAKE_TRACKER_URL}/" 2>/dev/null || true)"

if [[ -z "$response" ]]; then
  emit_error \
    "fake tracker not reachable at ${FAKE_TRACKER_URL} — start the server or set FAKE_TRACKER_URL to the correct ngrok URL" \
    "url" "${FAKE_TRACKER_URL}"
fi

cache="{\"ok\":true,\"tracker\":\"fake\",\"base_url\":\"${FAKE_TRACKER_URL}\"}"
printf '%s\n' "$cache" > "$CACHE_PATH"
printf '%s\n' "$cache"
