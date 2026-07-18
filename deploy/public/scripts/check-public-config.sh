#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
compose_file="$root_dir/docker-compose.public.yml"
env_file="$root_dir/.env.public"

[ -f "$env_file" ] || {
  printf '%s\n' "Missing $env_file; copy .env.public.example and fill it first." >&2
  exit 1
}

required_vars='PUBLIC_WEB_PORT PUBLIC_TLS_CERT_PATH PUBLIC_TLS_KEY_PATH PUBLIC_ORIGIN DATABASE_DOCKER_NETWORK DATABASE_URL AI_BASE_URL AI_API_KEY AI_MODEL ANON_TOKEN_SECRET IP_HASH_SECRET IDEMPOTENCY_SECRET TIMEZONE PUBLIC_GENERATION_ENABLED'
for name in $required_vars; do
  value=$(grep -E "^${name}=" "$env_file" | tail -n 1 | cut -d= -f2- || true)
  [ -n "$value" ] || {
    printf 'Missing %s in %s\n' "$name" "$env_file" >&2
    exit 1
  }
done

. "$env_file"
case "$PUBLIC_ORIGIN" in https://*) ;; *) printf '%s\n' 'PUBLIC_ORIGIN must use https.' >&2; exit 1 ;; esac
[ "$TIMEZONE" = "Asia/Shanghai" ] || {
  printf '%s\n' 'TIMEZONE must be Asia/Shanghai.' >&2
  exit 1
}
case "$PUBLIC_GENERATION_ENABLED" in true|false) ;; *) printf '%s\n' 'PUBLIC_GENERATION_ENABLED must be true or false.' >&2; exit 1 ;; esac
for name in ANON_TOKEN_SECRET IP_HASH_SECRET IDEMPOTENCY_SECRET; do
  eval "value=\${$name}"
  [ "${#value}" -ge 32 ] || {
    printf '%s must contain at least 32 characters.\n' "$name" >&2
    exit 1
  }
done

docker network inspect "$DATABASE_DOCKER_NETWORK" >/dev/null 2>&1 || {
  printf 'Docker network not found: %s\n' "$DATABASE_DOCKER_NETWORK" >&2
  exit 1
}

[ -f "$PUBLIC_TLS_CERT_PATH" ] || {
  printf 'TLS certificate not found: %s\n' "$PUBLIC_TLS_CERT_PATH" >&2
  exit 1
}
[ -f "$PUBLIC_TLS_KEY_PATH" ] || {
  printf 'TLS key not found: %s\n' "$PUBLIC_TLS_KEY_PATH" >&2
  exit 1
}

docker compose --env-file "$env_file" -f "$compose_file" config --quiet
printf '%s\n' 'Public deployment configuration is valid.'
