#!/usr/bin/env sh
set -eu

: "${PUBLIC_ORIGIN:?Set PUBLIC_ORIGIN to the Cloudflare HTTPS origin.}"

case "$PUBLIC_ORIGIN" in
  https://*) ;;
  *) printf '%s\n' 'PUBLIC_ORIGIN must use https.' >&2; exit 1 ;;
esac

live=$(curl --fail --silent --show-error --max-time 10 "$PUBLIC_ORIGIN/health/live")
ready=$(curl --fail --silent --show-error --max-time 10 "$PUBLIC_ORIGIN/health/ready")
session_headers=$(mktemp "${TMPDIR:-/tmp}/public-session-headers.XXXXXX")
trap 'rm -f "$session_headers"' EXIT HUP INT TERM
session=$(curl --fail --silent --show-error --max-time 10 --cookie-jar "$session_headers" "$PUBLIC_ORIGIN/api/session")

printf '%s' "$live" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || {
  printf '%s\n' 'Live health response is invalid.' >&2
  exit 1
}
printf '%s' "$ready" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || {
  printf '%s\n' 'Ready health response is invalid.' >&2
  exit 1
}
printf '%s' "$session" | grep -Eq '"mode"[[:space:]]*:[[:space:]]*"public"' || {
  printf '%s\n' 'Public session response is invalid.' >&2
  exit 1
}
printf '%s\n' 'Public smoke check passed without calling image write endpoints.'
