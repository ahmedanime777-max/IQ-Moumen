#!/usr/bin/env bash
# Launcher for the Emergent 'frontend' supervisor program.
# Starts the local Qdrant vector DB (if not already running) and then execs the
# Node MCP + dashboard server on the supervisor-provided PORT (3000).
set -uo pipefail
cd /app

QDRANT_BIN=/usr/local/bin/qdrant

is_qdrant_up() {
  curl -s -m 2 http://localhost:6333/readyz >/dev/null 2>&1
}

if ! is_qdrant_up; then
  echo "[launch] starting qdrant..."
  mkdir -p /app/data/qdrant/storage /app/data/qdrant/snapshots
  QDRANT__STORAGE__STORAGE_PATH=/app/data/qdrant/storage \
  QDRANT__STORAGE__SNAPSHOTS_PATH=/app/data/qdrant/snapshots \
  QDRANT__SERVICE__HTTP_PORT=6333 \
  QDRANT__TELEMETRY_DISABLED=true \
  nohup "$QDRANT_BIN" > /var/log/qdrant.log 2>&1 &
  for i in $(seq 1 30); do
    if is_qdrant_up; then echo "[launch] qdrant ready"; break; fi
    sleep 1
  done
else
  echo "[launch] qdrant already running"
fi

exec ./node_modules/.bin/tsx src/server/index.ts
