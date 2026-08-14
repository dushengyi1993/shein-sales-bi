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
 *    set), MAX_DETAILS=budget, SKIP_DETAILS=0, DETAIL_PRIORITY_FILE and
 *    PRIORITY_DETAILS_ONLY=1;
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
  /SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="\$RECONCILE_STORES" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="\$DETAIL_TARGET_BUDGET_PER_STORE" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=0 \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE="\$DETAIL_TARGETS" \\\n\s*SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \\\n\s*bash scripts\/cloud_openapi_product_reconciliation\.sh/,
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
  /test\(" OpenAPI product detail evidence is incomplete\$"\)/,
  'missing current detail blocks and is recoverable');
match('canonical-evidence blocker pattern',
  guard,
  /test\(" OpenAPI product canonical evidence is incomplete\$"\)/,
  'canonical evidence gaps are recoverable through targeted detail');
match('current-detail provenance blocker pattern',
  guard,
  /test\(" OpenAPI product canonical evidence is not from current detail"\)/,
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

console.log(JSON.stringify({ok: true, checks}, null, 2));
