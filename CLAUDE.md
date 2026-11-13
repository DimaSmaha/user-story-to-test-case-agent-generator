# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Server Commands

```bash
npm run dev                     # Start server with hot reload (tsx --watch) — port 4000
npm run server                  # Start server once, no watch
npm run build                   # Compile TypeScript to dist/
npm start                       # Run compiled build (dist/server/production.js)
npm run auth                    # Playwright login — saves .playwright-auth/auth.json
npm run us:to:tc <story-id>     # Run full pipeline for a story via Claude Agent SDK
npm run typecheck               # TypeScript type check (no emit)
npm run lint                    # ESLint on server/, scripts/, helpers/
npm run format                  # Prettier on server/, scripts/, helpers/
```

Docker:

```bash
npm run docker:dev              # Containerised dev with hot reload
npm run docker:build            # Build production image (us-tc-generator:latest)
docker compose -f docker-compose.prod.yml up -d   # Start prod stack (app + nginx on :80)
docker compose -f docker-compose.prod.yml down    # Stop prod stack
```

## Environment

Copy `.env.sample` to `.env` before running the server or any skills.

Required vars:

| Var | Purpose |
|---|---|
| `ISSUE_TRACKER` | `fake` \| `github` \| `jira` \| `ado` \| `linear` — validated at startup |
| `FAKE_TRACKER_URL` | `http://localhost:3000` (or ngrok URL) — **only required when `ISSUE_TRACKER=fake`** |
| `APP_URL` | Target app URL for Playwright (e.g. `https://www.saucedemo.com`) |
| `APP_USERNAME` / `APP_PASSWORD` | Credentials used by `helpers/auth.ts` |
| `API_KEY` | Optional — if set, all `/api/*` routes require `X-API-Key` header |
| `SERVER_PORT` | Default `4000` |
| `JOB_TIMEOUT_MS` / `BATCH_TIMEOUT_MS` | Default 40 min / 60 min |

Skills source `.env` automatically via `_common.sh`. The fake tracker server must be running separately before using `ISSUE_TRACKER=fake`.

## Architecture

### Pipeline — User Story → Test Cases

**`/flow-1a-gt-us-to-tc`** — Story → Test Cases:
```
gt-story-planner → playwright-cli exploration → [ft-bug-reporter if bugs found] → gt-test-ideation → gt-test-case-generator → link TCs to story
```

**The orchestrator is fully autonomous — it never re-asks the user mid-run.** Missing inputs or env vars cause an immediate stop-and-report, not a prompt.

### Invocation

```bash
/flow-1a-gt-us-to-tc --us-id 112
```

### Artifact contracts

Each stage reads the previous stage's artifact from `.workflow-artifacts/{run_id}/` and writes its own. All files are JSON unless noted.

**`us.json`** — written by `gt-story-planner`
```json
{
  "id": "112",
  "title": "User can log in with valid credentials",
  "description": "...",
  "ac": ["Given valid credentials, user lands on inventory page", "..."],
  "url": "http://localhost:3000/tasks/112"
}
```
When story text is pasted directly: `"id": "manual"`, `"url": null`.

**`tracker-source.json`** — written by `gt-story-planner` (ID input only): the verbatim `get.sh` output. Never edited; the us.json reviewer uses it as the source of truth.

**`us.validation.json`** — written by the `us-json-gate` hook (not by the skill)
```json
{ "max_retries": 3, "status": "PASSED", "retries": 1, "mode": "subagent",
  "checked_by": "subagent (us-json-reviewer.md)", "notes": [], "checked_at": "..." }
```
`status`: `PASSED` | `RETRYING` | `FAILED` (flow-1a aborts) | `UNVERIFIED` (reviewer could not run).

**`exploration.json`** — written by Phase 1.5 (app exploration)
```json
{
  "run_id": "gtc-20240601-143012",
  "us_id": "112",
  "pages_visited": ["login", "inventory"],
  "observations": ["Login form has username and password fields", "..."],
  "bugs": [
    {
      "title": "Submit button enabled with empty fields",
      "description": "Button is clickable before any input is entered",
      "steps_to_reproduce": ["Navigate to login page", "Leave both fields empty", "Observe Login button state"],
      "severity": "medium",
      "screenshot": null
    }
  ]
}
```
`bugs` is `[]` when no defects are found. Non-empty `bugs` trigger Phase 2.5 (`ft-bug-reporter`).
`screenshot` is `null` by default. Set to a PNG path only when a confirmed bug is documented with `playwright-cli screenshot --filename=...`.

