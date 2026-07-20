#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
compose_file="$root_dir/docker-compose.public.yml"
env_file="$root_dir/.env.public"

[ -f "$env_file" ] || {
  printf '%s\n' "Missing $env_file; copy .env.public.example and fill it first." >&2
  exit 1
}

required_vars='PUBLIC_WEB_BIND_IP PUBLIC_WEB_PORT PUBLIC_WEB_HOST PUBLIC_ORIGIN DATABASE_DOCKER_NETWORK DATABASE_URL REDIS_ENV_FILE AI_BASE_URL AI_API_KEY AI_MODEL ANON_TOKEN_SECRET IP_HASH_SECRET IDEMPOTENCY_SECRET TIMEZONE PUBLIC_GENERATION_ENABLED UPSTREAM_TIMEOUT_MS RESERVATION_TTL_SECONDS EXECUTION_LEASE_SECONDS IMAGE_WORKER_CONCURRENCY GENERATION_STORAGE_DIR GENERATION_RESULT_TTL_SECONDS WORKER_HEALTH_PORT'
for name in $required_vars; do
  value=$(grep -E "^${name}=" "$env_file" | tail -n 1 | cut -d= -f2- || true)
  [ -n "$value" ] || {
    printf 'Missing %s in %s\n' "$name" "$env_file" >&2
    exit 1
  }
done

. "$env_file"
case "$PUBLIC_WEB_BIND_IP" in
  0.0.0.0) printf '%s\n' 'PUBLIC_WEB_BIND_IP must use one exact host address, not 0.0.0.0.' >&2; exit 1 ;;
esac
case "$PUBLIC_WEB_HOST" in
  ''|*/*|*:*|.*|*.|*[!A-Za-z0-9.-]*) printf '%s\n' 'PUBLIC_WEB_HOST must be one exact hostname without scheme, port, path, or wildcard.' >&2; exit 1 ;;
esac
case "$PUBLIC_ORIGIN" in https://*) ;; *) printf '%s\n' 'PUBLIC_ORIGIN must use https.' >&2; exit 1 ;; esac
case "$PUBLIC_ORIGIN" in "https://$PUBLIC_WEB_HOST"|"https://$PUBLIC_WEB_HOST/") ;; *) printf '%s\n' 'PUBLIC_ORIGIN must match PUBLIC_WEB_HOST.' >&2; exit 1 ;; esac
[ "$TIMEZONE" = "Asia/Shanghai" ] || {
  printf '%s\n' 'TIMEZONE must be Asia/Shanghai.' >&2
  exit 1
}
case "$PUBLIC_GENERATION_ENABLED" in true|false) ;; *) printf '%s\n' 'PUBLIC_GENERATION_ENABLED must be true or false.' >&2; exit 1 ;; esac
case "$GENERATION_STORAGE_DIR" in /data/public-generation-temp) ;; *) printf '%s\n' 'GENERATION_STORAGE_DIR must be /data/public-generation-temp.' >&2; exit 1 ;; esac
for name in ANON_TOKEN_SECRET IP_HASH_SECRET IDEMPOTENCY_SECRET; do
  eval "value=\${$name}"
  [ "${#value}" -ge 32 ] || {
    printf '%s must contain at least 32 characters.\n' "$name" >&2
    exit 1
  }
done

case "$IMAGE_WORKER_CONCURRENCY" in ''|*[!0-9]*) printf '%s\n' 'IMAGE_WORKER_CONCURRENCY must be an integer between 1 and 10.' >&2; exit 1 ;; esac
[ "$IMAGE_WORKER_CONCURRENCY" -ge 1 ] && [ "$IMAGE_WORKER_CONCURRENCY" -le 10 ] || {
  printf '%s\n' 'IMAGE_WORKER_CONCURRENCY must be an integer between 1 and 10.' >&2
  exit 1
}
for name in UPSTREAM_TIMEOUT_MS RESERVATION_TTL_SECONDS EXECUTION_LEASE_SECONDS GENERATION_RESULT_TTL_SECONDS; do
  eval "value=\${$name}"
  case "$value" in ''|*[!0-9]*) printf '%s must be a positive integer.\n' "$name" >&2; exit 1 ;; esac
  [ "$value" -gt 0 ] || {
    printf '%s must be a positive integer.\n' "$name" >&2
    exit 1
  }
done
[ $((EXECUTION_LEASE_SECONDS * 1000)) -gt $((UPSTREAM_TIMEOUT_MS + 5000)) ] || {
  printf '%s\n' 'EXECUTION_LEASE_SECONDS must exceed UPSTREAM_TIMEOUT_MS by at least 5 seconds.' >&2
  exit 1
}
case "$WORKER_HEALTH_PORT" in ''|*[!0-9]*) printf '%s\n' 'WORKER_HEALTH_PORT must be between 1 and 65535.' >&2; exit 1 ;; esac
[ "$WORKER_HEALTH_PORT" -ge 1 ] && [ "$WORKER_HEALTH_PORT" -le 65535 ] || {
  printf '%s\n' 'WORKER_HEALTH_PORT must be between 1 and 65535.' >&2
  exit 1
}

[ "${REDIS_ENV_FILE#/}" != "$REDIS_ENV_FILE" ] || {
  printf '%s\n' 'REDIS_ENV_FILE must be an absolute path.' >&2
  exit 1
}
[ -f "$REDIS_ENV_FILE" ] || {
  printf 'Redis environment file not found: %s\n' "$REDIS_ENV_FILE" >&2
  exit 1
}
redis_url=$(grep -E '^REDIS_URL=' "$REDIS_ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
redis_prefix=$(grep -E '^REDIS_PREFIX=' "$REDIS_ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
case "$redis_url" in redis://*:*@redis_shared:6379/*) ;; *) printf '%s\n' 'REDIS_URL must use the redis_shared business account.' >&2; exit 1 ;; esac
redis_credentials=${redis_url#redis://}
redis_credentials=${redis_credentials%%@*}
redis_user=${redis_credentials%%:*}
case "$redis_user" in ''|default|admin|redis_admin|root) printf '%s\n' 'REDIS_URL must not use a default or administrative account.' >&2; exit 1 ;; esac
[ "$redis_prefix" = "infinite-canvas" ] || {
  printf '%s\n' 'REDIS_PREFIX must be infinite-canvas.' >&2
  exit 1
}

generation_storage_host="$root_dir/data/public-generation-temp"
[ -d "$generation_storage_host" ] && [ -w "$generation_storage_host" ] || {
  printf 'Generation storage directory must exist and be writable: %s\n' "$generation_storage_host" >&2
  exit 1
}

docker network inspect "$DATABASE_DOCKER_NETWORK" >/dev/null 2>&1 || {
  printf 'Docker network not found: %s\n' "$DATABASE_DOCKER_NETWORK" >&2
  exit 1
}

redis_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' redis_shared 2>/dev/null || true)
[ "$redis_health" = "healthy" ] || {
  printf '%s\n' 'redis_shared must be running and healthy.' >&2
  exit 1
}

docker compose --env-file "$env_file" -f "$compose_file" config --quiet
printf '%s\n' 'Public deployment configuration is valid.'
