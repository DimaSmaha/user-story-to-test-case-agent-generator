---
name: operations-with-issue-tracker
description: >
  Unified issue-tracker wrapper skill for downstream agentic flows. Use when
  any workflow needs to read, create, update, link, comment on, query, or
  transition work items. Supports GitHub Issues, ADO, Jira, Linear, and the
  fake mock tracker (localhost or ngrok). Strongly prefer this skill over direct
  tracker CLI/API calls so all callers share one stable JSON contract.
---

# operations-with-issue-tracker

Stable JSON interface for issue-tracker operations. All callers must use these
wrapper scripts and must not invoke tracker-specific CLIs or APIs directly.

## When this skill fits

Use it for:

- Fetching a user story, bug, or test case by ID
- Creating a bug, test case, or task in the tracker
- Updating, linking, or commenting on work items
- Any tracker operation inside Pipeline A or Pipeline B

Do **not** call tracker APIs directly — always go through these scripts.

## Required environment

Set `ISSUE_TRACKER` to one of: `ado`, `github`, `jira`, `linear`, `fake`

| Tracker | Required vars |
|---|---|
| `ado` | `ADO_TOKEN` |
| `github` | `GITHUB_TOKEN` or `GH_TOKEN`, `REPO_OWNER`, `REPO_NAME` |
| `jira` | `JIRA_BASE_URL`, `JIRA_TOKEN` |
| `linear` | `LINEAR_TOKEN` |
| `fake` | `FAKE_TRACKER_URL` (ngrok URL or `http://localhost:3000`) |

### Fake tracker (`ISSUE_TRACKER=fake`)

The fake tracker is a lightweight mock REST server. No auth is needed.

```bash
export ISSUE_TRACKER=fake
export FAKE_TRACKER_URL=https://<your-ngrok-domain>  # or http://localhost:3000
```

Supported endpoints: `GET /tasks/:id`, `GET /bugs/:id`, `GET /testcases/:id`,
`POST /tasks/create`, `POST /bugs/create`, `POST /testcases/create`

Unsupported verbs (update, link, comment, query, transition) return
`{"ok":true,"skipped":true}` — they do not fail.

The fake tracker returns `{"status":"ok"}` on create with no ID.
The adapter normalizes this to `{"id":0,"url":"...","deduped":false}`.

## Script inventory

All scripts emit JSON only to stdout.

| Script | Purpose |
|---|---|
| `scripts/preflight.sh` | Validate config and write cache |
| `scripts/get.sh --id <id>` | Fetch work item by ID |
| `scripts/create.sh --type <t> --title <t>` | Create work item |
| `scripts/update.sh --id <id>` | Update fields |
| `scripts/update-steps.sh --id <id>` | Update test case steps |
| `scripts/link.sh --source <id> --target <id>` | Link two items |
| `scripts/comment.sh --id <id> --body-file <f>` | Add comment |
| `scripts/query.sh --query <q>` | Search work items |
| `scripts/transition.sh --id <id> --to <state>` | Change state |

## Workflow

### 1. Run preflight once per session

```bash
bash .claude/skills/operations-with-issue-tracker/scripts/preflight.sh
```

This validates the config and writes a cache file. All other scripts check this
cache before running.

### 2. Fetch a work item

```bash
bash .claude/skills/operations-with-issue-tracker/scripts/get.sh --id 112
```

Returns normalized JSON regardless of which tracker is configured:
```json
{
  "id": 112,
  "type": "Task",
  "title": "...",
  "description": "...",
  "acl": [],
  "parent_id": null,
  "url": "...",
  "steps_xml": "",
  "image_urls": []
}
```

### 3. Create a work item

```bash
bash .claude/skills/operations-with-issue-tracker/scripts/create.sh \
  --type "Bug" \
  --title "Login button unresponsive on Safari" \
  --description-file /tmp/bug-desc.md \
  --tag "claude-generated" \
  --dedupe-by title
```

Returns:
```json
{ "id": 11111, "url": "https://...", "deduped": false }
```

With fake tracker: `{"id":0,"url":"http://localhost:3000/bugs/create","deduped":false}`

## Output contract

- **Success:** domain object (e.g. `{"id":123,...}` or `{"ok":true}`)
- **Failure:** `{"error":"human-readable reason",...context}` + non-zero exit

## Rules

1. Run `preflight.sh` once before any other script in a session.
2. Use `--dedupe-by` on create calls to avoid duplicate items.
3. Do not hardcode tracker field IDs in caller code.
4. Keep caller logic tracker-agnostic — adapter scripts handle tracker specifics.
5. With the fake tracker, `id:0` on create is expected and valid.

## References

- Detailed contracts: `references/tracker-schema.md`
- Script usage examples: `references/scripts.md`
- Adapter behavior: `references/adapters.md`
