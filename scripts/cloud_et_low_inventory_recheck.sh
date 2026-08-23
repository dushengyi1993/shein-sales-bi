#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
RUNTIME_ROOT="${SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/et-low-inventory-guard}"
STATE="$RUNTIME_ROOT/state/latest.json"
MANIFEST="${SHEIN_ET_LATEST_MANIFEST:-$ROOT/outputs/et-forwarder/latest-manifest.json}"
if [[ ! -s "$STATE" ]] || [[ "$(jq -r '.active == true' "$STATE")" != "true" ]]; then
  echo "[et_low_inventory_recheck] no active ET 1-10 watchlist; skip ET HTTP refresh"
  exit 0
fi
if ! command -v realpath >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo "[et_low_inventory_recheck] realpath and sha256sum are required for same-run ET binding" >&2
  exit 75
fi
ROOT_REAL="$(realpath -e "$ROOT")"

canonical_manifest_path() {
  local candidate="$1"
  local resolved
  [[ -s "$candidate" ]] || return 1
  resolved="$(realpath -e "$candidate")" || return 1
  case "$resolved" in
    "$ROOT_REAL"/*)
      printf '%s\n' "$resolved"
      ;;
    *)
      return 2
      ;;
  esac
}

resolve_batch_manifest() {
  local pointer="$1"
  local ref
  ref="$(jq -r '.manifestPath // empty' "$pointer")"
  if [[ -z "$ref" ]]; then
    printf '%s\n' "$pointer"
    return 0
  fi
  if [[ "$ref" = /* ]]; then
    printf '%s\n' "$ref"
  else
    printf '%s\n' "$ROOT/$ref"
  fi
}

manifest_hash() {
  local file="$1"
  sha256sum "$file" | awk '{print $1}'
}

PREVIOUS_BATCH_ID=""
if [[ -s "$MANIFEST" ]]; then
  PREVIOUS_BATCH_ID="$(jq -r '.batchId // empty' "$MANIFEST")"
fi

echo "[et_low_inventory_recheck] active low-ET watchlist; run stock-only ET direct HTTP refresh"
SHEIN_ET_TRANSPORT="${SHEIN_ET_TRANSPORT:-http}" \
SHEIN_ET_ENDPOINTS="store_stock,box_stock" \
SHEIN_ET_REFRESH_PORTAL_MODE="sections" \
SHEIN_ET_SYNC_PREWARM_SECTIONS="inventoryTrend" \
SHEIN_ET_REFRESH_SECTIONS="inventoryTrend" \
SHEIN_ET_MAX_DETAILS=0 \
SHEIN_ET_WAIT_BUSY_TIMEOUT_SEC="${SHEIN_ET_LOW_RECHECK_WAIT_BUSY_TIMEOUT_SEC:-180}" \
  bash "$ROOT/scripts/cloud_et_forwarder_sync.sh" today

if [[ ! -s "$MANIFEST" ]]; then
  echo "[et_low_inventory_recheck] same-run ET manifest is missing after forwarder" >&2
  exit 75
fi
POST_BATCH_ID="$(jq -r '.batchId // empty' "$MANIFEST")"
POST_TARGET_DATE="$(jq -r '.targetDate // empty' "$MANIFEST")"
POST_MANIFEST_OK="$(jq -r '.ok == true' "$MANIFEST")"
POST_MANIFEST_FILE="$(resolve_batch_manifest "$MANIFEST")"
if ! POST_MANIFEST_REAL="$(canonical_manifest_path "$POST_MANIFEST_FILE")"; then
  echo "[et_low_inventory_recheck] same-run ET batch manifest target is missing: $POST_MANIFEST_FILE" >&2
  exit 75
fi
POST_MANIFEST_HASH="$(manifest_hash "$POST_MANIFEST_REAL")"
if [[ -z "$POST_BATCH_ID" || "$POST_MANIFEST_OK" != "true" ]]; then
  echo "[et_low_inventory_recheck] forwarder did not leave a completed ET batch batch=$POST_BATCH_ID targetDate=$POST_TARGET_DATE" >&2
  exit 75
fi
if [[ -n "$PREVIOUS_BATCH_ID" && "$POST_BATCH_ID" == "$PREVIOUS_BATCH_ID" ]]; then
  echo "[et_low_inventory_recheck] forwarder produced no new ET batch; refuse to reuse the previous manifest" >&2
  exit 75
fi

GUARD_ENV=(
  "HOME=/home/sheinops"
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "TZ=${TZ:-Asia/Shanghai}"
  "SHEIN_BI_ROOT=$ROOT"
  "SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT=$RUNTIME_ROOT"
  "SHEIN_OPENAPI_PRODUCT_CACHE_DIR=${SHEIN_OPENAPI_PRODUCT_CACHE_DIR:-/srv/shein-bi/runtime/openapi-product-cache}"
  "SHEIN_BI_INVENTORY_JOURNAL_DIRS=${SHEIN_BI_INVENTORY_JOURNAL_DIRS:-/srv/shein-bi/runtime/daily-inventory-replenishment/results:/srv/shein-bi/runtime/et-low-inventory-guard/results}"
  "SHEIN_BI_INVENTORY_SKU_LOCK_DIR=${SHEIN_BI_INVENTORY_SKU_LOCK_DIR:-/data/shein-bi/state/locks}"
  "SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=${SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT:-cloud_et_low_inventory_guard}"
  "SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION=${SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION:-owner-automatic-et-low-inventory-20260806-v1}"
  "SHEIN_ET_LATEST_MANIFEST=$MANIFEST"
  "SHEIN_ET_EXPECTED_BATCH_ID=$POST_BATCH_ID"
  "SHEIN_ET_EXPECTED_MANIFEST_HASH=$POST_MANIFEST_HASH"
)
if [[ -n "${SHEIN_OPENAPI_CONFIG_FILE:-}" ]]; then
  GUARD_ENV+=("SHEIN_OPENAPI_CONFIG_FILE=$SHEIN_OPENAPI_CONFIG_FILE")
fi
if [[ "$(id -u)" -eq 0 ]]; then
  /usr/sbin/runuser -u sheinops -- /usr/bin/env "${GUARD_ENV[@]}" \
    bash "$ROOT/scripts/cloud_et_low_inventory_guard.sh"
else
  if [[ "$(id -un)" != "sheinops" ]]; then
    echo "[et_low_inventory_recheck] guard must run as sheinops" >&2
    exit 75
  fi
  /usr/bin/env "${GUARD_ENV[@]}" bash "$ROOT/scripts/cloud_et_low_inventory_guard.sh"
fi
