#!/usr/bin/env bash
set -e

host=${1:-postgres}
shift || true

until pg_isready -h "$host" -p 5432 >/dev/null 2>&1; do
  echo "waiting for postgres at $host:5432"
  sleep 1
done

exec "$@"
