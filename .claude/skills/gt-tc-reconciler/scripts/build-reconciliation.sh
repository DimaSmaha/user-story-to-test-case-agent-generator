#!/usr/bin/env bash
# build-reconciliation.sh --run-dir <dir>
# Compares existing-tcs.json against test-ideas.json.
# Writes reconciliation.json with per-scenario action and obsolete tracker IDs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPTS="$(cd "${SCRIPT_DIR}/../../operations-with-issue-tracker/scripts" && pwd)"
source "${TRACKER_SCRIPTS}/_common.sh"

RUN_DIR=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --run-dir) RUN_DIR="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$RUN_DIR" ]] && emit_error "missing --run-dir"

EXISTING_FILE="${RUN_DIR}/existing-tcs.json"
IDEAS_FILE="${RUN_DIR}/test-ideas.json"
OUT_FILE="${RUN_DIR}/reconciliation.json"

[[ -f "$EXISTING_FILE" ]] || emit_error "existing-tcs.json not found; run fetch-existing-tcs.sh first" "path" "$EXISTING_FILE"
[[ -f "$IDEAS_FILE" ]]    || emit_error "test-ideas.json not found" "path" "$IDEAS_FILE"

require_cmd jq

normalize_title() {
  local t="$1"
  t="$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')"
  t="$(printf '%s' "$t" | sed 's/^\[[^]]*\][[:space:]]*//')"  # strip [Pn]/[SKIP] prefix
  t="$(printf '%s' "$t" | tr -s '[:space:]' ' ')"
  t="$(printf '%s' "$t" | sed 's/^[[:space:][:punct:]]*//' | sed 's/[[:space:][:punct:]]*$//')"
  printf '%s' "$t"
}

us_id="$(jq -r '.us_id' "$EXISTING_FILE")"
total_existing="$(jq '.tc_count' "$EXISTING_FILE")"
total_new="$(jq 'length' "$IDEAS_FILE")"

# Build lookup: normalized_title → tracker_id
declare -A existing_map
declare -A used_ids

for (( i=0; i<total_existing; i++ )); do
  tracker_id="$(jq -r ".tcs[$i].tracker_id" "$EXISTING_FILE")"
  raw_title="$(jq -r ".tcs[$i].title" "$EXISTING_FILE")"
  norm="$(normalize_title "$raw_title")"
  existing_map["$norm"]="$tracker_id"
done

# Build scenario_matches JSON array
matches_json="["
first_match=true

for (( i=0; i<total_new; i++ )); do
  new_title="$(jq -r ".[$i].scenario" "$IDEAS_FILE")"
  norm_new="$(normalize_title "$new_title")"

  if [[ -n "${existing_map[$norm_new]+_}" ]]; then
    matched_id="${existing_map[$norm_new]}"
    used_ids["$matched_id"]=1
    entry="$(jq -n \
      --argjson idx "$i" \
      --arg title "$new_title" \
      --arg mid "$matched_id" \
      '{scenario_index:$idx,new_title:$title,matched_tracker_id:$mid,action:"update"}')"
  else
    entry="$(jq -n \
      --argjson idx "$i" \
      --arg title "$new_title" \
      '{scenario_index:$idx,new_title:$title,matched_tracker_id:null,action:"create"}')"
  fi

  if $first_match; then
    matches_json+="$entry"
    first_match=false
  else
    matches_json+=",$entry"
  fi
done
matches_json+="]"

# Build obsolete_tracker_ids: existing IDs not matched to any new scenario
obsolete_json="["
first_obsolete=true

for (( i=0; i<total_existing; i++ )); do
  tid="$(jq -r ".tcs[$i].tracker_id" "$EXISTING_FILE")"
  if [[ -z "${used_ids[$tid]+_}" ]]; then
    if $first_obsolete; then
      obsolete_json+="\"$(json_escape "$tid")\""
      first_obsolete=false
    else
      obsolete_json+=",\"$(json_escape "$tid")\""
    fi
  fi
done
obsolete_json+="]"

match_count="$(printf '%s' "$matches_json" | jq '[.[] | select(.action=="update")] | length')"
obsolete_count="$(printf '%s' "$obsolete_json" | jq 'length')"
create_count=$(( total_new - match_count ))

jq -n \
  --arg us_id "$us_id" \
  --argjson existing_tc_count "$total_existing" \
  --argjson scenario_matches "$matches_json" \
  --argjson obsolete_tracker_ids "$obsolete_json" \
  '{us_id:$us_id,existing_tc_count:$existing_tc_count,
    scenario_matches:$scenario_matches,obsolete_tracker_ids:$obsolete_tracker_ids}' \
  > "$OUT_FILE"

printf '{"status":"ok","match_count":%s,"create_count":%s,"obsolete_count":%s}\n' \
  "$match_count" "$create_count" "$obsolete_count"
