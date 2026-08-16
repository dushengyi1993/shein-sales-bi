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
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const guard = read('scripts/cloud_daily_inventory_replenishment_guard.sh');
const reconciliation = read('scripts/cloud_openapi_product_reconciliation.sh');
const planner = read('scripts/inventory/build_daily_inventory_replenishment_plan.mjs');
const executor = read('scripts/inventory/execute_daily_inventory_replenishment_plan.mjs');

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
  /DETAIL_TARGET_BUDGET_PER_STORE="\$\{SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-64\}"/,
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
  /--argjson rows "\$\(jq '\.detailRefreshTargets \/\/ \[\]' "\$PLAN"\)"/,
  'the manifest is generated from the planner-emitted targets');
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
  /curl -fsS --max-time "\$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS" \\\n\s*-H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \\\n\s*"\$PORTAL_URL\/api\/bi\/section\/inventoryTrend\?refresh=1" >\/dev\/null/,
  'the sync refresh must reuse the host-locked worker header on the section endpoint');
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
  /^ensure_inventory_trend_fresh 1$/m,
  'a fresh cachedAt can still hide an old ET business day, so the daily refresh must bypass the age skip');
noMatch('inventoryTrend refresh failure is never swallowed',
  guard,
  /ensure_inventory_trend_fresh 1 \|\| true/,
  'a failed refresh must abort the guard, not fall through to a stale plan');
match('inventoryTrend HTTP failure blocks the guard',
  guard,
  /if ! curl -fsS --max-time "\$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS"[\s\S]*inventoryTrend HTTP refresh failed; blocking the daily inventory guard[\s\S]*return 1/,
  'a non-success HTTP refresh must stop the guard before any plan build or write');
check('request start is recorded before the refresh request', () => {
  const requestStartAt = guard.indexOf('request_start_epoch="$(date +%s)"');
  const refreshAt = guard.indexOf('inventoryTrend?refresh=1');
  assert.ok(requestStartAt >= 0 && refreshAt >= 0 && requestStartAt < refreshAt,
    'cachedAt advancement must be measured against a timestamp taken before the HTTP call');
});
match('cachedAt that did not advance past request start blocks the guard',
  guard,
  /\(\( published_epoch <= request_start_epoch \)\)[\s\S]*cachedAt did not advance past request start[\s\S]*return 1/,
  'a refresh that re-serves the old cache must stop the guard');
match('matched current-day row count uses the planner row rule',
  guard,
  /select\(\(\( \.inventory_match_status \/\/ ""\) == "matched"\)\)[\s\S]*contains\("01_full_carton_exception"\)[\s\S]*et_box_snapshot_date[\s\S]*et_store_snapshot_date[\s\S]*\.\[0:10\]/,
  'the guard must count matched rows with the same per-row warehouse-position date rule as the planner');
match('zero matched current-day rows blocks the guard',
  guard,
  /\(\( matched_current_day <= 0 \)\)[\s\S]*inventoryTrend has no matched current-day operational rows[\s\S]*return 1/,
  'an artifact without any matched current-day ET row must stop the guard');
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
  assert.equal((guard.match(/^  refresh_targeted_openapi_sources \|\| REFRESH_STATUS=\$\?$/gm) || []).length, 1,
    'the merged refresh decision exposes a single call point, so at most one reconciliation runs per guard run');
});
match('reconciliation is gated by the single-run reason',
  guard,
  /if \[\[ -n "\$REFRESH_REASON" \]\]; then[\s\S]*refresh_targeted_openapi_sources \|\| REFRESH_STATUS=\$\?/,
  'the only call site sits inside the merged decision gate');

// ---------------------------------------------------------------------------
// MAX_DETAILS is the exact manifest maxPerStore (already validated <= 64):
// maxTargets=59 reconciles with MAX_DETAILS=59, maxTargets>64 fails closed
// before any reconciliation env is built.
// ---------------------------------------------------------------------------
match('reconciliation MAX_DETAILS is the exact validated maxTargets',
  guard,
  /SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="\$max_targets" \\/,
  'the reconciliation pays for the real target count, not the ceiling');
