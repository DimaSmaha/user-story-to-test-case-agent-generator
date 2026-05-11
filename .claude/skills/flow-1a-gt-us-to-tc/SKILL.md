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

## Workflow

### Phase 0 — Initialize

```bash
run_id="gtc-$(date +%Y%m%d-%H%M%S)"
mkdir -p ".workflow-artifacts/${run_id}"
```

Confirm ISSUE_TRACKER and FAKE_TRACKER_URL (or other tracker vars) are set. If missing, stop and report exactly which vars are absent — do not ask interactively.

### Phase 1 — Plan (`gt-story-planner`)

Invoke `gt-story-planner` with the user story input.

- **SUCCESS:** `us.json` and `scenarios.md` written
- **FAILED:** stop and report

Show checkpoint: `✓ Scenarios planned: N scenarios (M skipped as already covered)`

### Phase 1.5 — App exploration (`playwright-cli`)

Use `playwright-cli` to explore the feature area described in `us.json`:

1. Navigate to the relevant pages and flows.
2. Take snapshots of key states (forms, error messages, modals, success states).
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
      "screenshot": ".workflow-artifacts/<run_id>/exploration-bug-<N>.png"
    }
  ]
}
```

If no bugs are found, write `"bugs": []`.

- **SUCCESS:** `exploration.json` written
- **FAILED:** stop and report

Show checkpoint: `✓ App explored: N pages visited, M potential bugs found`

### Phase 2 — Ideation (`gt-test-ideation`)

Invoke `gt-test-ideation` with `us.json` and `scenarios.md`.

- **SUCCESS:** `test-ideas.json` written
- **FAILED:** stop and report

Show checkpoint: `✓ Test ideas generated: N ideation units`

### Phase 2.5 — Bug reporting (`ft-bug-reporter`)

Read `exploration.json`. If `bugs` is empty, skip this phase — log `No exploration bugs to report` and continue.

For each bug in `exploration.json.bugs`:

1. Synthesize `.workflow-artifacts/{run_id}/exploration-classification-{i}.json`:

```json
{
  "verdict": "app-bug",
  "confidence": "<severity-to-confidence: critical→0.90, high→0.80, medium→0.70, low→0.62>",
  "signals": [{ "name": "observed defect during live app exploration", "weight": "<confidence>" }],
  "error_summary": "<bug.title>",
  "evidence_paths": ["<bug.screenshot>"],
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
    "screenshot": "<bug.screenshot>",
    "video": null
  }
}
```

3. Invoke `ft-bug-reporter` with these two synthesized artifacts as inputs.

- If an individual bug report fails: log the failure and continue to the next bug — do not abort.
- **SUCCESS:** `bug-{i}.json` written for each filed bug
- **SKIPPED:** `bugs` array was empty

Show checkpoint: `✓ Bugs reported: N bugs filed, M failed`

## Phase compact protocol

After each phase (and each per-scenario iteration) completes, emit a compact
JSON block and drop all full phase output from active context. This is mandatory
— long pipelines with many scenario iterations will overflow context without it.

**Rules:**
1. After a phase skill finishes, immediately emit a `<!-- PHASE COMPACT -->` block.
2. The block contains only the fields listed below for that phase.
3. All other output from that phase is dropped from active context after the block.
4. For the per-scenario loop, emit one compact block per phase per iteration.
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
| gt-test-case-generator (3a) | `tc_id`, `scenario_index`, `title`, `deduped` |
| Link TCs to Story (4) | `linked_count`, `failed_count` |

All other data (ideation arrays, tracker API responses, full error stacks)
remains in artifact files on disk — access by path if needed.

### Phase 3 — Batch TC generation (`gt-test-case-generator`)

For every non-SKIP scenario in `scenarios.md`, invoke `gt-test-case-generator` with `test-ideas.json` and the `scenario_index`.

- Resume: if `tc-{index}.json` already exists, skip and continue
- **SUCCESS:** `tc-{index}.json` written for every non-SKIP scenario
- **FAILED:** log the failure for that scenario and continue to the next

All `tc-*.json` files must be produced before Phase 4 begins.

Show checkpoint: `✓ Test cases generated: N / M scenarios`

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

Show checkpoint: `✓ TCs linked to story {us_id}: N linked, M skipped, K failed`

### Phase 5 — Final summary

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

## Hard rules

**Bash execution — fully agentic, zero prompts:**
- Run all bash commands directly: `bash .claude/skills/...` — never prefix with `cd /path &&` or `source .env &&`; the working directory and env are already set.
- Do not chain env-var exports before bash calls; the scripts source `.env` via `_common.sh` automatically.
- Never use compound `cd && source && bash` forms — they bypass the permission allowlist and trigger prompts.

**Autonomous execution — never pause for human input:**
- Do not ask the user to confirm any phase, scenario skip, or linking operation.
- Do not add "shall I proceed?" or approval gates anywhere in the flow.
- If a non-critical phase fails (any Phase 3a / Phase 4 iteration), log the failure and continue — do not abort the entire pipeline.
- Phases 0, 1, 1.5, 2, and 5 use `on_failure: stop` — a failure there aborts everything.
- Phases 2.5 and 4 are per-item loops: log individual failures and continue; do not abort the pipeline.

**Artifact contracts:**
- Generate a `run_id` at start with prefix `gtc` and use it consistently for all artifacts.
- Explicit invocation only — for any partial flow use individual `gt-*` skills.
- Resume-safe: if stage artifacts already exist for a scenario, skip that stage.
- Tracker and git operations go through wrapper skills/scripts only.
- Keep handoff contracts file-based — never pass raw JSON between stages as text.

**Phase compact:**
- Emit a compact block after every phase and after every per-scenario iteration.
- Drop all non-compact phase output from active context immediately after emitting.
- Omitting compaction on long runs causes context overflow — this rule is non-negotiable.
