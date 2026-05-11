---
name: gt-test-case-generator
description: >
  Pipeline A stage that converts ideation output into tracker-backed test cases
  and structured steps artifacts. Use when asked to generate test cases from
  test-ideas.json, create QA test steps, or publish scenario-level test cases to
  the issue tracker with dedupe and resume safety.
---

# gt-test-case-generator

Convert one or more scenarios from `test-ideas.json` into tracker test cases and
emit `tc-N.json` artifacts for downstream spec writing.

**This stage is fully deterministic — it uses a shell script, not LLM generation.**
Do not paraphrase, expand, or rewrite the ideas or verifications. The script
formats them verbatim.

## When this skill fits

Use it for requests like:

- "create test case for scenario 2"
- "upload test cases to the tracker"
- "generate tc.json for this scenario"
- "publish test cases for the cart flow"

Do **not** use it for:

- generating ideation (use `gt-test-ideation`)
- writing Playwright specs (use `gt-spec-writer`)

## What comes before and after

- **Before:** `gt-test-ideation` produces `test-ideas.json`
- **After:** `gt-spec-writer` reads `tc-N.json` to generate the Playwright spec

## Inputs

**Required:**
- `test-ideas.json` from `gt-test-ideation` — path under `.workflow-artifacts/{run_id}/`
- `scenario_index` — 0-based index of the scenario to process (or `all` to process every scenario)

If `test-ideas.json` is missing, check `.workflow-artifacts/` or ask the user to
run `gt-test-ideation` first.

If `scenario_index` is not specified, ask:
```
Which scenario index should I create a test case for? (0 = first, "all" = every scenario)
```

## Workflow

### 1. Locate test-ideas.json

Find the most recent `test-ideas.json` under `.workflow-artifacts/`:

```bash
ls -t .workflow-artifacts/*/test-ideas.json 2>/dev/null | head -1
```

Confirm the `run_id` directory (e.g. `gt-20240601-143012`). All outputs go into that same directory.

### 2. Run the appropriate script

**Single scenario:**

```bash
bash .claude/skills/gt-test-case-generator/scripts/generate-tc.sh \
  --ideas-file ".workflow-artifacts/${run_id}/test-ideas.json" \
  --index <scenario_index> \
  --run-dir  ".workflow-artifacts/${run_id}"
```

Optionally pass `--us-id <id>` if `us.json` has a non-manual tracker ID.

The script:
1. Reads `.ideas[]` and `.verifications[]` from the selected scenario verbatim
2. Writes `tc-steps-<n>.md` — numbered Step / Expected table
3. Writes `tc-steps-<n>.xml` — same data as XML CDATA
4. Runs `preflight.sh` then `create.sh` to upload the test case to the tracker
5. Writes `tc-<n>.json` — full artifact including all ideation context
6. Prints `tc-<n>.json` on stdout

**All scenarios (with retry logic):**

For `scenario_index = "all"`, use `batch-generate-tc.sh` instead of looping manually:

```bash
bash .claude/skills/gt-test-case-generator/scripts/batch-generate-tc.sh \
  --ideas-file ".workflow-artifacts/${run_id}/test-ideas.json" \
  --run-dir    ".workflow-artifacts/${run_id}" \
  [--us-id <id>] \
  [--max-retries 3] \
  [--retry-delay 5]
```

The batch script:
1. Iterates every scenario index in `test-ideas.json`
2. Skips indices where `tc-<n>.json` already exists (resume-safe)
3. Calls `generate-tc.sh` for each remaining index
4. On TMS failure (non-zero exit from `create.sh`), retries up to `--max-retries` times with exponential back-off starting at `--retry-delay` seconds
5. Logs `[SKIP]` / `[OK]` / `[FAIL]` per scenario to stderr; exits 0 when all pass, 1 if any fail
6. Failed scenarios can be retried by re-running the same command (resume-safe)

### 3. Resume safety

The script is idempotent: if `tc-<n>.json` already exists for a given index it
returns immediately without re-creating or re-uploading.

### 4. Output

Tell the user:

```
tc-<n>.json written to .workflow-artifacts/{run_id}/
Tracker upload: OK (id may be 0 for fake tracker — expected)
```

List every tc file created when processing multiple scenarios.

## Hard rules

- **Never rewrite or paraphrase ideas or verifications** — the script copies them verbatim.
- Resume-safe: if `tc-<n>.json` already exists, return it without recreating.
- Always go through `operations-with-issue-tracker` scripts — never call tracker APIs directly.
- `id:0` from fake tracker is valid — the script generates a local `tc-<timestamp>` ID.
- JSON-only primary output (`tc-<n>.json`).
