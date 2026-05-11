#!/usr/bin/env bash
set -euo pipefail

# Reads FAKE_TRACKER_URL from env — required, no default.
# Supports localhost:3000 for local dev or an ngrok HTTPS URL.
: "${FAKE_TRACKER_URL:?FAKE_TRACKER_URL is required (e.g. http://localhost:3000 or https://<ngrok>.ngrok.io)}"

fake_type_to_path() {
  local type="${1:?missing type}"
  case "$type" in
    "Bug")         printf 'bugs' ;;
    "Test Case")   printf 'testcases' ;;
    "Task"|"User Story"|*) printf 'tasks' ;;
  esac
}

# curl_with_retry <method> <url> [<extra curl args...>]
# Retries up to 3 times on HTTP 500 or connection failure.
# Prints response body on success; emits error JSON and exits 1 on all failures.
curl_with_retry() {
  local method="${1:?missing method}"
  local url="${2:?missing url}"
  shift 2
  local attempt body http_code
  for attempt in 1 2 3; do
    body="$(curl -s -w '\n%{http_code}' -X "$method" "$url" "$@" 2>/dev/null || true)"
    http_code="$(printf '%s' "$body" | tail -n1)"
    body="$(printf '%s' "$body" | head -n -1)"
    if [[ "$http_code" =~ ^[2][0-9]{2}$ ]]; then
      printf '%s' "$body"
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      sleep 1
    fi
  done
  printf '{"error":"fake tracker returned HTTP %s after 3 attempts","url":"%s"}\n' "$http_code" "$url"
  exit 1
}
