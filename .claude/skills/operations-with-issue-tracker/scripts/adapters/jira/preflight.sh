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
require_auth jira

AUTH_ARGS=()
if [[ -n "${JIRA_EMAIL:-}" ]]; then
  AUTH_ARGS=(-u "${JIRA_EMAIL}:${JIRA_TOKEN}")
else
  AUTH_ARGS=(-H "Authorization: Bearer ${JIRA_TOKEN}")
fi

if ! curl -sf "${AUTH_ARGS[@]}" -H "Accept: application/json" \
  "${JIRA_BASE_URL%/}/rest/api/3/myself" >/dev/null 2>&1; then
  emit_error "jira authentication check failed"
fi

ORG="${TRACKER_ORG:-${JIRA_BASE_URL:-}}"
PROJECT="${TRACKER_PROJECT:-${JIRA_PROJECT_KEY:-}}"

ensure_workflow_dir
printf '{"tracker":"jira","org":"%s","project":"%s","relation_types":["Relates","Blocks","Tests","Tested By"],"generated_at":"%s"}\n' \
  "$(json_escape "$ORG")" "$(json_escape "$PROJECT")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CACHE_PATH"

printf '{"ok":true,"cached_path":"%s","tracker":"jira","org":"%s","project":"%s"}\n' \
  "$(json_escape "$CACHE_PATH")" "$(json_escape "$ORG")" "$(json_escape "$PROJECT")"

