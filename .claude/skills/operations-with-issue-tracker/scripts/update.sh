#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

ID=""
SEVERITY=""
PRIORITY=""
STATE=""
TAG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    --severity) SEVERITY="${2-}"; shift 2 ;;
    --priority) PRIORITY="${2-}"; shift 2 ;;
    --state) STATE="${2-}"; shift 2 ;;
    --tag) TAG="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"
if [[ -z "$SEVERITY" && -z "$PRIORITY" && -z "$STATE" && -z "$TAG" ]]; then
  emit_error "at least one update field is required (--severity|--priority|--state|--tag)"
fi

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

ARGS=(--id "$ID")
[[ -n "$SEVERITY" ]] && ARGS+=(--severity "$SEVERITY")
[[ -n "$PRIORITY" ]] && ARGS+=(--priority "$PRIORITY")
[[ -n "$STATE" ]] && ARGS+=(--state "$STATE")
[[ -n "$TAG" ]] && ARGS+=(--tag "$TAG")

dispatch_to_adapter update "${ARGS[@]}"

