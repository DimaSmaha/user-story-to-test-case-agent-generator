# Tracker schema reference

This file is the source of truth for normalized JSON contracts emitted by `scripts/*.sh`.

## Common error envelope

```json
{ "error": "human-readable reason", "tracker": "github", "verb": "create" }
```

## `preflight.sh` success

```json
{
  "ok": true,
  "cached_path": ".workflow-artifacts/.tracker-cache.json",
  "tracker": "github",
  "org": "acme",
  "project": "platform"
}
```

## `get.sh` success

```json
{
  "id": 11111,
  "type": "User Story",
  "title": "...",
  "description": "plain text",
  "acl": [],
  "parent_id": null,
  "url": "https://...",
  "steps_xml": "",
  "image_urls": []
}
```

## `create.sh` success

```json
{ "id": 11111, "url": "https://...", "deduped": false }
```

## `update.sh` success

```json
{
  "id": 11111,
  "updated": { "severity": "high", "priority": "p1", "state": "In Progress" }
}
```

## `update-steps.sh` success

```json
{ "ok": true }
```

## `link.sh` success

```json
{ "ok": true, "existed": false }
```

## `comment.sh` success

```json
{ "ok": true }
```

## `query.sh` success

```json
{
  "results": [
    {
      "id": 11111,
      "type": "Bug",
      "title": "...",
      "state": "OPEN",
      "url": "https://..."
    }
  ],
  "count": 1
}
```

## `transition.sh` success

```json
{ "id": 11111, "from": "OPEN", "to": "Closed", "changed": true }
```
