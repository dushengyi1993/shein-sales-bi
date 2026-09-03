#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
PORTAL_ROOT="${SHEIN_BI_PORTAL_ROOT:-$ROOT/outputs/bi-portal}"
QUEUE_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:-$ROOT/state/portal-section-queue/queue.json}"
LOCK_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-section-queue.lock}"
MAX_SECTIONS="${SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS:-3}"
SECTION_TIMEOUT="${SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC:-900}"
PRODUCT_SALES_DAILY_TIMEOUT_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC:-600}"
PROFIT_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_PROFIT_MIN_RUNTIME_SEC:-630}"
PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC:-630}"
HOME_RANKINGS_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_HOME_RANKINGS_MIN_RUNTIME_SEC:-630}"
RANKINGS_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_RANKINGS_MIN_RUNTIME_SEC:-630}"
INVENTORY_TREND_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_INVENTORY_TREND_MIN_RUNTIME_SEC:-630}"
POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC:-60}"
MIN_REMAINING_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_MIN_REMAINING_RUNTIME_SEC:-120}"
LEASE_SECONDS="${SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC:-1200}"
SCHEDULED_ENTRY="${SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED:-0}"
DEADLINE_MINUTE="${SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE:-}"
HEAVY_FIRST="${SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_FIRST:-0}"
# The :02 slot has only a short reserved window. Its caller explicitly
# disables heavy sections; the worker still keeps the time-budget checks below
# as a second fail-closed guard for every other slot.
HEAVY_ALLOWED="${SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED:-1}"
REFRESH_ERROR_MAX_ENCODED=12288
REFRESH_FAILURE_REASON_MAX=900
REFRESH_FAILURE_JOURNAL_MAX=240
START_HOUR="$(date +%H)"
START_MINUTE="$(date +%M)"

# Never leak the per-section curl header file, even on early exit paths.
trap '[[ -n "${HEADERS_FILE:-}" ]] && rm -f "$HEADERS_FILE"' EXIT

[[ "$MAX_SECTIONS" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$SECTION_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$PRODUCT_SALES_DAILY_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$PROFIT_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$HOME_RANKINGS_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$RANKINGS_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$INVENTORY_TREND_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$MIN_REMAINING_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$DEADLINE_MINUTE" =~ ^[0-9]+$ ]] && (( DEADLINE_MINUTE >= 0 && DEADLINE_MINUTE <= 59 )) || exit 64
[[ "$HEAVY_ALLOWED" == 0 || "$HEAVY_ALLOWED" == 1 ]] || exit 64
[[ "$HEAVY_FIRST" == 0 || "$HEAVY_FIRST" == 1 ]] || exit 64
(( PRODUCT_SALES_DAILY_TIMEOUT_SEC + 30 <= PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC )) || exit 64
if [[ "$SCHEDULED_ENTRY" != "1" ]]; then
  echo "[portal-section-worker] defer reason=unscheduled_direct_entry; use shein-bi-cloud-portal-section-queue.service" >&2
  exit 75
fi
SAFE_START=0
case "$START_HOUR:$START_MINUTE" in
  01:*|02:0[1-4]|03:0[1-4]|07:0[1-4])
    echo "[portal-section-worker] defer reason=special_reserved_window hour=$START_HOUR minute=$START_MINUTE" >&2
    exit 75
    ;;
  *:0[1-4]|*:3[1-4]) SAFE_START=1 ;;
esac
if (( SAFE_START == 0 )); then
  echo "[portal-section-worker] defer reason=outside_safe_start_window hour=$START_HOUR minute=$START_MINUTE" >&2
  exit 75
fi

# Resolve the slot boundary once. A later wall-clock hour must not extend a
# worker that started in the previous slot; every claim is capped again by its
# own lease expiry below.
START_CURRENT_HOUR="$(date +%Y-%m-%dT%H)"
SLOT_DEADLINE_EPOCH="$(date -d "${START_CURRENT_HOUR}:${DEADLINE_MINUTE}:00" +%s)"
[[ "$SLOT_DEADLINE_EPOCH" =~ ^[0-9]+$ ]] || exit 64
readonly SLOT_DEADLINE_EPOCH

