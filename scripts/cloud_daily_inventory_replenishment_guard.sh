#!/usr/bin/env bash
set -euo pipefail
ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="$(TZ=Asia/Shanghai date +%F)"
RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
PLAN="$RUNTIME_ROOT/plans/daily-inventory-replenishment-$DATE.json"
mkdir -p "$(dirname "$PLAN")"
cd "$ROOT"
node scripts/inventory/build_daily_inventory_replenishment_plan.mjs --date "$DATE" --out "$PLAN"
