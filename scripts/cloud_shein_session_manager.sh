#!/usr/bin/env bash
set -euo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-session-manager}"
REPORT_DIR="${SHEIN_SESSION_MANAGER_REPORT_DIR:-$ROOT/outputs/reports}"

mkdir -p "$LOG_DIR" "$REPORT_DIR"

cd "$ROOT"

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
