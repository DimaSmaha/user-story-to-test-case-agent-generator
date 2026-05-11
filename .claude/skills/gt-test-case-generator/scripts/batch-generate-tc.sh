#!/usr/bin/env bash
# batch-generate-tc.sh
#   --ideas-file <path>      required
#   --run-dir    <dir>       required
#   --us-id      <id>        optional
#   --max-retries <n>        optional  default 3
#   --retry-delay <seconds>  optional  default 5 (doubled on each retry)
#
# Generates tc-N.json for every scenario in test-ideas.json.
# Skips indices where tc-N.json already exists (resume-safe).
# Retries only the tracker upload step on TMS failures; local file
# generation is not retried (it is deterministic and fast).
# Exits 0 even when individual scenarios fail — prints a summary table.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRACKER_SCRIPTS="$(cd "${SCRIPT_DIR}/../../operations-with-issue-tracker/scripts" && pwd)"
source "${TRACKER_SCRIPTS}/_common.sh"

# ── defaults ────────────────────────────────────────────────────────────────
IDEAS_FILE=""
RUN_DIR=""
US_ID=""
MAX_RETRIES=3
RETRY_DELAY=5

while [[ $# -gt 0 ]]; do
  case $1 in
    --ideas-file)   IDEAS_FILE="${2-}";   shift 2 ;;
    --run-dir)      RUN_DIR="${2-}";      shift 2 ;;
    --us-id)        US_ID="${2-}";        shift 2 ;;
    --max-retries)  MAX_RETRIES="${2-}";  shift 2 ;;
    --retry-delay)  RETRY_DELAY="${2-}";  shift 2 ;;
    *) emit_error "unknown argument: $1" ;;
  esac
done

[[ -z "$IDEAS_FILE" ]] && emit_error "missing --ideas-file"
[[ -z "$RUN_DIR" ]]    && emit_error "missing --run-dir"
[[ ! -f "$IDEAS_FILE" ]] && emit_error "ideas file not found" "path" "$IDEAS_FILE"

require_cmd jq

total="$(jq 'length' "$IDEAS_FILE")"
[[ "$total" -eq 0 ]] && emit_error "test-ideas.json is empty" "path" "$IDEAS_FILE"

mkdir -p "$RUN_DIR"

# ── per-scenario retry wrapper ───────────────────────────────────────────────
# Calls generate-tc.sh for one index.
# On tracker failure (non-zero exit) retries up to MAX_RETRIES with
# exponential back-off starting at RETRY_DELAY seconds.
# Returns 0 on success, 1 after all retries exhausted.
run_with_retry() {
  local index="$1"
  local attempt=1
  local delay="$RETRY_DELAY"

  local extra_args=()
  [[ -n "$US_ID" ]] && extra_args+=(--us-id "$US_ID")

  while [[ $attempt -le $((MAX_RETRIES + 1)) ]]; do
    if bash "${SCRIPT_DIR}/generate-tc.sh" \
         --ideas-file "$IDEAS_FILE" \
         --index      "$index" \
         --run-dir    "$RUN_DIR" \
         "${extra_args[@]}" > /dev/null 2>&1; then
      return 0
    fi

    if [[ $attempt -gt $MAX_RETRIES ]]; then
      return 1
    fi

    echo "  [retry ${attempt}/${MAX_RETRIES}] scenario ${index} — waiting ${delay}s before next attempt" >&2
    sleep "$delay"
    delay=$(( delay * 2 ))
    attempt=$(( attempt + 1 ))
  done
}

# ── main loop ────────────────────────────────────────────────────────────────
declare -a PASSED=()
declare -a FAILED=()
declare -a SKIPPED=()

echo "Batch TC generation: ${total} scenarios  (max_retries=${MAX_RETRIES}  retry_delay=${RETRY_DELAY}s)"
echo "────────────────────────────────────────────────────────────────"

for (( i=0; i<total; i++ )); do
  tc_file="${RUN_DIR}/tc-${i}.json"

  if [[ -f "$tc_file" ]]; then
    title="$(jq -r '.title // "?"' "$tc_file")"
    printf "  [SKIP]  scenario %-3d  %s\n" "$i" "$title"
    SKIPPED+=("$i")
    continue
  fi

  title="$(jq -r ".[$i].scenario // \"scenario ${i}\"" "$IDEAS_FILE")"
  printf "  [RUN]   scenario %-3d  %s\n" "$i" "$title"

  if run_with_retry "$i"; then
    tracker_id="$(jq -r '.tracker_id // .id' "${RUN_DIR}/tc-${i}.json")"
    printf "  [OK]    scenario %-3d  tracker_id=%s\n" "$i" "$tracker_id"
    PASSED+=("$i")
  else
    printf "  [FAIL]  scenario %-3d  all %d retries exhausted\n" "$i" "$MAX_RETRIES"
    FAILED+=("$i")
  fi
done

# ── summary ──────────────────────────────────────────────────────────────────
echo "────────────────────────────────────────────────────────────────"
echo "Results: ${#PASSED[@]} passed | ${#FAILED[@]} failed | ${#SKIPPED[@]} skipped"

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Failed indices: ${FAILED[*]}"
  echo "Re-run with the same arguments to retry failed scenarios (resume-safe)."
  exit 1
fi

exit 0
