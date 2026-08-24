#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
MIN_START_BUDGET_SEC="${SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC:-900}"
HOUR="$(TZ="$TZ_NAME" date +%H)"
HOUR=$((10#$HOUR))
MINUTE="$(TZ="$TZ_NAME" date +%M)"
MINUTE=$((10#$MINUTE))
TODAY="$(TZ="$TZ_NAME" date +%F)"
NOW_EPOCH="$(date +%s)"

if [[ ! "$MIN_START_BUDGET_SEC" =~ ^[0-9]+$ ]] || (( MIN_START_BUDGET_SEC < 900 )); then
  echo "[marketing-fallback-slot] invalid minimum start budget: $MIN_START_BUDGET_SEC" >&2
  exit 64
fi

# The existing 20:45/21:15 timer remains the only scheduler.  A started run
# may continue through the same-day fallback window; the broad acceptance
# range only matters if systemd starts the same service after a transient
# lock/resource defer.  The worker and batch runner still gate every new
# group independently.
if ! ((
  (HOUR == 20 && MINUTE >= 45)
  || (HOUR == 21 && MINUTE >= 15)
  || HOUR == 22
)); then
  echo "[marketing-fallback-slot] outside 20:45-22:55 same-day fallback window; defer"
  exit 75
fi

if ! GRACEFUL_CUTOFF_EPOCH="$(TZ="$TZ_NAME" date -d "${TODAY} 22:55:00" +%s)"; then
  echo "[marketing-fallback-slot] unable to resolve same-day graceful cutoff" >&2
  exit 75
fi
if ! OUTER_HARD_DEADLINE_EPOCH="$(TZ="$TZ_NAME" date -d "${TODAY} 23:10:00" +%s)"; then
  echo "[marketing-fallback-slot] unable to resolve same-day outer deadline" >&2
  exit 75
fi
if [[ ! "$GRACEFUL_CUTOFF_EPOCH" =~ ^[0-9]+$ ]] || [[ ! "$OUTER_HARD_DEADLINE_EPOCH" =~ ^[0-9]+$ ]]; then
  echo "[marketing-fallback-slot] resolved deadlines are invalid" >&2
  exit 75
fi
if (( OUTER_HARD_DEADLINE_EPOCH <= GRACEFUL_CUTOFF_EPOCH )); then
  echo "[marketing-fallback-slot] outer deadline must be later than graceful cutoff" >&2
  exit 75
fi
if (( OUTER_HARD_DEADLINE_EPOCH - GRACEFUL_CUTOFF_EPOCH < MIN_START_BUDGET_SEC )); then
  echo "[marketing-fallback-slot] outer deadline has less than the minimum group safety margin" >&2
  exit 75
fi
if (( NOW_EPOCH >= GRACEFUL_CUTOFF_EPOCH || GRACEFUL_CUTOFF_EPOCH - NOW_EPOCH < MIN_START_BUDGET_SEC )); then
  echo "[marketing-fallback-slot] insufficient same-day group budget; defer"
  exit 75
fi

export SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true
export SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH="$GRACEFUL_CUTOFF_EPOCH"
export SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH="$OUTER_HARD_DEADLINE_EPOCH"
export SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC="$MIN_START_BUDGET_SEC"

deadline_args=(--deadline-epoch "$OUTER_HARD_DEADLINE_EPOCH")

exec /usr/bin/env bash "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain marketing-repair --class browser --lock-wait-sec 0 \
  "${deadline_args[@]}" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/marketing-repair.latest.json \
  --defer-reason deferred_to_local -- \
  /usr/bin/env bash "$ROOT/scripts/cloud_marketing_repair_worker.sh"
