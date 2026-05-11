#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

QUERY=""
LIMIT="25"

while [[ $# -gt 0 ]]; do
  case $1 in
    --query) QUERY="${2-}"; shift 2 ;;
    --limit) LIMIT="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] || emit_error "--limit must be numeric" "limit" "$LIMIT"
[[ -z "$QUERY" ]] && QUERY="is:issue"

require_cmd gh
gh_repo_args

OUT="$(gh issue list "${GH_REPO_ARGS[@]}" \
  --state all \
  --search "$QUERY" \
  --limit "$LIMIT" \
  --json number,title,url,state,labels \
  --jq '{
    results: map({
      id: .number,
      type: (
        if ([.labels[]?.name] | index("type:test-case")) then "Test Case"
        elif ([.labels[]?.name] | index("type:user-story")) then "User Story"
        elif ([.labels[]?.name] | index("type:bug")) then "Bug"
        else "Task"
        end
      ),
      title: .title,
      state: .state,
      url: .url
    }),
    count: length
  }' 2>/dev/null)" || emit_error "query failed"

printf '%s\n' "$OUT"

