#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
HOUR="$(TZ="${SHEIN_BI_TZ:-Asia/Shanghai}" date +%H)"
HOUR=$((10#$HOUR))
MINUTE="$(TZ="${SHEIN_BI_TZ:-Asia/Shanghai}" date +%M)"
MINUTE=$((10#$MINUTE))

# Two bounded emergency lanes only.  20:57/21:27 are no-new-work cutoffs;
# the outer hard deadline leaves the shared browser token before full-managed
# home-realtime starts at :02/:32.
if (( HOUR == 20 && MINUTE >= 45 && MINUTE < 57 )); then
  HARD_DEADLINE_MINUTE=57
  HARD_DEADLINE_NEXT_HOUR=0
elif (( HOUR == 21 && MINUTE >= 15 && MINUTE < 27 )); then
  HARD_DEADLINE_MINUTE=27
  HARD_DEADLINE_NEXT_HOUR=0
else
  echo "[marketing-fallback-slot] outside 20:45-20:57 / 21:15-21:27; defer"
  exit 75
fi

export SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true
export SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_MINUTE="$HARD_DEADLINE_MINUTE"
export SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_NEXT_HOUR="$HARD_DEADLINE_NEXT_HOUR"

deadline_args=(--deadline-minute "$HARD_DEADLINE_MINUTE")

exec /usr/bin/env bash "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain marketing-repair --class browser --lock-wait-sec 0 \
  "${deadline_args[@]}" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/marketing-repair.latest.json \
  --defer-reason deferred_to_local -- \
  /usr/bin/env bash "$ROOT/scripts/cloud_marketing_repair_worker.sh"
