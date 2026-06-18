#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_RTV_LOG_DIR:-/srv/shein-bi/logs/cloud-rtv-verify}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
LIMIT="${SHEIN_RTV_LIMIT:-300}"
CASE_LIMIT="${SHEIN_RTV_CASE_LIMIT:-25}"
MAX_RUNTIME_MS="${SHEIN_RTV_VERIFY_TIMEOUT_MS:-3600000}"

STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/rtv-verify-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_rtv_verify] start root=$ROOT limit=$LIMIT caseLimit=$CASE_LIMIT"
cd "$ROOT"

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
node scripts/generate_bi_portal_v2.mjs

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
  nohup bash scripts/prewarm_bi_portal_sections.sh >/dev/null 2>&1 &
  echo "[cloud_rtv_verify] portal section prewarm started pid=$!"
fi

echo "[cloud_rtv_verify] done log=$LOG_FILE"
