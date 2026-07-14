#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
compose_file="$root_dir/docker-compose.public.yml"
env_file="$root_dir/.env.public"

[ -f "$env_file" ] || {
  printf '%s\n' "Missing $env_file; copy .env.public.example and fill it first." >&2
  exit 1
}

docker compose --env-file "$env_file" -f "$compose_file" run --rm --no-deps api bun src/db/migrate.ts
