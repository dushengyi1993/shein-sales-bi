#!/usr/bin/env node

// Morning inventory coordinator vs homepage Portal section prewarm contract.
//
// The 07:10 coordinator must be able to enter the reserved inventory window
// as soon as the 19-store merge and the inventory-critical linksData section
// are complete.  Homepage-critical sections (homeRankings..homeProfit) must
// never be a synchronous prewarm on that critical path, because a single slow
// section (measured homeRankings > 13 min) can exhaust the inventory reserve.
// The fix:
//   - cloud_daily_refresh.sh keeps `sync` as the DEFAULT mode (standalone
//     daily refresh unchanged) and adds `queue` mode: linksData stays
//     synchronous in both modes; homepage-critical sections are enqueued to
//     the bounded host-locked section queue worker (lease + per-section
//     timeout + profit/homeProfit dependency barriers);
//   - cloud_morning_chain.sh run_supplements_stage selects `queue` and never
//     forces SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1;
//   - queue mode combined with REQUIRE_CRITICAL_PORTAL_SECTIONS=1 fails
//     closed (exit 64) instead of silently downgrading the requirement;
//   - linksData failure is never treated as success: it stays synchronous and
//     the inventory guard keeps its own fail-closed linksData gate.

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const daily = read('scripts/cloud_daily_refresh.sh');
const morning = read('scripts/cloud_morning_chain.sh');

// ---------------------------------------------------------------------------
// Syntax gates
// ---------------------------------------------------------------------------
execFileSync('bash', ['-n', 'scripts/cloud_daily_refresh.sh'], {cwd: root, stdio: 'inherit'});
execFileSync('bash', ['-n', 'scripts/cloud_morning_chain.sh'], {cwd: root, stdio: 'inherit'});

// ---------------------------------------------------------------------------
// Source contracts: mode selection and fail-closed validation
// ---------------------------------------------------------------------------
assert.match(daily, /CRITICAL_PORTAL_PREWARM_MODE="\$\{SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM:-sync\}"/,
  'the synchronous homepage-critical prewarm must remain the default for standalone daily runs');
assert.match(daily, /case "\$CRITICAL_PORTAL_PREWARM_MODE" in\s*sync\|queue\) ;;\s*\*\)/,
  'only sync and queue modes may be accepted');
assert.match(daily, /invalid SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=\$CRITICAL_PORTAL_PREWARM_MODE[\s\S]*exit 64/,
  'an unknown mode must fail closed with exit 64');
assert.match(daily, /cannot be combined with SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1[\s\S]*exit 64/,
  'queue mode with REQUIRE_CRITICAL_PORTAL_SECTIONS=1 must fail closed, never silently downgrade');

// ---------------------------------------------------------------------------
// Source contracts: linksData stays synchronous and outside the mode branches
// ---------------------------------------------------------------------------
assert.match(daily, /refresh inventory-critical linksData section synchronously[\s\S]*SHEIN_BI_PORTAL_PREWARM_SECTIONS=linksData[\s\S]*SHEIN_BI_PORTAL_PREWARM_ASYNC=0[\s\S]*SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1[\s\S]*bash scripts\/prewarm_bi_portal_sections\.sh 8>&-/,
  'linksData must stay a synchronous host-locked prewarm in every mode');
assert.ok(
  daily.indexOf('refresh inventory-critical linksData section synchronously')
    < daily.indexOf('CRITICAL_PORTAL_PREWARM_MODE" == "sync"'),
  'the linksData sync block must not be inside either homepage-critical mode branch',
);
assert.ok(
  daily.indexOf('SHEIN_BI_PORTAL_PREWARM_SECTIONS=linksData')
    < daily.indexOf('CRITICAL_PORTAL_SECTIONS="'),
  'linksData must be prewarmed before any homepage-critical section decision',
);

// ---------------------------------------------------------------------------
// Source contracts: sync branch unchanged, queue branch never prewarms
// ---------------------------------------------------------------------------
const syncBranch = daily.slice(
  daily.indexOf('CRITICAL_PORTAL_SECTIONS="${SHEIN_BI_DAILY_CRITICAL_PORTAL_SECTIONS'),
  daily.indexOf('bash scripts/enqueue_bi_portal_sections.sh'),
);
assert.match(syncBranch, /SHEIN_BI_DAILY_CRITICAL_PORTAL_SECTIONS:-homeRankings,homeTrafficDaily,priceScatter,afterSales,orders,profit,homeProfit/,
  'the sync branch must keep the full homepage-critical section set');
