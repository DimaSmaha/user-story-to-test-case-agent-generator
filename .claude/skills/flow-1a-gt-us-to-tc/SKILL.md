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

---

## ⚠️ PIPELINE EXECUTION CONTRACT

```
Phase 0 → Phase 1 → Phase 1.5 → Phase 2 → Phase 2.5 → Phase 2.7 → Phase 3 → Phase 3.5 → Phase 4 → Phase 5
```

- **Never stop between phases.** After any phase completes, immediately begin the next.
- **Only Phase 5 produces the final user-facing reply.** All other phases emit compact blocks only.
- **Sub-skill closing messages are handoff notes, not stop signals.** Continue to the next phase.
- **Abort permitted only for critical failures in Phases 0, 1, 1.5, or 2.** All other phases log failures and continue.

---

## Pipeline schema

On start, read `.claude/skills/flow-1a-gt-us-to-tc/pipeline.json` as the execution manifest.

## Inputs

Either `--us-id <id>` or `--us-text "<title + description>"`. If neither provided, stop:
> "flow-1a-gt-us-to-tc requires --us-id or --us-text."

---

## Phases

### Phase 0 — Initialize

> Use the Bash tool for all shell commands in this phase.

**Resume detection (run before generating a new run_id):**

1. List the five most recently modified `gtc-*` dirs:
   ```bash
   ls -t .workflow-artifacts/gtc-*/us.json 2>/dev/null | head -5
   ```
2. For each, read `us.json.id`. If it matches `--us-id` and `links.json` is absent → incomplete run.
3. Match found: set `run_id` to that dir name, report `↩ Resuming run <run_id>`, continue to Phase 1.
4. No match:
   ```bash
   run_id="gtc-$(date +%Y%m%d-%H%M%S)"
   mkdir -p ".workflow-artifacts/${run_id}"
   ```
   Report `→ New run <run_id>`.

> For `--us-text` (pasted stories, `id="manual"`), always start a fresh run.

Confirm `ISSUE_TRACKER` and `FAKE_TRACKER_URL` (or tracker-specific vars) are set. If missing, stop and report which vars are absent.

> Do NOT run `preflight.sh` here — `gt-story-planner` calls it automatically.

**→ Immediately continue to Phase 1.**

---

### Phase 1 — Plan (`gt-story-planner`)

Invoke `gt-story-planner` — it runs in its own `story-planner` subagent and cannot
see this conversation, so pass everything as arguments:
```
Skill: gt-story-planner  args: --run-id <run_id> --us-id <id>
Skill: gt-story-planner  args: --run-id <run_id> --us-text "<title + description>"
```

On finish, the `SubagentStop` hook (`.claude/hooks/us-json-gate.mjs`) validates
`us.json` and sends feedback to the planner (max 3 retries). Afterwards read
`{run_dir}/us.validation.json`:
- `status: "FAILED"` → **abort** and report its `notes`
- `PASSED` / `UNVERIFIED` (reviewer could not run) / file absent → continue

- Resume-skip: `us.json` and `scenarios.md` both exist in `{run_dir}` and `us.validation.json.status` is not `FAILED`
- Success → emit compact block → continue to Phase 1.5
- **Abort on failure** (no scenarios to work with)

Checkpoint: `✓ Scenarios planned: N scenarios (M skipped as already covered)`

---

### Phase 1.5 — App exploration (`playwright-cli`)

**Load auth state first (required):**
```bash
playwright-cli state-load .playwright-auth/auth.json
```
If file missing: abort → "Auth state missing — run `npm run auth` first."

Navigate the feature area from `us.json`. Use `playwright-cli snapshot` at key states (forms, errors, modals). Walk each AC from `us.json.ac`. Look for defects: broken UI, wrong copy, unexpected errors, behavior contradicting the ACs. Do NOT take PNG screenshots during navigation — snapshots are sufficient.

