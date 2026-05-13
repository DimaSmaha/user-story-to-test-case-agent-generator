#!/usr/bin/env bash
# fetch-existing-tcs.sh --us-id <id> --run-dir <dir>
# Fetches TCs linked to a user story from the tracker.
# Writes {run_dir}/existing-tcs.json ONLY when linked TCs are found.
# Exits 0 with status="skipped" when none found or endpoint unavailable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPTS="$(cd "${SCRIPT_DIR}/../../operations-with-issue-tracker/scripts" && pwd)"
source "${TRACKER_SCRIPTS}/_common.sh"

US_ID=""
RUN_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --us-id)   US_ID="${2-}";   shift 2 ;;
    --run-dir) RUN_DIR="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$US_ID" ]]   && emit_error "missing --us-id"
[[ -z "$RUN_DIR" ]] && emit_error "missing --run-dir"

require_cmd jq
mkdir -p "$RUN_DIR"

OUT_FILE="${RUN_DIR}/existing-tcs.json"

# Resume skip
if [[ -f "$OUT_FILE" ]]; then
  tc_count="$(jq '.tc_count' "$OUT_FILE")"
  printf '{"status":"found","tc_count":%s,"path":"%s"}\n' "$tc_count" "$(json_escape "$OUT_FILE")"
  exit 0
fi

# Preflight is idempotent; gt-story-planner runs it first but re-running is safe
bash "${TRACKER_SCRIPTS}/preflight.sh" > /dev/null

raw="$(bash "${TRACKER_SCRIPTS}/get-linked-tcs.sh" --us-id "$US_ID" 2>/dev/null)" || {
  printf '{"status":"skipped","reason":"get-linked-tcs failed","tc_count":0}\n'
  exit 0
}

# verb not supported by this tracker
if [[ "$(printf '%s' "$raw" | jq -r '.skipped // false' 2>/dev/null)" == "true" ]]; then
  printf '{"status":"skipped","reason":"verb not supported by tracker","tc_count":0}\n'
  exit 0
fi

# tracker returned an error
if printf '%s' "$raw" | jq -e '.error' > /dev/null 2>&1; then
  err="$(printf '%s' "$raw" | jq -r '.error')"
  printf '{"status":"skipped","reason":"tracker error: %s","tc_count":0}\n' "$(json_escape "$err")"
  exit 0
fi

tc_count="$(printf '%s' "$raw" | jq '.tcs | length' 2>/dev/null || printf '0')"

if [[ "$tc_count" -eq 0 ]]; then
  printf '{"status":"skipped","reason":"no linked TCs found","tc_count":0}\n'
  exit 0
fi

# TCs found — write existing-tcs.json
printf '%s' "$raw" \
  | jq --arg us_id "$US_ID" --argjson tc_count "$tc_count" \
    '{us_id:$us_id, tc_count:$tc_count, tcs:.tcs}' \
  > "$OUT_FILE"

printf '{"status":"found","tc_count":%s,"path":"%s"}\n' "$tc_count" "$(json_escape "$OUT_FILE")"
