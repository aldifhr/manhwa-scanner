#!/usr/bin/env bash
# Apply migrations in order to $DATABASE_URL (transaction pooler).
set -euo pipefail
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then export $(grep -v '^#' .env | xargs); fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL not set"; exit 1
fi
for f in app/db/migrations/*.sql; do
  echo "=> $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f "$f"
done
echo "done"
