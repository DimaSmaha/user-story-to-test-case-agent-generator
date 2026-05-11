# Script reference

All commands emit JSON only.

## Preflight

```bash
bash scripts/preflight.sh [--force]
```

## Get

```bash
bash scripts/get.sh --id 11111
```

## Create

```bash
bash scripts/create.sh \
  --type "Test Case" \
  --title "Validate checkout address" \
  --description-file .workflow-artifacts/desc.md \
  --parent 40001 \
  --parent-relation "Tests" \
  --tag "automation,smoke" \
  --dedupe-by title
```

## Update

```bash
bash scripts/update.sh --id 11111 --severity high --priority p1 --state "In Progress" --tag "triaged"
```

## Update steps

```bash
bash scripts/update-steps.sh --id 11111 --steps-file .workflow-artifacts/steps.xml --replace
```

## Link

```bash
bash scripts/link.sh --source 11111 --target 11110 --type Related
```

## Comment

```bash
bash scripts/comment.sh --id 11111 --body-file .workflow-artifacts/comment.md
```

## Query

```bash
bash scripts/query.sh --query "state:open label:type:bug" --limit 20
```

## Transition

```bash
bash scripts/transition.sh --id 11111 --to Closed
```
