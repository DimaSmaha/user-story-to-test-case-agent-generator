#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

SOURCE_ID=""
TARGET_ID=""
RELATION_TYPE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --source) SOURCE_ID="${2-}"; shift 2 ;;
    --target) TARGET_ID="${2-}"; shift 2 ;;
    --type) RELATION_TYPE="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$SOURCE_ID" ]] && emit_error "missing --source"
[[ -z "$TARGET_ID" ]] && emit_error "missing --target"
[[ -z "$RELATION_TYPE" ]] && emit_error "missing --type"

require_cmd gh
gh_repo_args

MARKER="[relation:${RELATION_TYPE}:${TARGET_ID}]"
EXISTED="$(gh issue view "$SOURCE_ID" "${GH_REPO_ARGS[@]}" --json comments \
  --jq --arg marker "$MARKER" '[.comments[]?.body | contains($marker)] | any' 2>/dev/null || echo false)"

if [[ "$EXISTED" == "true" ]]; then
  printf '{"ok":true,"existed":true}\n'
  exit 0
fi

gh issue comment "$SOURCE_ID" "${GH_REPO_ARGS[@]}" \
  --body "${MARKER} linked to #${TARGET_ID}" >/dev/null 2>&1 \
  || emit_error "failed to add relation comment" "source" "$SOURCE_ID" "target" "$TARGET_ID"

printf '{"ok":true,"existed":false}\n'

