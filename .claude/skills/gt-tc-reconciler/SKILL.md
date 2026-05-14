---
name: gt-tc-reconciler
description: >
  Reconciler stage for Pipeline A-1. Invoked by flow-1a-gt-us-to-tc at Phase 2.7
  (before TC generation) and Phase 3.5 (after TC generation). Fetches existing
  tracker TCs linked to a user story, compares them with test-ideas.json to determine
  create vs update per scenario, and tags obsolete TCs after Phase 3 completes.
  Not invoked standalone.
---

# gt-tc-reconciler

Invoked by `flow-1a-gt-us-to-tc`. Not for standalone use.

---

## Phase 2.7 — Pre-generation reconciliation

**Goal:** Determine which new scenarios match existing linked TCs so Phase 3 can
update rather than duplicate.

**Resume-skip:** if `reconciliation.json` already exists in `{run_dir}`, skip both
steps and continue to Phase 3.

### Step 1 — Fetch existing linked TCs

```bash
bash .claude/skills/gt-tc-reconciler/scripts/fetch-existing-tcs.sh \
  --us-id <us_id> \
  --run-dir ".workflow-artifacts/<run_id>"
```

**Output interpretation:**

| `status` in stdout | Meaning | Next action |
|---|---|---|
| `"skipped"` | No linked TCs, endpoint unavailable, or error | Log reason → immediately continue to Phase 3 |
| `"found"` | Linked TCs written to `existing-tcs.json` | Proceed to Step 2 |

If `status` is `"skipped"`, do NOT run Step 2. Phase 2.7 is complete.

### Step 2 — Build reconciliation plan

```bash
bash .claude/skills/gt-tc-reconciler/scripts/build-reconciliation.sh \
  --run-dir ".workflow-artifacts/<run_id>"
```

Writes `reconciliation.json`. Stdout contains match/create/obsolete counts.

**Compact block fields:** `existing_tc_count`, `match_count`, `obsolete_count`

---

## Phase 3 interaction — generate-tc.sh

`generate-tc.sh` automatically reads `reconciliation.json` from `{run_dir}` if
it exists. For each scenario:

- `action: "update"` — calls `update-steps.sh` + `update.sh --tag claude-generated,claude-generated-modified` with the matched tracker ID; writes `tc-{n}.json` with `reused: true`
- `action: "create"` (or file absent) — calls `create.sh` as normal; `reused: false`

On update failure: falls back to `create.sh` and logs a warning.

---

## Phase 3.5 — Post-generation obsolete tagging

```bash
bash .claude/skills/gt-tc-reconciler/scripts/tag-obsolete.sh \
  --run-dir ".workflow-artifacts/<run_id>"
```

Applies `claude-generated-obsolete` tag to every tracker ID in
`reconciliation.json.obsolete_tracker_ids`.

- If `reconciliation.json` is absent → skips silently (status: "skipped")
- Fake tracker returns `{"ok":true,"skipped":true}` for update — treated as success

**Compact block fields:** `obsolete_tagged_count`, `obsolete_failed_count`

---

## Artifact contracts

### `existing-tcs.json`

Written only when linked TCs are found. Absent on clean runs.

```json
{
  "us_id": "112",
  "tc_count": 3,
  "tcs": [
    { "tracker_id": "TEST-26034", "title": "[P1] Auth: Login with valid credentials...", "url": "http://localhost:3000/testcases/TEST-26034" }
  ]
}
```

### `reconciliation.json`

Written only when `existing-tcs.json` was written. Absent on clean runs.
`generate-tc.sh` and `tag-obsolete.sh` treat absence as "all creates, no obsoletes."

```json
{
  "us_id": "112",
  "existing_tc_count": 3,
  "scenario_matches": [
    { "scenario_index": 0, "new_title": "...", "matched_tracker_id": "TEST-26034", "action": "update" },
    { "scenario_index": 2, "new_title": "...", "matched_tracker_id": null,         "action": "create" }
  ],
  "obsolete_tracker_ids": ["TEST-99001"]
}
```

### `tc-{n}.json` — tracker registration record

Contains only tracker-registration fields. Ideation fields (`ideas`, `verifications`, `conditions`, `navigations`, `ac_trace`, `reusable_helpers`) are NOT duplicated here — read them from `test-ideas.json[scenario_index]`.

```json
{
  "id": "tc-1234567890",
  "tracker_id": 42,
  "scenario_index": 0,
  "title": "Login with valid credentials succeeds",
  "parent_us_id": "112",
  "deduped": false,
  "reused": false,
  "steps_xml_path": ".workflow-artifacts/{run_id}/tc-steps-0.xml",
  "steps_md_path":  ".workflow-artifacts/{run_id}/tc-steps-0.md"
}
```

`reused: true` when the TC updated an existing tracker item; `false` when created fresh.

---

## Matching strategy

Title normalization (both sides):
1. Lowercase
2. Strip `[Pn]` / `[SKIP]` bracket prefix at start
3. Collapse whitespace
4. Trim leading/trailing punctuation

Exact normalized match → `action: "update"`. No match → `action: "create"`.
Existing TCs unmatched by any new scenario → `obsolete_tracker_ids`.

---

## Hard rules

- **Never aborts the pipeline.** Both phases log failures and continue.
- **Clean skip when no existing TCs.** `existing-tcs.json` and `reconciliation.json` are not written; Phase 3 runs as a fresh create-only run.
- **Graceful endpoint fallback.** 404, connection error, or unsupported verb → treated as clean skip.
- **Update failure falls back to create.** `generate-tc.sh` falls back to `create.sh` if `update-steps.sh` or `update.sh` fails, logging a warning.
