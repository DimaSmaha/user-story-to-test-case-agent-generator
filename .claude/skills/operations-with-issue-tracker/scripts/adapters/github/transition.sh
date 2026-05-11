#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

ID=""
TO_STATE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    --to) TO_STATE="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"
[[ -z "$TO_STATE" ]] && emit_error "missing --to"

require_cmd gh
gh_repo_args

FROM_STATE="$(gh issue view "$ID" "${GH_REPO_ARGS[@]}" --json state --jq '.state' 2>/dev/null)" \
  || emit_error "failed to read current state" "id" "$ID"

TARGET_LC="$(printf '%s' "$TO_STATE" | tr '[:upper:]' '[:lower:]')"
DESIRED="OPEN"
case "$TARGET_LC" in
  close|closed|done|resolved) DESIRED="CLOSED" ;;
esac

CHANGED=false
if [[ "$DESIRED" == "CLOSED" && "$FROM_STATE" != "CLOSED" ]]; then
  gh issue close "$ID" "${GH_REPO_ARGS[@]}" >/dev/null 2>&1 || emit_error "failed to close issue" "id" "$ID"
  CHANGED=true
elif [[ "$DESIRED" == "OPEN" && "$FROM_STATE" == "CLOSED" ]]; then
  gh issue reopen "$ID" "${GH_REPO_ARGS[@]}" >/dev/null 2>&1 || emit_error "failed to reopen issue" "id" "$ID"
  CHANGED=true
fi

printf '{"id":%s,"from":"%s","to":"%s","changed":%s}\n' "$ID" "$(json_escape "$FROM_STATE")" "$(json_escape "$TO_STATE")" "$CHANGED"
