#!/usr/bin/env bash
# get-linked-tcs.sh --us-id <id>
# Returns test cases linked to a user story as {tcs:[{tracker_id,title,url},...]}
# Non-fake trackers fall back to _not_implemented.sh -> {"ok":true,"skipped":true}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"
source "${SCRIPT_DIR}/_dispatch.sh"

US_ID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --us-id) US_ID="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$US_ID" ]] && emit_error "missing --us-id"

TRACKER="$(tracker_from_env)"
require_auth "$TRACKER"
require_preflight "$TRACKER"

dispatch_to_adapter get-linked-tcs --us-id "$US_ID"
