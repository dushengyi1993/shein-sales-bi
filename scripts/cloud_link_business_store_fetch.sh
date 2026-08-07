#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
STORE="${1:-}"
DATE="${2:-}"

[[ "$STORE" =~ ^[A-Z0-9]{2,8}$ ]] || { echo "invalid store: $STORE" >&2; exit 64; }
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "invalid date: $DATE" >&2; exit 64; }

cd "$ROOT"

# This is one store boundary inside the single daily coordinator.  The browser
# is opened once, reused by both collectors, and closed by the coordinator.
# Fast start probes the persistent profile/autofill first; session injection is
# retained only as a fallback instead of adding ~20 seconds to every store.
node scripts/restore_shein_store_session.mjs \
  --store "$STORE" \
  --date "$DATE" \
  --headless \
  --fast-start \
  --timeout-ms "${SHEIN_SESSION_RESTORE_TIMEOUT_MS:-180000}"

node scripts/fetch_shein_links.mjs \
  --stores "$STORE" \
  --date "$DATE" \
  --page-size "${SHEIN_LINK_PAGE_SIZE:-100}"

node scripts/fetch_shein_business_domains.mjs \
  --store "$STORE" \
  --date "$DATE" \
  --domains "${SHEIN_BUSINESS_DOMAINS:-home,afterSales,waybill,fulfillment,productInventory,management,marketing,quality,comments}" \
  --page-size "${SHEIN_BUSINESS_PAGE_SIZE:-100}" \
  --wait-ms "${SHEIN_BUSINESS_WAIT_MS:-500}" \
  --max-pages "${SHEIN_BUSINESS_MAX_PAGES:-20}" \
  --store-attempts 1 \
  --no-auto-relogin \
  --json
