---
name: flow-1a-gt-us-to-tc
description: >
  EXPLICIT-INVOCATION ONLY. Sub-orchestrator for Pipeline A-1 (User Story → Test Cases).
  Use when the caller explicitly requests a flow from user story to tracker-backed test cases.
  Runs plan → ideate → batch TC generation → link TCs to story. For spec generation from
  existing test cases, use flow-1b-gt-tc-to-spec instead.
---

# flow-1a-gt-us-to-tc

EXPLICIT-INVOCATION ONLY.

> **NEVER re-ask the user for any input, confirmation, or clarification during execution.**
> All decisions are resolved from artifacts and env vars. Stop-and-report is the only permitted response to missing inputs.

Run Pipeline A-1: planner → ideation → batch TC generation → link TCs to story.

---

## ⚠️ PIPELINE EXECUTION CONTRACT — READ FIRST

**The pipeline MUST execute every phase in sequence without stopping.**

```
Phase 0 → Phase 1 → Phase 1.5 → Phase 2 → Phase 2.5 → Phase 3 → Phase 4 → Phase 5
```

- **Never stop between phases.** After any phase completes (success, skip, or non-critical failure), immediately begin the next phase.
- **Never output a final reply after a mid-pipeline phase.** Only Phase 5 produces the final user-facing output.
- **Never treat a sub-skill's closing message as a signal to stop.** Sub-skills say "tell the user…" or "pass X to Y" — ignore those as user addresses; they are handoff notes. Continue to the next phase.
- **Outputting a summary or checkpoint line does NOT end the pipeline.** It is just a progress marker — keep going.
- The only permitted abort points are critical failures in Phase 0, 1, 1.5, or 2 (see "Hard rules").
- Phases 2.5, 3, and 4 NEVER abort the pipeline. Log failures per item and continue.

---

## Pipeline schema

On start, read `.claude/skills/flow-1a-gt-us-to-tc/pipeline.json`.
This file is the authoritative definition of all phases, loop structure,
artifact contracts, resume-skip conditions, and compaction fields.
Use it as the execution manifest throughout.

## When this skill fits

Use it for requests like:

- "generate test cases from this user story"
- "create TCs in the tracker for story 112"
- "run the first half of Pipeline A — plan and TC generation only"
- "upload test cases and link them to the user story"

Do **not** use it for:

- generating Playwright specs (use `flow-1b-gt-tc-to-spec` or `flow-1-gt-us-to-spec`)
- generating scenarios only (use `gt-story-planner`)
- creating one test case (use `gt-test-case-generator`)

## Inputs

Either:
- `--us-id <id>` — fetch from tracker
- `--us-text "<title + description>"` — paste directly

If neither provided, stop immediately and report: "flow-1a-gt-us-to-tc requires --us-id or --us-text. Invoke with one of these inputs."

---

## Workflow

### Phase 0 — Initialize

> All shell commands in Phase 0 must use the **Bash tool** (not PowerShell).

**Resume detection (run before generating a new run_id):**

1. List the five most recently modified `gtc-*` dirs:
   ```bash
   ls -t .workflow-artifacts/gtc-*/us.json 2>/dev/null | head -5
   ```
2. For each dir, read `us.json` and extract `id`. If `id` matches the requested `--us-id` and `links.json` does NOT exist in that dir → it is an incomplete run.
3. If a match is found:
   - Set `run_id` to that directory name.
   - Report: `↩ Resuming run <run_id>`
   - Continue to Phase 1 — existing artifacts auto-skip via `resume_skip_if`.
4. If no match found:
   ```bash
   run_id="gtc-$(date +%Y%m%d-%H%M%S)"
   mkdir -p ".workflow-artifacts/${run_id}"
   ```
   Report: `→ New run <run_id>`

> Note: For `--us-text` (pasted stories, `id="manual"`), always start a fresh run.

Confirm ISSUE_TRACKER and FAKE_TRACKER_URL (or other tracker vars) are set. If missing, stop and report exactly which vars are absent — do not ask interactively.

> ⚠️ Do NOT run `preflight.sh` in Phase 0. `gt-story-planner` (Phase 1) calls preflight automatically when fetching the story. Phase 0 only checks that the required env vars are non-empty.

**→ Immediately continue to Phase 1.**

---

### Phase 1 — Plan (`gt-story-planner`)

Invoke `gt-story-planner` with the user story input.

- **SUCCESS:** `us.json` and `scenarios.md` written → emit compact block → **immediately continue to Phase 1.5**
- **FAILED:** stop and report (this is the only permitted abort for this phase)

Show checkpoint: `✓ Scenarios planned: N scenarios (M skipped as already covered)`

---

