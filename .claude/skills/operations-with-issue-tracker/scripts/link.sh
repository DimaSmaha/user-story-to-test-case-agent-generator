#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

SOURCE_ID=""
TARGET_ID=""
RELATION_TYPE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --source) SOURCE_ID="${2-}"; shift 2 ;;
    --target) TARGET_ID="${2-}"; shift 2 ;;
    --type) RELATION_TYPE="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$SOURCE_ID" ]] && emit_error "missing --source"
[[ -z "$TARGET_ID" ]] && emit_error "missing --target"
[[ -z "$RELATION_TYPE" ]] && emit_error "missing --type"

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

dispatch_to_adapter link --source "$SOURCE_ID" --target "$TARGET_ID" --type "$RELATION_TYPE"