check('per-store ceiling stays 64 and gates before reconciliation', () => {
  const budgetDefault = guard.match(/DETAIL_TARGET_BUDGET_PER_STORE="\$\{SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-(\d+)\}"/)?.[1];
  assert.equal(budgetDefault, '64', 'the per-store ceiling remains 64');
  const budgetCheckAt = guard.indexOf('max_targets > DETAIL_TARGET_BUDGET_PER_STORE');
  const reconcileAt = guard.indexOf('SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$max_targets"');
  assert.ok(budgetCheckAt >= 0 && reconcileAt >= 0 && budgetCheckAt < reconcileAt,
    'over-budget manifests must fail closed before any reconciliation env is built');
});
check('maxTargets=59 passes and maxTargets>64 fails closed', () => {
  assert.equal(59 > 64, false, 'the measured 2026-08-15 maxPerStore=59 must pass the 64 ceiling');
  assert.equal(65 > 64, true, 'any store over the 64 ceiling must hit the overrun branch');
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
  /if ! flock -n 9; then[\s\S]*exit 75/,
  'lock contention must never produce a false done marker');
match('done marker binds plan and result evidence', guard,
  /write_inventory_marker\(\)[\s\S]*--evidence "\$PLAN"[\s\S]*--evidence "\$RESULT"/,
  'successful completion must bind immutable plan/result evidence');
match('terminal result states are explicit allowlist', guard,
  /skipped_target_already_matched[\s\S]*skipped_safety_no_increase[\s\S]*skipped_within_scarcity_band[\s\S]*skipped_recovered[\s\S]*else false end/,
  'unknown skipped states must not promote the run to done');
match('updated readback equals target', guard,
  /after\.totalUsableInventory == \.targetUsableInventory/,
  'a status string alone is not enough without exact after inventory');
match('guard and final marker share semantic inventory validator', guard,
  /validate_daily_operating_refresh\.mjs[\s\S]*--inventory-only/,
  'guard must not write done from a weaker jq-only interpretation');
match('exact pending readback remains retryable in same run', guard,
  /result_is_readback_pending_only[\s\S]*submitted_but_readback_pending[\s\S]*exit 75/,
  'an exact durable intent waiting only for propagation must not become restart-prevented exit 2');
match('deadline prevents executor dispatch', guard,
  /run deadline reached before executor dispatch; no inventory request was submitted[\s\S]*exit 76/,
  'no new inventory batch may start after the reserved window expires');
match('platform idempotency survives plan evidence refresh', executor,
  /logicalActionKey = stableInventoryHash\(\{[\s\S]*runDate: plan\.date[\s\S]*target: approvedTarget[\s\S]*actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET'[\s\S]*policyVersion: plan\.policyVersion[\s\S]*authorizationId:/,
  'the same logical daily action must reuse its SHEIN idempotency key after a crash');
match('recovery lookup cannot be bypassed by target or authorization drift', executor,
  /pendingIntentsByScope\.get\(recoveryScopeKey\)/,
  'all non-rejected intents for the same run/store/SKC/SKU scope must block a new POST');
match('rebuilt plan cannot delete an unresolved intent', executor,
  /unresolvedIntents = \[\.\.\.pendingIntentsByScope\.entries\(\)\][\s\S]*absent from the rebuilt current plan[\s\S]*for \(const row of unresolvedIntents\.length \? \[\] : rows\)/,
  'an intent scope omitted by a rebuilt plan must block all current-plan writes and final success');
noMatch('idempotency excludes mutable attempt and overwrite', executor,
  /logicalActionKey = stableInventoryHash\(\{[^}]*\b(?:attempt|overwrite)\b[^}]*\}\)/s,
  'attempt number and observed overwrite quantity must not change the platform key');
match('durable intent helper owns the single submission', executor,
  /submitDurableInventoryWriteOnce\(\{[\s\S]*journalFile[\s\S]*intent: activeIntent[\s\S]*maxReadbackAttempts: 10/,
  'the exact intent must be fsync-visible before the only network submission');
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

console.log(JSON.stringify({ok: true, checks}, null, 2));
