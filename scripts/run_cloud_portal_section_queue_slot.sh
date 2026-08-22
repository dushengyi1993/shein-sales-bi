#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
HOUR=$((10#$(date +%H)))
MINUTE=$((10#$(date +%M)))
DEADLINE_MINUTE=""
MAX_SECTIONS=1
HEAVY_ALLOWED=0

if (( HOUR == 1 )); then
  echo "[portal-section-slot] defer reason=full_hour_reserved hour=$HOUR minute=$MINUTE" >&2
  exit 75
fi

yield_to_daily_coordinator() {
  # Portal materialization is cache maintenance. The daily business refresh is
  # now one coordinator rather than several timer slots, so only yield while
  # that single run is active. The previous complete cache remains available.
  local active_state
  active_state="$(systemctl show --no-pager --property=ActiveState --value shein-bi-cloud-morning-chain.service 2>/dev/null || true)"
  case "$active_state" in
    active|activating|reloading)
      echo "[portal-section-slot] defer reason=daily_operating_refresh_active state=$active_state hour=$HOUR minute=$MINUTE" >&2
      exit 75
      ;;
    inactive|failed)
      return 0
      ;;
    *)
      echo "[portal-section-slot] defer reason=daily_operating_refresh_state_unknown state=${active_state:-unknown} hour=$HOUR minute=$MINUTE" >&2
      exit 75
      ;;
  esac
}

if (( MINUTE >= 1 && MINUTE <= 4 )); then
  case "$HOUR" in
    2|3|7)
      echo "[portal-section-slot] defer reason=special_reserved_window hour=$HOUR minute=$MINUTE" >&2
      exit 75
      ;;
  esac
  DEADLINE_MINUTE=14
  MAX_SECTIONS=1
  HEAVY_ALLOWED=0
elif (( MINUTE >= 31 && MINUTE <= 34 )); then
  DEADLINE_MINUTE=44
  MAX_SECTIONS=8
  HEAVY_ALLOWED=1
else
  echo "[portal-section-slot] defer reason=outside_portal_slot hour=$HOUR minute=$MINUTE" >&2
  exit 75
fi

yield_to_daily_coordinator

export SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1
export SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE="$DEADLINE_MINUTE"
export SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS="$MAX_SECTIONS"
export SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED="$HEAVY_ALLOWED"

exec "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain portal-sections \
  --class materializer \
  --lock-wait-sec 0 \
  --deadline-minute "$DEADLINE_MINUTE" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/portal-sections.latest.json \
  -- /usr/bin/env bash "$ROOT/scripts/cloud_portal_section_queue_worker.sh"
