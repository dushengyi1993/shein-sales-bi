#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
RUN_DATE="$(TZ=Asia/Shanghai date +%F)"
MINUTE=$((10#$(TZ=Asia/Shanghai date +%M)))

# Recovery is strictly resumable.  Once the all-store marker exists, later
# safety slots exit without opening a browser or rebuilding Portal data.
if node "$ROOT/scripts/pipeline_marker.mjs" require \
  --stage morning-links-ready \
  --date "$RUN_DATE" \
  --status done,warning >/dev/null 2>&1; then
  echo "[morning-link-recovery] already complete date=$RUN_DATE"
  exit 0
fi

case "$MINUTE" in
  13|14|15|16)
    DEADLINE_MINUTE=27
    ;;
  43|44|45|46)
    DEADLINE_MINUTE=57
    ;;
  *)
    echo "[morning-link-recovery] outside safe start window minute=$MINUTE" >&2
    exit 75
    ;;
esac

exec /usr/bin/env bash "$ROOT/scripts/run_host_browser_read_job.sh" \
  --domain morning-link-recovery \
  --lock-wait-sec 60 \
  --deadline-minute "$DEADLINE_MINUTE" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/morning-link-recovery.latest.json \
  -- /usr/bin/env bash "$ROOT/scripts/cloud_morning_chain.sh" chunk-2
