#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_MORNING_CHAIN_LOG_DIR:-/srv/shein-bi/logs/cloud-morning-chain}"
LOCK_FILE="${SHEIN_BI_MORNING_CHAIN_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-morning-chain.lock}"
STATE_DIR="${SHEIN_BI_MORNING_CHAIN_STATE_DIR:-$ROOT/state/cloud_morning_chain}"
DAILY_REFRESH_UNIT="${SHEIN_BI_MORNING_DAILY_REFRESH_UNIT:-shein-bi-cloud-daily-refresh.service}"
DAILY_REFRESH_WAIT_SEC="${SHEIN_BI_MORNING_DAILY_REFRESH_WAIT_SEC:-14400}"
SEND_LARK_REPORT="${SHEIN_BI_MORNING_SEND_LARK_REPORT:-0}"
RUN_SALES_REFRESH="${SHEIN_BI_MORNING_SALES_REFRESH:-0}"
ALLOW_REPEAT="${SHEIN_BI_MORNING_CHAIN_FORCE:-0}"
DRY_RUN="${SHEIN_BI_MORNING_CHAIN_DRY_RUN:-0}"

resolve_today() {
  TZ="$TZ_NAME" date +%F
}

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
}

wait_for_unit_inactive() {
  local unit="$1"
  local timeout="$2"
  local interval=15
  local elapsed=0
  while systemctl is-active --quiet "$unit"; do
    if (( elapsed >= timeout )); then
      echo "[cloud_morning_chain] ERROR timeout waiting for $unit after ${timeout}s" >&2
      return 1
    fi
    echo "[cloud_morning_chain] wait active unit=$unit elapsed=${elapsed}s"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}

write_state() {
  local status="$1"
  local message="$2"
  mkdir -p "$STATE_DIR" "$ROOT/state/cloud_ops_alerts"
  local state_json
  state_json="{\"date\":\"$DATE\",\"generatedAt\":\"$(now_iso)\",\"status\":\"$status\",\"message\":\"$message\",\"logFile\":\"$LOG_FILE\"}"
  printf '%s\n' "$state_json" > "$STATE_DIR/latest.json"
  if [[ "$status" == "ok" ]]; then
    rm -f "$ROOT/state/cloud_ops_alerts/morning-chain-last.json" 2>/dev/null || true
  else
    printf '%s\n' "$state_json" > "$ROOT/state/cloud_ops_alerts/morning-chain-last.json"
  fi
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  write_state "failed" "morning chain aborted at line=$line exit=$status"
  echo "[cloud_morning_chain] ERROR aborted at line=$line exit=$status log=$LOG_FILE" >&2
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR"
DATE="$(resolve_today)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/morning-chain-${DATE}-${STAMP}.log"
DONE_FLAG="$STATE_DIR/${DATE}.done"

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_morning_chain] another morning chain is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1
trap 'on_error "$LINENO" "$?"' ERR

cd "$ROOT"
echo "[cloud_morning_chain] start date=$DATE root=$ROOT dryRun=$DRY_RUN sendLarkReport=$SEND_LARK_REPORT"

if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  if [[ "$SEND_LARK_REPORT" == "1" || "$SEND_LARK_REPORT" == "true" ]]; then
    echo "[cloud_morning_chain] dry-run plan: sales refresh -> Lark report without duplicate sync -> daily refresh service"
  else
    echo "[cloud_morning_chain] dry-run plan: sales refresh -> skip Lark report -> daily refresh service"
  fi
  write_state "ok" "dry-run plan validated"
  exit 0
fi

if [[ -f "$DONE_FLAG" && "$ALLOW_REPEAT" != "1" && "$ALLOW_REPEAT" != "true" ]]; then
  echo "[cloud_morning_chain] already completed for date=$DATE flag=$DONE_FLAG"
  write_state "ok" "already completed for date=$DATE"
  exit 0
fi

if [[ "$RUN_SALES_REFRESH" == "1" || "$RUN_SALES_REFRESH" == "true" ]]; then
  write_state "running" "sales fallback refresh started"
  SHEIN_BI_REFRESH_BUSY_EXIT_CODE=75 bash scripts/cloud_bi_refresh.sh today morning-chain
  echo "[cloud_morning_chain] sales fallback refresh done"
else
  echo "[cloud_morning_chain] webhook is the intraday sales source; skip duplicate morning sales pull"
fi

echo "[cloud_morning_chain] start Lark daily report stage"
if [[ "$SEND_LARK_REPORT" == "1" || "$SEND_LARK_REPORT" == "true" ]]; then
  write_state "running" "daily report started"
  SHEIN_LARK_REPORT_SYNC_TODAY=0 bash scripts/cloud_daily_lark_report.sh today
  echo "[cloud_morning_chain] daily report done; start slow daily refresh via $DAILY_REFRESH_UNIT"
else
  write_state "running" "daily report skipped; daily refresh starting"
  echo "[cloud_morning_chain] Lark daily report disabled; start slow daily refresh via $DAILY_REFRESH_UNIT"
fi

write_state "running" "daily refresh started"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reset-failed "$DAILY_REFRESH_UNIT" || true
  systemctl start "$DAILY_REFRESH_UNIT"
  wait_for_unit_inactive "$DAILY_REFRESH_UNIT" "$DAILY_REFRESH_WAIT_SEC"
  RESULT="$(systemctl show "$DAILY_REFRESH_UNIT" -p Result --value 2>/dev/null || true)"
  STATUS="$(systemctl show "$DAILY_REFRESH_UNIT" -p ExecMainStatus --value 2>/dev/null || true)"
  if [[ -n "$RESULT" && "$RESULT" != "success" ]]; then
    echo "[cloud_morning_chain] ERROR $DAILY_REFRESH_UNIT result=$RESULT status=${STATUS:-}" >&2
    exit 1
  fi
else
  bash scripts/cloud_daily_refresh.sh yesterday
fi

printf 'completed_at=%s\nlog=%s\n' "$(now_iso)" "$LOG_FILE" > "$DONE_FLAG"
write_state "ok" "morning chain completed"
echo "[cloud_morning_chain] done date=$DATE log=$LOG_FILE"