Write `.workflow-artifacts/{run_id}/exploration.json`:
```json
{ "run_id": "...", "us_id": "...", "pages_visited": [], "observations": [], "bugs": [] }
```
Take a PNG only when documenting a confirmed reproducible bug:
```bash
playwright-cli screenshot --filename=".workflow-artifacts/{run_id}/exploration-bug-{N}.png"
```
Set `screenshot` to that path for that bug entry; leave `null` otherwise.

- Resume-skip: `exploration.json` exists
- Success → emit compact block → continue to Phase 2
- **Abort on failure**

Checkpoint: `✓ App explored: N pages visited, M potential bugs found`

---

### Phase 2 — Ideation (`gt-test-ideation`)

Invoke `gt-test-ideation` with `us.json` and `scenarios.md`.

`test-ideas.json` is checked by `.claude/hooks/artifact-gate.mjs` (active trigger set in
`.claude/hooks/artifact-gate.json`). With trigger `write` it runs on every Write/Edit of the file and
sends feedback right there (max 3 retries). After the skill returns, read
`{run_dir}/test-ideas.validation.json`:
- `status: "FAILED"` → **abort** and report its `notes`
- `status: "RETRYING"` → **abort** and report its `notes` — the last written version is still invalid
  (a write-trigger block cannot force a rewrite)
- `PASSED` / file absent → continue. The file is absent when the trigger is `stop`: that hook only
  fires when this whole turn ends, and then skips itself because the run is past ideation.

- Resume-skip: `test-ideas.json` exists and `test-ideas.validation.json.status` is not `FAILED` / `RETRYING`
- Success → emit compact block → continue to Phase 2.5
- **Abort on failure** (no ideas to generate TCs from)

Checkpoint: `✓ Test ideas generated: N ideation units`

> **Do NOT stop here. Phases 2.5 → 5 still remain. Only Phase 5 ends the pipeline.**

---

### Phase 2.5 — Bug reporting (`ft-bug-reporter`)

Read `exploration.json.bugs`. If empty: log `No exploration bugs to report` → continue to Phase 2.7.

For each bug at index `i`, invoke `ft-bug-reporter`:
```
ft-bug-reporter --from-exploration ".workflow-artifacts/${run_id}/exploration.json" --bug-index <i>
```
Output: `bug-{i}.json` per filed bug.

- Individual failure → log and continue to the next bug
- Never aborts the pipeline
- Success/Partial/Skipped → emit compact block → continue to Phase 2.7

Checkpoint: `✓ Bugs reported: N filed, M failed`

---

### Phase 2.7 — TC Reconciliation (`gt-tc-reconciler`)

- Resume-skip: `reconciliation.json` exists in `{run_dir}`

Step 1 — Fetch existing linked TCs:
```bash
bash .claude/skills/gt-tc-reconciler/scripts/fetch-existing-tcs.sh \
  --us-id <us_id> --run-dir ".workflow-artifacts/<run_id>"
```
`status: "skipped"` → log reason → skip Step 2 → continue to Phase 3.
`status: "found"` → `existing-tcs.json` written → proceed to Step 2.

Step 2 — Build reconciliation plan:
```bash
bash .claude/skills/gt-tc-reconciler/scripts/build-reconciliation.sh \
  --run-dir ".workflow-artifacts/<run_id>"
```
Writes `reconciliation.json`. Phase 3 reads it automatically.

- Never aborts (failure → log; Phase 3 falls back to create-only since `reconciliation.json` is absent)
- Success/Skipped → emit compact block → continue to Phase 3

Checkpoint: `✓ TC reconciliation: N existing matched, M to create, K obsolete`

---

### Phase 3 — Batch TC generation (`gt-test-case-generator`)

Invoke `gt-test-case-generator` with `--scenario-index all`. **Do NOT run as a background process — wait synchronously for each invocation to complete.**
```
Skill: gt-test-case-generator  args: --run-id <run_id> --scenario-index all
```

