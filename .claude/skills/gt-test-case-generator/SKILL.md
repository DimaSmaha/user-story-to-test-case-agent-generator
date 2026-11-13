---
name: gt-test-case-generator
description: >
  Pipeline A stage that converts ideation output into tracker-backed test cases
  and structured steps artifacts. Use when asked to generate test cases from
  test-ideas.json, create QA test steps, or publish scenario-level test cases to
  the issue tracker with dedupe and resume safety.
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          if: "Bash(bash .claude/skills/gt-test-case-generator/scripts/*)"
          command: node "$CLAUDE_PROJECT_DIR/.claude/hooks/tc-gate.mjs" --model sonnet
          timeout: 240
---

# gt-test-case-generator

Convert one or more scenarios from `test-ideas.json` into tracker test cases and
emit `tc-N.json` tracker registration records.

**This stage is fully deterministic — it uses a shell script, not LLM generation.**
Do not paraphrase, expand, or rewrite the ideas or verifications. The script
formats them verbatim.

## Inputs

**Required:**
- `test-ideas.json` from `gt-test-ideation` — path under `.workflow-artifacts/{run_id}/`
- `scenario_index` — 0-based index of the scenario to process (or `all` to process every scenario)

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

Pass `--us-id <us.json.id>` whenever `us.json.id` is not `"manual"` — otherwise `parent_us_id`
falls back to `"manual"` (acceptance criterion 4). Same for the batch script below.

The script:
1. Reads `.ideas[]` and `.verifications[]` from the selected scenario verbatim
2. Writes `tc-steps-<n>.md` — numbered Step / Expected table
3. Writes `tc-steps-<n>.xml` — same data as XML CDATA
4. Runs `preflight.sh` then `create.sh` to upload the test case to the tracker
5. Writes `tc-<n>.json` — tracker registration record (`id`, `tracker_id`, `scenario_index`, `title`, `parent_us_id`, `deduped`, `reused`, `steps_xml_path`, `steps_md_path`). Ideation fields are NOT duplicated — read from `test-ideas.json[scenario_index]` when needed.
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

## Output

- `.workflow-artifacts/{run_id}/tc-<n>.json`, `tc-steps-<n>.md`, `tc-steps-<n>.xml` — per scenario index
- `.workflow-artifacts/{run_id}/tc.validation.json` — written by the validation hook, not by you

## Acceptance criteria (LLM-reviewed)

After each successful run of either script, the `tc-gate` hook pastes this stage's output into one
LLM call that judges it against the rules below (see "Validation feedback"). For every in-scope
scenario index `N` (`--index N`, or every index of `test-ideas.json` for the batch script):

1. **Coverage** — `tc-N.json` exists for every in-scope `N`; no `tc-*.json` has an index outside `test-ideas.json`.
2. `tc-N.json.scenario_index` is the integer `N`.
3. `tc-N.json.title` is exactly `test-ideas[N].scenario` — verbatim, including the `[Pn] ` prefix.
4. `tc-N.json.parent_us_id` equals `us.json.id` (compared as strings). `"manual"` only when `us.json.id` is `"manual"`.
5. `tc-N.json.tracker_id` is not null (`0` is valid on the fake tracker). `reused: true` only when
   `reconciliation.json` has `action: "update"` for `N`, and then `tracker_id` equals its `matched_tracker_id`;
   otherwise `reused: false` (a failed update falls back to create — that is allowed). `deduped` and `reused` are booleans.
6. `steps_md_path` / `steps_xml_path` point to `tc-steps-N.md` / `tc-steps-N.xml` in this run folder
   (relative or absolute form), and both files are present.
7. `tc-N.json` is a registration record only — no ideation fields (`ideas`, `verifications`, `conditions`,
   `navigations`, `ac_trace`, `reusable_helpers`).
8. `tc-steps-N.md` starts with `# <test-ideas[N].scenario>` and has exactly `ideas.length` steps, in order:
   `Step k: <ideas[k-1]>` followed by `  Expected: <verifications[k-1]>` — both verbatim. No step
   paraphrased, added, dropped, merged, or reordered.

Not in scope: the test design of `ideas` / `verifications` (wording, coverage, quality). They are this
stage's inputs, copied as-is — problems there belong to `gt-test-ideation`.

## Validation feedback

`.claude/hooks/tc-gate.mjs` (the `PostToolUse` hook in this skill's frontmatter) runs after every
successful `generate-tc.sh` / `batch-generate-tc.sh` call. It makes **one direct LLM call** — no tools,
`.claude/hooks/lib/review-tc-llm.mjs` — with `us.json`, the in-scope `test-ideas.json` units,
`reconciliation.json`, and every in-scope `tc-N.json` + `tc-steps-N.md` pasted in, and records the
result in `{run_dir}/tc.validation.json` (`PASSED` | `RETRYING` | `FAILED` | `UNVERIFIED`).

When feedback starting with `tc validation FAILED (retry N/3)` arrives next to the script's output:
1. Never hand-edit `tc-*.json` or `tc-steps-*` — they are script output.
2. For each index `N` in the notes: delete `tc-N.json`, `tc-steps-N.md`, `tc-steps-N.xml` from the run
   folder, then re-run the same script command (resume-safe; `--dedupe-by title` reuses the tracker item
   instead of duplicating it). Add `--us-id <us.json.id>` if `parent_us_id` was wrong.
3. If the cause is upstream (`test-ideas.json` itself, the tracker, a denied tool) or a note is plainly
   wrong about the files, stop and say why instead of regenerating.

When the feedback says all retries are used up: stop regenerating and reply with a message that starts
with `TC VALIDATION FAILED after 3 retries — <run_dir>` followed by the unresolved problems. Inside
`flow-1a` this is not an abort — continue with Phase 3.5.

The hook only fires when the script exits 0. A batch run with `[FAIL]` scenarios exits 1 and is not
reviewed — re-run it (resume-safe), or let flow-1a's re-invoke loop do so.

## Hard rules

- **Never rewrite or paraphrase ideas or verifications** — the script copies them verbatim.
- Resume-safe: if `tc-<n>.json` already exists, return it without recreating.
- Always go through `operations-with-issue-tracker` scripts — never call tracker APIs directly.
- `id:0` from fake tracker is valid — the script generates a local `tc-<timestamp>` ID.
- JSON-only primary output (`tc-<n>.json`).
