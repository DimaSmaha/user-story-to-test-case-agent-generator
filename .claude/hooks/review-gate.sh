#!/bin/bash
# Generic Stop-hook review gate. Shared by any skill that wants a critical
# pass/fail review of its own session output before Stop is allowed through.
#
# This script has no hardcoded knowledge of any particular skill — everything
# skill-specific (which file holds the acceptance criteria, which section,
# what to focus on, how many retry rounds to allow) is passed in as CLI args
# from that skill's own `hooks:` frontmatter block.
set -euo pipefail

AC_FILE="" AC_SECTION="" FOCUS="" MAX_ROUNDS=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ac-file) AC_FILE="$2"; shift 2 ;;
    --ac-section) AC_SECTION="$2"; shift 2 ;;
    --focus) FOCUS="$2"; shift 2 ;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
COUNTER_DIR=".claude/.review-state"
COUNTER_FILE="$COUNTER_DIR/${SESSION_ID}.round"
mkdir -p "$COUNTER_DIR"

if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  ROUND=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
else
  ROUND=0
fi

if [ "$ROUND" -ge "$MAX_ROUNDS" ]; then
  rm -f "$COUNTER_FILE"; exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path')
EXCERPT=$(mktemp)
tail -c 8000 "$TRANSCRIPT" > "$EXCERPT"

REVIEW=$(claude --agent reviewer -p "Acceptance criteria: '$AC_SECTION' section of $AC_FILE.
Recent session activity: $EXCERPT.
Focus specifically on: $FOCUS")
rm -f "$EXCERPT"

VERDICT=$(echo "$REVIEW" | grep -oP '(?<=VERDICT: )\w+' || echo "UNKNOWN")

if [ "$VERDICT" = "FAIL" ]; then
  echo $((ROUND + 1)) > "$COUNTER_FILE"
  NOTES=$(echo "$REVIEW" | sed -n '/NOTES:/,$p')
  echo "{\"decision\": \"block\", \"reason\": $(echo "$NOTES" | jq -Rs .)}"
  exit 0
fi

rm -f "$COUNTER_FILE"; exit 0
