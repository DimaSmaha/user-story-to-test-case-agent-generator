#!/usr/bin/env bash
# Graceful no-op for verbs not supported by the fake tracker:
# update, update-steps, link, comment, query, transition.
printf '{"ok":true,"skipped":true,"reason":"verb not supported by fake tracker"}\n'
exit 0
