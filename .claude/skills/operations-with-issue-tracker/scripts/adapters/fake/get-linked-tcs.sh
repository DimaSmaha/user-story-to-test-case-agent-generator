#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

PARENT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${PARENT_DIR}/_common.sh"

US_ID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --us-id) US_ID="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$US_ID" ]] && emit_error "missing --us-id"

URL="${FAKE_TRACKER_URL}/tasks/${US_ID}/linked-tc"

raw="$(curl_with_retry GET "$URL" -H "Accept: application/json")" || {
  printf '{"tcs":[]}\n'
  exit 0
}

tcs_json="$(printf '%s' "$raw" | jq -c '
  if type == "array" then
    {tcs: [.[] | {tracker_id: (.id // ""), title: (.title // ""), url: (.url // "")}]}
  elif (.data != null) and ((.data | type) == "array") then
    {tcs: [.data[] | {tracker_id: (.id // ""), title: (.title // ""), url: (.url // "")}]}
  elif (.linked_tcs != null) and ((.linked_tcs | type) == "array") then
    {tcs: [.linked_tcs[] | {tracker_id: (.id // ""), title: (.title // ""), url: (.url // "")}]}
  elif (.tcs != null) and ((.tcs | type) == "array") then
    .
  else
    {tcs: []}
  end
' 2>/dev/null)" || {
  printf '{"tcs":[]}\n'
  exit 0
}

printf '%s\n' "$tcs_json"
