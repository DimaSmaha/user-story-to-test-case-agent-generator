#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

ID=""
BODY_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    --body-file) BODY_FILE="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"
[[ -z "$BODY_FILE" ]] && emit_error "missing --body-file"
[[ -f "$BODY_FILE" ]] || emit_error "body file does not exist" "path" "$BODY_FILE"

require_cmd gh
gh_repo_args

gh issue comment "$ID" "${GH_REPO_ARGS[@]}" --body-file "$BODY_FILE" >/dev/null 2>&1 \
  || emit_error "failed to post comment" "id" "$ID"

printf '{"ok":true}\n'

