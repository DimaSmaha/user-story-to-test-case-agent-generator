#!/usr/bin/env bash
# NOT TESTED — requires live credentials; no automated test coverage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common.sh"

while [[ $# -gt 0 ]]; do
  case $1 in
    --force) shift ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

require_cmd curl
require_auth linear

PAYLOAD='{"query":"query { viewer { id } }"}'
if ! curl -sf "https://api.linear.app/graphql" \
  -H "Authorization: ${LINEAR_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" >/dev/null 2>&1; then
  emit_error "linear authentication check failed"
fi

ORG="${TRACKER_ORG:-linear}"
PROJECT="${TRACKER_PROJECT:-}"

ensure_workflow_dir
printf '{"tracker":"linear","org":"%s","project":"%s","relation_types":["related","blocks","tests","tested-by"],"generated_at":"%s"}\n' \
  "$(json_escape "$ORG")" "$(json_escape "$PROJECT")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CACHE_PATH"

printf '{"ok":true,"cached_path":"%s","tracker":"linear","org":"%s","project":"%s"}\n' \
  "$(json_escape "$CACHE_PATH")" "$(json_escape "$ORG")" "$(json_escape "$PROJECT")"

