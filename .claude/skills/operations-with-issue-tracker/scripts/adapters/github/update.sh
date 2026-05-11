#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

ID=""
SEVERITY=""
PRIORITY=""
STATE=""
TAG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --id) ID="${2-}"; shift 2 ;;
    --severity) SEVERITY="${2-}"; shift 2 ;;
    --priority) PRIORITY="${2-}"; shift 2 ;;
    --state) STATE="${2-}"; shift 2 ;;
    --tag) TAG="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$ID" ]] && emit_error "missing --id"

require_cmd gh
gh_repo_args

LABELS=()
[[ -n "$SEVERITY" ]] && LABELS+=("severity:${SEVERITY}")
[[ -n "$PRIORITY" ]] && LABELS+=("priority:${PRIORITY}")

if [[ -n "$TAG" ]]; then
  IFS=',' read -r -a TAGS <<<"$TAG"
  for tag_value in "${TAGS[@]}"; do
    cleaned="$(printf '%s' "$tag_value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$cleaned" ]] && LABELS+=("$cleaned")
  done
fi

if [[ ${#LABELS[@]} -gt 0 ]]; then
  LABEL_ARG="$(IFS=,; echo "${LABELS[*]}")"
  gh issue edit "$ID" "${GH_REPO_ARGS[@]}" --add-label "$LABEL_ARG" >/dev/null 2>&1 \
    || emit_error "failed to apply labels" "id" "$ID"
fi

if [[ -n "$STATE" ]]; then
  CURRENT_STATE="$(gh issue view "$ID" "${GH_REPO_ARGS[@]}" --json state --jq '.state' 2>/dev/null || true)"
  TARGET_STATE="$(printf '%s' "$STATE" | tr '[:upper:]' '[:lower:]')"
  case "$TARGET_STATE" in
    closed|close|done|resolved)
      if [[ "$CURRENT_STATE" != "CLOSED" ]]; then
        gh issue close "$ID" "${GH_REPO_ARGS[@]}" >/dev/null 2>&1 || emit_error "failed to close issue" "id" "$ID"
      fi
      ;;
    *)
      if [[ "$CURRENT_STATE" == "CLOSED" ]]; then
        gh issue reopen "$ID" "${GH_REPO_ARGS[@]}" >/dev/null 2>&1 || emit_error "failed to reopen issue" "id" "$ID"
      fi
      ;;
  esac
fi

UPDATED="{"
SEP=""
append_updated() {
  UPDATED+="${SEP}\"$(json_escape "$1")\":\"$(json_escape "$2")\""
  SEP=","
}
[[ -n "$SEVERITY" ]] && append_updated "severity" "$SEVERITY"
[[ -n "$PRIORITY" ]] && append_updated "priority" "$PRIORITY"
[[ -n "$STATE" ]] && append_updated "state" "$STATE"
[[ -n "$TAG" ]] && append_updated "tag" "$TAG"
UPDATED+="}"

printf '{"id":%s,"updated":%s}\n' "$ID" "$UPDATED"

