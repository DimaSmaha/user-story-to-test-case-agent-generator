---
name: gt-story-planner
description: >
  First stage of Pipeline A that converts a user story (ID or pasted text) into
  normalized planning artifacts for test generation. Use when asked to plan tests
  for a user story, break a story into scenarios, or prepare scenario coverage
  before writing Playwright tests.
context: fork
agent: story-planner
background: false
---

# gt-story-planner

Convert a user story into `us.json` and `scenarios.md` — the planning inputs for
downstream test ideation and spec generation.

> This skill runs in its own `story-planner` subagent (`context: fork`) and does
> not see the caller's conversation. Everything it needs comes from the arguments.

## Inputs

Arguments: $ARGUMENTS

- `--run-id <run_id>` — artifact directory name. If absent, generate one:
  ```bash
  run_id="gtc-$(date +%Y%m%d-%H%M%S)"
  mkdir -p ".workflow-artifacts/${run_id}"
  ```
- Plus either:
  - `--us-id <id>` — user story ID (fetched from the tracker), or
  - `--us-text "<title + description/AC>"` — story pasted directly. A bare ID or
    pasted text without a flag is accepted too.

If neither a story ID nor story text is provided, **stop** and report:

```text
gt-story-planner requires --us-id <id> or --us-text "<story>".
```

Never ask the user — this skill runs autonomously.

## us.json contract (validated on finish)

When this skill finishes, the `SubagentStop` hook `.claude/hooks/us-json-gate.mjs`
checks `us.json` with one validator (reviewer subagent, deterministic script, or a
single LLM call — set by `--mode` in `.claude/settings.json`). Every rule must hold:

| Field | Rule |
|---|---|
| `id` | non-empty **string** — tracker id as a string (`"114"`, not `114`), or `"manual"` for pasted text |
| `title` | non-empty string — the story title exactly as in the tracker / pasted text |
| `description` | string — the full story description, not a summary |
| `ac` | array with ≥ 1 item, every item a non-empty string; taken from the tracker AC list, or derived from the description only when the tracker has none — never invented; no placeholders, no duplicates |
| `url` | tracker URL string; `null` only when `id` is `"manual"` |

Extra keys (e.g. `notes`) are allowed.

If the hook sends feedback (`us.json validation FAILED (retry N/3)`), fix
`us.json` **in place** at the same path, update `scenarios.md` if the ACs
changed, then finish again. After 3 failed retries the run is marked `FAILED`
in `.workflow-artifacts/{run_id}/us.validation.json`.

## Workflow

### 1. Fetch or synthesize us.json

**If an ID was provided:**

Run preflight if not already done:
```bash
bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh
```

Fetch the story and keep the raw tracker response — the us.json reviewer compares
against it:
```bash
bash .claude/skills/operations-with-issue-tracker/scripts/get.sh --id <id> > .workflow-artifacts/<run_id>/tracker-source.json
```
Never edit `tracker-source.json` — it must stay the tracker's verbatim output.

Map it to the us.json contract above (`id` as a string, `ac` from `acl`, or derived
from `description` when `acl` is empty, `url` from the tracker) and write
`.workflow-artifacts/{run_id}/us.json`.

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

0. Load the saved auth state before navigating (REQUIRED):
   ```bash
   playwright-cli state-load .playwright-auth/auth.json
   ```
   If the file does not exist, stop: report "Auth state missing — run `npm run auth` first."
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

- `.workflow-artifacts/{run_id}/tracker-source.json` — raw `get.sh` output (ID input only)
- `.workflow-artifacts/{run_id}/us.json`
- `.workflow-artifacts/{run_id}/scenarios.md` (includes scenario list + `## Exploratory Charters` section)
- `.workflow-artifacts/{run_id}/us.validation.json` — written by the finish hook, not by this skill

Final message — a single handoff line for the caller:

```text
run_id=<run_id> us_id=<id> title="<title>" scenario_count=<N>
```

## Hard rules

- Include at least one negative case per acceptance criterion — no exceptions.
- Use `playwright-cli` to verify UI state before designing scenarios.
- Do not create tracker test cases or write Playwright code at this stage.
- Do not invent scenario details not supported by the story or live app observation.
- Write artifacts only in `.workflow-artifacts/{run_id}/`.
