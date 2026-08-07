#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
RUN_DATE="$(TZ=Asia/Shanghai date +%F)"

# A successful 15:15 run is terminal for the day.  The 15:45 slot exists only
# to recover a lock/source-readiness deferral and must never execute a second
# inventory plan after the primary run completed.
if node "$ROOT/scripts/pipeline_marker.mjs" require \
  --stage inventory-guard \
  --date "$RUN_DATE" \
  --status done,warning >/dev/null 2>&1; then
  echo "[inventory-guard-retry] primary run already complete date=$RUN_DATE"
  exit 0
fi

exec /usr/bin/env bash "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain inventory-guard-retry \
  --class openapi \
  --lock-wait-sec 60 \
  --deadline-at 15:57 \
  --defer-state /srv/shein-bi/runtime/host-scheduler/inventory-guard-retry.latest.json \
  -- /usr/bin/env bash "$ROOT/scripts/run_pipeline_stage.sh" \
    --stage inventory-guard \
    --require morning-links-ready \
    --require stock-refresh \
    --message "daily inventory guard retry completed" \
    -- /usr/bin/env bash "$ROOT/scripts/cloud_daily_inventory_replenishment_guard.sh"
