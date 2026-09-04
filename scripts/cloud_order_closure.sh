#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
cd "$ROOT"
# Stable per-run force-refresh token: the same run reuses it (curl retries
# inside this run dedupe against the Portal queue), while a later business
# re-run forms a new token and can never be swallowed by the 30-day completed
# tombstone of the previous run on the same core generation. Deterministic
# source: the run's UTC start second, overridable for pinned/manual runs.
REFRESH_RUN_TOKEN="${SHEIN_ORDER_CLOSURE_REFRESH_TOKEN:-order-closure:$(date -u +%s)}"
OUTCOME_FILE="${SHEIN_ORDER_CLOSURE_OUTCOME_FILE:-$ROOT/state/order_closure_last_outcome.json}"
if [[ ! "$REFRESH_RUN_TOKEN" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  echo "[cloud_order_closure] refresh token must be 1-160 safe characters" >&2
  exit 64
fi

TEMP_REPORT="${OUTCOME_FILE}.$$.$RANDOM.tmp"
mkdir -p "$(dirname "$OUTCOME_FILE")"
set +e
node scripts/recheck_order_statuses.mjs \
  --max-pairs "${SHEIN_ORDER_CLOSURE_MAX_PAIRS:-30}" \
  --min-age-days "${SHEIN_ORDER_CLOSURE_MIN_AGE_DAYS:-2}" \
  --cooldown-hours "${SHEIN_ORDER_CLOSURE_COOLDOWN_HOURS:-20}" \
  --transport openapi >"$TEMP_REPORT" 2>&1
RECHECK_STATUS=$?
set -e
cat "$TEMP_REPORT"
TEMP_REPORT="$TEMP_REPORT" OUTCOME_FILE="$OUTCOME_FILE" RECHECK_STATUS="$RECHECK_STATUS" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const input = process.env.TEMP_REPORT;
const output = process.env.OUTCOME_FILE;
let report = {};
try { report = JSON.parse(fs.readFileSync(input, 'utf8')); } catch {}
const payload = {
  qualityStatus: typeof report.qualityStatus === 'string' ? report.qualityStatus : 'unknown',
  ok: report.ok === true,
  finishedAt: report.finishedAt || null,
  generatedAt: new Date().toISOString(),
  exitCode: Number(process.env.RECHECK_STATUS),
};
const temporary = `${output}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
fs.renameSync(temporary, output);
NODE
rm -f "$TEMP_REPORT"
if [[ "$RECHECK_STATUS" -ne 0 ]]; then
  exit "$RECHECK_STATUS"
fi

# Only publish after the closure command itself completed. Keeping this inside
# the command prevents SuccessExitStatus=75 deferrals from running a misleading
# ExecStartPost refresh.
curl -fsS --max-time "${SHEIN_ORDER_CLOSURE_PORTAL_TIMEOUT_SEC:-240}" \
  -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
  "$PORTAL_URL/api/bi/section/orders?refresh=1&refreshToken=${REFRESH_RUN_TOKEN}" >/dev/null
bash scripts/enqueue_bi_portal_sections.sh \
  --sections afterSales,homeRankings,homeProfit \
  --priority 20 \
  --reason "order-closure"
