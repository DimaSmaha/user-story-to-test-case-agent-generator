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

require_cmd az
require_auth ado

ORG="${TRACKER_ORG:-${REPO_OWNER:-}}"
PROJECT="${TRACKER_PROJECT:-${ADO_PROJECT:-${REPO_NAME:-}}}"

ensure_workflow_dir
printf '{"tracker":"ado","org":"%s","project":"%s","relation_types":["System.LinkTypes.Related","System.LinkTypes.Hierarchy-Forward","Microsoft.VSTS.Common.Tests","Microsoft.VSTS.Common.TestedBy-Reverse"],"generated_at":"%s"}\n' \
  "$(json_escape "$ORG")" "$(json_escape "$PROJECT")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CACHE_PATH"

printf '{"ok":true,"cached_path":"%s","tracker":"ado","org":"%s","project":"%s"}\n' \
  "$(json_escape "$CACHE_PATH")" "$(json_escape "$ORG")" "$(json_escape "$PROJECT")"

