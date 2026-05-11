#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

TYPE=""
TITLE=""
DESCRIPTION_FILE=""
PARENT_ID=""
PARENT_RELATION=""
TAG=""
DEDUPE_BY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --type) TYPE="${2-}"; shift 2 ;;
    --title) TITLE="${2-}"; shift 2 ;;
    --description-file) DESCRIPTION_FILE="${2-}"; shift 2 ;;
    --parent) PARENT_ID="${2-}"; shift 2 ;;
    --parent-relation) PARENT_RELATION="${2-}"; shift 2 ;;
    --tag) TAG="${2-}"; shift 2 ;;
    --dedupe-by) DEDUPE_BY="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$TYPE" ]] && emit_error "missing --type"
[[ -z "$TITLE" ]] && emit_error "missing --title"

case "$TYPE" in
  "Test Case"|"User Story"|"Bug"|"Task") ;;
  *) emit_error "invalid --type; expected one of: Test Case|User Story|Bug|Task" "type" "$TYPE" ;;
esac

if [[ -n "$DEDUPE_BY" ]]; then
  case "$DEDUPE_BY" in
    title|tag|error-hash) ;;
    *) emit_error "invalid --dedupe-by; expected title|tag|error-hash" "dedupe_by" "$DEDUPE_BY" ;;
  esac
fi

if [[ -n "$DESCRIPTION_FILE" && ! -f "$DESCRIPTION_FILE" ]]; then
  emit_error "description file does not exist" "path" "$DESCRIPTION_FILE"
fi

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

ARGS=(--type "$TYPE" --title "$TITLE")
[[ -n "$DESCRIPTION_FILE" ]] && ARGS+=(--description-file "$DESCRIPTION_FILE")
[[ -n "$PARENT_ID" ]] && ARGS+=(--parent "$PARENT_ID")
[[ -n "$PARENT_RELATION" ]] && ARGS+=(--parent-relation "$PARENT_RELATION")
[[ -n "$TAG" ]] && ARGS+=(--tag "$TAG")
[[ -n "$DEDUPE_BY" ]] && ARGS+=(--dedupe-by "$DEDUPE_BY")

dispatch_to_adapter create "${ARGS[@]}"

