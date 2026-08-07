#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
HOUR=$((10#$(date +%H)))
MINUTE=$((10#$(date +%M)))
DEADLINE_MINUTE=""
MAX_SECTIONS=1

marker_ready() {
  node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage "$1" \
    --date "$(TZ=Asia/Shanghai date +%F)" \
    --status done,warning >/dev/null 2>&1
}

yield_to_business_recovery() {
  # Portal materialization is cache maintenance.  It must never take the host
  # lock immediately before a missing-store recovery or the two inventory
  # execution slots.  Existing cache remains available while this run defers.
  if (( MINUTE >= 13 && MINUTE <= 16 )); then
    if (( HOUR == 11 || HOUR == 12 )) && ! marker_ready morning-links-ready; then
      echo "[portal-section-slot] defer reason=morning_link_recovery_priority hour=$HOUR minute=$MINUTE" >&2
      exit 75
    fi
    if (( HOUR == 15 )) && ! marker_ready inventory-guard; then
      echo "[portal-section-slot] defer reason=inventory_guard_priority hour=$HOUR minute=$MINUTE" >&2
      exit 75
    fi
  fi
  if (( MINUTE >= 43 && MINUTE <= 46 )); then
    if (( HOUR == 14 )) && ! marker_ready morning-links-ready; then
      echo "[portal-section-slot] defer reason=morning_link_recovery_priority hour=$HOUR minute=$MINUTE" >&2
      exit 75
    fi
    if (( HOUR == 15 )) && ! marker_ready inventory-guard; then
      echo "[portal-section-slot] defer reason=inventory_guard_retry_priority hour=$HOUR minute=$MINUTE" >&2
      exit 75
    fi
  fi
}

is_et_hour() {
  case "$HOUR" in
    1|4|7|10|13|14|17|20|23) return 0 ;;
    *) return 1 ;;
  esac
}

if (( MINUTE >= 13 && MINUTE <= 16 )); then
  if is_et_hour; then
    DEADLINE_MINUTE=17
    MAX_SECTIONS=1
  else
    DEADLINE_MINUTE=27
    MAX_SECTIONS=2
  fi
elif (( MINUTE >= 43 && MINUTE <= 46 )); then
  DEADLINE_MINUTE=57
  MAX_SECTIONS=2
else
  echo "[portal-section-slot] defer reason=outside_portal_slot hour=$HOUR minute=$MINUTE" >&2
  exit 75
fi

yield_to_business_recovery

export SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1
export SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE="$DEADLINE_MINUTE"
export SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS="$MAX_SECTIONS"

exec "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain portal-sections \
  --class materializer \
  --lock-wait-sec 0 \
  --deadline-minute "$DEADLINE_MINUTE" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/portal-sections.latest.json \
  -- /usr/bin/env bash "$ROOT/scripts/cloud_portal_section_queue_worker.sh"
