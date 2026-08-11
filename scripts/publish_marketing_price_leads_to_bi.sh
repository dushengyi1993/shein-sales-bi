#!/usr/bin/env bash
set -Eeuo pipefail

# Shared BI publish helper for the marketing live guard and the repair worker.
#
# After a successful marketing live snapshot this helper only:
#   1. runs the existing read-only price-lead export, then
#   2. enqueues the linksData portal section at high priority with a
#      deterministic reason into the existing portal-section queue.
#
# It never scrapes SHEIN, never launches a browser, never writes to the
# platform, never starts timers, and never prewarms sections; the caller owns
# the host-heavy lock and the live-snapshot success gate. A failure of either
# step aborts the helper so the caller fails closed instead of reporting ok.

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
REASON="${SHEIN_BI_MARKETING_BI_PUBLISH_REASON:-marketing-live-$(TZ="$TZ_NAME" date +%F)}"
PRIORITY="${SHEIN_BI_MARKETING_BI_PUBLISH_PRIORITY:-10}"

cd "$ROOT"

echo "[marketing_bi_publish] export marketing price leads snapshot"
node scripts/marketing/export_marketing_price_leads_for_bi.mjs --require-fresh

echo "[marketing_bi_publish] enqueue linksData section priority=$PRIORITY reason=$REASON"
bash scripts/enqueue_bi_portal_sections.sh \
  --sections linksData \
  --priority "$PRIORITY" \
  --reason "$REASON"
