#!/usr/bin/env node
/**
 * Daily inventory replenishment guard: targeted current-detail refresh
 * source-contract.
 *
 * The daily planner emits `detailRefreshTargets` (store+SPU pairs) for every
 * inventory-relevant SPU. The guard must never fall back to the old
 * MAX_DETAILS=0 blind full-catalog reconciliation. Instead, for
 * stale/failed/unavailable/current-detail blockers it:
 *
 * 1. writes an atomic `daily-inventory-detail-targets/v1` manifest under the
 *    runtime root, deduplicated per store+SPU, validated nonempty with
 *    max per-store <= default budget 64;
 * 2. calls cloud_openapi_product_reconciliation.sh with STORES (full 19-store
 *    set), MAX_DETAILS=exact maxTargets (bounded by the 64 ceiling check),
 *    SKIP_DETAILS=0, DETAIL_PRIORITY_FILE and PRIORITY_DETAILS_ONLY=1;
 * 3. rebuilds the same-day plan with --required-detail-targets;
 * 4. fails closed (plan_blocked, exit 2, no execute) on refresh failure,
 *    empty targets or budget overrun.
 *
 * This test pins that contract against the tracked sources.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const guard = read('scripts/cloud_daily_inventory_replenishment_guard.sh');
const reconciliation = read('scripts/cloud_openapi_product_reconciliation.sh');
const planner = read('scripts/inventory/build_daily_inventory_replenishment_plan.mjs');
const executor = read('scripts/inventory/execute_daily_inventory_replenishment_plan.mjs');
const {evaluateResultBatchStatus} = await import('./inventory/daily_inventory_version_publisher.mjs');
function runFixtureShell(script, temp) {
  if (process.platform !== 'win32') {
    return spawnSync('bash', ['--noprofile', '--norc'], {input: script + '\n', encoding: 'utf8', timeout: 60_000});
  }
  // DrvFS without metadata reports mode 0777 even after chmod(0600). Execute
  // the real atomic publisher on Linux tmpfs/ext4, then return fixture evidence
  // to the Windows harness. Feed stdin to avoid Windows -c quote translation.
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
  assert.ok(/^inventory-(trend-ack|guard-journal-only)-[A-Za-z0-9]+$/.test(relative));
  const mounted = temp.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
  const isolated = script.replaceAll(`'${mounted}/bin'`, '"$fixture_root/bin"').replaceAll(`'${mounted}'`, '"$fixture_root"');
  const input = [
    'set -eu',
    `windows_fixture='${mounted}'`,
    'fixture_root=$(mktemp -d /tmp/inventory-guard-fixture-XXXXXXXX)',
    'finish_fixture() {',
    '  fixture_status=$?',
    '  trap - EXIT',
    '  cd /',
    '  cp -R -- "$fixture_root/." "$windows_fixture/" || fixture_status=1',
    '  case "$fixture_root" in /tmp/inventory-guard-fixture-*) rm -rf -- "$fixture_root" ;; *) exit 99 ;; esac',
    '  exit "$fixture_status"',
    '}',
    'trap finish_fixture EXIT',
    'cp -R -- "$windows_fixture/." "$fixture_root/"',
    isolated,
    '',
  ].join('\n');
  return spawnSync('wsl.exe', ['--cd', '/', '--exec', '/bin/bash', '--noprofile', '--norc'], {
    input, encoding: 'utf8', timeout: 60_000,
  });
}

// The shell fixture writes a real, hash-bound marker so its exit trap exercises
// the copied production publisher with the same contract as pipeline_marker.
const markerFixtureScript = String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
fs.appendFileSync('marker-args.ndjson', JSON.stringify(args) + '\n');
if (args[0] === 'write') {
  const value = flag => args[args.indexOf(flag) + 1];
  const status = value('--status');
  const evidence = args.flatMap((arg, index) => {
    if (arg !== '--evidence') return [];
    const file = path.resolve(args[index + 1]);
    const bytes = fs.readFileSync(file);
    return [{path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length}];
  });
  const file = path.join(value('--root'), value('--date'), value('--stage') + '.json');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({stage: value('--stage'), runDate: value('--date'),
    businessDate: value('--business-date'), status, ok: ['done', 'warning'].includes(status), evidence}) + '\n');
}
`;

let checks = 0;
const check = (name, fn) => {
  fn();
  checks += 1;
};
const match = (name, source, pattern, hint) => check(name, () => assert.match(source, pattern, hint));
const noMatch = (name, source, pattern, hint) => check(name, () => assert.doesNotMatch(source, pattern, hint));

// ---------------------------------------------------------------------------
// Per-store detail budget (default 64, positive integer, invalid => exit 64)
// ---------------------------------------------------------------------------
match('budget default is 64',
  guard,
  /DETAIL_TARGET_BUDGET_PER_STORE="\$\{SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-96\}"/,
  'default per-store detail budget must be 64');
match('budget validated as positive integer',
  guard,
  /\[\[ ! "\$DETAIL_TARGET_BUDGET_PER_STORE" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/,
  'invalid budgets must be rejected before any refresh');
match('invalid budget fails closed with exit 64',
  guard,
  /invalid SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE=[\s\S]*exit 64/,
  'a malformed budget must abort the guard');

// ---------------------------------------------------------------------------
// Runtime manifest path (never a repo output)
// ---------------------------------------------------------------------------
match('manifest directory lives under the runtime root',
  guard,
  /DETAIL_TARGETS_DIR="\$RUNTIME_ROOT\/detail-targets"/,
  'the manifest is runtime state, not a tracked output');
match('manifest path is date-scoped',
  guard,
  /DETAIL_TARGETS="\$DETAIL_TARGETS_DIR\/daily-inventory-detail-targets-\$DATE\.json"/,
  'one manifest per day');
match('manifest directory is created before use',
  guard,
  /mkdir -p "\$\(dirname "\$PLAN"\)" "\$\(dirname "\$RESULT"\)" "\$DETAIL_TARGETS_DIR"/,
  'the runtime manifest directory must exist before writing');

// ---------------------------------------------------------------------------
// Manifest schema: daily-inventory-detail-targets/v1, atomic, deduped,
// nonempty, per-store budget respected
// ---------------------------------------------------------------------------
match('manifest uses daily-inventory-detail-targets/v1 schema',
  guard,
  /schemaVersion:"daily-inventory-detail-targets\/v1"/,
  'the second planner build only accepts this schema');
match('manifest groups targets per store from planner detailRefreshTargets',
  guard,
  /--slurpfile plan "\$PLAN"[\s\S]*?\(\$plan\[0\]\.detailRefreshTargets \/\/ \[\]\) as \$rows/,
  'the manifest reads planner targets from the plan file without exceeding the host argument limit');
match('manifest dedupes store+SPU pairs',
  guard,
  /\.\[\$row\.storeKey\] = \(\(\(\.\[\$row\.storeKey\] \/\/ \[\]\) \+ \[\$row\.spu\]\) \| unique \| sort\)/,
  'per-store SPU lists must be unique and sorted (store+SPU dedupe)');
match('manifest exposes total/perStore/maxPerStore counts',
  guard,
  /counts:\{\s*total:\(reduce \(\$grouped\[\] \| length\) as \$n \(0; \. \+ \$n\)\),\s*perStore:\(\$grouped \| map_values\(length\)\),\s*maxPerStore:\(reduce \(\$grouped\[\] \| length\) as \$n \(0; if \$n > \. then \$n else \. end\)\)\s*\}/,
  'the manifest must report the counts used for validation');
match('per-store counts derive from the deduped stores',
  guard,
  /perStore:\(\$grouped \| map_values\(length\)\)/,
  'counts.perStore must always equal the deduped stores array lengths');
noMatch('per-store counts no longer increment per raw row',
  guard,
  /\.perStore\[\$row\.storeKey\] = \(\(\.perStore\[\$row\.storeKey\] \/\/ 0\) \+ 1\)/,
  'raw-row counting could disagree with the deduped stores lists');
match('manifest written atomically via tmp + mv',
  guard,
  /' >"\$DETAIL_TARGETS\.tmp"; then[\s\S]*mv -f "\$DETAIL_TARGETS\.tmp" "\$DETAIL_TARGETS"/,
  'a crash mid-write must never leave a partial manifest');
match('empty manifest is rejected before refresh',
  guard,
  /total_targets="\$\(jq -r '\.counts\.total \/\/ 0' "\$DETAIL_TARGETS"\)"[\s\S]*\[\[ ! "\$total_targets" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/,
  'zero targets must stay blocked, no reconciliation may run');
match('empty manifest refuses refresh and returns failure',
  guard,
  /targeted detail manifest is empty; refusing refresh without targets and staying blocked[\s\S]*return 1/,
  'empty targets must keep the plan blocked');
match('per-store budget overrun detected from maxPerStore',
  guard,
  /max_targets="\$\(jq -r '\.counts\.maxPerStore \/\/ 0' "\$DETAIL_TARGETS"\)"[\s\S]*\(\( max_targets > DETAIL_TARGET_BUDGET_PER_STORE \)\)[\s\S]*return 2/,
  'max per-store targets must never exceed the budget');
match('budget overrun message names the limit',
  guard,
  /targeted detail manifest exceeds per-store budget maxTargets=.*budget=\$DETAIL_TARGET_BUDGET_PER_STORE/,
  'the fail-closed message must carry maxTargets and budget');

// ---------------------------------------------------------------------------
// Reconciliation call: STORES (full 19-store set), MAX_DETAILS=budget,
// SKIP_DETAILS=0, DETAIL_PRIORITY_FILE, PRIORITY_DETAILS_ONLY=1; never
// MAX_DETAILS=0 blind full scan
// ---------------------------------------------------------------------------
match('refresh passes the full 19-store STORES set',
  guard,
  /RECONCILE_STORES="\$\{SHEIN_BI_INVENTORY_RECONCILE_STORES:-CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL\}"/,
  'list + stock must refresh every plan store, not a narrowed subset');
match('refresh passes STORES into the reconciliation env',
  guard,
  /SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="\$RECONCILE_STORES" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="\$max_targets" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=0 \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE="\$DETAIL_TARGETS" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \\\n\s*bash scripts\/cloud_openapi_product_reconciliation\.sh/,
  'the targeted refresh must launch reconciliation with the exact bounded env');
match('refresh runs reconciliation through bash',
  guard,
  /PRIORITY_DETAILS_ONLY=1 \\\n\s*bash scripts\/cloud_openapi_product_reconciliation\.sh/,
  'the tracked wrapper is invoked explicitly');
noMatch('no MAX_DETAILS=0 blind full-catalog scan remains',
  guard,
  /MAX_DETAILS=0/,
  'the old full-scan branch must be gone');
noMatch('no bare full-scan reconciliation invocation remains',
  guard,
  /SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 bash scripts\/cloud_openapi_product_reconciliation\.sh/,
  'the old branch ran reconciliation without the bounded env');

// ---------------------------------------------------------------------------
// Pre-plan inventoryTrend freshness: the ET forwarder sync-refreshes only
// orders/waybills/afterSales and queues inventoryTrend asynchronously, so the
// guard bounded-refreshes inventoryTrend itself before the first plan build.
// The write interface is called at most once per run and is never retried.
// ---------------------------------------------------------------------------
match('inventory force refresh owns one stable run token',
  guard,
  /SHEIN_BI_INVENTORY_REFRESH_TOKEN:-daily-inventory:/,
  'all force-refresh retries inside one inventory run must reuse one token');
match('inventoryTrend file default is the planner input',
  guard,
  /INVENTORY_TREND_FILE="\$\{SHEIN_BI_INVENTORY_TREND_FILE:-\$ROOT\/outputs\/bi-portal\/sections\/inventoryTrend\.json\}"/,
  'the guard refreshes the exact file the planner consumes');
match('inventoryTrend max age default mirrors linksData',
  guard,
  /INVENTORY_TREND_MAX_AGE_SECONDS="\$\{SHEIN_BI_INVENTORY_TREND_MAX_AGE_SECONDS:-1800\}"/,
  'the freshness gate defaults to the same 1800s as linksData');
match('inventoryTrend refresh timeout mirrors linksData',
  guard,
  /INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS="\$\{SHEIN_BI_INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS:-1200\}"/,
  'the bounded refresh defaults to the same 1200s timeout as linksData');
match('inventoryTrend age reads cachedAt/generatedAt like linksData',
  guard,
  /jq -r '\.cachedAt \/\/ \.generatedAt \/\/ empty' "\$INVENTORY_TREND_FILE"/,
  'freshness derives from the published cache timestamp');
match('inventoryTrend refresh is host-locked and section-scoped',
  guard,
  /refresh_ack="\$\(curl -fsS --max-time "\$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS" \\\n\s*-H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \\\n\s*"\$PORTAL_URL\/api\/bi\/section\/inventoryTrend\?refresh=1&refreshToken=\$\{REFRESH_RUN_TOKEN\}"\)";/,
  'the sync refresh must reuse the host-locked worker header on the section endpoint');
match('inventoryTrend refresh requires a terminal JSON ack',
  guard,
  /jq -e [\s\S]*type == "object"[\s\S]*\.ok == true[\s\S]*\.section == "inventoryTrend"[\s\S]*\.terminal == true/,
  'HTTP success alone must not promote a nonterminal or wrong-section response');
const refreshAckValidation = guard.slice(
  guard.indexOf("if ! jq -e '\n    type == \"object\""),
  guard.indexOf("' <<<\"$refresh_ack\""),
);
noMatch('terminal acknowledgement does not require generatedAt',
  refreshAckValidation,
  /generatedAt/,
  'the real raw-cache host-locked acknowledgement may carry an empty generatedAt');
match('fresh inventoryTrend skips duplicate refresh',
  guard,
  /inventoryTrend fresh ageSeconds=\$age; skip duplicate refresh/,
  'an already-fresh section must not be re-refreshed');
match('failed inventoryTrend refresh stays a failure',
  guard,
  /inventoryTrend refresh did not publish a fresh cache ageSeconds=\$\{age:-unknown\}[\s\S]*return 1/,
  'a refresh that does not publish a fresh cache must return failure');
check('exactly one inventoryTrend refresh call per run (no write-interface retry)', () => {
  assert.equal((guard.match(/inventoryTrend\?refresh=1/g) || []).length, 1,
    'the inventoryTrend write interface must never be retried inside the guard run');
});
check('inventoryTrend refresh runs before the first plan build', () => {
  const refreshAt = guard.indexOf('ensure_inventory_trend_fresh 1\n');
  const firstBuildAt = guard.indexOf('build_plan || PLAN_STATUS=$?');
  assert.ok(refreshAt >= 0 && firstBuildAt >= 0 && refreshAt < firstBuildAt,
    'the plan must be built after the refresh so only detail blockers remain');
});
match('inventoryTrend refresh is always forced once per daily run',
  guard,
  /^\s*ensure_inventory_trend_fresh 1$/m,
  'a fresh cachedAt can still hide an old ET business day, so the daily refresh must bypass the age skip');
noMatch('inventoryTrend refresh failure is never swallowed',
  guard,
  /ensure_inventory_trend_fresh 1 \|\| true/,
  'a failed refresh must abort the guard, not fall through to a stale plan');
match('inventoryTrend HTTP failure blocks the guard',
  guard,
  /if ! refresh_ack="\$\(curl -fsS --max-time "\$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS"[\s\S]*inventoryTrend HTTP refresh failed; blocking the daily inventory guard[\s\S]*return 1/,
  'a non-success HTTP refresh must stop the guard before any plan build or write');
noMatch('cachedAt advancement is not required after a terminal ack',
  guard,
  /request_start_epoch|published_epoch|cachedAt did not advance past request start/,
  'a terminal refresh ack may legitimately leave identical cache content and cachedAt');
match('matched current-day row count uses the planner row rule',
  guard,
  /select\(\(\( \.inventory_match_status \/\/ ""\) == "matched"\)\)[\s\S]*contains\("01_full_carton_exception"\)[\s\S]*et_box_snapshot_date[\s\S]*et_store_snapshot_date[\s\S]*\.\[0:10\]/,
  'the guard must count matched rows with the same per-row warehouse-position date rule as the planner');
match('zero matched current-day rows blocks the guard',
  guard,
  /\(\( matched_current_day <= 0 \)\)[\s\S]*inventoryTrend has no matched current-day operational rows[\s\S]*return 1/,
  'an artifact without any matched current-day ET row must stop the guard');

// Exercise the actual shell refresh gate with a local curl stub. The terminal
// case intentionally leaves inventoryTrend bytes unchanged: a valid terminal
// ack plus a fresh cache and one current-day row is sufficient.
check('inventoryTrend ack and cache postconditions fail closed without retries', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-trend-ack-'));
  const runDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'})
    .format(new Date(Date.now() - 86_400_000));
  const trendFile = path.join(temp, 'inventoryTrend.json');
  const linksFile = path.join(temp, 'linksData.json');
  const countFile = path.join(temp, 'curl-count');
  const setupDirs = [
    path.join(temp, 'bin'),
    path.join(temp, 'scripts', 'lib'),
    path.join(temp, 'scripts', 'inventory'),
    path.join(temp, 'lib'),
  ];
  try {
    for (const dir of setupDirs) fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(temp, 'scripts', 'cloud_daily_inventory_replenishment_guard.sh'), guard);
    fs.copyFileSync(
      path.resolve('scripts', 'inventory', 'daily_inventory_version_publisher.mjs'),
      path.join(temp, 'scripts', 'inventory', 'daily_inventory_version_publisher.mjs')
    );
    fs.copyFileSync(path.resolve('lib', 'inventory_journal_discovery.mjs'), path.join(temp, 'lib', 'inventory_journal_discovery.mjs'));
    fs.copyFileSync(
      path.resolve('lib', 'atomic_file_publish.mjs'),
      path.join(temp, 'lib', 'atomic_file_publish.mjs')
    );
    fs.copyFileSync(
      path.resolve('lib', 'cross_process_ticket_lock.mjs'),
      path.join(temp, 'lib', 'cross_process_ticket_lock.mjs')
    );
    fs.writeFileSync(path.join(temp, 'scripts', 'lib', 'shared_lock.sh'),
      'prepare_shared_lock_file(){ mkdir -p "$(dirname "$1")"; touch "$1"; }\n');
    fs.writeFileSync(path.join(temp, 'lib', 'durable_inventory_write.mjs'), `
export async function discoverInventoryJournalFiles(file) { return [file]; }
export async function readInventoryIntentLifecycle() {
  return {intents: new Map(), pending: new Map(), terminalOutcomes: new Map()};
}
export async function readInventoryIntentJournals(files) {
  return {
    files,
    records: [],
    pending: new Map(),
    terminalOutcomes: new Map(),
    manualResolutions: new Map(),
    fences: new Map(),
    tombstonedIdempotencyKeys: new Set(),
  };
}
`);
    fs.writeFileSync(path.join(temp, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const output = value('--out');
fs.appendFileSync(process.env.SHEIN_TEST_PHASE_FILE, 'planner\\n');
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify({
  date: value('--date'),
  payloadHash: 'a'.repeat(64),
  executable: true,
  blockers: [],
  actionable: [],
}) + '\\n');
`);
    fs.writeFileSync(path.join(temp, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
fs.appendFileSync(process.env.SHEIN_TEST_PHASE_FILE, 'executor\\n');
const plan = JSON.parse(fs.readFileSync(value('--plan'), 'utf8'));
const output = value('--out');
fs.writeFileSync(output + '.tmp', JSON.stringify({
  planHash: plan.payloadHash,
  execute: true,
  executionMode: 'automatic',
  generatedAt: new Date().toISOString(),
  results: [],
}) + '\\n');
fs.renameSync(output + '.tmp', output);
`);
    fs.writeFileSync(path.join(temp, 'scripts', 'pipeline_marker.mjs'), markerFixtureScript);
    fs.writeFileSync(path.join(temp, 'scripts', 'validate_daily_operating_refresh.mjs'), 'process.exit(0);\n');
    const ack = {
      terminal: JSON.stringify({ok: true, section: 'inventoryTrend', generatedAt: '', terminal: true}),
      nonterminal: JSON.stringify({ok: true, section: 'inventoryTrend', generatedAt: '2026-09-01T00:00:00.000Z', terminal: false}),
      wrongSection: JSON.stringify({ok: true, section: 'linksData', generatedAt: '2026-09-01T00:00:00.000Z', terminal: true}),
      notOk: JSON.stringify({ok: false, section: 'inventoryTrend', generatedAt: '2026-09-01T00:00:00.000Z', terminal: true}),
    };
    fs.writeFileSync(path.join(temp, 'bin', 'curl'), [
      '#!/usr/bin/env bash',
      'set -u',
      'is_inventory_trend=0',
      'for arg in "$@"; do [[ "$arg" == *"/inventoryTrend?"* ]] && is_inventory_trend=1; done',
      'if [[ "$is_inventory_trend" != "1" ]]; then printf "%s\\n" "{}"; exit 0; fi',
      'count_file="${SHEIN_TEST_CURL_COUNT_FILE:?}"',
      'if [[ -f "$count_file" ]]; then count=$(<"$count_file"); else count=0; fi',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" >"$count_file"',
      'case "${SHEIN_TEST_CURL_MODE:-terminal}" in',
      '  http-500) exit 22 ;;',
      `  nonjson) printf '%s\\n' 'not-json' ;;`,
      `  not-ok) printf '%s\\n' '${ack.notOk}' ;;`,
      `  http-202-nonterminal|nonterminal) printf '%s\\n' '${ack.nonterminal}' ;;`,
      `  wrong-section) printf '%s\\n' '${ack.wrongSection}' ;;`,
      `  terminal) printf '%s\\n' '${ack.terminal}' ;;`,
      '  *) exit 99 ;;',
      'esac',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(temp, 'bin', 'curl'), 0o755);

    const writeSources = (cacheAgeSeconds, rowDate) => {
      const cachedAt = new Date(Date.now() - cacheAgeSeconds * 1000).toISOString();
      fs.writeFileSync(linksFile, JSON.stringify({cachedAt, generatedAt: cachedAt}) + '\n');
      fs.writeFileSync(trendFile, JSON.stringify({
        cachedAt,
        generatedAt: cachedAt,
        data: {
          inventoryDepletion: {
            products: [{inventory_match_status: 'matched', et_store_snapshot_date: rowDate}],
          },
        },
      }) + '\n');
    };
    const wslTemp = temp
      .replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`)
      .replaceAll('\\', '/');
    const wslBin = `${wslTemp}/bin`;
    const runGuard = (mode, cacheAgeSeconds = 60, rowDate = runDate) => {
      fs.rmSync(path.join(temp, 'runtime'), {recursive: true, force: true});
      writeSources(cacheAgeSeconds, rowDate);
      fs.rmSync(countFile, {force: true});
      fs.rmSync(path.join(temp, 'phase.log'), {force: true});
      const before = fs.readFileSync(trendFile);
      const run = runFixtureShell([
        `cd '${wslTemp}' &&`,
        'env',
        'SHEIN_BI_ROOT=.',
        'SHEIN_BI_INVENTORY_RUNTIME_ROOT=runtime',
        `SHEIN_BI_INVENTORY_RUN_DATE=${runDate}`,
        `SHEIN_BI_INVENTORY_BUSINESS_DATE=${businessDate}`,
        'SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH=0',
        'SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=0',
        'SHEIN_BI_INVENTORY_MAX_ROWS=10',
        'SHEIN_BI_INVENTORY_LINKS_MAX_AGE_SECONDS=1800',
        'SHEIN_BI_INVENTORY_TREND_MAX_AGE_SECONDS=1800',
        'SHEIN_BI_INVENTORY_REFRESH_TIMEOUT_SECONDS=5',
        'SHEIN_BI_INVENTORY_REFRESH_TOKEN=fixture',
        'SHEIN_BI_INVENTORY_LINKS_DATA_FILE=linksData.json',
        'SHEIN_BI_INVENTORY_TREND_FILE=inventoryTrend.json',
        'SHEIN_BI_PORTAL_URL=http://127.0.0.1:8787',
        `SHEIN_TEST_CURL_MODE=${mode}`,
        'SHEIN_TEST_CURL_COUNT_FILE=curl-count',
        'SHEIN_TEST_PHASE_FILE=phase.log',
        `PATH='${wslBin}':"$PATH"`,
        'bash scripts/cloud_daily_inventory_replenishment_guard.sh',
      ].join(' '), temp);
      const calls = fs.existsSync(countFile)
        ? Number.parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10)
        : 0;
      const phases = fs.existsSync(path.join(temp, 'phase.log'))
        ? fs.readFileSync(path.join(temp, 'phase.log'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
        : [];
      return {run, calls, phases, before, after: fs.readFileSync(trendFile)};
    };

    for (const testCase of [
      {name: 'HTTP non-2xx', mode: 'http-500', cacheAgeSeconds: 60, rowDate: runDate, status: 1},
      {name: 'non-JSON response', mode: 'nonjson', cacheAgeSeconds: 60, rowDate: runDate, status: 1},
      {name: 'ok=false response', mode: 'not-ok', cacheAgeSeconds: 60, rowDate: runDate, status: 1},
      {name: 'HTTP 202 nonterminal response', mode: 'http-202-nonterminal', cacheAgeSeconds: 60, rowDate: runDate, status: 1},
      {name: 'wrong section response', mode: 'wrong-section', cacheAgeSeconds: 60, rowDate: runDate, status: 1},
      {name: 'stale cache after terminal ack', mode: 'terminal', cacheAgeSeconds: 1801, rowDate: runDate, status: 1},
      {name: 'zero current-day rows after terminal ack', mode: 'terminal', cacheAgeSeconds: 60, rowDate: businessDate, status: 1},
      {name: 'same-content terminal ack', mode: 'terminal', cacheAgeSeconds: 60, rowDate: runDate, status: 0, unchanged: true},
    ]) {
      const result = runGuard(testCase.mode, testCase.cacheAgeSeconds, testCase.rowDate);
      assert.equal(result.run.status, testCase.status,
        `${testCase.name} status=${result.run.status}\nstdout=${result.run.stdout}\nstderr=${result.run.stderr}`);
      assert.equal(result.calls, 1,
        `${testCase.name} must issue exactly one inventoryTrend curl\nstdout=${result.run.stdout}\nstderr=${result.run.stderr}`);
      assert.deepEqual(result.phases, testCase.status === 0 ? ['planner', 'executor'] : [],
        `${testCase.name} must ${testCase.status === 0 ? 'reach' : 'stop before'} planner and executor`);
      if (testCase.unchanged) {
        assert.deepEqual(result.after, result.before,
          'a terminal ack must allow identical cache bytes without cachedAt advancement');
      }
    }
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
});

check('stale ET projection never selects a targeted refresh reason', () => {
  const reasonStart = guard.indexOf('REFRESH_REASON=""');
  const reasonEnd = guard.indexOf('if [[ -n "$REFRESH_REASON" ]]; then', reasonStart);
  assert.ok(reasonStart >= 0 && reasonEnd > reasonStart, 'the refresh-decision block must exist');
  const decision = guard.slice(reasonStart, reasonEnd);
  assert.doesNotMatch(decision, /BI\/ET projection is stale/,
    'a failed inventoryTrend refresh keeps the ET blocker outside every refresh branch, so the run stays blocked');
});
check('current-detail predicate covers only the three detail-evidence blockers', () => {
  const start = guard.indexOf('all(.blockers[];');
  const end = guard.indexOf('"$PLAN" >/dev/null; then', start);
  assert.ok(start >= 0 && end > start, 'the predicate block must exist');
  const predicate = guard.slice(start, end);
  assert.match(predicate, /test\(" OpenAPI product detail evidence is incomplete\(\$\|:\)"\)/);
  assert.match(predicate, /test\(" OpenAPI product canonical evidence is incomplete\(\$\|:\)"\)/);
  assert.match(predicate, /test\(" OpenAPI product canonical evidence is not from current detail\(\$\|:\)"\)/);
  assert.doesNotMatch(predicate, /BI\/ET projection is stale/,
    'a refreshed plan with only detail blockers must satisfy all() and trigger the targeted refresh');
  assert.doesNotMatch(predicate, /BI links data is stale/,
    'stale linksData must never be silently absorbed by the targeted refresh');
});
check('769 not-current-detail plus 7 canonical-incomplete blockers are recoverable together', () => {
  const recoverable = blocker => (
    / OpenAPI product detail evidence is incomplete(?:$|:)/.test(blocker)
    || / OpenAPI product canonical evidence is incomplete(?:$|:)/.test(blocker)
    || / OpenAPI product canonical evidence is not from current detail(?:$|:)/.test(blocker)
  );
  const blockers = [
    ...Array.from({length: 769}, (_, index) => `DL OpenAPI product canonical evidence is not from current detail: store=DL spu=spu-${index} skc=skc-${index}`),
    ...Array.from({length: 7}, (_, index) => `DL OpenAPI product canonical evidence is incomplete: store=DL spu=canonical-${index} skc=canonical-${index}`),
  ];
  assert.equal(blockers.length, 776);
  assert.equal(blockers.every(recoverable), true,
    'the exact production-shaped 769+7 blocker mix must satisfy the all() recovery gate');
  assert.equal(recoverable('DL OpenAPI product detail evidence is incomplete'), true);
  assert.equal(recoverable('DL OpenAPI product detail evidence is incomplete: store=DL spu=1 skc=1'), true);
  assert.equal(recoverable('DL OpenAPI product canonical evidence is incomplete'), true);
  assert.equal(recoverable('DL OpenAPI product canonical evidence is incomplete: store=DL spu=1 skc=1'), true);
});
check('any non-allowlisted blocker keeps the targeted refresh gate closed', () => {
  const recoverable = blocker => (
    / OpenAPI product detail evidence is incomplete(?:$|:)/.test(blocker)
    || / OpenAPI product canonical evidence is incomplete(?:$|:)/.test(blocker)
    || / OpenAPI product canonical evidence is not from current detail(?:$|:)/.test(blocker)
  );
  const allowed = ['DL OpenAPI product canonical evidence is incomplete: store=DL spu=1 skc=1'];
  for (const blocker of [
    'DL OpenAPI product exposure evidence is incomplete: store=DL spu=1',
    'DL OpenAPI product has multiple SKUs: store=DL spu=1',
    'daily current-detail target set is not fully covered by manifest: store=DL spu=1',
    'BI/ET projection is stale: generatedAt=old ageHours=20',
    'BI links data is stale: generatedAt=old ageHours=20',
    'DL OpenAPI product canonical evidence is incomplete but exposure is missing',
  ]) {
    assert.equal([...allowed, blocker].every(recoverable), false, `must remain blocked: ${blocker}`);
  }
});

// ---------------------------------------------------------------------------
// Per-run row ceiling: the guard refuses to invoke the executor when the
// plan already exceeds MAX_ROWS, and the executor refuses to slice. TOTAL >
// MAX_ROWS exits 2 before the executor launch, so no partial write can occur.
// ---------------------------------------------------------------------------
match('per-run row ceiling default is 1000',
  guard,
  /MAX_ROWS="\$\{SHEIN_BI_INVENTORY_MAX_ROWS:-1000\}"/,
  'the guard and executor must share the same default ceiling');
match('row ceiling validated as positive integer',
  guard,
  /\[\[ ! "\$MAX_ROWS" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/,
  'an invalid ceiling must be rejected before any plan build');
match('invalid row ceiling fails closed with exit 64',
  guard,
  /invalid SHEIN_BI_INVENTORY_MAX_ROWS=[\s\S]*exit 64/,
  'a malformed ceiling must abort the guard');
match('row ceiling overrun fails closed with exit 2',
  guard,
  /\(\( TOTAL > MAX_ROWS \)\)[\s\S]*refusing executor to avoid partial writes[\s\S]*exit 2/,
  'an over-ceiling plan must block without launching the executor');
check('row ceiling gate sits before the executor invocation', () => {
  const gateAt = guard.indexOf('TOTAL > MAX_ROWS');
  const executorAt = guard.indexOf('node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs');
  assert.ok(gateAt >= 0 && executorAt >= 0 && gateAt < executorAt,
    'the guard must exit 2 before the executor can be launched');
});
match('executor receives the validated row ceiling',
  guard,
  /--max-rows "\$MAX_ROWS" \\/,
  'the same MAX_ROWS value must reach the executor');
noMatch('no hardcoded executor row limit remains',
  guard,
  /--max-rows 1000/,
  'the guard and executor ceilings must stay wired to the shared variable');

{
  const guardStores = guard.match(/RECONCILE_STORES="\$\{SHEIN_BI_INVENTORY_RECONCILE_STORES:-([^}]+)\}"/)?.[1] ?? '';
  const reconciliationStores = reconciliation.match(/DEFAULT_STORES="([^"]+)"/)?.[1] ?? '';
  check('guard STORES set equals reconciliation DEFAULT_STORES', () => {
    const norm = value => value.split(',').map(item => item.trim()).filter(Boolean).sort().join(',');
    assert.equal(norm(guardStores), norm(reconciliationStores),
      'guard and reconciliation must agree on the full store set');
    assert.equal(guardStores.split(',').length, 19, 'the full daily store set is 19 stores');
  });
}

// ---------------------------------------------------------------------------
// Blocker match patterns: stale / failed chunks / unavailable / current-detail
// ---------------------------------------------------------------------------
match('stale-snapshot blocker pattern',
  guard,
  /test\(" OpenAPI product snapshot is stale\$"\)/,
  'stale snapshots trigger the targeted refresh');
match('failed-stock-chunks blocker pattern',
  guard,
  /test\(" OpenAPI stock snapshot has failed chunks\$"\)/,
  'failed stock chunks trigger the targeted refresh');
match('unavailable-snapshot blocker pattern',
  guard,
  /test\(" OpenAPI product snapshot unavailable:"\)/,
  'unavailable snapshots trigger the targeted refresh');
match('stale-refresh gate is enabled by default',
  guard,
  /REFRESH_OPENAPI_ON_STALE="\$\{SHEIN_BI_INVENTORY_REFRESH_OPENAPI_ON_STALE:-1\}"/,
  'the OpenAPI stale refresh must default on');
match('current-detail evidence blocker pattern',
  guard,
  /test\(" OpenAPI product detail evidence is incomplete\(\$\|:\)"\)/,
  'missing current detail blocks and is recoverable');
match('canonical-evidence blocker pattern',
  guard,
  /test\(" OpenAPI product canonical evidence is incomplete\(\$\|:\)"\)/,
  'canonical evidence gaps are recoverable through targeted detail');
match('current-detail provenance blocker pattern',
  guard,
  /test\(" OpenAPI product canonical evidence is not from current detail\(\$\|:\)"\)/,
  'cached (non-current) detail is recoverable only through targeted refresh');
match('current-detail gate requires emitted targets',
  guard,
  /REFRESH_DETAIL_TARGETS_ON_BLOCKED="\$\{SHEIN_BI_INVENTORY_REFRESH_DETAIL_TARGETS_ON_BLOCKED:-1\}"/,
  'the current-detail refresh must default on');
match('current-detail refresh only runs on non-executable plans with targets and only detail blockers',
  guard,
  /\[\[ "\$\(jq -r '\.executable' "\$PLAN"\)" != "true" \]\] \\\n\s*&& jq -e '\s*\(\(\.detailRefreshTargets \/\/ \[\]\) \| length\) > 0\s*and \(\(\.blockers \/\/ \[\]\) \| length\) > 0\s*and all\(\.blockers\[\];/,
  'no execute without a blocked plan, emitted targets and only recoverable blockers');
match('refresh decision branches are mutually exclusive via if/elif',
  guard,
  /REFRESH_REASON="openapi_sources_stale"[\s\S]*elif \[\[ "\$REFRESH_DETAIL_TARGETS_ON_BLOCKED" == "1" \]\] \\\n\s*&& \[\[ "\$\(jq -r '\.executable' "\$PLAN"\)" != "true" \]\]/,
  'stale-sources and current-detail branches must never both fire');
check('exactly one targeted reconciliation call point per run', () => {
    assert.equal((guard.match(/^\s+refresh_targeted_openapi_sources \|\| REFRESH_STATUS=\$\?$/gm) || []).length, 1,
    'the merged refresh decision exposes a single call point, so at most one reconciliation runs per guard run');
});
match('reconciliation is gated by the single-run reason',
  guard,
  /if \[\[ -n "\$REFRESH_REASON" \]\]; then[\s\S]*refresh_targeted_openapi_sources \|\| REFRESH_STATUS=\$\?/,
  'the only call site sits inside the merged decision gate');

// ---------------------------------------------------------------------------
// MAX_DETAILS is the exact manifest maxPerStore (already validated <= 64):
// maxTargets=68 reconciles with MAX_DETAILS=68, maxTargets>96 fails closed
// before any reconciliation env is built.
// ---------------------------------------------------------------------------
match('reconciliation MAX_DETAILS is the exact validated maxTargets',
  guard,
  /SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="\$max_targets" \\/,
  'the reconciliation pays for the real target count, not the ceiling');
check('per-store ceiling stays 96 and gates before reconciliation', () => {
  const budgetDefault = guard.match(/DETAIL_TARGET_BUDGET_PER_STORE="\$\{SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-(\d+)\}"/)?.[1];
  assert.equal(budgetDefault, '96', 'the per-store ceiling remains 96');
  const budgetCheckAt = guard.indexOf('max_targets > DETAIL_TARGET_BUDGET_PER_STORE');
  const reconcileAt = guard.indexOf('SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$max_targets"');
  assert.ok(budgetCheckAt >= 0 && reconcileAt >= 0 && budgetCheckAt < reconcileAt,
    'over-budget manifests must fail closed before any reconciliation env is built');
});
check('maxTargets=68 passes and maxTargets>96 fails closed', () => {
  assert.equal(68 > 96, false, 'the measured 2026-08-30 maxPerStore=68 must pass the 96 ceiling');
  assert.equal(97 > 96, true, 'any store over the 96 ceiling must hit the overrun branch');
  assert.match(guard, /\(\( max_targets > DETAIL_TARGET_BUDGET_PER_STORE \)\)[\s\S]*return 2/,
    'the over-ceiling branch must fail closed with return 2');
});

// ---------------------------------------------------------------------------
// Second build: rebuild the same-day plan with --required-detail-targets
// ---------------------------------------------------------------------------
check('exactly one manifest rebuild after the single refresh', () => {
  assert.equal((guard.match(/build_plan "\$DETAIL_TARGETS" \|\| PLAN_STATUS=\$\?/g) || []).length, 1,
    'after the single successful refresh the plan must be rebuilt against the manifest');
});
match('build_plan supports --required-detail-targets',
  guard,
  /--required-detail-targets "\$manifest" \\\n\s*--out "\$PLAN"/,
  'the rebuild must require every manifest target');
match('planner parses --required-detail-targets',
  planner,
  /a === '--required-detail-targets'/,
  'the planner CLI flag must exist');
match('planner accepts only the daily schema in daily mode',
  planner,
  /requiredDetailTargets\.schemaVersion !== 'daily-inventory-detail-targets\/v1'/,
  'the daily second build validates the manifest schema');
match('planner validates manifest date against plan date',
  planner,
  /daily current-detail target manifest date does not match plan date/,
  'a stale manifest must never gate a different day');
match('planner validates per-store budget',
  planner,
  /daily current-detail target manifest exceeds per-store budget: store=/,
  'the second build re-checks the per-store budget');
match('planner rejects empty or duplicate per-store SPUs',
  planner,
  /daily current-detail target manifest has empty or duplicate SPUs for store=/,
  'dedupe and nonempty are enforced again at plan time');
match('planner fails closed on missing or non-current targets',
  planner,
  /daily current-detail target is (missing from refreshed snapshot|not from current detail after refresh):/,
  'any manifest target without current detail keeps the plan blocked');
match('planner freezes the bound detail manifest as distinct plan-private evidence',
  planner,
  /immutableBoundManifestMeta = await writePlanPrivateEvidenceArtifact\(requiredDetailTargetsMeta, \{kind: 'daily-detail-manifest-bound'\}\)/,
  'DETAIL_MANIFEST.file must bind the manifest after terminalEvidence was embedded');
match('planner freezes the original detail manifest as distinct plan-private evidence',
  planner,
  /immutableOriginalManifestMeta = await writePlanPrivateEvidenceArtifact\(originalManifestMeta, \{kind: 'daily-detail-manifest-original'\}\)/,
  'manifestOriginalFile must remain the original guard manifest, not the bound manifest');
match('planner freezes terminal evidence as distinct plan-private evidence',
  planner,
  /immutableEvidenceMeta = await writePlanPrivateEvidenceArtifact\(evidenceMeta, \{kind: 'daily-detail-terminal-evidence'\}\)/,
  'terminalEvidenceFile must remain the standalone terminal evidence artifact');
match('DETAIL_MANIFEST file points at the bound manifest artifact',
  planner,
  /store: 'DETAIL_MANIFEST',[\s\S]*file: immutableBoundManifestMeta\.file,[\s\S]*sha256: immutableBoundManifestMeta\.sha256/,
  'the DETAIL_MANIFEST primary file/hash must not be confused with the original manifest');
match('DETAIL_MANIFEST original and terminal evidence paths stay separate',
  planner,
  /manifestOriginalFile: immutableOriginalManifestMeta\.file,[\s\S]*terminalEvidenceFile: immutableEvidenceMeta\.file/,
  'bound manifest, original manifest and terminal evidence must be independently bound');
match('planner rejects targetBindings without a cache source',
  planner,
  /if \(!storeKey \|\| !sourceCacheFile\) \{[\s\S]*terminal target binding cache source is missing/,
  'targetBindings.cacheFile is required and cannot silently fall back to a mutable path');
match('planner requires targetBindings to match immutable cacheBindings by original source path',
  planner,
  /path\.resolve\(cache\.sourceCacheFile\) === path\.resolve\(sourceCacheFile\)[\s\S]*terminal target binding cache source has no immutable cache binding/,
  'a target binding with no matching cache binding must fail closed');
match('planner always rewrites targetBindings to immutable cache files while retaining sourceCacheFile',
  planner,
  /return \{\.\.\.binding, cacheFile: boundCache\.cacheFile, sourceCacheFile\};/,
  'successful targetBindings must never preserve the original mutable cacheFile');
noMatch('planner no longer falls back to original terminal target binding',
  planner,
  /boundCache \? \{\.\.\.binding, cacheFile: boundCache\.cacheFile, sourceCacheFile\} : binding/,
  'missing cache binding must throw instead of preserving the mutable source path');

// ---------------------------------------------------------------------------
// Fail-closed: refresh failure / empty targets / budget exceed => blocked,
// no execute
// ---------------------------------------------------------------------------
match('budget overrun appends a blocker and exits 2',
  guard,
  /plan_blocked_with_budget_failure[\s\S]*daily current-detail target manifest exceeds per-store budget[\s\S]*exit 2/,
  'an over-budget manifest must terminate the guard blocked');
match('budget fail-closed is wired into the single refresh path',
  guard,
  /plan_blocked_with_budget_failure\s*$/gm,
  'the single refresh path fails closed on budget overrun');
check('budget fail-closed helper and call site', () => {
  assert.equal((guard.match(/plan_blocked_with_budget_failure/g) || []).length, 2,
    'exactly the helper definition plus the single fail-closed call site');
});
match('refresh failure retains exact blockers and never re-attempts',
  guard,
  /targeted OpenAPI refresh failed status=\$REFRESH_STATUS; retain exact blockers; no second targeted refresh this run/,
  'a failed refresh keeps the plan blocked and must not trigger a second reconciliation on the same old plan');
match('non-executable plans never reach the executor',
  guard,
  /if \[\[ "\$EXECUTABLE" != "true" \]\]; then[\s\S]*state:"plan_blocked"[\s\S]*exit 2/,
  'blocked plans must exit before any execute step');

match('coordinator run date is injected', guard,
  /DATE="\$\{SHEIN_BI_INVENTORY_RUN_DATE:-/,
  'the guard must not silently switch to the wall-clock date');
match('business date is exact previous day', guard,
  /BUSINESS_DATE="\$\{SHEIN_BI_INVENTORY_BUSINESS_DATE:-[\s\S]*EXPECTED_BUSINESS_DATE=/,
  'runDate/businessDate drift must fail closed');
match('inventory mutex contention is retryable not success', guard,
  /if ! flock (-n|-w [^;]+) 9; then[\s\S]*exit 75/,
  'lock contention must never produce a false done marker');
match('done marker binds plan and result evidence', guard,
  /write_inventory_marker\(\)[\s\S]*--evidence "\$PLAN"[\s\S]*--evidence "\$RESULT"/,
  'successful completion must bind immutable plan/result evidence');
match('terminal result states are explicit allowlist', guard,
  /skipped_target_already_matched[\s\S]*skipped_safety_no_increase[\s\S]*skipped_within_scarcity_band[\s\S]*skipped_recovered[\s\S]*else false end/,
  'unknown skipped states must not promote the run to done');
match('closed terminal readback remains safe after natural inventory drift', guard,
  /skipped_terminal_readback_recorded[\s\S]*reconcilePendingOnly == true[\s\S]*terminalDisposition == "readback_matched"[\s\S]*currentLiveUsableInventory/,
  'reconcile-only must trust the strict terminal journal lifecycle instead of requiring live stock to stay frozen');
match('updated readback equals target', guard,
  /after\.totalUsableInventory == \.targetUsableInventory/,
  'a status string alone is not enough without exact after inventory');
match('historical unknown scopes are terminal exclusions, not whole-run failures', guard,
  /submitted_but_readback_pending" and \.historicalPending == true[\s\S]*historicalIntentId[\s\S]*historicalRunDate[\s\S]*writes/,
  'a pre-existing unknown request must remain skipped without blocking unrelated completed rows');
match('manual-resolution fences are terminal exclusions with exact scope binding', guard,
  /blocked_by_manual_resolution_fence[\s\S]*manual_baseline_adopted_effect_unknown[\s\S]*scope\.storeKey == \.storeKey[\s\S]*scopeKey/,
  'an exact permanent fence must remain visible without failing the whole daily pipeline');
match('only current pending writes remain retryable', guard,
  /select\(\.state == "submitted_but_readback_pending" and \.historicalPending != true\)/,
  'historical skipped intents must not force the current run into retry status');
match('guard and final marker share semantic inventory validator', guard,
  /validate_daily_operating_refresh\.mjs[\s\S]*--inventory-only/,
  'guard must not write done from a weaker jq-only interpretation');
match('exact pending readback remains retryable in same run', guard,
  /result_is_readback_pending_only[\s\S]*submitted_but_readback_pending[\s\S]*exit 75/,
  'an exact durable intent waiting only for propagation must not become restart-prevented exit 2');
match('executor result freshness uses atomic identity and content evidence', guard,
  /result_fingerprint\(\)[\s\S]*sha256[\s\S]*stat\.mtimeNs[\s\S]*stat\.dev[\s\S]*stat\.ino/,
  'freshness must distinguish an atomic replacement from an old result that merely still exists');
check('historical pending uses warning in both guard and immutable publication', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-guard-journal-only-'));
  try {
    const value = {execute: true, executionMode: 'automatic', generatedAt: '2026-09-08T01:00:00Z', results: [
      {state: 'submitted_but_readback_pending', historicalPending: true, historicalRunDate: '2026-08-17', disposition: 'skipped'},
      {state: 'updated_readback_matched', targetUsableInventory: 10, after: {totalUsableInventory: 10}, writes: [{}]},
    ]};
    fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(value));
    assert.equal(evaluateResultBatchStatus(value, 2), 'warning');
    const warning = guard.slice(guard.indexOf('result_has_item_warning() {'), guard.indexOf('\n}\n', guard.indexOf('result_has_item_warning() {')) + 3);
    const complete = guard.slice(guard.indexOf('result_is_complete_and_safe() {'), guard.indexOf('\n}\n', guard.indexOf('result_is_complete_and_safe() {')) + 3);
    const shellTemp = process.platform === 'win32'
      ? temp.replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/')
      : temp;
    const run = runFixtureShell([
      'set -eu', `cd '${shellTemp}'`, 'DATE=2026-09-08', 'RESULT=result.json',
      warning, complete, 'result_has_item_warning',
      'if result_is_complete_and_safe; then echo unexpected-clean-completion; exit 1; fi',
    ].join('\n'), temp);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
check('only a fresh complete result may enter the pending classifier', () => {
  const beforeAt = guard.indexOf('RESULT_BEFORE_FINGERPRINT=');
  const afterAt = guard.indexOf('RESULT_AFTER_FINGERPRINT=');
  const pendingAt = guard.indexOf('if result_has_item_warning || result_is_readback_pending_only; then');
  assert.ok(beforeAt >= 0 && afterAt > beforeAt && pendingAt > afterAt,
    'the guard must snapshot before dispatch and validate freshness before warning classification');
  assert.match(guard.slice(afterAt, pendingAt), /RESULT_AFTER_FINGERPRINT.*RESULT_BEFORE_FINGERPRINT/,
    'the post-executor gate must reject an unchanged result before pending classification');
});
match('unresolved durable lifecycle selects immutable readback-only recovery', guard,
  /durable inventory journal requires lifecycle recovery pending=\$PENDING_INTENT_COUNT readbackMatched=\$READBACK_MATCHED_INTENT_COUNT; preserve the immutable plan and run readback-only reconciliation/,
  'an existing ambiguous or pending lifecycle must not rebuild its plan');
match('journal is the recovery fact source even when result publication crashed', guard,
  /readInventoryIntentLifecycle[\s\S]*PENDING_INTENT_COUNT > 0 \|\| READBACK_MATCHED_INTENT_COUNT > 0[\s\S]*RECONCILE_PENDING_ONLY=1/,
  'intent fsync precedes result publication, so RESULT must not gate recovery selection');
match('all-readback-matched crash still selects recovery', guard,
  /READBACK_MATCHED_INTENT_COUNT > 0/,
  'all closed outcomes without a published result must never be mistaken for an unexecuted plan');
check('same-day completed result short-circuits before journal and source refresh', () => {
  const completedAt = guard.indexOf('state:"already_completed"');
  const journalAt = guard.indexOf('readInventoryIntentLifecycle');
  const refreshAt = guard.indexOf('ensure_links_data_fresh || true');
  assert.ok(completedAt >= 0 && completedAt < journalAt && journalAt < refreshAt,
    'a fully validated same-day result must not be replanned or re-executed');
});
match('journal-only recovery refuses a missing immutable plan', guard,
  /durable inventory intent exists but its immutable plan is missing; refuse refresh, rebuild and every inventory write[\s\S]*exit 76/,
  'a crash that loses the plan cannot fall through to a rebuilt write plan');
check('journal recovery selection occurs before result inspection and source refresh', () => {
  const journalAt = guard.indexOf('readInventoryIntentLifecycle');
  const priorResultAt = guard.indexOf('prior result is not a safe current terminal readback');
  const refreshAt = guard.indexOf('ensure_links_data_fresh || true');
  assert.ok(journalAt >= 0 && priorResultAt > journalAt && refreshAt > journalAt,
    'journal-only pending detection must dominate both result shortcuts and mutable source refresh');
});
match('readback-only recovery skips mutable source refresh and pipeline marker gates', guard,
  /if \(\( RECONCILE_PENDING_ONLY == 0 \)\) && \[\[ "\$REQUIRE_PIPELINE_MARKERS"[\s\S]*if \(\( RECONCILE_PENDING_ONLY == 0 \)\); then\s*ensure_links_data_fresh/,
  'already-submitted intent reconciliation depends on immutable intent plus live readback, not mutable planning sources');
match('guard passes the dedicated no-write recovery flag', guard,
  /EXECUTOR_RECOVERY_ARGS\+\=\(--reconcile-pending-only\)[\s\S]*"\$\{EXECUTOR_RECOVERY_ARGS\[@\]\}"/,
  'normal guard retries must make the executor write branch unreachable');
match('expired new-write deadline does not block pure readback', guard,
  /if \(\( RECONCILE_PENDING_ONLY == 0 \)\) && \[\[ "\$RUN_DEADLINE_EPOCH"/,
  'a durable ambiguous outcome must remain reconcilable after the write window closes');
match('deadline prevents executor dispatch', guard,
  /run deadline reached before executor dispatch; no inventory request was submitted[\s\S]*exit 76/,
  'no new inventory batch may start after the reserved window expires');
match('platform idempotency survives plan evidence refresh', executor,
  /logicalActionKey = (stableInventoryHash|inventoryLogicalActionKey)\(\{[\s\S]*runDate: plan\.date[\s\S]*(target|targetUsableInventory): approvedTarget[\s\S]*policyVersion: plan\.policyVersion[\s\S]*authorizationId:/,
  'the same logical daily action must reuse its SHEIN idempotency key after a crash');
match('recovery lookup cannot be bypassed by target or authorization drift', executor,
  /acquireCrossProcessTicketLock\(lockFile[\s\S]*discoverInventoryJournalFiles\(journalFile,\s*\{[\s\S]*?includeAll:\s*true[\s\S]*?additionalDirectories:\s*inventoryJournalDirectories[\s\S]*?\}\)[\s\S]*readInventoryIntentJournals\(freshJournalFiles,\s*\{[\s\S]*?maxRunDate:\s*today[\s\S]*?allowMultiplePendingByScope:\s*true[\s\S]*?\}\)[\s\S]*pendingByScope\.get\(recoveryScopeKey\)[\s\S]*activeIntent\s*=\s*\{/,
  'all non-rejected intents for the same store/SKC/SKU scope must be re-read under the SKU lock before a new POST');
match('multiple pending intents are blocked at item scope before any new POST', executor,
  /if \(scopeIntents\.length > 1\)[\s\S]*state: 'needs_manual_resolve'[\s\S]*this SKU is blocked without changing other rows[\s\S]*continue;[\s\S]*const mismatch = recoveredInventoryIntentMismatch/,
  'more than one pending intent must stop only this SKU and let independent rows continue');
noMatch('generic executor never appends startup supersede outcomes', executor,
  /superseded_by_later_readback/,
  'supersede closures belong to the explicitly audited reconciliation path, not the generic executor startup scan');
match('rebuilt plan cannot delete an unresolved intent', executor,
  /deferredHistoricalIntents = \[\.\.\.pendingIntentsByScope\.entries\(\)\][\s\S]*absent from the rebuilt current plan[\s\S]*for \(const row of rows\)/,
  'an intent scope omitted by a rebuilt plan must remain unresolved while independent current rows continue');
match('shared executor discovers every journal prefix in its result directory', executor,
  /discoverInventoryJournalFiles\(journalFile,\s*\{[\s\S]*?includeAll:\s*true[\s\S]*?additionalDirectories:\s*inventoryJournalDirectories[\s\S]*?\}\)/,
  'daily and ET low-inventory sidecars must share cross-day durable recovery through configured journal directories');
match('daily guard shares the executor journal discovery domain', guard,
  /SHEIN_BI_INVENTORY_JOURNAL_DIRS[\s\S]*?split\(path\.delimiter\)[\s\S]*?discoverInventoryJournalFiles\(currentJournal,\s*\{[\s\S]*?includeAll:\s*true[\s\S]*?additionalDirectories:\s*inventoryJournalDirectories/,
  'daily and ET low-inventory journals must share the configured durable recovery domain');
match('historical omission is a warning, not a current-run blocker', executor,
  /deferredHistorical: deferredHistoricalIntents[\s\S]*unresolvedIntents: \[\][\s\S]*blocked: unsafeResultCount/,
  'an absent historical scope stays in the result audit without failing an otherwise safe current run');
noMatch('idempotency excludes mutable attempt and overwrite', executor,
  /logicalActionKey = stableInventoryHash\(\{[^}]*\b(?:attempt|overwrite)\b[^}]*\}\)/s,
  'attempt number and observed overwrite quantity must not change the platform key');
match('durable intent helper owns the single submission', executor,
  /submitDurableInventoryWriteOnce\(\{[\s\S]*journalFile[\s\S]*intent: activeIntent[\s\S]*maxReadbackAttempts: 10/,
  'the exact intent must be fsync-visible before the only network submission');
match('pre-append inventory admission passes headers and scope separately', executor,
  /assertInventoryAdmission: \(\) => client\.assertInventoryFence\(\s*request\.pathname,\s*request\.method,\s*request\.body,\s*request\.headers,\s*\{[\s\S]*?requestPayloadHash,[\s\S]*?intentId: activeIntent\.intentId,[\s\S]*?logicalActionKey: activeIntent\.logicalActionKey,[\s\S]*?\}\s*,?\s*\)/,
  'the inventory scope must be the fifth argument; passing it as headers makes every valid row fail before the durable intent is appended');
match('write POST bypasses read retry helper', executor,
  /submit: \(\) => \{[\s\S]*assertInventoryWriteWindow\(plan\.date\)[\s\S]*return client\.request\(request\.pathname/,
  'the inventory write must issue one transport POST, not a rate-limit retry loop');
noMatch('journal is never truncated on restart', executor,
  /writeFile\(journalFile, ''/,
  'a restart must preserve already-audited terminal rows');
noMatch('historical journal results never bypass fresh readback', executor,
  /results\.push\(entry\.row\)/,
  'journal rows are audit history; a restart must re-read live stock under the SKU lock');
match('midnight and deadline checked before every POST', executor,
  /assertInventoryWriteWindow\(plan\.date\)[\s\S]*submitDurableInventoryWriteOnce/,
  'a stale runDate or exhausted safety window must fail before a new request');

// ---------------------------------------------------------------------------
// Per-row catch scope and live pendingIntents key invariant.  Production
// 2026.08.16.10 hit `ReferenceError: activeIntent is not defined` at the row
// catch because the declaration lived inside the inner try; the declaration
// must stay in the outer per-row scope so pre-durable errors record `blocked`
// and durable errors record `suspicious_write_attempted`.
// ---------------------------------------------------------------------------
match('catch classifies durable vs pre-durable errors', executor,
  /if \(activeIntent && error\?\.inventoryIntentDurable === true\)[\s\S]*state: 'suspicious_write_attempted'[\s\S]*state: 'blocked'/,
  'pre-durable failures record blocked; durable failures record suspicious_write_attempted in the same catch');
match('in-run intent insert uses the journal-plus-intentId key', executor,
  /pendingIntents\.set\(journalIntentKey\(activeIntent\), activeIntent\)/,
  'the live map must share the journal load/delete composite key');
noMatch('in-run intent map never keyed by logicalActionKey', executor,
  /pendingIntents\.set\(logicalActionKey, activeIntent\)/,
  'keying the live map by logicalActionKey makes the intentId deletes no-ops');
check('activeIntent is declared outside the per-row try block', () => {
  const loopAt = executor.indexOf('for (const row of rows) {');
  const outerTryAt = executor.indexOf('\n  try {', loopAt);
  const declarationAt = executor.indexOf('let activeIntent = null;', loopAt);
  assert.ok(loopAt >= 0 && outerTryAt > loopAt && declarationAt > loopAt,
    'the execution loop, per-row try and declaration must exist');
  assert.ok(declarationAt < outerTryAt,
    'activeIntent must be declared before the per-row try: a catch block cannot see let bindings from its try block');
  const insertAt = executor.indexOf('pendingIntents.set(journalIntentKey(activeIntent), activeIntent)');
  assert.ok(insertAt > declarationAt && insertAt < executor.indexOf('} catch (error) {', outerTryAt),
    'the map insert stays inside the same per-row scope as the declaration');
});

// Real shell behavior for the crash-before-result window: a durable journal
// intent with no RESULT must select recovery-only before marker/source/planner
// work, carry the exact immutable plan, and pass the dedicated no-write flag.
check('journal-only crash recovery bypasses result and planning', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-guard-journal-only-'));
  const runtime = path.join(temp, 'runtime');
  const runDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 86_400_000));
  const commandId = `morning:${runDate}`;
  const commandHash = crypto.createHash('sha256').update(commandId).digest('hex');
  const runDir = path.join(runtime, 'runs', runDate, commandHash);
  const planFile = path.join(runDir, 'plans', `daily-inventory-replenishment-${runDate}.json`);
  const resultFile = path.join(runDir, 'results', `daily-inventory-replenishment-${runDate}.json`);
  const journalFile = `${resultFile}.journal.ndjson`;
  const executorArgsFile = path.join(temp, 'executor-args.json');
  const markerArgsFile = path.join(temp, 'marker-args.ndjson');
  try {
    for (const dir of [
      path.join(temp, 'scripts', 'lib'),
      path.join(temp, 'scripts', 'inventory'),
      path.join(temp, 'lib'),
      path.join(temp, 'state', 'locks'),
      path.dirname(planFile),
      path.dirname(resultFile),
    ]) fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(temp, 'scripts', 'cloud_daily_inventory_replenishment_guard.sh'), guard);
    fs.copyFileSync(
      path.resolve('scripts', 'inventory', 'daily_inventory_version_publisher.mjs'),
      path.join(temp, 'scripts', 'inventory', 'daily_inventory_version_publisher.mjs')
    );
    fs.copyFileSync(path.resolve('lib', 'inventory_journal_discovery.mjs'), path.join(temp, 'lib', 'inventory_journal_discovery.mjs'));
    fs.copyFileSync(
      path.resolve('lib', 'atomic_file_publish.mjs'),
      path.join(temp, 'lib', 'atomic_file_publish.mjs')
    );
    fs.copyFileSync(
      path.resolve('lib', 'cross_process_ticket_lock.mjs'),
      path.join(temp, 'lib', 'cross_process_ticket_lock.mjs')
    );
    fs.writeFileSync(path.join(temp, 'scripts', 'lib', 'shared_lock.sh'), 'prepare_shared_lock_file(){ mkdir -p "$(dirname "$1")"; touch "$1"; }\n');
    fs.writeFileSync(path.join(temp, 'lib', 'durable_inventory_write.mjs'), `
import fs from 'node:fs/promises';
export async function readInventoryIntentLifecycle(file) {
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  for (const line of (await fs.readFile(file, 'utf8')).split(/\\r?\\n/).filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.kind === 'intent') { intents.set(entry.intentId, entry); pending.set(entry.intentId, entry); }
    if (entry.kind === 'write_outcome' && ['rejected','readback_matched'].includes(entry.disposition)) {
      pending.delete(entry.intentId); terminalOutcomes.set(entry.intentId, entry);
    }
  }
  return {intents, pending, terminalOutcomes};
}
export async function discoverInventoryJournalFiles(file) { return [file]; }
export async function readInventoryIntentJournals(files) {
  const records = [];
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  for (const file of files) {
    let lifecycle;
    try { lifecycle = await readInventoryIntentLifecycle(file); } catch (error) {
      if (error?.code === 'ENOENT') lifecycle = {intents:new Map(), pending:new Map(), terminalOutcomes:new Map()};
      else throw error;
    }
    records.push({journalFile:file, ...lifecycle});
    for (const [intentId, intent] of lifecycle.intents) {
      const key = file + '\\u0000' + intentId;
      intents.set(key, {...intent, intentId, journalFile:file});
      if (lifecycle.pending.has(intentId)) pending.set(key, {...intent, intentId, journalFile:file});
      const outcome = lifecycle.terminalOutcomes.get(intentId);
      if (outcome) terminalOutcomes.set(key, {...outcome, journalFile:file});
    }
  }
  return {files, records, intents, pending, terminalOutcomes};
}
`);
    fs.writeFileSync(path.join(temp, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.SHEIN_TEST_INVENTORY_EXECUTOR_MODE || 'default';
if (mode === 'fatal-no-result' || mode === 'fatal-no-result-75') {
  console.error('INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED:fixture');
  process.exit(mode === 'fatal-no-result-75' ? 75 : 42);
}
fs.writeFileSync('executor-args.json', JSON.stringify(args));
const value = flag => args[args.indexOf(flag) + 1];
const plan = JSON.parse(fs.readFileSync(value('--plan'), 'utf8'));
const journal = fs.readFileSync(value('--out')+'.journal.ndjson', 'utf8');
const closed = journal.includes('readback_matched');
const result = {planHash:plan.payloadHash,execute:true,executionMode:'automatic',results:[{...plan.actionable[0], ...(closed
  ? {state:'skipped_target_already_matched',before:{totalUsableInventory:10},targetUsableInventory:10}
  : {state:'submitted_but_readback_pending'})}]};
const output = value('--out');
const temporary = output + '.tmp';
fs.writeFileSync(temporary, JSON.stringify(result) + '\\n');
fs.renameSync(temporary, output);
if (mode === 'fresh-pending') process.exit(1);
`);
    fs.writeFileSync(path.join(temp, 'scripts', 'pipeline_marker.mjs'), markerFixtureScript);
    fs.writeFileSync(path.join(temp, 'scripts', 'validate_daily_operating_refresh.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(planFile, JSON.stringify({
      schemaVersion: 'daily-inventory-replenishment-plan/v1',
      date: runDate,
      payloadHash: 'a'.repeat(64),
      executable: true,
      blockers: [],
      actionable: [{storeKey: 'ZZ', skc: 'ZZ-SKC', skuCode: 'ZZ-SKU', targetUsableInventory: 10}],
    }));
    fs.writeFileSync(journalFile, `${JSON.stringify({kind:'intent',intentId:'intent-1',logicalActionKey:'logical-1'})}\n`);
    const wslTemp = temp
      .replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`)
      .replaceAll('\\', '/');
    const runGuard = mode => {
      // These are independent crash fixtures sharing one shell harness. Reset
      // only their previous publication before changing the source tuple;
      // otherwise the real same-command replay correctly bypasses execution.
      for (const output of [path.join(runtime, 'results'), path.join(runtime, 'versions'),
        path.join(runDir, 'markers'), journalFile + '.sealed.json']) {
        const relative = path.relative(path.resolve(temp), path.resolve(output));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        fs.rmSync(output, {recursive: true, force: true});
      }
      return runFixtureShell([
      `cd '${wslTemp}' &&`,
      'env',
      'SHEIN_BI_ROOT=.',
      'SHEIN_BI_INVENTORY_RUNTIME_ROOT=runtime',
      `SHEIN_BI_INVENTORY_RUN_DATE=${runDate}`,
      `SHEIN_BI_INVENTORY_BUSINESS_DATE=${businessDate}`,
      'SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH=1',
      'SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1',
      'SHEIN_BI_INVENTORY_MAX_ROWS=10',
      `SHEIN_TEST_INVENTORY_EXECUTOR_MODE=${mode}`,
      'bash scripts/cloud_daily_inventory_replenishment_guard.sh',
      ].join(' '), temp);
    };
    const run = runGuard('default');
    assert.equal(run.status, 2, `journal-only recovery must converge as an auditable warning without replay\nstdout=${run.stdout}\nstderr=${run.stderr}`);
    assert.match(run.stdout, /durable inventory journal requires lifecycle recovery pending=1 readbackMatched=0/);
    assert.match(run.stdout, /"state":\s*"completed_with_warning"/);
    const executorArgs = JSON.parse(fs.readFileSync(executorArgsFile, 'utf8'));
    assert.ok(executorArgs.includes('--reconcile-pending-only'));
    assert.equal(executorArgs[executorArgs.indexOf('--plan') + 1], `runtime/runs/${runDate}/${commandHash}/plans/daily-inventory-replenishment-${runDate}.json`);
    const markerCalls = fs.readFileSync(markerArgsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(markerCalls.every(args => args[0] !== 'require'), 'pipeline markers must not gate already-submitted intent readback');

    fs.rmSync(resultFile, {force: true});
    fs.writeFileSync(journalFile, [
      JSON.stringify({kind:'intent',intentId:'intent-1',logicalActionKey:'logical-1'}),
      JSON.stringify({kind:'write_outcome',intentId:'intent-1',disposition:'readback_matched'}),
      '',
    ].join('\n'));
    fs.rmSync(executorArgsFile, {force: true});
    const closedRun = runGuard('default');
    assert.equal(closedRun.status, 0, `all-closed crash recovery must reconstruct a terminal result\nstdout=${closedRun.stdout}\nstderr=${closedRun.stderr}`);
    assert.match(closedRun.stdout, /lifecycle recovery pending=0 readbackMatched=1/);
    const closedArgs = JSON.parse(fs.readFileSync(executorArgsFile, 'utf8'));
    assert.ok(closedArgs.includes('--reconcile-pending-only'), 'all-closed crash recovery must still make the write branch unreachable');

    // A stale pending RESULT must not be promoted to exit 75 when the
    // recovery executor fails before publishing this invocation's result.
    const pendingResult = {
      planHash: 'a'.repeat(64),
      execute: true,
      executionMode: 'automatic',
      generatedAt: '2026-08-25T00:00:00.000Z',
      results: [{storeKey: 'ZZ', skc: 'ZZ-SKC', skuCode: 'ZZ-SKU', targetUsableInventory: 10, state: 'submitted_but_readback_pending'}],
    };
    const pendingJournal = `${JSON.stringify({kind:'intent',intentId:'intent-1',logicalActionKey:'logical-1'})}\n`;
    fs.writeFileSync(journalFile, pendingJournal);
    fs.writeFileSync(resultFile, `${JSON.stringify(pendingResult)}\n`);
    const priorResultBytes = fs.readFileSync(resultFile);
    const priorJournalBytes = fs.readFileSync(journalFile);
    const fatalRun = runGuard('fatal-no-result');
    assert.equal(fatalRun.status, 42,
      `executor fatal without a fresh result must be a real failure\nstdout=${fatalRun.stdout}\nstderr=${fatalRun.stderr}`);
    assert.doesNotMatch(`${fatalRun.stdout}\n${fatalRun.stderr}`, /submitted_but_readback_pending|capacity|exit75/u,
      'a stale pending result must not be reported as capacity/readback-pending');
    assert.deepEqual(fs.readFileSync(resultFile), priorResultBytes,
      'executor fatal must preserve the old RESULT bytes');
    assert.deepEqual(fs.readFileSync(journalFile), priorJournalBytes,
      'executor fatal must preserve the append-only journal');
    const fatal75Run = runGuard('fatal-no-result-75');
    assert.equal(fatal75Run.status, 1,
      `executor 75 without a fresh result must be remapped to a real failure\nstdout=${fatal75Run.stdout}\nstderr=${fatal75Run.stderr}`);
    assert.doesNotMatch(`${fatal75Run.stdout}\n${fatal75Run.stderr}`, /submitted_but_readback_pending|capacity|exit75/u,
      'executor 75 without a fresh result must not be reported as capacity/readback-pending');
    assert.deepEqual(fs.readFileSync(resultFile), priorResultBytes,
      'executor 75 fatal must preserve the old RESULT bytes');

    // A new complete pending RESULT, even with executor status 1, converges as
    // an auditable warning while the durable intent keeps duplicate writes fenced.
    const freshRun = runGuard('fresh-pending');
    assert.equal(freshRun.status, 2,
      `a fresh complete pending result must converge as an auditable warning\nstdout=${freshRun.stdout}\nstderr=${freshRun.stderr}`);
    assert.match(freshRun.stdout, /"state":\s*"completed_with_warning"/);
    assert.notDeepEqual(fs.readFileSync(resultFile), priorResultBytes,
      'the fresh executor result must replace the old pending RESULT');
    assert.deepEqual(fs.readFileSync(journalFile), priorJournalBytes,
      'readback-only classification must not rewrite the journal fixture');
    assert.equal(fs.existsSync(path.join(temp, 'inventory-write.log')), false,
      'all guard freshness cases must use a no-inventory-write fixture');
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
});

console.log(JSON.stringify({ok: true, checks}, null, 2));
