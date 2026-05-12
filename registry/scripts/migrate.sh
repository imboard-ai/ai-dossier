#!/usr/bin/env bash
# Apply SQL migrations in order. Idempotent: every migration uses IF NOT EXISTS.
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/migrate.sh
#
# Requires psql in PATH.

set -euo pipefail

if [[ -z "${DATABASE_URL:-${POSTGRES_URL:-}}" ]]; then
  echo "ERROR: DATABASE_URL (or POSTGRES_URL) must be set" >&2
  exit 1
fi

CONN="${DATABASE_URL:-$POSTGRES_URL}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/migrations"

shopt -s nullglob
for file in "$DIR"/*.sql; do
  echo "Applying $(basename "$file")..."
  psql "$CONN" -v ON_ERROR_STOP=1 -f "$file"
done
echo "Done."
