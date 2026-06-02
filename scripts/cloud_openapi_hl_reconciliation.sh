#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_OPENAPI_LOG_DIR:-/srv/shein-bi/logs/cloud-openapi-hl}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"

resolve_date() {
  local target="$1"
  case "$target" in
    today)
      TZ="$TZ_NAME" date +%F
      ;;
    yesterday)
      TZ="$TZ_NAME" date -d 'yesterday' +%F
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unsupported OpenAPI date target: $target" >&2
      exit 64
      ;;
  esac
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/openapi-hl-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_openapi_hl] start date=$DATE root=$ROOT"
cd "$ROOT"

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

if [[ ! -s config/shein_openapi.local.json ]]; then
  echo "Missing config/shein_openapi.local.json on cloud server. This secret config is not stored in GitHub." >&2
  exit 69
fi

node scripts/fetch_shein_openapi_sales.mjs HL --date "$DATE"
node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --date "$DATE"
node scripts/generate_bi_portal.mjs --metabase-url "$METABASE_URL"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
  nohup bash scripts/prewarm_bi_portal_sections.sh >/dev/null 2>&1 &
  echo "[cloud_openapi_hl] portal section prewarm started pid=$!"
fi

echo "[cloud_openapi_hl] done date=$DATE log=$LOG_FILE"
