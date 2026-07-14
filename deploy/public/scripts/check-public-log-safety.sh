#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
log_file=${1:-}

[ -n "$log_file" ] || {
  printf 'Usage: %s /path/to/log-file\n' "$0" >&2
  exit 2
}
[ -f "$log_file" ] || {
  printf 'Log file not found: %s\n' "$log_file" >&2
  exit 2
}

forbidden='anon_session|set-cookie|cookie:|authorization:|bearer[[:space:]]+[A-Za-z0-9._-]+|database_url|postgres(ql)?://|ai_api_key|api[_-]?key[[:space:]]*[:=]|"?prompt"?[[:space:]]*[:=]|cf-connecting-ip|[0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]{4,}'
if grep -Ein "$forbidden" "$log_file"; then
  printf '%s\n' 'Unsafe log content detected.' >&2
  exit 1
fi

printf '%s\n' 'No configured secret, cookie, prompt, or raw IP patterns found.'
