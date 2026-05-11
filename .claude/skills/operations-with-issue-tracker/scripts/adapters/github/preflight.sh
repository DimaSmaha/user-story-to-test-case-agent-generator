#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

FORCE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) FORCE=true; shift ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

require_cmd gh
if ! gh auth status >/dev/null 2>&1; then
  emit_error "gh auth is not configured"
fi

gh_repo_args

ORG="${REPO_OWNER:-}"
PROJECT="${REPO_NAME:-}"
if [[ -z "$ORG" || -z "$PROJECT" ]]; then
  REPO_FULL="$(gh repo view "${GH_REPO_ARGS[@]}" --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
  if [[ -n "$REPO_FULL" && "$REPO_FULL" == */* ]]; then
    ORG="${REPO_FULL%/*}"
    PROJECT="${REPO_FULL#*/}"
  fi
fi

ensure_workflow_dir
if [[ "$FORCE" == true || ! -f "$CACHE_PATH" ]]; then
  printf '{"tracker":"github","org":"%s","project":"%s","relation_types":["related","duplicate","tests","tested-by"],"generated_at":"%s"}\n' \
    "$(json_escape "$ORG")" "$(json_escape "$PROJECT")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CACHE_PATH"
fi

printf '{"ok":true,"cached_path":"%s","tracker":"github","org":"%s","project":"%s"}\n' \
  "$(json_escape "$CACHE_PATH")" "$(json_escape "$ORG")" "$(json_escape "$PROJECT")"