After the skill returns, count `tc-*.json` files present in `{run_dir}`. If the count is less than `scenario_count` (from Phase 2 compact), re-invoke `gt-test-case-generator` with the same arguments — the batch script is resume-safe and skips already-created files. Repeat up to **3 invocations total**.

- Resume-skip: batch script skips indices where `tc-{index}.json` already exists
- Individual scenario failure → logged per scenario, pipeline continues
- All 3 invocations exhausted with missing TCs → log → continue to Phase 4 with whatever tc files exist

Checkpoint: `✓ Test cases generated: N / M scenarios`

> **Do NOT stop here. Phases 3.5 → 5 still remain. Only Phase 5 ends the pipeline.**

---

### Phase 3.5 — Tag obsolete TCs (`gt-tc-reconciler`)

```bash
bash .claude/skills/gt-tc-reconciler/scripts/tag-obsolete.sh \
  --run-dir ".workflow-artifacts/<run_id>"
```

- `reconciliation.json` absent → skipped silently
- Never aborts
- Success/Skipped/Partial → emit compact block → continue to Phase 4

Checkpoint: `✓ Obsolete TCs tagged: N tagged, M failed`

---

### Phase 4 — Link TCs to story

For each `tc-{index}.json` with non-null, non-zero `tracker_id`:
```bash
bash .claude/skills/operations-with-issue-tracker/scripts/link.sh \
  --source <tracker_id> --target <us_id> --relation "tested-by"
```
`{"ok":true,"skipped":true}` from fake tracker → treat as success. Individual failure → log, continue.

Write `links.json`:
```json
{
  "us_id": "<us_id>",
  "linked_tcs": [
    { "tc_id": "tc-1234567890", "tracker_id": "TEST-57041", "status": "linked" }
  ],
  "linked_count": 1,
  "failed_count": 0
}
```
`status` values: `"linked"` | `"skipped-no-tracker-id"` | `"failed"`

- Never aborts
- Success/Partial/All-skipped → emit compact block → continue to Phase 5

Checkpoint: `✓ TCs linked to story {us_id}: N linked, M skipped, K failed`

---

### Phase 5 — Final summary

**This is the only phase that produces a final user-facing reply.**

Output a table:
```
| # | Scenario                                | TC ID           | Tracker ID  | Reused | Link Status |
|---|-----------------------------------------|-----------------|-------------|--------|-------------|
| 0 | [P1] Auth: Login with valid credentials | tc-1234567890   | TEST-57041  | yes    | linked      |
| 1 | [P1] Auth: Login with invalid password  | tc-1234567891   | TEST-57042  | no     | linked      |
| 2 | [SKIP] Auth: Logout flow                | —               | —           | —      | skipped     |

Run ID: gtc-20240601-143012
Total: 3 scenarios | 1 modified | 1 created | K obsolete tagged | 2 linked to story {us_id} | 1 skipped
Next: run flow-1b-gt-tc-to-spec --run-id gtc-20240601-143012 to generate Playwright specs
```

---

## Phase compact protocol

After each phase, emit a compact block and drop all full phase output from active context.

```json
<!-- PHASE COMPACT: {phase_label} -->
{
  "phase": "<phase_label>",
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
| TC Reconciliation (2.7) | `existing_tc_count`, `match_count`, `obsolete_count` |
| gt-test-case-generator (3) | `tc_count`, `failed_count` |
| Tag Obsolete TCs (3.5) | `obsolete_tagged_count`, `obsolete_failed_count` |
| Link TCs to Story (4) | `linked_count`, `failed_count` |

---

## Hard rules

- **Abort permitted only for:** missing inputs (Phase 0), missing env vars (Phase 0), `gt-story-planner` failure (Phase 1), missing auth state (Phase 1.5), `gt-test-ideation` failure (Phase 2).
- All tracker and git operations go through wrapper scripts only.
- Keep handoff contracts file-based — never pass raw JSON between stages as text.
- `run_id` prefix is `gtc`; use it consistently for all artifacts.
