#!/usr/bin/env bash
# generate-tc.sh  --ideas-file <path> --index <n> --run-dir <dir> [--us-id <id>]
# Deterministic (no-LLM) conversion of one test-ideas.json scenario into:
#   tc-steps-<n>.md   — numbered step/expected table (Markdown)
#   tc-steps-<n>.xml  — same data as XML CDATA steps
#   tc-<n>.json       — full tc artifact for gt-spec-writer
# Also uploads the test case to the tracker via create.sh.
# Outputs tc-<n>.json content on stdout (for chaining).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPTS="$(cd "${SCRIPT_DIR}/../../operations-with-issue-tracker/scripts" && pwd)"

# Load env (handles .env sourcing via _common.sh)
source "${TRACKER_SCRIPTS}/_common.sh"

IDEAS_FILE=""
INDEX=""
RUN_DIR=""
US_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --ideas-file) IDEAS_FILE="${2-}"; shift 2 ;;
    --index)      INDEX="${2-}";      shift 2 ;;
    --run-dir)    RUN_DIR="${2-}";    shift 2 ;;
    --us-id)      US_ID="${2-}";      shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$IDEAS_FILE" ]] && emit_error "missing --ideas-file"
[[ -z "$INDEX" ]]      && emit_error "missing --index"
[[ -z "$RUN_DIR" ]]    && emit_error "missing --run-dir"
[[ ! -f "$IDEAS_FILE" ]] && emit_error "ideas file not found" "path" "$IDEAS_FILE"

require_cmd jq
mkdir -p "$RUN_DIR"

# --- Resume check ---
TC_JSON="${RUN_DIR}/tc-${INDEX}.json"
if [[ -f "$TC_JSON" ]]; then
  cat "$TC_JSON"
  exit 0
fi

# --- Extract scenario ---
scenario_json="$(jq -c ".[$INDEX]" "$IDEAS_FILE")"
[[ "$scenario_json" == "null" ]] && emit_error "no scenario at index ${INDEX}" "index" "$INDEX"

title="$(jq -r '.scenario' <<< "$scenario_json")"
idea_count="$(jq '.ideas | length' <<< "$scenario_json")"

# Prefer explicit us_id from flag, then from ideation output
[[ -z "$US_ID" ]] && US_ID="$(jq -r '.us_id // "manual"' <<< "$scenario_json")"

# --- Generate MD ---
MD_FILE="${RUN_DIR}/tc-steps-${INDEX}.md"
{
  printf '# %s\n\n' "$title"
  for ((i=0; i<idea_count; i++)); do
    idea="$(jq -r ".ideas[$i]" <<< "$scenario_json")"
    verification="$(jq -r ".verifications[$i] // empty" <<< "$scenario_json")"
    printf 'Step %d: %s\n' "$((i+1))" "$idea"
    [[ -n "$verification" ]] && printf '  Expected: %s\n' "$verification"
    printf '\n'
  done
} > "$MD_FILE"

# --- Generate XML ---
XML_FILE="${RUN_DIR}/tc-steps-${INDEX}.xml"
{
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<steps>\n'
  for ((i=0; i<idea_count; i++)); do
    idea="$(jq -r ".ideas[$i]" <<< "$scenario_json")"
    verification="$(jq -r ".verifications[$i] // empty" <<< "$scenario_json")"
    printf '  <step index="%d">\n' "$((i+1))"
    printf '    <action><![CDATA[%s]]></action>\n' "$idea"
    printf '    <expected><![CDATA[%s]]></expected>\n' "$verification"
    printf '  </step>\n'
  done
  printf '</steps>\n'
} > "$XML_FILE"

# --- Reconciliation check ---
RECON_FILE="${RUN_DIR}/reconciliation.json"
matched_tracker_id=""
action="create"

if [[ -f "$RECON_FILE" ]]; then
  action="$(jq -r --argjson idx "$INDEX" \
    '.scenario_matches[] | select(.scenario_index == $idx) | .action // "create"' \
    "$RECON_FILE" 2>/dev/null || printf 'create')"
  matched_tracker_id="$(jq -r --argjson idx "$INDEX" \
    '.scenario_matches[] | select(.scenario_index == $idx) | .matched_tracker_id // ""' \
    "$RECON_FILE" 2>/dev/null || printf '')"
  # guard: if action=update but id is missing or null string, fall back to create
  if [[ "$action" == "update" && ( -z "$matched_tracker_id" || "$matched_tracker_id" == "null" ) ]]; then
    action="create"
  fi
fi

# --- Upload to tracker ---
# Run preflight (idempotent — re-running is safe)
bash "${TRACKER_SCRIPTS}/preflight.sh" > /dev/null

reused="false"
if [[ "$action" == "update" ]]; then
  if bash "${TRACKER_SCRIPTS}/update-steps.sh" \
       --id "$matched_tracker_id" \
       --steps-file "$XML_FILE" \
       --replace > /dev/null 2>&1 \
     && bash "${TRACKER_SCRIPTS}/update.sh" \
          --id "$matched_tracker_id" \
          --tag "claude-generated,claude-generated-modified" > /dev/null 2>&1; then
    tracker_id="\"${matched_tracker_id}\""
    deduped="true"
    reused="true"
  else
    printf '[WARN] generate-tc: update failed for %s — falling back to create\n' "$matched_tracker_id" >&2
    action="create"
  fi
fi

if [[ "$action" == "create" ]]; then
  create_response="$(bash "${TRACKER_SCRIPTS}/create.sh" \
    --type "Test Case" \
    --title "$title" \
    --description-file "$MD_FILE" \
    --parent "$US_ID" \
    --tag "automated,claude-generated" \
    --dedupe-by title)"
  tracker_id="$(jq '.id' <<< "$create_response")"
  deduped="$(jq '.deduped' <<< "$create_response")"
  reused="false"
fi

# --- Write tc.json ---
local_id="tc-$(date +%s)-${RANDOM}"

jq -n \
  --arg id "$local_id" \
  --argjson tracker_id "$tracker_id" \
  --argjson deduped "$deduped" \
  --argjson reused "$reused" \
  --arg title "$title" \
  --arg us_id "$US_ID" \
  --arg xml_path "$XML_FILE" \
  --arg md_path "$MD_FILE" \
  --argjson index "$INDEX" \
  --argjson scenario "$scenario_json" \
  '{
    id: $id,
    tracker_id: $tracker_id,
    title: $title,
    parent_us_id: $us_id,
    steps_xml_path: $xml_path,
    steps_md_path: $md_path,
    scenario_index: $index,
    scenario: $scenario.scenario,
    conditions: ($scenario.conditions // []),
    ideas: ($scenario.ideas // []),
    verifications: ($scenario.verifications // []),
    navigations: ($scenario.navigations // []),
    ac_trace: ($scenario.ac_trace // []),
    reusable_helpers: ($scenario.reusable_helpers // []),
    deduped: $deduped,
    reused: $reused
  }' > "$TC_JSON"

cat "$TC_JSON"
