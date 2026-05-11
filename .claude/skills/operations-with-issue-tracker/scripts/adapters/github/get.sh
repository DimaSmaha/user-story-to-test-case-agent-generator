#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

ID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done
[[ -z "$ID" ]] && emit_error "missing --id"

require_cmd gh
gh_repo_args

OUT="$(gh issue view "$ID" "${GH_REPO_ARGS[@]}" \
  --json number,title,body,url,labels \
  --jq '{
    id: .number,
    type: (
      if ([.labels[]?.name] | index("type:test-case")) then "Test Case"
      elif ([.labels[]?.name] | index("type:user-story")) then "User Story"
      elif ([.labels[]?.name] | index("type:bug")) then "Bug"
      else "Task"
      end
    ),
    title: .title,
    description: (.body // ""),
    acl: [],
    parent_id: null,
    url: .url,
    steps_xml: "",
    image_urls: []
  }' 2>/dev/null)" || emit_error "failed to fetch issue" "id" "$ID"

printf '%s\n' "$OUT"

