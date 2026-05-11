#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

ID=""
TYPE=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --id)   ID="${2-}";   shift 2 ;;
    --type) TYPE="${2-}"; shift 2 ;;
    *)
      if [[ -z "$ID" ]]; then
        ID="$1"
        shift
      else
        emit_error "unknown argument: $1"
      fi
      ;;
  esac
done

if [[ -z "$ID" ]]; then
  emit_error "missing id; use get.sh --id <item-id>"
fi

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

DISPATCH_ARGS=(--id "$ID")
[[ -n "$TYPE" ]] && DISPATCH_ARGS+=(--type "$TYPE")
dispatch_to_adapter get "${DISPATCH_ARGS[@]}"

