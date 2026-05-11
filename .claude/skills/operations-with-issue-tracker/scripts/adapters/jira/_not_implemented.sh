#!/usr/bin/env bash
# NOT TESTED — requires live credentials; no automated test coverage.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common.sh"

VERB="${1:-unknown}"
emit_error "jira adapter verb is not implemented yet" "tracker" "jira" "verb" "$VERB"

