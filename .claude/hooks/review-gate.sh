#!/bin/bash
# Generic Stop-hook review gate, registered once for the whole session in
# .claude/settings.json. It has no hardcoded knowledge of any particular
# skill — instead it reads .claude/hooks/review-map.json, a list of
# { name, match, ac_file, ac_section, focus } entries (one object per line),
# and runs a critical review for every entry whose `match` substring appears
# in a Bash command somewhere in this session's transcript.
#
# No jq dependency, by design — matches this repo's existing scripts
# (see operations-with-issue-tracker/scripts/_common.sh), which treat jq as
# optional and fall back to grep/sed. review-map.json is kept to one flat
# JSON object per line specifically so it can be parsed the same way.
#
# No retry-count file, by design — Claude Code already forces a Stop
# through after it blocks 8 times in a row without progress, so a
# second, hand-rolled cap here would just be redundant persisted state.
#
# Detection note: this keys off literal Bash tool_use commands, not the
# Skill tool. operations-with-issue-tracker (the only mapped entry today) is
# a script library other skills shell out to directly
# (`bash .claude/skills/operations-with-issue-tracker/scripts/...`) — it is
# never invoked through the Skill tool itself, so a Skill-name-based
# detection would never fire for it. Keying on the script-path substring in
# Bash commands is what actually appears in every real invocation (verified
# against this project's own session transcripts). Add a line to
# review-map.json for any other skill that needs gating — no changes to
# this script or to settings.json are needed.
set -euo pipefail

MAP_FILE=".claude/hooks/review-map.json"

# Extracts a flat string field's value from a single-line JSON object.
jfield() {
  printf '%s' "$1" \
    | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 \
    | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*\"//; s/\"\$//"
}

INPUT=$(cat)
TRANSCRIPT=$(jfield "$INPUT" transcript_path)

[ -f "$MAP_FILE" ] || exit 0
[ -f "$TRANSCRIPT" ] || exit 0

ALL_NOTES=""
FAILED=0

while IFS= read -r entry; do
  MATCH=$(jfield "$entry" match)
  [ -n "$MATCH" ] || continue
  grep -qF "$MATCH" "$TRANSCRIPT" || continue

  NAME=$(jfield "$entry" name)
  AC_FILE=$(jfield "$entry" ac_file)
  AC_SECTION=$(jfield "$entry" ac_section)
  FOCUS=$(jfield "$entry" focus)
  EXCERPT=$(tail -c 8000 "$TRANSCRIPT")

  REVIEW=$(claude --agent reviewer --permission-mode dontAsk -p "Acceptance criteria: '$AC_SECTION' section of $AC_FILE.
Recent session activity:
$EXCERPT
Focus specifically on: $FOCUS")

  VERDICT=$(echo "$REVIEW" | grep -oP '(?<=VERDICT: )\w+' || echo "UNKNOWN")

  if [ "$VERDICT" = "FAIL" ]; then
    FAILED=1
    NOTES=$(echo "$REVIEW" | sed -n '/NOTES:/,$p')
    ALL_NOTES="${ALL_NOTES}[$NAME]
${NOTES}
"
  fi
done < <(grep -F '"name"' "$MAP_FILE")

if [ "$FAILED" -eq 1 ]; then
  # Exit 2 + stderr is the documented, unambiguous way for a command hook to
  # block Stop and feed its reason back to Claude — used in preference to a
  # Stop-specific stdout JSON schema whose exact field names aren't
  # confirmed in the public docs.
  echo "$ALL_NOTES" >&2
  exit 2
fi

exit 0
