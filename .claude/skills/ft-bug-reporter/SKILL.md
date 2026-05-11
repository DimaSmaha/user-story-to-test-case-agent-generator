---
name: ft-bug-reporter
description: >
  Create or dedupe tracker bugs for classified Playwright app defects in Pipeline
  B. Use when classification.json returns app-bug with confidence above threshold
  and a bug artifact must be produced with links to evidence. Trigger on requests
  like "file bug from classification", "create issue for app-bug", or
  "generate bug.json from Playwright failure evidence".
---

# ft-bug-reporter

Turn a high-confidence `app-bug` classification into a tracker bug and emit
`bug.json` for downstream reference.

## When this skill fits

Use it for requests like:

- "file a bug for this app-bug classification"
- "create a tracker issue from classification.json"
- "report this as a bug with evidence"

Do **not** use it for:

- `test-bug` verdicts (use `ft-test-fix-runner`)
- low-confidence classifications (< 0.60)
- running or classifying the test

## What comes before and after

- **Before:** `ft-classifier` produces `classification.json` with `verdict: "app-bug"`
- **After:** `bug.json` is produced; the run is complete unless a human follow-up is needed

## Inputs

**Required:**
- `classification.json` — must have `verdict: "app-bug"` and `confidence >= 0.60`
- `repro.json` — for error details and evidence artifact paths

If either file is missing, check `.workflow-artifacts/` for the most recent run.
If still not found, ask the user to run `ft-repro` and `ft-classifier` first.

## Workflow

### 1. Confirm verdict and confidence

Read `classification.json`. If `verdict != "app-bug"` or `confidence < 0.60`:

```text
Verdict is <verdict> with confidence <confidence>.
The threshold for ft-bug-reporter is app-bug with confidence >= 0.60.
<Explain what to do instead based on the actual verdict>
```

Stop — do not create a bug.

### 2. (Optional but recommended) Verify the bug in the live app

Use `playwright-cli` to navigate to the failing feature and confirm the regression
is still present in the live app:

1. Open the app URL (derive from the spec's `goto` call or ask)
2. Reproduce the flow described in `repro.json`
3. Observe whether the bug is still present

Record your observation. Include it in the bug description. This prevents filing
bugs for issues that are already fixed.

### 3. Build the bug description

Write a description file (e.g. `.workflow-artifacts/{run_id}/bug-desc.md`) with:

```markdown
## Summary
<error_summary from classification.json>

## Failing test
Spec: <spec path from repro.json>

## Error
<error from repro.json>

## Stack trace
<stack from repro.json>

## Classification signals
<signals[] with weights from classification.json>

## Evidence
- Screenshot: <artifacts.screenshot>
- Trace: <artifacts.trace>
- Video: <artifacts.video if present>

## Live app verification
<your playwright-cli observations from step 2, or "Not verified">
```

### 4. Create the bug in the tracker

Run preflight if not already done:

```bash
bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh
```

Create the bug with up to 3 attempts (3-second delay between retries):

```bash
max_attempts=3
attempt=0
create_result=""
while [ $attempt -lt $max_attempts ]; do
  attempt=$((attempt + 1))
  create_result=$(bash .claude/skills/operations-with-issue-tracker/scripts/create.sh \
    --type "Bug" \
    --title "<error_summary from classification.json>" \
    --description-file ".workflow-artifacts/${run_id}/bug-desc.md" \
    --tag "claude-generated,automated-triage" 2>&1) && break
  echo "Attempt $attempt failed. Retrying in 3s..." >&2
  sleep 3
done
if [ -z "$create_result" ]; then
  echo '{"error":"tracker create failed after 3 attempts"}' && exit 1
fi
echo "$create_result"
```

Retry up to 3 times on transient failures (e.g. tracker temporarily unreachable). Fail the phase only after all attempts are exhausted.

With the fake tracker, the response will be `{"id":0,"url":"...","deduped":false}`.
This is expected — `id:0` is valid for the fake tracker.

### 5. Write bug.json

Write `.workflow-artifacts/{run_id}/bug.json`:

```json
{
  "id": 0,
  "title": "TimeoutError: Finish button not visible after completing checkout",
  "url": "http://localhost:3000/bugs/create",
  "severity": "high",
  "summary": "App-bug: checkout finish button not appearing after form submission",
  "classification_source": "ft-classifier",
  "evidence_paths": [
    ".workflow-artifacts/ft-20240601-143012/trace.zip",
    ".workflow-artifacts/ft-20240601-143012/fail.png"
  ],
  "deduped": false
}
```

**Severity mapping:**
- `confidence >= 0.70` → `critical`
- `confidence >= 0.70` → `high`
- `confidence >= 0.60` → `medium`

### 6. Output

Tell the user:

```text
Bug created. bug.json written to .workflow-artifacts/{run_id}/bug.json
Tracker response: {"id":0, ...}
Tag: claude-generated
```

## Hard rules

- Only run when `verdict == "app-bug"` and `confidence >= 0.60`.
- Always call tracker ops via `operations-with-issue-tracker` scripts — never call APIs directly.
- `id:0` from the fake tracker is expected and valid; do not treat it as a failure.
- JSON-only primary output (`bug.json`).
- Include evidence paths in the description, not just in the JSON.
