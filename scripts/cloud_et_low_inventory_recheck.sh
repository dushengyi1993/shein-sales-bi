#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
RUNTIME_ROOT="${SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/et-low-inventory-guard}"
STATE="$RUNTIME_ROOT/state/latest.json"
if [[ ! -s "$STATE" ]] || [[ "$(jq -r '.active == true' "$STATE")" != "true" ]]; then
  echo "[et_low_inventory_recheck] no active ET 1-20 watchlist; skip browser refresh"
  exit 0
fi

echo "[et_low_inventory_recheck] active low-ET watchlist; run stock-only ET refresh"
SHEIN_ET_ENDPOINTS="store_stock,box_stock" \
SHEIN_ET_REFRESH_PORTAL_MODE="sections" \
SHEIN_ET_SYNC_PREWARM_SECTIONS="inventoryTrend" \
SHEIN_ET_REFRESH_SECTIONS="inventoryTrend" \
SHEIN_ET_MAX_DETAILS=0 \
SHEIN_ET_WAIT_BUSY_TIMEOUT_SEC="${SHEIN_ET_LOW_RECHECK_WAIT_BUSY_TIMEOUT_SEC:-180}" \
  bash "$ROOT/scripts/cloud_et_forwarder_sync.sh" today

bash "$ROOT/scripts/cloud_et_low_inventory_guard.sh"
