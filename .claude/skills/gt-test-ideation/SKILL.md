---
name: gt-test-ideation
description: >
  Pipeline A ideation stage that expands planned scenarios into structured test
  design units used by test-case generation and spec writing. Use when asked for
  test ideas, test design expansion, or conversion of scenarios into conditions,
  verifications, and navigations.
hooks:
  Stop:
    - hooks:
        - type: command
          command: node "$CLAUDE_PROJECT_DIR/.claude/hooks/artifact-gate.mjs" --trigger stop --artifact test-ideas.json
          timeout: 60
          once: true
---

# gt-test-ideation

Expand each scenario from `scenarios.md` into a fully structured ideation unit
with conditions, ideas, verifications, navigations, and reusable helper references.

## Inputs

**Required:** `us.json` and `scenarios.md` from `gt-story-planner`

If missing, check `.workflow-artifacts/` or ask the user to run `gt-story-planner` first.

## Workflow

### 1. Read planning artifacts

Load `us.json` (for context and AC trace) and `scenarios.md` (for the scenario list).
Skip any lines marked `[SKIP]`.

### 2. Catalog existing page object methods

Read these files to find reusable helpers:

```
tests/pages/login.page.ts
tests/pages/inventory.page.ts
tests/pages/cart.page.ts
tests/pages/checkout.page.ts
tests/fixtures/pages.fixture.ts
```

Build an internal map of available public methods. Use these in `reusable_helpers`
rather than inventing new patterns.

### 3. Expand each scenario into an ideation unit

For each non-SKIP scenario, produce a structured ideation unit:

| Field | Description |
|---|---|
| `scenario` | The scenario title from scenarios.md |
| `conditions` | Pre-conditions that must be true before the test starts |
| `ideas` | Ordered list of human-readable test steps (imperative mood) |
| `verifications` | What to assert for each step — **must match `ideas` in length and order** |
| `navigations` | Page/route transitions in order |
| `ac_trace` | Which acceptance criteria from `us.json.ac` this scenario covers |
| `reusable_helpers` | Existing page object methods applicable to this scenario |

### 4. Use playwright-cli for unclear navigation or conditional UI

If a scenario involves navigation flow, modals, error states, or conditional UI
that is not clear from the story text alone:

1. Use `playwright-cli` to navigate through the actual flow
2. Observe exact labels, validation messages, route changes, modal triggers
3. Use these observations to write accurate `ideas` and `verifications`

This is especially important for negative scenarios — error messages must match exactly.

### 5. Hard validate ideas vs verifications

Before writing any output, check for every ideation unit:

```
ideas.length === verifications.length
```

If they do not match — **stop and fix before continuing**. This constraint is
enforced by downstream skills, and by the validation hook (see
"test-ideas.json contract (validated)" below).

### 6. Write test-ideas.json

Write `.workflow-artifacts/{run_id}/test-ideas.json` as a JSON array:

```json
[
  {
    "index": 0,
    "scenario": "[P1] Auth: Login with valid credentials succeeds",
    "conditions": ["User is on the login page", "User has a valid account"],
    "ideas": [
      "User enters valid username 'standard_user'",
      "User enters valid password 'secret_sauce'",
      "User clicks the Login button",
      "User is redirected to the inventory page"
    ],
    "verifications": [
      "Username field shows 'standard_user'",
      "Password field is filled (masked)",
      "Login button click triggers navigation",
      "URL contains '/inventory' and inventory items are visible"
    ],
    "navigations": ["login", "inventory"],
    "ac_trace": ["AC1: User can log in with valid credentials"],
    "reusable_helpers": ["LoginPage.login(username, password)", "InventoryPage.isLoaded()"]
  }
]
```

### 7. Write test-ideas.md

Write `.workflow-artifacts/{run_id}/test-ideas.md` as a human-readable version
for review — one section per scenario with conditions, numbered steps, and assertions.

## Output

- `.workflow-artifacts/{run_id}/test-ideas.json`
- `.workflow-artifacts/{run_id}/test-ideas.md`
- `.workflow-artifacts/{run_id}/test-ideas.validation.json` — written by the validation hook, not by you

## test-ideas.json contract (validated)

`.claude/hooks/artifact-gate.mjs` checks `test-ideas.json` with the deterministic validator
`.claude/hooks/lib/validate-test-ideas.mjs`. The file passes only if:

- It is a non-empty JSON array of objects (units).
- `index` is an integer equal to the unit's position (0 … n-1).
- `scenario` is a non-empty string starting with `[P<n>] ` — the `scenarios.md` heading text without `## `.
- `conditions`, `ideas`, `verifications`, `navigations` are arrays with at least one item, each a non-empty string.
- **`verifications.length === ideas.length`** for every unit.
- `ac_trace` has at least one non-empty string. An item that starts with `ACn:` must name an existing
  criterion (`n` is the 1-based position in `us.json.ac`), and the text after `ACn: ` must be
  `us.json.ac[n-1]` verbatim (whitespace may differ).
- Ground truth: `scenarios.md` and `us.json` must be in the same run folder as `test-ideas.json`. If one is
  missing, write `test-ideas.json` into the run folder that holds them — never create or edit them yourself.
- `reusable_helpers` is an array of non-empty strings; `[]` when none apply.
- Coverage: every `## [P…]` heading in the same run folder's `scenarios.md` appears exactly once as a
  unit's `scenario`, in the same order, and no unit has a scenario that is not a heading there.
  `[SKIP]` headings and Exploratory Charters are ignored.

## Validation feedback

The active trigger is set in `.claude/hooks/artifact-gate.json` (`"trigger"`):
- `write` — a `PostToolUse` hook checks the file right after each Write/Edit of it; feedback appears
  next to that tool result.
- `stop` — the `Stop` hook in this skill's frontmatter checks it when your turn ends; feedback arrives
  as a stop-hook message. Inside `flow-1a` it skips itself (the run folder is already past ideation).

When feedback starting with `test-ideas.json validation FAILED (retry N/3)` arrives:
1. Fix `test-ideas.json` **in place** — same run folder, same path — so every listed point is resolved.
   Do not start a new run folder.
2. Update `test-ideas.md` to match.
3. Each note names one problem and one fix. Do not pad `ideas` / `verifications` with filler items to make
   the counts match, and do not edit `scenarios.md` / `us.json` to make the file pass.
4. If you cannot fix it (e.g. `scenarios.md` or `us.json` themselves are wrong, or a tool is denied):
   do not write a placeholder. With the `write` trigger, stop and say why. With the `stop` trigger, end your
   final message with a line starting `BLOCKED: <reason>` — the hook then records `FAILED` (with
   `blocked`) at once instead of sending more feedback.

When the feedback says all retries are used up: stop fixing, and reply with a message that starts with
`TEST-IDEAS VALIDATION FAILED after 3 retries — <path>` followed by the unresolved problems.
The status is recorded in `{run_dir}/test-ideas.validation.json`. A later passing version resets the
retry count, so a new problem in the same session gets its own 3 retries.

The `stop` hook is `once: true`: Claude Code removes it after its first run that does not block. If your turn
ends before `test-ideas.json` is written (e.g. you ask the user something), that run uses it up and a later
version is not checked — re-invoke the skill, or use the `write` trigger.

## Hard rules

- `ideas.length` must equal `verifications.length` for every unit — fail fast if not.
- Reuse existing page object methods; scan `tests/pages/` — do not invent methods.
- Use `playwright-cli` to verify actual error messages and navigation paths for negative scenarios.
- Do not create tracker items or write Playwright code at this stage.
