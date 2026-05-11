---
name: gt-test-ideation
description: >
  Pipeline A ideation stage that expands planned scenarios into structured test
  design units used by test-case generation and spec writing. Use when asked for
  test ideas, test design expansion, or conversion of scenarios into conditions,
  verifications, and navigations.
---

# gt-test-ideation

Expand each scenario from `scenarios.md` into a fully structured ideation unit
with conditions, ideas, verifications, navigations, and reusable helper references.

## When this skill fits

Use it for requests like:

- "generate test ideas for these scenarios"
- "expand scenarios into test design"
- "create test-ideas.json from the scenario list"
- "what steps and assertions should each scenario have?"

Do **not** use it for:

- creating tracker test cases (use `gt-test-case-generator`)
- writing Playwright code (use `gt-spec-writer`)

## What comes before and after

- **Before:** `gt-story-planner` produces `us.json` and `scenarios.md`
- **After:** `gt-test-case-generator` reads `test-ideas.json`

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
enforced by downstream skills.

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

Tell the user: "Pass `test-ideas.json` to `gt-test-case-generator` with a scenario index to create tracker test cases."

## Hard rules

- `ideas.length` must equal `verifications.length` for every unit — fail fast if not.
- Reuse existing page object methods; scan `tests/pages/` — do not invent methods.
- Use `playwright-cli` to verify actual error messages and navigation paths for negative scenarios.
- Do not create tracker items or write Playwright code at this stage.
