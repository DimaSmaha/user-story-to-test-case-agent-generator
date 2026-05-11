#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

TYPE=""
TITLE=""
DESCRIPTION_FILE=""
PARENT_ID=""
PARENT_RELATION="Related"
TAG=""
DEDUPE_BY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --type) TYPE="${2-}"; shift 2 ;;
    --title) TITLE="${2-}"; shift 2 ;;
    --description-file) DESCRIPTION_FILE="${2-}"; shift 2 ;;
    --parent) PARENT_ID="${2-}"; shift 2 ;;
    --parent-relation) PARENT_RELATION="${2-}"; shift 2 ;;
    --tag) TAG="${2-}"; shift 2 ;;
    --dedupe-by) DEDUPE_BY="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$TYPE" ]] && emit_error "missing --type"
[[ -z "$TITLE" ]] && emit_error "missing --title"
if [[ -n "$DESCRIPTION_FILE" && ! -f "$DESCRIPTION_FILE" ]]; then
  emit_error "description file does not exist" "path" "$DESCRIPTION_FILE"
fi

require_cmd gh
gh_repo_args

DESCRIPTION=""
[[ -n "$DESCRIPTION_FILE" ]] && DESCRIPTION="$(cat "$DESCRIPTION_FILE")"

HASH_LABEL=""
SEARCH_QUERY=""
if [[ -n "$DEDUPE_BY" ]]; then
  case "$DEDUPE_BY" in
    title)
      SEARCH_QUERY="$TITLE in:title"
      ;;
    tag)
      FIRST_TAG="$(printf '%s' "$TAG" | awk -F',' '{print $1}' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -z "$FIRST_TAG" ]] && emit_error "--dedupe-by tag requires --tag"
      SEARCH_QUERY="label:${FIRST_TAG} ${TITLE} in:title"
      ;;
    error-hash)
      HASH_LABEL="error-hash:$(sha1_prefix "${TITLE}:${TYPE}")"
      SEARCH_QUERY="label:${HASH_LABEL}"
      ;;
    *)
      emit_error "invalid --dedupe-by" "value" "$DEDUPE_BY"
      ;;
  esac
fi

if [[ -n "$SEARCH_QUERY" ]]; then
  EXISTING_ID="$(gh issue list "${GH_REPO_ARGS[@]}" --state all --search "$SEARCH_QUERY" --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || true)"
  EXISTING_URL="$(gh issue list "${GH_REPO_ARGS[@]}" --state all --search "$SEARCH_QUERY" --limit 1 --json url --jq '.[0].url // empty' 2>/dev/null || true)"
  if [[ -n "$EXISTING_ID" && -n "$EXISTING_URL" ]]; then
    printf '{"id":%s,"url":"%s","deduped":true}\n' "$EXISTING_ID" "$(json_escape "$EXISTING_URL")"
    exit 0
  fi
fi

LABELS=("$(gh_type_to_label "$TYPE")")
if [[ -n "$TAG" ]]; then
  IFS=',' read -r -a TAGS <<<"$TAG"
  for tag_value in "${TAGS[@]}"; do
    cleaned="$(printf '%s' "$tag_value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$cleaned" ]] && LABELS+=("$cleaned")
  done
fi
[[ -n "$HASH_LABEL" ]] && LABELS+=("$HASH_LABEL")

LABEL_ARG=""
if [[ ${#LABELS[@]} -gt 0 ]]; then
  LABEL_ARG="$(IFS=,; echo "${LABELS[*]}")"
fi

BODY="$DESCRIPTION"
if [[ -n "$PARENT_ID" ]]; then
  if [[ -n "$BODY" ]]; then
    BODY+=$'\n\n'
  fi
  BODY+="Parent: #${PARENT_ID} (${PARENT_RELATION})"
fi

CREATE_ARGS=(--title "$TITLE" --body "$BODY")
[[ -n "$LABEL_ARG" ]] && CREATE_ARGS+=(--label "$LABEL_ARG")

CREATE_URL="$(gh issue create "${GH_REPO_ARGS[@]}" "${CREATE_ARGS[@]}" 2>/dev/null)" || emit_error "failed to create issue"
ISSUE_ID="${CREATE_URL##*/}"

if [[ -n "$PARENT_ID" ]]; then
  gh issue comment "$ISSUE_ID" "${GH_REPO_ARGS[@]}" \
    --body "[relation:${PARENT_RELATION}:${PARENT_ID}] auto-linked parent" >/dev/null 2>&1 || true
fi

printf '{"id":%s,"url":"%s","deduped":false}\n' "$ISSUE_ID" "$(json_escape "$CREATE_URL")"

