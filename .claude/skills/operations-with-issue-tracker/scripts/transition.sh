#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

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

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

dispatch_to_adapter transition --id "$ID" --to "$TO_STATE"
