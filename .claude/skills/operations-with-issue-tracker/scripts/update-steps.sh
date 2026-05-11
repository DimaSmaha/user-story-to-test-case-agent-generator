#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

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

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

ARGS=(--id "$ID" --steps-file "$STEPS_FILE")
[[ "$REPLACE" == true ]] && ARGS+=(--replace)
dispatch_to_adapter update-steps "${ARGS[@]}"

