#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

dispatch_to_adapter() {
  local verb="${1:?missing verb}"
  shift || true

  local tracker
  tracker="$(tracker_from_env)"
  local adapter_dir="${SCRIPT_DIR}/adapters/${tracker}"
  local adapter="${adapter_dir}/${verb}.sh"
  local fallback="${adapter_dir}/_not_implemented.sh"

  if [[ ! -f "$adapter" ]]; then
    [[ -f "$fallback" ]] || emit_error "adapter not found" "tracker" "$tracker" "verb" "$verb"
    adapter="$fallback"
  fi

  local stdout_file stderr_file rc raw err normalized
  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"

  if [[ "$adapter" == "$fallback" ]]; then
    if bash "$adapter" "$verb" "$@" >"$stdout_file" 2>"$stderr_file"; then
      raw="$(cat "$stdout_file")"
      if [[ -z "${raw//[[:space:]]/}" ]]; then
        raw='{"ok":true}'
      fi
      is_valid_json "$raw" || emit_error "adapter returned invalid JSON" "tracker" "$tracker" "verb" "$verb"
      normalized="$(normalize_json "$raw")"
      rm -f "$stdout_file" "$stderr_file"
      printf '%s\n' "$normalized"
      return 0
    fi
  else
    if bash "$adapter" "$@" >"$stdout_file" 2>"$stderr_file"; then
      raw="$(cat "$stdout_file")"
      if [[ -z "${raw//[[:space:]]/}" ]]; then
        raw='{"ok":true}'
      fi
      is_valid_json "$raw" || emit_error "adapter returned invalid JSON" "tracker" "$tracker" "verb" "$verb"
      normalized="$(normalize_json "$raw")"
      rm -f "$stdout_file" "$stderr_file"
      printf '%s\n' "$normalized"
      return 0
    fi
  fi

  rc=$?
  raw="$(cat "$stdout_file" 2>/dev/null || true)"
  err="$(cat "$stderr_file" 2>/dev/null || true)"
  rm -f "$stdout_file" "$stderr_file"

  if [[ -n "${raw//[[:space:]]/}" ]] && is_valid_json "$raw"; then
    printf '%s\n' "$(normalize_json "$raw")"
    return "$rc"
  fi

  err="$(printf '%s' "$err" | tr '\r\n' ' ')"
  emit_error "adapter failed" "tracker" "$tracker" "verb" "$verb" "stderr" "$err"
}