**`scenarios.md`** — written by `gt-story-planner`
```markdown
# Test Scenarios: <story title>

## [P1] Auth: Login with valid credentials succeeds
## [P1] Auth: Login with invalid password shows error "..."
## [P2] Auth: Login with empty username shows validation error
## [SKIP] Auth: Logout flow — already covered in tests/example.spec.ts

## Exploratory Charters
### Charter: Login
- **Mission:** Explore login form with Interruption heuristic ...
- **Heuristics:** Boundary | Interruption | State machine
- **Personas:** Speedrunner | Attacker
```

Format: `## [P{priority}] <Module>: <description>`. SKIP entries include the covering spec path. Every non-SKIP scenario must have at least one negative case.

**`test-ideas.json`** — written by `gt-test-ideation`
```json
[
  {
    "index": 0,
    "scenario": "[P1] Auth: Login with valid credentials succeeds",
    "conditions": ["User is on the login page", "User has a valid account"],
    "ideas": ["User enters valid username 'standard_user'", "User enters valid password", "User clicks Login", "Redirected to inventory"],
    "verifications": ["Username field shows value", "Password field is filled", "Navigation triggered", "URL contains '/inventory'"],
    "navigations": ["login", "inventory"],
    "ac_trace": ["AC1: User can log in with valid credentials"],
    "reusable_helpers": ["LoginPage.login(username, password)", "InventoryPage.isLoaded()"]
  }
]
```
Constraint: `ideas.length === verifications.length` for every unit — hard fail if violated.

**`tc-N.json`** — written by `gt-test-case-generator` (N = scenario index) — tracker registration record
```json
{
  "id": "tc-1234567890",
  "tracker_id": 42,
  "scenario_index": 0,
  "title": "Login with valid credentials succeeds",
  "parent_us_id": "112",
  "deduped": false,
  "reused": false,
  "steps_xml_path": ".workflow-artifacts/gtc-.../tc-steps-0.xml",
  "steps_md_path":  ".workflow-artifacts/gtc-.../tc-steps-0.md"
}
```
Ideation fields (`ideas`, `verifications`, `conditions`, etc.) are NOT duplicated here — read from `test-ideas.json[scenario_index]`.

**`bug-{i}.json`** — written by `ft-bug-reporter` (optional, one per exploration bug)
```json
{
  "id": 0,
  "title": "Submit button enabled with empty fields",
  "url": "http://localhost:3000/bugs/1",
  "severity": "medium",
  "summary": "App-bug found during story exploration",
  "evidence_paths": [".workflow-artifacts/gtc-20240601-143012/exploration-bug-0.png"],
  "deduped": false
}
```

### Phase compact protocol

The orchestrator emits a `<!-- PHASE COMPACT -->` JSON block after each stage and drops full phase output from active context. This prevents context overflow on long runs.

```json
<!-- PHASE COMPACT: gt-story-planner scenario=0 -->
{
  "phase": "gt-story-planner",
  "scenario_index": 0,
  "status": "SUCCESS",
  "us_id": "112",
  "title": "User can log in with valid credentials",
  "scenario_count": 5
}
```

Fields retained per phase:

| Phase | Fields retained |
|---|---|
| `gt-story-planner` (1) | `us_id`, `title`, `scenario_count` |
| App exploration (1.5) | `pages_visited_count`, `bug_count` |
| `gt-test-ideation` (2) | `total_ideas`, `scenario_count` |
| Bug reporting (2.5) | `bugs_filed`, `bugs_failed` |
| `gt-test-case-generator` (3) | `tc_id`, `scenario_index`, `title`, `deduped` |

### Feedback loop (gt-story-planner → us.json)

`gt-story-planner` forks into the `story-planner` subagent (`context: fork`). A `SubagentStop` hook in `.claude/settings.json` runs `.claude/hooks/us-json-gate.mjs`, which checks `us.json` and, on failure, blocks the stop with feedback the planner must fix (max 3 retries, counted per `agent_id`).
Exactly one validator is active — the `--mode` in the `.claude/settings.json` hook command:

| `--mode` | Validator | Code |
|---|---|---|
| `subagent` | `.claude/agents/us-json-reviewer.md` run as an agent via `claude -p --agent us-json-reviewer` (needs `claude` on PATH; Read tool, multi-turn; prompt is just `Review <path>`, it reads `us.json` + `tracker-source.json` itself) | `.claude/hooks/lib/review-us-json-subagent.mjs` |
| `script` | deterministic contract check, no LLM (also a CLI: `node .claude/hooks/lib/validate-us-json.mjs <path>`) | `.claude/hooks/lib/validate-us-json.mjs` |
| `llm` | one LLM call, no tools, `us.json` + `tracker-source.json` pasted in; rules = body of `us-json-reviewer.md` | `.claude/hooks/lib/review-us-json-llm.mjs` |

Switching mode needs a new Claude Code session. Every run records the active validator in `us.validation.json` (`mode`, `checked_by`) and in the feedback text (`checked by: ...`).
Hook state and log: `.workflow-artifacts/.hook-state/` (`us-json-gate.log` shows every gate run).

### Skills system

Skills live in `.claude/skills/` (invocable via `/skill-name`). Each skill has a `SKILL.md` that defines its contract, inputs, outputs, and trigger conditions.

- **`gt-*`** — generation stages: `gt-story-planner`, `gt-test-ideation`, `gt-test-case-generator`
- **`ft-bug-reporter`** — files tracker bugs for defects found during app exploration
- **`operations-with-issue-tracker`** — tracker-agnostic wrapper; all skills call this instead of hitting tracker APIs directly

Additional reference skills in `.agents/skills/`: `playwright-best-practices`, `playwright-test-improver`, `decomposition-coverage`, `decomposition-maintenance`, `userstory-to-testcase`.

**Explicit-invocation-only skills** (never auto-triggered): `flow-1a-gt-us-to-tc`.

**Hard constraints shared by all skills:**
- Use `npx` (not `pnpm`) for Playwright commands
- `gt-test-case-generator`: verbatim copy of ideas/verifications; `ideas.length === verifications.length`
- `gt-story-planner`: mandatory live app exploration via `playwright-cli` before writing artifacts
- `flow-1a` Phase 1.5: dedicated bug-hunting exploration via `playwright-cli`; writes `exploration.json`; non-empty `bugs[]` triggers Phase 2.5
- Fake tracker returns `{"id":0,...}` on create — this is expected, not an error
- All tracker operations go through wrapper skills/scripts only
- Never prefix bash calls with `cd /path && source .env &&` — working directory and env are already set; doing so bypasses the permission allowlist

### Issue tracker scripts

All tracker operations go through `.claude/skills/operations-with-issue-tracker/scripts/`:

```bash
# Must run once per session before any other script
ISSUE_TRACKER=fake FAKE_TRACKER_URL=http://localhost:3000 \
  bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh

# Fetch a work item (--type: Bug | Task | Test Case)
bash .claude/skills/operations-with-issue-tracker/scripts/get.sh --id 112 --type Task

# Create a work item
bash .claude/skills/operations-with-issue-tracker/scripts/create.sh \
  --type "Bug" --title "..." --description-file /tmp/desc.md \
  --tag "claude-generated" --dedupe-by title
```

Scripts emit JSON only to stdout. Create returns `{"id":0,...}` on the fake tracker (expected, not an error).

> **Windows fallback:** if `bash` is not in PATH, set `GIT_BASH` in `.env` and invoke scripts as:
> ```powershell
> $bash = if ($env:GIT_BASH) { $env:GIT_BASH } else { "C:\Program Files\Git\usr\bin\bash.exe" }
> & $bash "-c" "bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh"
> ```
> If `playwright-cli` and `npx` are both unavailable, set `NODE_EXE` in `.env` and invoke directly:
> ```powershell
> $node = if ($env:NODE_EXE) { $env:NODE_EXE } else { "C:\Program Files\nodejs\node.exe" }
> & $node "node_modules\@playwright\cli\playwright-cli.js" <command>
> ```

### Tests and pages

Tests target [SauceDemo](https://www.saucedemo.com/). Page Object Model lives in `tests/pages/` with a fixture in `pages.fixture.ts` that wires all pages. Coverage state is tracked in `decomposition/saucedemo.markmap.md`.

### Workflow artifacts

`.workflow-artifacts/` is the shared scratch space for all pipeline runs. It holds JSON handoff files, screenshots, and `.tracker-cache.json` (preflight output). This directory is gitignored.

Artifact handoff chain:
```
us.json → exploration.json → scenarios.md → test-ideas.json → tc-N.json
                   ↓
              bug-{i}.json (optional — when Phase 1.5 exploration finds defects)
```
