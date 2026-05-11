#!/usr/bin/env bash
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${ADAPTER_DIR}/../.." && pwd)"
source "${SCRIPTS_DIR}/_common.sh"

gh_repo_args() {
  GH_REPO_ARGS=()
  if [[ -n "${TRACKER_REPO:-}" ]]; then
    GH_REPO_ARGS=(--repo "${TRACKER_REPO}")
  elif [[ -n "${REPO_OWNER:-}" && -n "${REPO_NAME:-}" ]]; then
    GH_REPO_ARGS=(--repo "${REPO_OWNER}/${REPO_NAME}")
  fi
}

gh_type_to_label() {
  case "${1:-Task}" in
    "Test Case") printf 'type:test-case' ;;
    "User Story") printf 'type:user-story' ;;
    "Bug") printf 'type:bug' ;;
    *) printf 'type:task' ;;
  esac
}

gh_normalized_type_jq() {
  cat <<'EOF'
if ([.labels[]?.name] | index("type:test-case")) then "Test Case"
elif ([.labels[]?.name] | index("type:user-story")) then "User Story"
elif ([.labels[]?.name] | index("type:bug")) then "Bug"
else "Task" end
EOF
}