### Phase 1.5 — App exploration (`playwright-cli`)

**Step 0 — Load auth state (REQUIRED)**

Before any `playwright-cli` navigation, load the saved storage state:

```bash
playwright-cli state-load .playwright-auth/auth.json
```

If the file does not exist, stop and report: "Auth state missing — run `npm run auth` first."

Use `playwright-cli` to explore the feature area described in `us.json`:

1. Navigate to the relevant pages and flows.
2. Use `playwright-cli snapshot` at key states (forms, error messages, modals, success states). Do NOT take PNG screenshots during navigation — snapshots are sufficient for UI observation.
3. Walk through each acceptance criterion from `us.json.ac` in the live app.
4. Specifically look for defects: broken UI, missing elements, wrong copy, unexpected errors, incorrect navigation, or behavior that contradicts the acceptance criteria.

Write `.workflow-artifacts/{run_id}/exploration.json`:

```json
{
  "run_id": "<run_id>",
  "us_id": "<us_id>",
  "pages_visited": ["<page1>", "<page2>"],
  "observations": ["<observation 1>", "..."],
  "bugs": [
    {
      "title": "<short defect title>",
      "description": "<what is wrong and what was expected>",
      "steps_to_reproduce": ["Step 1", "Step 2", "..."],
      "severity": "critical | high | medium | low",
      "screenshot": null
    }
  ]
}
```

Take a PNG only when documenting a confirmed reproducible bug:
```bash
playwright-cli screenshot --filename=".workflow-artifacts/{run_id}/exploration-bug-{N}.png"
```
Set `screenshot` to that path for that bug entry; leave `null` otherwise.

```json
```

If no bugs are found, write `"bugs": []`.

- **SUCCESS:** `exploration.json` written → emit compact block → **immediately continue to Phase 2**
- **FAILED:** stop and report

Show checkpoint: `✓ App explored: N pages visited, M potential bugs found`

---

### Phase 2 — Ideation (`gt-test-ideation`)

Invoke `gt-test-ideation` with `us.json` and `scenarios.md`.

- **SUCCESS:** `test-ideas.json` written → emit compact block → **immediately continue to Phase 2.5**
- **FAILED:** stop and report

Show checkpoint: `✓ Test ideas generated: N ideation units`

> **After showing this checkpoint, do NOT stop. Do NOT output a closing reply.**
> The pipeline is not finished. Phase 2.5, 3, 4, and 5 still remain.
> Emit the compact block and immediately invoke Phase 2.5.

---

### Phase 2.5 — Bug reporting (`ft-bug-reporter`)

Read `exploration.json`. If `bugs` is empty, skip this phase — log `No exploration bugs to report` and **immediately continue to Phase 3**.

For each bug in `exploration.json.bugs`:

1. Synthesize `.workflow-artifacts/{run_id}/exploration-classification-{i}.json`:

```json
{
  "verdict": "app-bug",
  "confidence": "<severity-to-confidence: critical→0.90, high→0.80, medium→0.70, low→0.62>",
  "signals": [{ "name": "observed defect during live app exploration", "weight": "<confidence>" }],
  "error_summary": "<bug.title>",
  "evidence_paths": ["<bug.screenshot if non-null, otherwise omit array entry>"],
  "recommended_next_skill": "ft-bug-reporter"
}
```

2. Synthesize `.workflow-artifacts/{run_id}/exploration-repro-{i}.json`:

```json
{
  "run_id": "<run_id>",
  "spec": "exploration",
  "error": "<bug.description>",
  "stack": "<bug.steps_to_reproduce joined with newlines>",
  "locator": null,
  "expected": "behavior matching acceptance criteria",
  "actual": "<bug.description>",
  "artifacts": {
    "trace": null,
    "screenshot": "<bug.screenshot or null>",
    "video": null
  }
}
```

3. Invoke `ft-bug-reporter` with these two synthesized artifacts as inputs.

- If an individual bug report fails: log the failure and continue to the next bug — **do not abort**.
- **SUCCESS / SKIPPED / PARTIAL:** emit compact block → **immediately continue to Phase 3**

Show checkpoint: `✓ Bugs reported: N bugs filed, M failed`

---

### Phase 3 — Batch TC generation (`gt-test-case-generator`)

Invoke `gt-test-case-generator` **once** with `--scenario-index all`. This calls `batch-generate-tc.sh` internally, which is resume-safe and handles every non-SKIP scenario in a single run.

```
Skill: gt-test-case-generator  args: --run-id <run_id> --scenario-index all
```