assert.match(syncBranch, /SHEIN_BI_PORTAL_PREWARM_ASYNC=0[\s\S]*SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1[\s\S]*bash scripts\/prewarm_bi_portal_sections\.sh 8>&-/,
  'sync mode must keep the synchronous host-locked prewarm');
assert.match(syncBranch, /CRITICAL_PORTAL_STATUS=\$\?/,
  'sync mode must keep the retryable critical status contract');

const queueBranch = daily.slice(
  daily.indexOf('bash scripts/enqueue_bi_portal_sections.sh'),
  daily.indexOf('--sections actions,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings'),
);
assert.match(queueBranch, /bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections "\$CRITICAL_PORTAL_SECTIONS"[\s\S]*--priority "\$\{SHEIN_BI_DAILY_CRITICAL_PORTAL_QUEUE_PRIORITY:-10\}"[\s\S]*--reason "daily-refresh-\$DATE"/,
  'queue mode must enqueue every homepage-critical section on the homepage lane priority');
assert.match(daily, /enqueue homepage-critical sections for the bounded queue worker/,
  'queue mode must log the delegation decision');
assert.doesNotMatch(queueBranch, /bash scripts\/prewarm_bi_portal_sections\.sh/,
  'queue mode must never synchronously prewarm the homepage-critical sections');
assert.doesNotMatch(queueBranch, /CRITICAL_PORTAL_STATUS=\$\?/,
  'queue mode must not pretend a synchronous critical prewarm happened');

// ---------------------------------------------------------------------------
// Source contracts: morning coordinator selects queue and keeps the gates
// ---------------------------------------------------------------------------
const supplements = morning.slice(
  morning.indexOf('run_supplements_stage() {'),
  morning.indexOf('run_inventory_stage() {'),
);
assert.match(supplements, /SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize/,
  'the coordinator must keep the single finalize merge');
assert.match(supplements, /SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1/,
  'the 19-store complete link/business requirement must stay fail-closed');
assert.match(supplements, /SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=0[\s\S]*SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue/,
  'the coordinator must delegate homepage-critical sections to the bounded queue');
assert.doesNotMatch(supplements, /SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1/,
  'the coordinator must never force the synchronous homepage-critical gate');
assert.match(supplements, /SHEIN_BI_DAILY_RTV_VERIFY=0[\s\S]*SHEIN_BI_PORTAL_PREWARM_DISABLED=0/,
  'prewarm must stay enabled so the inventory-critical linksData sync block runs');
assert.match(supplements, /timeout --signal=TERM --kill-after=30s "\$\{remaining\}s" bash scripts\/cloud_daily_refresh\.sh/,
  'supplements must remain bounded by the pre-inventory deadline');
assert.match(supplements, /local remaining=\$\(\(PRE_INVENTORY_DEADLINE_EPOCH - \$\(date \+%s\)\)\)[\s\S]*return 76/,
  'the inventory reserve boundary must still abort supplements without starting inventory');

