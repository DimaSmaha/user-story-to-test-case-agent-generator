#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

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

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

dispatch_to_adapter comment --id "$ID" --body-file "$BODY_FILE"

