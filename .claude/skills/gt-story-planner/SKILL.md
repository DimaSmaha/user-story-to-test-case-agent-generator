---
name: gt-story-planner
description: >
  First stage of Pipeline A that converts a user story (ID or pasted text) into
  normalized planning artifacts for test generation. Use when asked to plan tests
  for a user story, break a story into scenarios, or prepare scenario coverage
  before writing Playwright tests.
---

# gt-story-planner

Convert a user story into `us.json` and `scenarios.md` — the planning inputs for
downstream test ideation and spec generation.

## When this skill fits

Use it for requests like:

- "plan test coverage for user story 112"
- "analyze this story and list scenarios to test"
- "what should we test for this feature?"
- "break this story into test scenarios"

Do **not** use it for:

- generating test ideas or steps (use `gt-test-ideation`)
- creating tracker test cases (use `gt-test-case-generator`)
- writing Playwright specs (use `gt-spec-writer`)

## What comes before and after

- **Before:** a user story (ID from the tracker, or pasted text)
- **After:** `gt-test-ideation` reads `us.json` and `scenarios.md`

## Inputs

Either:
- A user story ID (fetched from the tracker), or
- User story title + description/acceptance criteria pasted directly

If neither is provided, ask:

```text
Please provide a user story ID or paste the title and description/AC directly.
```

## Workflow

### 1. Fetch or synthesize us.json

**If an ID was provided:**

Run preflight if not already done:
```bash
bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh
```

Fetch the story:
```bash
bash .claude/skills/operations-with-issue-tracker/scripts/get.sh --id <id>
```

Write the result to `.workflow-artifacts/{run_id}/us.json`.

**If text was pasted:**

Synthesize `us.json` directly:

```json
{
  "id": "manual",
  "title": "<story title>",
  "description": "<full description>",
  "ac": [
    "As a user, I can ...",
    "Given ... When ... Then ..."
  ],
  "url": null
}
```

Write to `.workflow-artifacts/{run_id}/us.json`.

### 2. Explore the app with playwright-cli

**This step is mandatory for any story that involves UI behavior.**

Use `playwright-cli` to navigate to the feature area described in the story:

1. Open the app URL and navigate to the relevant page/feature
2. Take a snapshot to observe the actual UI: field labels, button names, validation messages, navigation flow
3. Try the happy path described in the acceptance criteria
4. Note any edge states, error messages, or conditional UI not explicit in the story

Record your observations — these feed into scenario design and prevent writing tests against assumptions that don't match the actual UI.

### 3. Check for already-covered scenarios

Scan `tests/` for existing specs that cover this user story or feature area:

```bash
grep -r "<feature keywords>" tests/ --include="*.spec.ts" -l
```

Read matching specs to understand what is already covered. Mark those scenarios
as `[SKIP]` in the output.

### 4. Design scenarios

For each acceptance criterion in `us.json.ac`, generate at minimum:

- **1 happy path** — AC fulfilled with valid data and expected navigation
- **1 negative / invalid input** — wrong data type, empty required field, over-limit input, special characters
- **1 error state** — verify the correct error message is shown (not just that an error appears)

Additionally design from these categories as applicable:

| Category | Description |
|---|---|
| Boundary values | Min/max field values, edge numbers, length limits |
| Cancel / interrupt | User abandons mid-flow, navigates away, clicks back |
| Read-only verification | Data persisted correctly after save; correct display |
| Exploratory | Suspicious behavior noticed during playwright-cli exploration |
| Concurrency | Two users performing the same action, quick double-clicks |
| Role / permission violation | Attempt the action as an unauthorized role or unauthenticated user |
| Cross-field validation | Conflicting field combinations that each pass individual rules but fail together |
| Data integrity | Delete a parent record while a child exists; reference a deleted entity |
| Session interruption | Token expiry mid-flow, forced logout, page reload during an in-progress operation |

**Negative scenarios are mandatory** — every AC must have at least one negative test.

### 5. Write exploratory charters

For each acceptance criterion, generate one exploratory charter. Append a
`## Exploratory Charters` section to `scenarios.md` after the scenario list.

Charter format:

```markdown
### Charter: <AC short label>
- **Mission:** Explore [feature area] with [heuristic] to discover [risk type]
- **Heuristics:** CRUD completeness | Boundary (too big / too small / empty) | Interruption (back, refresh, network drop, session expiry) | State machine (sequence violations)
- **Personas:**
  - Speedrunner — clicks fast, skips reading, submits before page settles
  - New User — unfamiliar with field rules, tries unexpected sequences
  - Attacker — probes permission boundaries, tests unauthorized access paths
```

Include only heuristics and personas that are relevant to the AC. Skip any that
do not apply — do not pad with generic text.

### 6. Write scenarios.md

Write `.workflow-artifacts/{run_id}/scenarios.md`:

```markdown
# Test Scenarios: <story title>

## [P1] Auth: Login with valid credentials succeeds
## [P1] Auth: Login with invalid password shows error message "Invalid username or password"
## [P2] Auth: Login with empty username shows validation error
## [P2] Auth: Login form blocks submission when password field is empty
## [P2] Auth: Login attempt as unauthenticated API call returns 401
## [P3] Auth: Cancel login flow returns to landing page
## [P3] Auth: Session token expiry during login redirects to login page
## [SKIP] Auth: Logout flow — already covered in tests/example.spec.ts

## Exploratory Charters

### Charter: Login
- **Mission:** Explore login form with Interruption heuristic to discover race conditions on fast submission
- **Heuristics:** Boundary (empty / max-length credentials) | Interruption (network drop mid-submit, page refresh) | State machine (submit while validation is pending)
- **Personas:**
  - Speedrunner — submits before autofill completes
  - Attacker — tries SQL injection in username field, reuses expired session token
```

Format for scenario list: `## [P{priority}] <Module>: <description>` — priority 1 = highest.
SKIP entries include the path of the covering spec.

## Output

- `.workflow-artifacts/{run_id}/us.json`
- `.workflow-artifacts/{run_id}/scenarios.md` (includes scenario list + `## Exploratory Charters` section)

Tell the user: "Pass these artifacts to `gt-test-ideation` to expand scenarios into test design."

## Hard rules

- **Fully agentic — never pause for input:** run all bash commands directly (e.g., `bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh`). Never prefix with `cd /path &&` or `source .env &&`; the working directory and env vars are already available. Do not ask the user anything mid-execution.
- Include at least one negative case per acceptance criterion — no exceptions.
- Use `playwright-cli` to verify UI state before designing scenarios.
- Do not create tracker test cases or write Playwright code at this stage.
- Do not invent scenario details not supported by the story or live app observation.
- Write artifacts only in `.workflow-artifacts/{run_id}/`.
