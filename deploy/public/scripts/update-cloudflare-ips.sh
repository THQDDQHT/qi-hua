#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output="$script_dir/../nginx/cloudflare-trusted.conf"
tmp=$(mktemp "${TMPDIR:-/tmp}/cloudflare-trusted.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM

{
  printf '%s\n' '# Generated from https://www.cloudflare.com/ips-v4 and /ips-v6.'
  printf '%s\n' '# Do not edit manually; refresh before deployment.'
  curl --fail --silent --show-error --location https://www.cloudflare.com/ips-v4
  curl --fail --silent --show-error --location https://www.cloudflare.com/ips-v6
} | while IFS= read -r cidr; do
  case "$cidr" in
    ''|'#'*) continue ;;
    *) printf 'set_real_ip_from %s;\n' "$cidr" ;;
  esac
done > "$tmp"

mv "$tmp" "$output"
printf 'Updated %s\n' "$output"
