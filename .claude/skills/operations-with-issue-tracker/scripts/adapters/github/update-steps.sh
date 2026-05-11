#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

ID=""
STEPS_FILE=""
REPLACE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    --steps-file) STEPS_FILE="${2-}"; shift 2 ;;
    --replace) REPLACE=true; shift ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"
[[ -z "$STEPS_FILE" ]] && emit_error "missing --steps-file"
[[ -f "$STEPS_FILE" ]] || emit_error "steps file does not exist" "path" "$STEPS_FILE"

require_cmd gh
gh_repo_args

CURRENT_BODY="$(gh issue view "$ID" "${GH_REPO_ARGS[@]}" --json body --jq '.body // ""' 2>/dev/null || true)"
if [[ "$REPLACE" == true ]]; then
  CURRENT_BODY="$(printf '%s' "$CURRENT_BODY" | sed '/^### Test Steps (generated)$/,$d')"
fi

STEPS_XML="$(cat "$STEPS_FILE")"
NEW_BODY="$CURRENT_BODY"
if [[ -n "$NEW_BODY" ]]; then
  NEW_BODY+=$'\n\n'
fi
NEW_BODY+="### Test Steps (generated)"
NEW_BODY+=$'\n```xml\n'
NEW_BODY+="$STEPS_XML"
NEW_BODY+=$'\n```'

gh issue edit "$ID" "${GH_REPO_ARGS[@]}" --body "$NEW_BODY" >/dev/null 2>&1 \
  || emit_error "failed to update test steps" "id" "$ID"

printf '{"ok":true}\n'

