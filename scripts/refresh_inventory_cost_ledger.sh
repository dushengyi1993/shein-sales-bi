#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
LOCK_FILE="${SHEIN_BI_INVENTORY_COST_LOCK_FILE:-$ROOT/state/locks/inventory-cost-ledger.lock}"
LOCK_WAIT_SEC="${SHEIN_BI_INVENTORY_COST_LOCK_WAIT_SEC:-900}"
mkdir -p "$(dirname "$LOCK_FILE")"
touch "$LOCK_FILE"
chmod 0660 "$LOCK_FILE" 2>/dev/null || true
exec 7>>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT_SEC" 7; then
  echo "[refresh_inventory_cost_ledger] lock timeout after ${LOCK_WAIT_SEC}s" >&2
  exit 75
fi

cd "$ROOT"
echo "[refresh_inventory_cost_ledger] start"
node scripts/rebuild_inventory_cost_ledger.mjs "$@"
echo "[refresh_inventory_cost_ledger] done"
