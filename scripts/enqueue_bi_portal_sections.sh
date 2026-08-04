#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
QUEUE_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:-$ROOT/state/portal-section-queue/queue.json}"
LOCK_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-section-queue.lock}"

source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
exec 9<>"$LOCK_FILE"
if ! flock -w 10 9; then
  echo "[portal-section-queue] enqueue lock busy" >&2
  exit 75
fi

exec node "$ROOT/scripts/manage_bi_portal_section_queue.mjs" enqueue \
  --file "$QUEUE_FILE" \
  "$@"
