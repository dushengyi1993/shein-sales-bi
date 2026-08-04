#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_RTV_LOG_DIR:-/srv/shein-bi/logs/cloud-rtv-verify}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
LIMIT="${SHEIN_RTV_LIMIT:-300}"
CASE_LIMIT="${SHEIN_RTV_CASE_LIMIT:-25}"
MAX_RUNTIME_MS="${SHEIN_RTV_VERIFY_TIMEOUT_MS:-3600000}"
LEASE_TASK="${SHEIN_RTV_LEASE_TASK:-cloud-rtv-verify}"
LEASE_RUN_ID="${SHEIN_RTV_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LEASE_TTL_SEC="${SHEIN_RTV_LEASE_TTL_SEC:-4500}"
LEASE_ACTIVE=0

STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/rtv-verify-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_rtv_verify] start root=$ROOT limit=$LIMIT caseLimit=$CASE_LIMIT"
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

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

node scripts/verify_shein_rtv_tracking.mjs \
  --transport webapi \
  --headless \
  --limit "$LIMIT" \
  --case-limit "$CASE_LIMIT" \
  --max-runtime-ms "$MAX_RUNTIME_MS" \
  --json

if [[ "${SHEIN_RTV_REFRESH_PORTAL:-1}" != "1" && "${SHEIN_RTV_REFRESH_PORTAL:-1}" != "true" ]]; then
  echo "[cloud_rtv_verify] verification done; skip portal refresh because SHEIN_RTV_REFRESH_PORTAL=${SHEIN_RTV_REFRESH_PORTAL:-}"
  echo "[cloud_rtv_verify] done log=$LOG_FILE"
  exit 0
fi

node scripts/generate_bi_portal.mjs --metabase-url "$METABASE_URL"
node scripts/generate_bi_portal_shell.mjs

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
  bash scripts/enqueue_bi_portal_sections.sh \
    --sections rtvData,afterSales,homeProfit,profit \
    --priority 20 \
    --reason "rtv-verify-$STAMP"
  echo "[cloud_rtv_verify] Portal sections queued for bounded host-locked refresh"
fi

echo "[cloud_rtv_verify] done log=$LOG_FILE"
