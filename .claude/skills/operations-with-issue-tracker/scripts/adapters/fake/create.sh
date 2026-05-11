#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

PARENT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${PARENT_DIR}/_common.sh"

TYPE=""
TITLE=""
DESCRIPTION_FILE=""
PARENT_ID=""
TAG=""
DEDUPE_BY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --type)             TYPE="${2-}";             shift 2 ;;
    --title)            TITLE="${2-}";            shift 2 ;;
    --description-file) DESCRIPTION_FILE="${2-}"; shift 2 ;;
    --parent)           PARENT_ID="${2-}";        shift 2 ;;
    --parent-relation)  shift 2 ;;  # accepted but unused by fake tracker
    --tag)              TAG="${2-}";              shift 2 ;;
    --dedupe-by)        DEDUPE_BY="${2-}";        shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$TYPE" ]]  && emit_error "missing --type"
[[ -z "$TITLE" ]] && emit_error "missing --title"

DESCRIPTION=""
if [[ -n "$DESCRIPTION_FILE" && -f "$DESCRIPTION_FILE" ]]; then
  DESCRIPTION="$(cat "$DESCRIPTION_FILE")"
fi

PATH_SEGMENT="$(fake_type_to_path "$TYPE")"
URL="${FAKE_TRACKER_URL}/${PATH_SEGMENT}/create"

# Build JSON payload
escaped_title="$(json_escape "$TITLE")"
escaped_desc="$(json_escape "$DESCRIPTION")"
escaped_tag="$(json_escape "$TAG")"
escaped_parent="$(json_escape "$PARENT_ID")"
escaped_type="$(json_escape "$TYPE")"
escaped_dedupe="$(json_escape "$DEDUPE_BY")"

if [[ "$PATH_SEGMENT" == "testcases" ]]; then
  # /testcases/create requires `steps` array, not `description`
  if [[ -n "$DESCRIPTION" ]]; then
    steps_json="$(printf '%s' "$DESCRIPTION" | jq -Rs '[split("\n")[] | select(length > 0)]')"
    [[ "$steps_json" == "[]" ]] && steps_json="[\"${escaped_title}\"]"
  else
    steps_json="[\"${escaped_title}\"]"
  fi
  payload="{\"title\":\"${escaped_title}\",\"type\":\"${escaped_type}\",\"steps\":${steps_json}"
else
  payload="{\"title\":\"${escaped_title}\",\"description\":\"${escaped_desc}\",\"type\":\"${escaped_type}\""
fi
[[ -n "$TAG" ]]       && payload+=",\"tag\":\"${escaped_tag}\""
[[ -n "$PARENT_ID" ]] && payload+=",\"parent_id\":\"${escaped_parent}\""
[[ -n "$DEDUPE_BY" ]] && payload+=",\"dedupe_by\":\"${escaped_dedupe}\""
payload+="}"

response="$(curl_with_retry POST "$URL" \
  -H "Content-Type: application/json" \
  -d "$payload")"

# Fake tracker returns {"status":"ok","data":{"id":"TEST-xxxxx",...}}
# Extract the id from data.id; fall back to 0 if missing.
tracker_id="$(printf '%s' "$response" | jq -r '.data.id // 0')"
escaped_url="$(json_escape "$URL")"
printf '{"id":"%s","url":"%s","deduped":false}\n' "$tracker_id" "$escaped_url"
