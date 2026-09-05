#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
RUN_BUDGET_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_RUN_BUDGET_SEC:-1800}"
[[ "$RUN_BUDGET_SEC" =~ ^[0-9]+$ ]] && (( RUN_BUDGET_SEC >= 120 && RUN_BUDGET_SEC <= 1800 )) || exit 64
DEADLINE_EPOCH=$(( $(date +%s) + RUN_BUDGET_SEC ))

# The existing timer starts work; resource availability determines admission.
# The same service retries deferred work without discarding the durable queue.
# Per-section leases and atomic publication retain their existing ownership.
export SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1
export SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_EPOCH="$DEADLINE_EPOCH"
export SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS="${SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS:-8}"
export SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED=1
export SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_FIRST=1

exec "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain portal-sections \
  --class materializer \
  --lock-wait-sec 0 \
  --deadline-epoch "$DEADLINE_EPOCH" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/portal-sections.latest.json \
  -- /usr/bin/env bash "$ROOT/scripts/cloud_portal_section_queue_worker.sh"
