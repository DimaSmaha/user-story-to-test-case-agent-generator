#!/usr/bin/env bash
set -euo pipefail

# Load .env from project root if present and vars not already set
if [[ -f "${PWD}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PWD}/.env"
  set +a
fi

WORKFLOW_DIR="${WORKFLOW_ARTIFACTS_DIR:-${PWD}/.workflow-artifacts}"
CACHE_PATH="${WORKFLOW_DIR}/.tracker-cache.json"

json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

emit_error() {
  local message="${1:-unknown error}"
  shift || true
  local json
  json="{\"error\":\"$(json_escape "$message")\""
  while [[ $# -gt 1 ]]; do
    local key="$1"
    local value="$2"
    shift 2
    json+=",\"$(json_escape "$key")\":\"$(json_escape "$value")\""
  done
  json+="}"
  printf '%s\n' "$json"
  exit 1
}

emit_ok() {
  local json='{"ok":true'
  while [[ $# -gt 1 ]]; do
    local key="$1"
    local value="$2"
    shift 2
    json+=",\"$(json_escape "$key")\":\"$(json_escape "$value")\""
  done
  json+='}'
  printf '%s\n' "$json"
}

require_cmd() {
  local cmd="${1:?missing command name}"
  command -v "$cmd" >/dev/null 2>&1 || emit_error "required command not found" "command" "$cmd"
}

tracker_from_env() {
  local tracker="${ISSUE_TRACKER:-}"
  [[ -z "$tracker" ]] && emit_error "ISSUE_TRACKER is required (ado|github|jira|linear)"
  case "$tracker" in
    ado|github|jira|linear|fake) ;;
    *) emit_error "ISSUE_TRACKER must be one of: ado|github|jira|linear|fake" "value" "$tracker" ;;
  esac
  printf '%s' "$tracker"
}

require_auth() {
  local tracker="${1:-$(tracker_from_env)}"
  case "$tracker" in
    ado)
      if [[ -z "${ADO_TOKEN:-}" ]]; then
        emit_error "ADO_TOKEN is required for ISSUE_TRACKER=ado"
      fi
      ;;
    github)
      if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
        emit_error "GITHUB_TOKEN or GH_TOKEN is required for ISSUE_TRACKER=github"
      fi
      ;;
    jira)
      if [[ -z "${JIRA_BASE_URL:-}" ]]; then
        emit_error "JIRA_BASE_URL is required for ISSUE_TRACKER=jira"
      fi
      if [[ -z "${JIRA_TOKEN:-}" ]]; then
        emit_error "JIRA_TOKEN is required for ISSUE_TRACKER=jira"
      fi
      ;;
    linear)
      if [[ -z "${LINEAR_TOKEN:-}" ]]; then
        emit_error "LINEAR_TOKEN is required for ISSUE_TRACKER=linear"
      fi
      ;;
    fake)
      if [[ -z "${FAKE_TRACKER_URL:-}" ]]; then
        emit_error "FAKE_TRACKER_URL is required for ISSUE_TRACKER=fake (e.g. http://localhost:3000 or https://<ngrok>.ngrok.io)"
      fi
      ;;
  esac
}

ensure_workflow_dir() {
  mkdir -p "$WORKFLOW_DIR"
}

require_preflight() {
  local tracker="${1:-$(tracker_from_env)}"
  [[ -f "$CACHE_PATH" ]] || emit_error "preflight cache missing; run scripts/preflight.sh first" "cache_path" "$CACHE_PATH"
  if ! grep -Eiq "\"tracker\"[[:space:]]*:[[:space:]]*\"${tracker}\"" "$CACHE_PATH"; then
    emit_error "preflight cache is for a different tracker; rerun scripts/preflight.sh" "cache_path" "$CACHE_PATH" "tracker" "$tracker"
  fi
}

slug() {
  local input="${1-}"
  printf '%s' "$input" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/-\+/-/g; s/^-//; s/-$//'
}

sha1_prefix() {
  local input="${1-}"
  local length="${2:-12}"
  local hash=""
  if command -v sha1sum >/dev/null 2>&1; then
    hash="$(printf '%s' "$input" | sha1sum | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$input" | shasum -a 1 | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    hash="$(printf '%s' "$input" | openssl sha1 | awk '{print $NF}')"
  else
    hash="$(printf '%s' "$input" | tr -cd 'a-zA-Z0-9' | tr '[:upper:]' '[:lower:]')"
  fi
  printf '%s' "${hash:0:${length}}"
}

html_encode() {
  local input="${1-}"
  printf '%s' "$input" \
    | sed -e 's/&/\&amp;/g' \
          -e 's/</\&lt;/g' \
          -e 's/>/\&gt;/g' \
          -e 's/"/\&quot;/g' \
          -e "s/'/\&#39;/g"
}

md_to_html() {
  local src="${1-}"
  local markdown=""
  if [[ -f "$src" ]]; then
    markdown="$(cat "$src")"
  else
    markdown="$src"
  fi

  if command -v pandoc >/dev/null 2>&1; then
    printf '%s' "$markdown" | pandoc -f gfm -t html
    return 0
  fi

  local escaped
  escaped="$(html_encode "$markdown")"
  escaped="$(printf '%s' "$escaped" | sed ':a;N;$!ba;s/\r//g;s/\n\n/<\/p><p>/g;s/\n/<br\/>/g')"
  printf '<p>%s</p>' "$escaped"
}

is_valid_json() {
  local payload="${1-}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -e . >/dev/null 2>&1
    return $?
  fi
  printf '%s' "$payload" | grep -Eq '^[[:space:]]*[{[]'
}

normalize_json() {
  local payload="${1-}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -c .
    return 0
  fi
  printf '%s' "$payload" | tr -d '\r' | tr '\n' ' '
}