// ---------------------------------------------------------------------------
// Behavioral harness (sandboxed; skipped cleanly when the host lacks bash)
// ---------------------------------------------------------------------------
function bashAvailable() {
  try {
    execFileSync('bash', ['-lc', 'command -v flock && command -v timeout'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

const HARNESS = `
#!/usr/bin/env bash
set -u
export TZ=Asia/Shanghai
REPO="\$PWD"
SB="\$(mktemp -d /tmp/shein-portal-async-test.XXXXXX)"
trap 'rm -rf -- "\$SB"' EXIT
mkdir -p "\$SB/scripts/lib" "\$SB/scripts/marketing" "\$SB/state/locks" "\$SB/state/cloud_ops_alerts" "\$SB/outputs/bi-portal/sections" "\$SB/logs" "\$SB/bin"
chmod 2770 "\$SB/state/locks"
cp "\$REPO/scripts/lib/shared_lock.sh" "\$SB/scripts/lib/shared_lock.sh"
printf 'x' > "\$SB/outputs/bi-portal/index.html"
printf 'x' > "\$SB/outputs/bi-portal/data.json"

cat > "\$SB/bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "\$SB/bin/node"
cat > "\$SB/bin/systemctl" <<'EOF'
#!/bin/sh
exit 3
EOF
chmod +x "\$SB/bin/systemctl"
export PATH="\$SB/bin:\$PATH"

for stub in cloud_link_business_sync refresh_inventory_cost_ledger refresh_profit_marts; do
  cat > "\$SB/scripts/\$stub.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "\$SB/scripts/\$stub.sh"
done

cat > "\$SB/scripts/prewarm_bi_portal_sections.sh" <<'STUB'
#!/usr/bin/env bash
{
  echo "sections=\$SHEIN_BI_PORTAL_PREWARM_SECTIONS"
  echo "async=\$SHEIN_BI_PORTAL_PREWARM_ASYNC"
  echo "host_locked=\$SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED"
} >> "\$PREWARM_LOG"
exit 0
STUB
chmod +x "\$SB/scripts/prewarm_bi_portal_sections.sh"

cat > "\$SB/scripts/enqueue_bi_portal_sections.sh" <<'STUB'
#!/usr/bin/env bash
echo "\$@" >> "\$ENQUEUE_LOG"
exit 0
STUB
chmod +x "\$SB/scripts/enqueue_bi_portal_sections.sh"

export SHEIN_BI_ROOT="\$SB"
export SHEIN_BI_DAILY_LOG_DIR="\$SB/logs"
export SHEIN_BI_DAILY_LOCK_FILE="\$SB/state/locks/daily.lock"
export SHEIN_BI_PORTAL_REFRESH_LOCK_FILE="\$SB/state/locks/portal-refresh.lock"
export SHEIN_BI_LARK_REPORT_LOCK_FILE="\$SB/state/locks/lark-report.lock"
export SHEIN_BI_PORTAL_REFRESH_LOCK_WAIT_SEC=5
export SHEIN_BI_PROFIT_MART_REFRESH_DISABLED=1
export SHEIN_BI_DAILY_RTV_VERIFY=0
export SHEIN_BI_DAILY_OPENAPI_RECONCILIATION=0
export SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION=0
export SHEIN_BI_DAILY_OPENAPI_FINANCE_SYNC=0
export SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION=0
export PREWARM_LOG="\$SB/prewarm.log"
export ENQUEUE_LOG="\$SB/enqueue.log"

REFRESH="\$REPO/scripts/cloud_daily_refresh.sh"
FAIL=0
check_rc() {
  local name="\$1" want="\$2" got="\$3"
  if [[ "\$got" -ne "\$want" ]]; then
    echo "FAIL[\$name] rc got=\$got want=\$want"
    FAIL=1
  else
    echo "PASS[\$name] rc=\$got"
  fi
}
require_absent() {
  local name="\$1" file="\$2"
  if [[ -e "\$file" ]]; then
    echo "FAIL[\$name] unexpected file: \$file"
    FAIL=1
  else
    echo "PASS[\$name] absent"
  fi
}
require_log() {
  local name="\$1" file="\$2" pattern="\$3"
  if [[ -s "\$file" ]] && grep -q -e "\$pattern" "\$file"; then
    echo "PASS[\$name] matched \$pattern"
  else
    echo "FAIL[\$name] missing \$pattern in \$file"
    FAIL=1
  fi
}
require_line_count() {
  local name="\$1" file="\$2" pattern="\$3" want="\$4"
  local got
  got="\$(grep -c -e "\$pattern" "\$file" 2>/dev/null || echo 0)"
  if [[ "\$got" -eq "\$want" ]]; then
    echo "PASS[\$name] lines=\$got"
  else
    echo "FAIL[\$name] lines=\$got want=\$want"
    FAIL=1
  fi
}

# A) queue mode: linksData stays synchronous, homepage-critical sections go to
#    the bounded queue, the run exits 0 and enters inventory promptly.
rm -f "\$PREWARM_LOG" "\$ENQUEUE_LOG" "\$SB/state/cloud_ops_alerts/daily-refresh-last.json"
OUT="\$(SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize \\
  SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1 \\
  SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=0 \\
  SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue \\
  SHEIN_BI_PORTAL_PREWARM_DISABLED=0 \\
  bash "\$REFRESH" yesterday 2>&1)"
RC=\$?
check_rc a_queue_exit 0 "\$RC"
require_line_count a_linksdata_only_prewarm "\$PREWARM_LOG" "sections=" 1
require_log a_linksdata_sync "\$PREWARM_LOG" "sections=linksData"
require_log a_linksdata_host_locked "\$PREWARM_LOG" "host_locked=1"
require_log a_linksdata_not_async "\$PREWARM_LOG" "async=0"
require_log a_critical_enqueued "\$ENQUEUE_LOG" "--sections homeRankings,homeTrafficDaily,priceScatter,afterSales,orders,profit,homeProfit --priority 10"
require_log a_noncritical_enqueued "\$ENQUEUE_LOG" "--sections actions,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings --priority 50"
require_line_count a_two_enqueues "\$ENQUEUE_LOG" "^--sections" 2
if printf '%s\\n' "\$OUT" | grep -q 'homepage-critical sections queued'; then
  echo 'PASS[a_queue_message]'
else
  echo 'FAIL[a_queue_message]'
  FAIL=1
fi
require_absent a_no_failed_alert "\$SB/state/cloud_ops_alerts/daily-refresh-last.json"

# B) default sync mode is a regression gate: the standalone run still
#    synchronously prewarms the full homepage-critical set.
rm -f "\$PREWARM_LOG" "\$ENQUEUE_LOG" "\$SB/state/cloud_ops_alerts/daily-refresh-last.json"
OUT="\$(SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize \\
  SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1 \\
  SHEIN_BI_PORTAL_PREWARM_DISABLED=0 \\
  bash "\$REFRESH" yesterday 2>&1)"
RC=\$?
check_rc b_sync_exit 0 "\$RC"
require_line_count b_sync_two_prewarms "\$PREWARM_LOG" "sections=" 2
require_log b_sync_critical_prewarm "\$PREWARM_LOG" "sections=homeRankings,homeTrafficDaily,priceScatter,afterSales,orders,profit,homeProfit"
require_log b_sync_host_locked "\$PREWARM_LOG" "host_locked=1"
require_log b_sync_not_async "\$PREWARM_LOG" "async=0"
require_line_count b_sync_one_enqueue "\$ENQUEUE_LOG" "^--sections" 1
require_log b_sync_noncritical_enqueue "\$ENQUEUE_LOG" "--priority 50"
if printf '%s\\n' "\$OUT" | grep -q 'refresh homepage-critical sections synchronously'; then
  echo 'PASS[b_sync_message]'
else
  echo 'FAIL[b_sync_message]'
  FAIL=1
fi

# C) queue + REQUIRE_CRITICAL_PORTAL_SECTIONS=1 must fail closed before any
#    section work starts.
rm -f "\$PREWARM_LOG" "\$ENQUEUE_LOG"
OUT="\$(SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue \\
  SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1 \\
  bash "\$REFRESH" yesterday 2>&1)"
RC=\$?
check_rc c_contradiction_exit 64 "\$RC"
require_absent c_no_prewarm "\$PREWARM_LOG"
require_absent c_no_enqueue "\$ENQUEUE_LOG"
if printf '%s\\n' "\$OUT" | grep -q 'cannot be combined'; then
  echo 'PASS[c_contradiction_message]'
else
  echo 'FAIL[c_contradiction_message]'
  FAIL=1
fi

# D) an unknown mode must fail closed before any section work starts.
rm -f "\$PREWARM_LOG" "\$ENQUEUE_LOG"
OUT="\$(SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=bogus \\
  bash "\$REFRESH" yesterday 2>&1)"
RC=\$?
check_rc d_invalid_mode_exit 64 "\$RC"
require_absent d_no_prewarm "\$PREWARM_LOG"
require_absent d_no_enqueue "\$ENQUEUE_LOG"

if [[ "\$FAIL" -eq 0 ]]; then echo 'PORTAL_ASYNC_HARNESS_OK'; exit 0; fi
exit 1
`;

function runBehavioral(label, harness) {
  if (!bashAvailable()) {
    console.log(`SKIP ${label}: bash/flock/timeout unavailable`);
    return 'SKIP';
  }
  const result = spawnSync('bash', ['-s'], {
    cwd: root,
    input: harness,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const harnessOutput = runBehavioral('cloud_daily_refresh.sh portal async modes', HARNESS);
if (typeof harnessOutput === 'string' && harnessOutput.includes('PORTAL_ASYNC_HARNESS_OK')) {
  console.log('portal async behavioral: queue mode keeps linksData sync and enqueues homepage sections; sync default preserved; contradictions fail closed');
}

console.log(JSON.stringify({ok: true}));
