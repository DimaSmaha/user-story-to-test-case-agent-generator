#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

PARENT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${PARENT_DIR}/_common.sh"

ID=""
TYPE="Task"

while [[ $# -gt 0 ]]; do
  case $1 in
    --id)   ID="${2-}";   shift 2 ;;
    --type) TYPE="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"

PATH_SEGMENT="$(fake_type_to_path "$TYPE")"
URL="${FAKE_TRACKER_URL}/${PATH_SEGMENT}/${ID}"

raw="$(curl_with_retry GET "$URL")"

# Normalize to the standard get.sh contract shape.
# Fake tracker returns varying shapes; we extract what we can.
title="$(printf '%s' "$raw" | jq -r '.title // ""' 2>/dev/null || true)"
if [[ "$PATH_SEGMENT" == "testcases" ]]; then
  # Test case records have `steps` array instead of `description`
  description="$(printf '%s' "$raw" | jq -r 'if (.steps | length) > 0 then .steps | join("\n") else (.description // "") end' 2>/dev/null || true)"
else
  description="$(printf '%s' "$raw" | jq -r '.description // ""' 2>/dev/null || true)"
fi

if [[ -z "$title" ]]; then
  title="item-${ID}"
fi

escaped_title="$(json_escape "$title")"
escaped_desc="$(json_escape "$description")"
escaped_url="$(json_escape "$URL")"
escaped_type="$(json_escape "$TYPE")"

printf '{"id":%s,"type":"%s","title":"%s","description":"%s","acl":[],"parent_id":null,"url":"%s","steps_xml":"","image_urls":[]}\n' \
  "$ID" "$escaped_type" "$escaped_title" "$escaped_desc" "$escaped_url"
