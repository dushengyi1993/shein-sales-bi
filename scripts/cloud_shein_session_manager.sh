#!/usr/bin/env bash
set -euo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-session-manager}"
REPORT_DIR="${SHEIN_SESSION_MANAGER_REPORT_DIR:-$ROOT/outputs/reports}"
LEASE_TASK="${SHEIN_SESSION_MANAGER_LEASE_TASK:-cloud-session-manager}"
LEASE_RUN_ID="${SHEIN_SESSION_MANAGER_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LEASE_TTL_SEC="${SHEIN_SESSION_MANAGER_LEASE_TTL_SEC:-7800}"
LEASE_ACTIVE=0

mkdir -p "$LOG_DIR" "$REPORT_DIR"

cd "$ROOT"

lease_action() {
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" \
    --run-id "$LEASE_RUN_ID" --owner-pid "$$" --ttl-sec "$LEASE_TTL_SEC" --group ALL
}
on_exit() {
  set +e
  [[ "$LEASE_ACTIVE" == "1" ]] && lease_action release >/dev/null 2>&1
}
trap on_exit EXIT
lease_action acquire
LEASE_ACTIVE=1

stamp="$(date +%Y%m%d-%H%M%S)"
log_file="$LOG_DIR/session-manager-$stamp.log"

echo "[cloud_shein_session_manager] start root=$ROOT log=$log_file" | tee -a "$log_file"
set +e
node scripts/cloud_shein_session_manager.mjs \
  --group ALL \
  --restore \
  --close-launched \
  --timeout-ms "${SHEIN_SESSION_MANAGER_TIMEOUT_MS:-180000}" \
  "$@" 2>&1 | tee -a "$log_file"
status="${PIPESTATUS[0]}"
set -e
echo "[cloud_shein_session_manager] done status=$status log=$log_file" | tee -a "$log_file"
exit "$status"
