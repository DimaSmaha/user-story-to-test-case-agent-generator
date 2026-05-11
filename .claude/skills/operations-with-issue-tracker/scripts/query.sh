#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

QUERY=""
LIMIT="25"

while [[ $# -gt 0 ]]; do
  case $1 in
    --query) QUERY="${2-}"; shift 2 ;;
    --limit) LIMIT="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] || emit_error "--limit must be an integer" "limit" "$LIMIT"

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

ARGS=(--limit "$LIMIT")
[[ -n "$QUERY" ]] && ARGS+=(--query "$QUERY")
dispatch_to_adapter query "${ARGS[@]}"