source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
cd "$ROOT"

queue_command() {
  local output
  local status
  exec 9<>"$LOCK_FILE"
  flock -w 10 9
  if output="$(node scripts/manage_bi_portal_section_queue.mjs "$@" --file "$QUEUE_FILE")"; then
    status=0
  else
    status=$?
  fi
  flock -u 9
  exec 9>&-
  printf '%s\n' "$output"
  return "$status"
}

response_header_value() {
  local header_name="$1"
  local max_length="${2:-4096}"
  awk -v wanted="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')" -v max_length="$max_length" '
    {
      line=$0
      sub(/\r$/, "", line)
      colon=index(line, ":")
      if (colon <= 0) next
      name=tolower(substr(line, 1, colon - 1))
      if (name != wanted) next
      value=substr(line, colon + 1)
      sub(/^[[:space:]]+/, "", value)
      print substr(value, 1, max_length)
      exit
    }
  ' "$HEADERS_FILE"
}

urlencode_query_value() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

bounded_refresh_failure_reason() {
  local encoded_error="${1:0:$REFRESH_ERROR_MAX_ENCODED}"
  local failed_at="$2"
  node - "$encoded_error" "$failed_at" "$REFRESH_FAILURE_REASON_MAX" <<'NODE'
const encoded = String(process.argv[2] || '');
const timestampRaw = String(process.argv[3] || '');
const maxLength = Math.max(1, Math.min(900, Number(process.argv[4]) || 900));
// The input is bounded by awk before it reaches argv. If that bound lands on
// a percent escape, remove only the incomplete escape; decode complete byte
// runs leniently so one malformed sequence cannot erase the useful Unicode
// reason that preceded it.
let completeEncoded = encoded;
while (/%(?:[0-9a-f])?$/iu.test(completeEncoded)) completeEncoded = completeEncoded.slice(0, -1);
const decoder = new TextDecoder('utf-8', {fatal: false});
const decoded = completeEncoded.replace(/(?:%[0-9a-f]{2})+/giu, run => {
  const bytes = [];
  for (let index = 0; index < run.length; index += 3) bytes.push(Number.parseInt(run.slice(index + 1, index + 3), 16));
  return decoder.decode(Uint8Array.from(bytes));
});
const sensitiveKeys = '(?:password|passwd|pwd|token|access_token|refresh_token|session|session_id|cookie|authorization|api_key|secret)';
const consumeValue = (text, start, escapedQuote = false) => {
  if (text.startsWith('[redacted]', start)) return start + '[redacted]'.length;
  if (escapedQuote && text[start] === '\\' && /["']/u.test(text[start + 1] || '')) {
    const quote = text[start + 1];
    for (let index = start + 2; index < text.length - 1; index += 1) {
      if (text[index] !== '\\' || text[index + 1] !== quote) continue;
      const tail = text.slice(index + 2);
      if (/^\s*(?:[,}\];]|$)/u.test(tail)) return index + 2;
    }
    return text.length;
  }
  if (/["']/u.test(text[start] || '')) {
    const quote = text[start];
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === '\\') {
        index += 1;
        continue;
      }
      if (text[index] === quote) return index + 1;
    }
    return text.length;
  }
  const match = /^[^\s,}\];]+/u.exec(text.slice(start));
  return match ? start + match[0].length : start;
};
const redactKeyValues = input => {
  const passes = [
    {regex: new RegExp(`(\\\\["']${sensitiveKeys}\\\\["']\\s*[:=]\\s*)`, 'giu'), escaped: true, replacement: '\\"[redacted]\\"'},
    {regex: new RegExp(`(["']${sensitiveKeys}["']\\s*[:=]\\s*)`, 'giu'), escaped: false, replacement: '"[redacted]"'},
    {regex: new RegExp(`(\\b${sensitiveKeys}\\b\\s*[:=]\\s*)`, 'giu'), escaped: false, replacement: '[redacted]'},
  ];
  let text = input;
  for (const pass of passes) {
    let output = '';
    let cursor = 0;
    pass.regex.lastIndex = 0;
    for (let match = pass.regex.exec(text); match; match = pass.regex.exec(text)) {
      if (match.index < cursor) continue;
      const valueStart = pass.regex.lastIndex;
      const valueEnd = consumeValue(text, valueStart, pass.escaped);
      output += text.slice(cursor, valueStart) + pass.replacement;
      cursor = Math.max(valueStart, valueEnd);
      pass.regex.lastIndex = cursor;
    }
    text = output + text.slice(cursor);
  }
  return text;
};
let oneLine = decoded
  .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .replace(/\b(Authorization)\s*[:=]\s*(?:Basic|Bearer)\s+[^\s,;"'\\]+/giu, '$1=[redacted]')
  .replace(/\b(Basic|Bearer)\s+[^\s,;"'\\]+/giu, '$1 [redacted]')
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/giu, '$1[redacted]@');
oneLine = redactKeyValues(oneLine)
  .replace(/\b(Cookie|Set-Cookie)\s*[:=]\s*.*$/giu, '$1=[redacted]');
const failedAt = timestampRaw
  .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, '')
  .trim()
  .slice(0, 64);
const safeFailedAt = /^[0-9TZ:+.-]{1,64}$/u.test(failedAt) ? failedAt : 'unknown';
const prefix = `portal refresh failed at=${safeFailedAt} error=`;
const safeError = oneLine || 'unknown refresh failure';
const available = Math.max(0, maxLength - Array.from(prefix).length);
process.stdout.write(prefix + Array.from(safeError).slice(0, available).join(''));
NODE
}

terminal_readback() {
  TERMINAL_REPORT=''
  TERMINAL_STATUS=124
  local now_epoch
  local remaining_sec
  now_epoch="$(date +%s)"
  remaining_sec=$((CLAIM_DEADLINE_EPOCH - now_epoch))
  if (( remaining_sec <= 0 )); then
    return 0
  fi
  if TERMINAL_REPORT="$(timeout --signal=TERM --kill-after=1s "${remaining_sec}s" \
    node scripts/check_bi_portal_section_terminal.mjs \
    --root "$PORTAL_ROOT" --section "$SECTION" \
    --expected-generated-at "$CLAIMED_CORE_GENERATED_AT" 2>&1)"; then
    TERMINAL_STATUS=0
  else
    TERMINAL_STATUS=$?
  fi
}

fail_terminal_claim() {
  local marker="$1"
  local error="$2"
  local journal="$3"
  queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" --error "$error" >/dev/null
  echo "[portal-section-worker] section=$SECTION failed status=$marker $journal" >&2
  FAILED_SECTIONS+=("$SECTION:$marker")
}

complete_terminal_claim() {
  local report_text="$1"
  TERMINAL_STATUS="$2"

  if [[ "$TERMINAL_STATUS" -eq 0 ]]; then
    if TERMINAL_EVIDENCE="$(node - "$report_text" "$SECTION" "$CLAIMED_CORE_GENERATED_AT" <<'NODE'
const reportText = String(process.argv[2] || '').trim();
const section = String(process.argv[3] || '');
const expected = String(process.argv[4] || '');
let report = null;
try {
  const line = reportText.split(/\r?\n/u).filter(Boolean).at(-1) || '';
  report = JSON.parse(line);
} catch {}
if (!report || report.ok !== true || report.section !== section
  || report.coreGeneratedAt !== expected || report.sectionGeneratedAt !== expected
  || report.generatedAt !== expected || !/^[a-f0-9]{64}$/u.test(String(report.generationIdentity || ''))) process.exit(2);
process.stdout.write([report.generatedAt, report.sectionGeneratedAt, report.generationIdentity].join('\t'));
NODE
    )"; then
      TERMINAL_EVIDENCE_STATUS=0
    else
      TERMINAL_EVIDENCE_STATUS=$?
    fi
    if [[ "$TERMINAL_EVIDENCE_STATUS" -ne 0 ]]; then
      fail_terminal_claim "terminal-evidence" \
        "terminal evidence generation or identity mismatch" \
        "(terminal evidence mismatch)"
      return 0
    fi
    IFS=$'\t' read -r TERMINAL_GENERATED_AT TERMINAL_SECTION_GENERATED_AT TERMINAL_GENERATION_IDENTITY <<< "$TERMINAL_EVIDENCE"
    NOW_EPOCH="$(date +%s)"
    if (( NOW_EPOCH >= CLAIM_DEADLINE_EPOCH )); then
      fail_terminal_claim "completion-deadline" \
        "terminal completion deadline elapsed" \
        "(completion was not attempted after the effective deadline)"
      return 0
    fi
    COMPLETE_REPORT="$(queue_command complete --section "$SECTION" --lease-id "$LEASE_ID" \
      --expected-generated-at "$CLAIMED_CORE_GENERATED_AT" \
      --terminal-generated-at "$TERMINAL_GENERATED_AT" \
      --terminal-section-generated-at "$TERMINAL_SECTION_GENERATED_AT" \
      --terminal-generation-identity "$TERMINAL_GENERATION_IDENTITY" \
      --not-after-epoch "$CLAIM_DEADLINE_EPOCH")"
    COMPLETED="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.completed===true))' "$COMPLETE_REPORT")"
    PUBLISHED="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.published===true))' "$COMPLETE_REPORT")"
    PUBLISHED_REVISION="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.publishedRevision||""))' "$COMPLETE_REPORT")"
    DESIRED_REVISION="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.desiredRevision||""))' "$COMPLETE_REPORT")"
    FOLLOW_UP_PENDING="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.followUpPending===true))' "$COMPLETE_REPORT")"
    COMPLETE_REPORT_VALID="$(node -e '
const x=JSON.parse(process.argv[1]);
const published=x.publishedRevision;
const desired=x.desiredRevision;
const follow=x.followUpPending;
const revisionsValid=Number.isSafeInteger(published) && published>0
  && Number.isSafeInteger(desired) && desired>0;
const relationValid=follow===true ? desired>published : follow===false && desired<=published;
process.stdout.write(String(x.completed===true && x.published===true && revisionsValid && relationValid));
' "$COMPLETE_REPORT")"
    if [[ "$COMPLETE_REPORT_VALID" != "true" ]]; then
      if [[ "$SECTION" == "profit" ]]; then
        PROFIT_COMPLETED_THIS_RUN=0
        PROFIT_FOLLOW_UP_PENDING=0
      fi
      echo "[portal-section-worker] section=$SECTION completion report was not accepted completed=$COMPLETED published=$PUBLISHED publishedRevision=$PUBLISHED_REVISION desiredRevision=$DESIRED_REVISION followUpPending=$FOLLOW_UP_PENDING" >&2
      FAILED_SECTIONS+=("$SECTION:complete")
    elif [[ "$FOLLOW_UP_PENDING" == "true" ]]; then
      if [[ "$SECTION" == "profit" ]]; then
        PROFIT_COMPLETED_THIS_RUN=0
        PROFIT_FOLLOW_UP_PENDING=1
      fi
      echo "[portal-section-worker] section=$SECTION publishedRevision=$PUBLISHED_REVISION follow-up pending"
    else
      if [[ "$SECTION" == "profit" ]]; then
        PROFIT_COMPLETED_THIS_RUN=1
        PROFIT_FOLLOW_UP_PENDING=0
        echo "[portal-section-worker] section=profit same-run completion eligible for post-profit homeRankings budgetSec=$POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC"
      fi
      echo "[portal-section-worker] section=$SECTION publishedRevision=$PUBLISHED_REVISION"
    fi
  else
    fail_terminal_claim "$TERMINAL_STATUS" \
      "terminal readback failed code=$TERMINAL_STATUS" \
      "(terminal readback: $(printf '%s' "$report_text" | tail -c 240))"
  fi
}

