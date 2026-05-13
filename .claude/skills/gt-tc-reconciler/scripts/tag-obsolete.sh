#!/usr/bin/env bash
# tag-obsolete.sh --run-dir <dir>
# Applies claude-generated-obsolete tag to tracker IDs listed in reconciliation.json.
# Exits 0 in all cases — failures are logged but never abort the pipeline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPTS="$(cd "${SCRIPT_DIR}/../../operations-with-issue-tracker/scripts" && pwd)"
source "${TRACKER_SCRIPTS}/_common.sh"

RUN_DIR=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --run-dir) RUN_DIR="${2-}"; shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$RUN_DIR" ]] && emit_error "missing --run-dir"

RECON_FILE="${RUN_DIR}/reconciliation.json"

if [[ ! -f "$RECON_FILE" ]]; then
  printf '{"status":"skipped","reason":"reconciliation.json absent","obsolete_tagged_count":0,"obsolete_failed_count":0}\n'
  exit 0
fi

require_cmd jq

obsolete_count="$(jq '.obsolete_tracker_ids | length' "$RECON_FILE")"

if [[ "$obsolete_count" -eq 0 ]]; then
  printf '{"status":"ok","obsolete_tagged_count":0,"obsolete_failed_count":0}\n'
  exit 0
fi

tagged=0
failed=0

for (( i=0; i<obsolete_count; i++ )); do
  tid="$(jq -r ".obsolete_tracker_ids[$i]" "$RECON_FILE")"

  if bash "${TRACKER_SCRIPTS}/update.sh" \
       --id "$tid" \
       --tag "claude-generated-obsolete" > /dev/null 2>&1; then
    tagged=$(( tagged + 1 ))
  else
    printf '[WARN] tag-obsolete: failed to tag tracker ID %s — skipping\n' "$tid" >&2
    failed=$(( failed + 1 ))
  fi
done

printf '{"status":"ok","obsolete_tagged_count":%s,"obsolete_failed_count":%s}\n' "$tagged" "$failed"