- Resume: the batch script skips indices where `tc-{index}.json` already exists
- **SUCCESS:** `tc-{index}.json` written for every non-SKIP scenario → emit compact block → **immediately continue to Phase 4**
- **FAILED (individual scenario):** logged per scenario; continue; **do not abort the pipeline**
- **FAILED (entire skill):** log the failure → **still continue to Phase 4** with whatever tc files exist

Show checkpoint: `✓ Test cases generated: N / M scenarios`

> **After this checkpoint, do NOT stop. Phase 4 (linking) still remains.**

---

### Phase 4 — Link TCs to Story

For each `tc-{index}.json` with a non-null, non-zero `tracker_id`:

```bash
bash .claude/skills/operations-with-issue-tracker/scripts/link.sh \
  --source <tracker_id> \
  --target <us_id> \
  --relation "tested-by"
```

- Fake tracker returns `{"ok":true,"skipped":true}` for unsupported verbs — treat as success.
- If individual link call fails: log the failure for that TC, continue to the next.
- After all TCs are processed, write `links.json`:

```json
{
  "us_id": "<us_id>",
  "linked_tcs": [
    { "tc_id": "tc-1234567890", "tracker_id": "TEST-57041", "status": "linked" },
    { "tc_id": "tc-1234567891", "tracker_id": "0", "status": "skipped-no-tracker-id" }
  ],
  "linked_count": 1,
  "failed_count": 0
}
```

`status` values: `"linked"` | `"skipped-no-tracker-id"` | `"failed"`

- **SUCCESS / PARTIAL / ALL-SKIPPED:** emit compact block → **immediately continue to Phase 5**

Show checkpoint: `✓ TCs linked to story {us_id}: N linked, M skipped, K failed`

---

### Phase 5 — Final summary

**This is the only phase that produces a final user-facing reply.**

Output a table:

```
| # | Scenario                                | TC ID           | Tracker ID  | Link Status |
|---|-----------------------------------------|-----------------|-------------|-------------|
| 0 | [P1] Auth: Login with valid credentials | tc-1234567890   | TEST-57041  | linked      |
| 1 | [P1] Auth: Login with invalid password  | tc-1234567891   | TEST-57042  | linked      |
| 2 | [SKIP] Auth: Logout flow                | —               | —           | skipped     |

Run ID: gtc-20240601-143012
Total: 3 scenarios | 2 TCs created | 2 linked to story {us_id} | 1 skipped
Next: run flow-1b-gt-tc-to-spec --run-id gtc-20240601-143012 to generate Playwright specs
```

---

## Phase compact protocol

After each phase completes, emit a compact JSON block and drop all full phase output from active context. This is mandatory — long pipelines overflow context without it.

**Rules:**
1. After a phase skill finishes, immediately emit a `<!-- PHASE COMPACT -->` block.
2. The block contains only the fields listed below for that phase.
3. All other output from that phase is dropped from active context after the block.
4. Emitting the compact block does NOT end the pipeline — continue to the next phase immediately.
5. Use only compact block fields when referencing past phases or building the summary.

**Format:**
```json
<!-- PHASE COMPACT: {phase_label} scenario={index} -->
{
  "phase": "<phase_label>",
  "scenario_index": <N>,
  "status": "SUCCESS | FAILED | SKIPPED",
  <phase-specific fields>
}
```

**Fields to retain per phase:**

| Phase | Retain |
|---|---|
| gt-story-planner (1) | `us_id`, `title`, `scenario_count` |
| App exploration (1.5) | `pages_visited_count`, `bug_count` |
| gt-test-ideation (2) | `total_ideas`, `scenario_count` |
| Bug reporting (2.5) | `bugs_filed`, `bugs_failed` |
| gt-test-case-generator (3) | `tc_count`, `failed_count` |
| Link TCs to Story (4) | `linked_count`, `failed_count` |

All other data (ideation arrays, tracker API responses, full error stacks)
remains in artifact files on disk — access by path if needed.

---

## Hard rules

**Abort permitted only for:**
- Missing `--us-id` or `--us-text` input (Phase 0)
- Missing required env vars (Phase 0)
- `gt-story-planner` failure — no scenarios to work with (Phase 1)
- Missing auth state file (Phase 1.5)
- `gt-test-ideation` failure — no ideas to generate TCs from (Phase 2)

**Everything else continues:** log failures per item and move to the next phase.

**Bash:** Use the **Bash tool** (not PowerShell) for all bash commands (`bash .claude/skills/...`). Never prefix with `cd /path &&` or `source .env &&`. Never use `cd && source && bash` chains — they bypass the permission allowlist.

**Artifact contracts:**
- `run_id` prefix is `gtc`; use it consistently for all artifacts.
- Keep handoff contracts file-based — never pass raw JSON between stages as text.
- Tracker and git operations go through wrapper scripts only.
