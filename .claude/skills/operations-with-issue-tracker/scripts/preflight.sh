#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

FORCE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --force) FORCE=true; shift ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"

ARGS=()
[[ "$FORCE" == true ]] && ARGS+=(--force)
dispatch_to_adapter preflight "${ARGS[@]}"
