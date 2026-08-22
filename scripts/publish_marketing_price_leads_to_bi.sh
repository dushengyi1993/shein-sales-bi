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
# the live-snapshot success gate. The helper owns the narrow marketing
# artifact-publication lock unless a guard/repair caller explicitly passes the
# already-held lock through its child environment. A failure of either step
# aborts the helper so the caller fails closed instead of reporting ok.

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
DATE="${SHEIN_BI_MARKETING_BI_PUBLISH_DATE:-$(TZ="$TZ_NAME" date +%F)}"
LOCK_FILE="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-artifact-publication.lock}"
LOCK_WAIT_SEC="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC:-30}"
PRICE_LEADS_FILE="${SHEIN_BI_MARKETING_PRICE_LEADS_FILE:-$ROOT/outputs/bi-portal/marketing-price-leads.json}"
PRICE_LEADS_STAGE_FILE="${SHEIN_BI_MARKETING_PRICE_LEADS_STAGE_FILE:-${PRICE_LEADS_FILE}.stage-${BASHPID}}"
REASON="${SHEIN_BI_MARKETING_BI_PUBLISH_REASON:-marketing-live-$(TZ="$TZ_NAME" date +%F)}"
PRIORITY="${SHEIN_BI_MARKETING_BI_PUBLISH_PRIORITY:-10}"
LOCK_ACQUIRED_HERE=0

cleanup_marketing_price_leads_stage() {
  if [[ "$PRICE_LEADS_STAGE_FILE" != "$PRICE_LEADS_FILE" ]]; then
    rm -f -- "$PRICE_LEADS_STAGE_FILE"
  fi
}

release_marketing_artifact_publication_lock() {
  if [[ "$LOCK_ACQUIRED_HERE" == "1" ]]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    LOCK_ACQUIRED_HERE=0
  fi
}

acquire_marketing_artifact_publication_lock() {
  if ! [[ "$LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || (( LOCK_WAIT_SEC >= 1800 )); then
    echo "[marketing_bi_publish] invalid artifact publication lock wait: $LOCK_WAIT_SEC" >&2
    return 64
  fi
  prepare_shared_lock_file "$LOCK_FILE"
  exec 8<>"$LOCK_FILE"
  if ! flock -w "$LOCK_WAIT_SEC" 8; then
    echo "[marketing_bi_publish] artifact publication lock busy: $LOCK_FILE" >&2
    exec 8>&-
    return 75
  fi
  LOCK_ACQUIRED_HERE=1
}

publish_staged_marketing_price_leads() {
  if [[ "$PRICE_LEADS_STAGE_FILE" == "$PRICE_LEADS_FILE" ]]; then
    return 0
  fi
  if [[ ! -f "$PRICE_LEADS_STAGE_FILE" ]]; then
    echo "[marketing_bi_publish] staged marketing price leads file is missing: $PRICE_LEADS_STAGE_FILE" >&2
    return 66
  fi
  STAGED_PRICE_LEADS_FILE="$PRICE_LEADS_STAGE_FILE" TARGET_PRICE_LEADS_FILE="$PRICE_LEADS_FILE" node --input-type=module <<'NODE'
import fs from 'node:fs/promises';
import {writeFileAtomic} from './lib/atomic_file_publish.mjs';

const payload = await fs.readFile(process.env.STAGED_PRICE_LEADS_FILE);
await writeFileAtomic(process.env.TARGET_PRICE_LEADS_FILE, payload);
NODE
}

derive_marketing_idempotency_key() {
  PRICE_LEADS_FILE="$PRICE_LEADS_FILE" PUBLISH_DATE="$DATE" node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const file = process.env.PRICE_LEADS_FILE;
const date = String(process.env.PUBLISH_DATE || '').trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid publication date: ${date}`);
const payload = JSON.parse(await fs.readFile(file, 'utf8'));
if (!payload || !Array.isArray(payload.rows)) throw new Error(`marketing price leads rows missing: ${file}`);
// generatedAt/checkedAt are run timestamps. The row set is the content that
// determines whether the linksData intent is equivalent across retries.
const canonical = JSON.stringify({date, rows: payload.rows});
const digest = crypto.createHash('sha256').update(canonical).digest('hex');
process.stdout.write(`marketing-linksData:${date}:sha256:${digest}`);
NODE
}

on_exit() {
  local status="$?"
  trap - EXIT
  set +e
  release_marketing_artifact_publication_lock
  cleanup_marketing_price_leads_stage
  exit "$status"
}

trap on_exit EXIT

cd "$ROOT"

if [[ "${SHEIN_BI_MARKETING_PRICE_LEADS_PREPARED:-0}" != "1" ]]; then
  echo "[marketing_bi_publish] export marketing price leads snapshot"
  node scripts/marketing/export_marketing_price_leads_for_bi.mjs --require-fresh --out "$PRICE_LEADS_STAGE_FILE"
fi

if [[ "${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_HELD:-0}" != "1" ]]; then
  acquire_marketing_artifact_publication_lock
fi

publish_staged_marketing_price_leads

IDEMPOTENCY_KEY="$(derive_marketing_idempotency_key)"
if [[ ! "$IDEMPOTENCY_KEY" =~ ^[A-Za-z0-9._:-]{1,120}$ ]]; then
  echo "[marketing_bi_publish] derived idempotency key is outside queue bounds" >&2
  exit 64
fi

echo "[marketing_bi_publish] enqueue linksData section priority=$PRIORITY reason=$REASON idempotency=$IDEMPOTENCY_KEY"
bash scripts/enqueue_bi_portal_sections.sh \
  --sections linksData \
  --priority "$PRIORITY" \
  --reason "$REASON" \
  --idempotency-key "$IDEMPOTENCY_KEY"