echo "[portal-section-worker] start maxSections=$MAX_SECTIONS heavyAllowed=$HEAVY_ALLOWED heavyFirst=$HEAVY_FIRST"
FAILED_SECTIONS=()
CLAIMED_SECTIONS=()
HEAVY_SECTION_DEFERRED=0
GENERIC_STOP=0
PROFIT_ATTEMPTED_THIS_RUN=0
PROFIT_COMPLETED_THIS_RUN=0
PROFIT_FOLLOW_UP_PENDING=0
for ((index=1; index<=MAX_SECTIONS; index+=1)); do
  NOW_EPOCH="$(date +%s)"
  REMAINING_SEC=$((SLOT_DEADLINE_EPOCH - NOW_EPOCH))
  if (( REMAINING_SEC <= 10 )); then
    echo "[portal-section-worker] stop before next core lane remainingSec=$REMAINING_SEC"
    break
  fi
  CLAIM_ARGS=(claim --lease-seconds "$LEASE_SECONDS")
  if (( index == 1 )); then
    # linksData feeds the Portal homepage and must not wait behind a long
    # profit/materialization attempt. Only change the first claim's preference;
    # lease, deadline, exclusion and terminal publication gates stay intact.
    FIRST_QUEUE_STATUS=""
    FIRST_LINKS_DATA_PENDING=0
    set +e
    FIRST_QUEUE_STATUS="$(queue_command status)"
    FIRST_QUEUE_STATUS_CODE=$?
    set -e
    if [[ "$FIRST_QUEUE_STATUS_CODE" -eq 0 ]]; then
      FIRST_LINKS_DATA_PENDING="$(node -e 'try { const x=JSON.parse(process.argv[1]); const e=(x.entries||[]).find(row=>row.section==="linksData"); process.stdout.write(e && ["pending","running"].includes(e.status) ? "1" : "0"); } catch { process.stdout.write("0"); }' "$FIRST_QUEUE_STATUS")"
    fi
    if [[ "$FIRST_LINKS_DATA_PENDING" == "1" ]]; then
      CLAIM_ARGS+=(--prefer-sections linksData)
      echo "[portal-section-worker] first claim prioritizes pending linksData"
    elif [[ "$HEAVY_FIRST" == "1" && "$HEAVY_ALLOWED" == "1" ]]; then
      CLAIM_ARGS+=(--prefer-sections profit,productSalesDaily,homeRankings)
    fi
  elif [[ "$HEAVY_FIRST" == "1" && "$HEAVY_ALLOWED" == "1" ]]; then
    CLAIM_ARGS+=(--prefer-sections profit,productSalesDaily,homeRankings)
  fi
  EXCLUDED_SECTIONS=("${CLAIMED_SECTIONS[@]}")
  if (( PROFIT_COMPLETED_THIS_RUN == 1 )); then
    PROFIT_QUEUE_STATUS="$(queue_command status)"
    PROFIT_QUEUE_PENDING="$(node -e 'const x=JSON.parse(process.argv[1]); const e=(x.entries||[]).find(row=>row.section==="profit"); process.stdout.write(e && ["pending","running"].includes(e.status) ? "1" : "0")' "$PROFIT_QUEUE_STATUS")"
    if [[ "$PROFIT_QUEUE_PENDING" == "1" ]]; then
      PROFIT_COMPLETED_THIS_RUN=0
      PROFIT_FOLLOW_UP_PENDING=1
      echo "[portal-section-worker] defer heavy section=homeRankings reason=profit_new_revision_pending"
    fi
  fi
  if [[ "$HEAVY_ALLOWED" == 0 ]]; then
    EXCLUDED_SECTIONS+=(profit homeRankings productSalesDaily rankings inventoryTrend)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy sections=profit,homeRankings,productSalesDaily,rankings,inventoryTrend reason=short_reserved_window remainingSec=$REMAINING_SEC"
  elif (( REMAINING_SEC < PROFIT_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(profit)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=profit remainingSec=$REMAINING_SEC requiredSec=$PROFIT_MIN_RUNTIME_SEC"
  fi
  if [[ "$HEAVY_ALLOWED" != 0 ]] && (( REMAINING_SEC < PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(productSalesDaily)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=productSalesDaily remainingSec=$REMAINING_SEC requiredSec=$PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC"
  fi
  if [[ "$HEAVY_ALLOWED" != 0 ]] && (( REMAINING_SEC < RANKINGS_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(rankings)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=rankings remainingSec=$REMAINING_SEC requiredSec=$RANKINGS_MIN_RUNTIME_SEC"
  fi
  if [[ "$HEAVY_ALLOWED" != 0 ]] && (( REMAINING_SEC < INVENTORY_TREND_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(inventoryTrend)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=inventoryTrend remainingSec=$REMAINING_SEC requiredSec=$INVENTORY_TREND_MIN_RUNTIME_SEC"
  fi
  # Any profit claim that is not a quiet, fully accepted completion is a
  # same-run dependency barrier. This includes a superseded publication and a
  # newly observed profit revision: manager dependencyYield remains the
  # liveness mechanism for a later run, not permission to run HR now.
  if (( PROFIT_ATTEMPTED_THIS_RUN == 1
    && PROFIT_COMPLETED_THIS_RUN != 1 )); then
    EXCLUDED_SECTIONS+=(homeRankings)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=homeRankings reason=profit_attempt_incomplete"
  fi
  HOME_RANKINGS_REQUIRED_RUNTIME_SEC="$HOME_RANKINGS_MIN_RUNTIME_SEC"
  if (( PROFIT_COMPLETED_THIS_RUN == 1 && PROFIT_FOLLOW_UP_PENDING == 0 )); then
    HOME_RANKINGS_REQUIRED_RUNTIME_SEC="$POST_PROFIT_HOME_RANKINGS_MIN_RUNTIME_SEC"
  fi
  if (( REMAINING_SEC < HOME_RANKINGS_REQUIRED_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(homeRankings)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=homeRankings remainingSec=$REMAINING_SEC requiredSec=$HOME_RANKINGS_REQUIRED_RUNTIME_SEC"
  fi
  if [[ "${#EXCLUDED_SECTIONS[@]}" -gt 0 ]]; then
    CLAIM_ARGS+=(--exclude-sections "$(IFS=,; echo "${EXCLUDED_SECTIONS[*]}")")
  fi
  if (( REMAINING_SEC < MIN_REMAINING_RUNTIME_SEC )); then
    echo "[portal-section-worker] stop before next section remainingSec=$REMAINING_SEC requiredSec=$MIN_REMAINING_RUNTIME_SEC"
    GENERIC_STOP=1
    break
  fi
  set +e
  CLAIM="$(queue_command "${CLAIM_ARGS[@]}")"
  CLAIM_STATUS=$?
  set -e
  if [[ "$CLAIM_STATUS" -eq 75 ]]; then
    if [[ "$HEAVY_SECTION_DEFERRED" -eq 1 ]]; then
      QUEUE_STATUS="$(queue_command status)"
      PENDING_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.counts?.pending||0))' "$QUEUE_STATUS")"
      if (( PENDING_COUNT > 0 )); then
        echo "[portal-section-worker] defer pending sections=$PENDING_COUNT reason=insufficient_heavy_budget"
        # Preserve a real section failure for systemd/watchdog. A failed
        # profit lease may leave pending work, but that is not a clean defer.
        if [[ "${#FAILED_SECTIONS[@]}" -eq 0 ]]; then
          exit 75
        fi
      fi
    fi
    echo "[portal-section-worker] queue empty"
    break
  fi
  [[ "$CLAIM_STATUS" -eq 0 ]] || exit "$CLAIM_STATUS"
  SECTION="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.entry?.section||""))' "$CLAIM")"
  LEASE_ID="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.entry?.leaseId||""))' "$CLAIM")"
  [[ -n "$SECTION" && -n "$LEASE_ID" ]] || {
    echo "[portal-section-worker] invalid claim: $CLAIM" >&2
    exit 1
  }
  LEASE_DEADLINE_EPOCH="$(node -e '
const x=JSON.parse(process.argv[1]);
const raw=String(x.entry?.leaseExpiresAt||"");
const millis=Date.parse(raw);
const epoch=Math.floor(millis/1000);
if (!raw || !Number.isFinite(millis) || !Number.isSafeInteger(epoch) || epoch <= 0) process.exit(2);
process.stdout.write(String(epoch));
' "$CLAIM")" || {
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "claim missing valid leaseExpiresAt" >/dev/null || true
    echo "[portal-section-worker] section=$SECTION failed status=claim-lease (invalid leaseExpiresAt)" >&2
    FAILED_SECTIONS+=("$SECTION:claim-lease")
    continue
  }
  CLAIM_DEADLINE_EPOCH="$SLOT_DEADLINE_EPOCH"
  if (( LEASE_DEADLINE_EPOCH < CLAIM_DEADLINE_EPOCH )); then
    CLAIM_DEADLINE_EPOCH="$LEASE_DEADLINE_EPOCH"
  fi
  NOW_EPOCH="$(date +%s)"
  if (( NOW_EPOCH >= CLAIM_DEADLINE_EPOCH )); then
    fail_terminal_claim "claim-deadline" \
      "claim effective deadline elapsed before refresh" \
      "(slot/lease deadline reached)"
    continue
  fi
  CLAIMED_CORE_GENERATED_AT="$(node -e 'const x=JSON.parse(process.argv[1]); const value=String(x.entry?.claimedCoreGeneratedAt||""); if(!/^[\x21-\x7E]{1,1024}$/.test(value)||value==="unknown") process.exit(2); process.stdout.write(value)' "$CLAIM")" || {
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" --error "claim missing immutable claimedCoreGeneratedAt" >/dev/null || true
    echo "[portal-section-worker] invalid claim generation: $CLAIM" >&2
    exit 1
  }
  if [[ "$SECTION" == "profit" ]]; then
    PROFIT_ATTEMPTED_THIS_RUN=1
    PROFIT_COMPLETED_THIS_RUN=0
    PROFIT_FOLLOW_UP_PENDING=0
  fi
  CLAIMED_SECTIONS+=("$SECTION")
  echo "[portal-section-worker] section=$SECTION attempt=$index"

  # Re-read the immutable effective deadline before curl and reserve a small
  # margin for the bounded strict terminal readback and completion command.
  NOW_EPOCH="$(date +%s)"
  REMAINING_SEC=$((CLAIM_DEADLINE_EPOCH - NOW_EPOCH))
  MAX_CURL_RUNTIME=$((REMAINING_SEC - 30))
  if (( MAX_CURL_RUNTIME < 1 )); then
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "insufficient deadline budget for bounded terminal readback" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=budget (no room for terminal readback)" >&2
    FAILED_SECTIONS+=("$SECTION:budget")
    continue
  fi
  CURL_TIMEOUT="$SECTION_TIMEOUT"
  if (( CURL_TIMEOUT > MAX_CURL_RUNTIME )); then CURL_TIMEOUT=$MAX_CURL_RUNTIME; fi
  if [[ "$SECTION" == "productSalesDaily" ]] \
    && (( CURL_TIMEOUT > PRODUCT_SALES_DAILY_TIMEOUT_SEC )); then
    CURL_TIMEOUT="$PRODUCT_SALES_DAILY_TIMEOUT_SEC"
  fi
  echo "[portal-section-worker] section=$SECTION curlBudgetSec=$CURL_TIMEOUT remainingSec=$REMAINING_SEC"
  HEADERS_FILE="$(mktemp)"
  EXPECTED_GENERATED_AT_QUERY="$(urlencode_query_value "$CLAIMED_CORE_GENERATED_AT")"
  # -f is deliberately not used: 202/403/503 responses must be classified
  # explicitly. Only a real HTTP 200 may even be considered for completion.
  set +e
  HTTP_CODE="$(curl -sS --max-time "$CURL_TIMEOUT" \
    -D "$HEADERS_FILE" -o /dev/null -w '%{http_code}' \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/$SECTION?refresh=1&expectedGeneratedAt=$EXPECTED_GENERATED_AT_QUERY")"
  CURL_STATUS=$?
  set -e
  if [[ "$CURL_STATUS" -ne 0 ]]; then
    fail_terminal_claim "$CURL_STATUS" \
      "curl status=$CURL_STATUS" \
      "(transport failure)"
  elif [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]] \
    && grep -qiE '^X-BI-Section-Refresh-Failed:[[:space:]]*true' "$HEADERS_FILE"; then
    # Both legacy marker families remain fail-closed:
    # X-BI-Section-(Stale|Refresh-Failed):[[:space:]]*true
    # The Portal deliberately URL-encodes this bounded header. Decode only the
    # header (never the response body), collapse control bytes to one line,
    # redact common credential assignments, and keep the manager payload below
    # its 1000-character error bound.
    STATUS=78
    REFRESH_ERROR_ENCODED="$(response_header_value 'X-BI-Section-Refresh-Error' "$REFRESH_ERROR_MAX_ENCODED")"
    REFRESH_FAILED_AT="$(response_header_value 'X-BI-Section-Refresh-Failed-At' 64)"
    REFRESH_FAILURE_REASON="$(bounded_refresh_failure_reason "$REFRESH_ERROR_ENCODED" "$REFRESH_FAILED_AT")"
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "$REFRESH_FAILURE_REASON" >/dev/null
    # The stale/failed refresh header path always fails the lease; only the
    # Refresh-Failed variant carries the Portal's primary error detail.
    JOURNAL_REASON="${REFRESH_FAILURE_REASON:0:$REFRESH_FAILURE_JOURNAL_MAX}"
    echo "[portal-section-worker] section=$SECTION failed status=$STATUS reason=$JOURNAL_REASON" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  elif [[ "$HTTP_CODE" != "200" ]]; then
    # A 202 pending / 403 / 503 / 500 is never a completed section: the cache
    # is not terminal yet. Fail the lease so the entry stays in the queue.
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl http=$HTTP_CODE non-200 never completes" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$HTTP_CODE (non-200)" >&2
    FAILED_SECTIONS+=("$SECTION:$HTTP_CODE")
  elif grep -qiE '^X-BI-Section-Stale:[[:space:]]*true' "$HEADERS_FILE"; then
    # A 200 that still carries a stale-source marker is a failed refresh, not
    # a completed section. Only a fresh, healthy cache may complete the entry.
    STATUS=78
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl status=200 but stale refresh header" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$STATUS (200 carried stale marker)" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  else
    # A clean 200 is still not terminal until the artifact on disk matches the
    # current core generation and the manager accepts the terminal evidence.
    terminal_readback
    complete_terminal_claim "$TERMINAL_REPORT" "$TERMINAL_STATUS"
  fi
  rm -f "$HEADERS_FILE"
done
if [[ "${#FAILED_SECTIONS[@]}" -gt 0 ]]; then
  # A terminal artifact from before this lease does not prove the requested
  # revision refreshed. The distinct-section claim rule prevents a later slot
  # from re-claiming the same section, so any recorded lease failure remains a
  # real service failure and stays visible to the watchdog.
  echo "[portal-section-worker] failed sections=$(IFS=,; echo "${FAILED_SECTIONS[*]}")" >&2
  exit 1
fi
if [[ "$HEAVY_SECTION_DEFERRED" -eq 1 && "$GENERIC_STOP" -eq 0 ]]; then
  QUEUE_STATUS="$(queue_command status)"
  PENDING_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.counts?.pending||0))' "$QUEUE_STATUS")"
  if (( PENDING_COUNT > 0 )); then
    echo "[portal-section-worker] defer pending sections=$PENDING_COUNT reason=insufficient_heavy_budget"
    exit 75
  fi
fi
echo "[portal-section-worker] done"
