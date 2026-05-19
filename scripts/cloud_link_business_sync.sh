#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-link-business}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"

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
      echo "Unsupported date target: $target" >&2
      exit 64
      ;;
  esac
}

check_portal_health() {
  if [[ ! -s "$PORTAL_INDEX_PATH" ]]; then
    echo "BI Portal index is missing or empty: $PORTAL_INDEX_PATH" >&2
    exit 1
  fi
  if [[ ! -s "$PORTAL_DATA_PATH" ]]; then
    echo "BI Portal data is missing or empty: $PORTAL_DATA_PATH" >&2
    exit 1
  fi
  if [[ -n "$PORTAL_HEALTH_URL" ]]; then
    curl -fsS --max-time 15 "$PORTAL_HEALTH_URL" >/dev/null
  else
    echo "[cloud_link_business_sync] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

close_store_browsers() {
  cd "$ROOT"
  node - <<'NODE' | while IFS= read -r profile_dir; do
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
for (const store of cfg.stores || []) {
  if (store.enabled === false) continue;
  console.log(path.join(root, 'profiles', `persistent-${store.profileKey}-profile`));
}
NODE
    [[ -n "$profile_dir" ]] || continue
    pkill -f -- "--user-data-dir=$profile_dir" 2>/dev/null || true
  done
}

store_profile_dir() {
  local key="$1"
  STORE_KEY="$key" node -e "const fs=require('fs'); const path=require('path'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); const s=(cfg.stores||[]).find(x=>String(x.storeKey).toUpperCase()===process.env.STORE_KEY.toUpperCase()); if(!s) process.exit(2); console.log(path.join(process.cwd(),'profiles',\`persistent-\${s.profileKey}-profile\`));"
}

close_one_store_browser() {
  local key="$1"
  local profile_dir
  profile_dir="$(store_profile_dir "$key")"
  [[ -n "$profile_dir" ]] || return 0
  pkill -f -- "--user-data-dir=$profile_dir" 2>/dev/null || true
}

store_keys() {
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    echo "$SHEIN_LINK_BUSINESS_STORES" | tr ',' ' '
    return 0
  fi
  node -e "const fs=require('fs'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); console.log((cfg.stores||[]).filter(s=>s.enabled!==false).map(s=>s.storeKey).join(' '));"
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/link-business-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_link_business_sync] start target=$TARGET date=$DATE root=$ROOT"
cd "$ROOT"

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-900000}"

trap close_store_browsers EXIT

STORES="$(store_keys)"
FAILED_STORES=()
SUCCESS_STORES=()
ALLOW_PARTIAL="${SHEIN_LINK_BUSINESS_ALLOW_PARTIAL:-1}"
for STORE in $STORES; do
  STORE_OK=0
  MAX_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-3}"
  for ATTEMPT in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT/$MAX_ATTEMPTS bootstrap/fetch start"
    close_one_store_browser "$STORE"
    if node scripts/bootstrap_shein_browser_session.mjs \
      --store "$STORE" \
      --date "$DATE" \
      --headless \
      && node scripts/fetch_shein_links.mjs \
        --stores "$STORE" \
        --date "$DATE" \
        --page-size "${SHEIN_LINK_PAGE_SIZE:-50}" \
      && node scripts/fetch_shein_business_domains.mjs \
        --store "$STORE" \
        --date "$DATE" \
        --wait-ms "${SHEIN_BUSINESS_WAIT_MS:-2000}" \
        --max-pages "${SHEIN_BUSINESS_MAX_PAGES:-20}" \
        --store-attempts "${SHEIN_BUSINESS_STORE_ATTEMPTS:-2}" \
        --relogin-headless \
        --json; then
      STORE_OK=1
      close_one_store_browser "$STORE"
      echo "[cloud_link_business_sync] store=$STORE done"
      break
    fi
    close_one_store_browser "$STORE"
    echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT failed; will retry after short cooldown" >&2
    sleep 10
  done
  if [[ "$STORE_OK" != "1" ]]; then
    echo "[cloud_link_business_sync] store=$STORE failed after $MAX_ATTEMPTS attempts" >&2
    FAILED_STORES+=("$STORE")
    if [[ "$ALLOW_PARTIAL" != "1" && "$ALLOW_PARTIAL" != "true" ]]; then
      exit 1
    fi
  else
    SUCCESS_STORES+=("$STORE")
  fi
done

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] WARN failed stores: ${FAILED_STORES[*]}" >&2
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  cat > "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" <<JSON
{"date":"$DATE","generatedAt":"$(TZ="$TZ_NAME" date --iso-8601=seconds)","failedStores":"${FAILED_STORES[*]}","successStores":"${SUCCESS_STORES[*]}","logFile":"$LOG_FILE"}
JSON
  if [[ "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "1" && "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "true" ]]; then
    echo "[cloud_link_business_sync] partial result recorded; skip BI warehouse/portal refresh to avoid presenting incomplete link/business date" >&2
    check_portal_health
    echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
    exit 0
  fi
fi

node scripts/generate_link_ops_web_dashboard.mjs \
  --date "$DATE" \
  --group ALL

node scripts/load_bi_warehouse.mjs \
  --sales-date 2099-01-01 \
  --link-date "$DATE" \
  --dashboard-json "outputs/link-dashboard/link-ops-dashboard-${DATE}.json"

node scripts/load_bi_business_domains.mjs \
  --date "$DATE"

node scripts/audit_bi_warehouse.mjs

node scripts/generate_bi_portal.mjs \
  --metabase-url "$METABASE_URL"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

check_portal_health

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
else
  rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" 2>/dev/null || true
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
fi
