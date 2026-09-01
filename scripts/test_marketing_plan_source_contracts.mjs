#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const planConsumers = [
  'scripts/marketing/audit_order_prices_against_plan.mjs',
  'scripts/marketing/build_high_coupon_research_candidates.mjs',
  'scripts/marketing/scan_coupon_low_price_overlap_risks.mjs',
];
for (const file of planConsumers) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /resolveCurrentMarketingPlanPair/,
    `${file} must use the shared durable selector`);
  assert.doesNotMatch(source, /2026-06-03|ALL-ready|legacy_fallback/,
    `${file} must not retain the retired ALL-ready fallback`);
}

const newListingBuilder = fs.readFileSync(
  path.join(root, 'scripts', 'marketing', 'build_new_listing_limited_discount_plan.mjs'),
  'utf8',
);
assert.match(newListingBuilder, /resolveCurrentMarketingPlanPair\(\{root: ROOT\}\)/,
  'new-listing builder must resolve an omitted price from the shared selector');
assert.doesNotMatch(newListingBuilder, /2026-06-22|price-overrides-2026-06-22/,
  'new-listing builder must not retain the retired static June price default');
assert.match(newListingBuilder, /args\.allowSupplementalPriceOverrides === 'true'/,
  'supplemental price overrides must require an explicit allow flag');
assert.match(newListingBuilder, /supplementalPriceOverridesEnabled/,
  'new-listing result must record whether supplemental price material was enabled');
assert.match(newListingBuilder, /disabled_by_default/,
  'new-listing result must record the default no-supplement policy');
assert.match(newListingBuilder, /args\.expectedPriceOverridesSha256/,
  'new-listing builder must accept an expected SHA-256 for an explicit price file');
assert.match(newListingBuilder, /Price overrides SHA-256 mismatch/,
  'new-listing builder must fail closed when the explicit price file drifts');
assert.match(newListingBuilder, /expectedPriceOverridesSha256: boundExpectedPriceOverridesSha256/,
  'new-listing summary must record the expected price SHA-256');
assert.match(newListingBuilder, /--expected-marketing-cost-map-sha256|args\.expectedMarketingCostMapSha256/,
  'new-listing builder must accept the canonical expected marketing cost-map SHA-256 flag');
assert.match(newListingBuilder, /marketingCostMapSource/,
  'new-listing summary and rescue manifest must record the exact cost-map source binding');
assert.match(newListingBuilder, /Marketing cost map SHA-256 mismatch/,
  'new-listing builder must fail closed when the marketing cost map drifts');

const guardReport = fs.readFileSync(
  path.join(root, 'scripts', 'marketing', 'build_marketing_daily_guard_report.mjs'),
  'utf8',
);
for (const option of ['--current-marketing-live-scan', '--marketing-stack-review']) {
  assert.match(guardReport, new RegExp(option.replaceAll('-', '\\-')));
}
assert.match(guardReport, /currentMarketingLiveScanSource\.source\.selectionSource = args\.currentMarketingLiveScan \? 'explicit_argument'/);
assert.match(guardReport, /stackReview\.source\.selectionSource = args\.marketingStackReview \? 'explicit_argument'/);
assert.match(guardReport, /registryHash: args\.planSelection\?\.registryHash/);
assert.match(guardReport, /selectionPlanHash: args\.planSelection\?\.selectionPlanHash/);
assert.match(guardReport, /priceOverridesHash: args\.planSelection\?\.priceOverridesHash/);
assert.match(guardReport, /--marketing-cost-map/);
assert.match(guardReport, /--expected-marketing-cost-map-sha256/);
assert.match(guardReport, /marketingCostMapSource/);

const guard = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
const repair = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
const terminalSnapshot = repair.slice(
  repair.indexOf('run_terminal_final_snapshot() {'),
  repair.indexOf('run_final_readback() {'),
);
const resumeRejectAt = guard.indexOf('if reject_marketing_resume_request; then');
const rootInitializationAt = guard.indexOf('ROOT="${SHEIN_BI_ROOT');
const preflightAt = guard.indexOf('if verify_marketing_plan_registry_preflight');
const costCollectorAt = guard.indexOf('if refresh_marketing_cost_map');
assert.ok(resumeRejectAt >= 0 && rootInitializationAt > resumeRejectAt,
  'resume requests must fail before ROOT initialization or any marketing helper can load');
assert.match(guard, /SHEIN_BI_MARKETING_RESUME_\*\|SHEIN_BI_MARKETING_LIVE_RESUME_\*\|SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_\*/,
  'all retired resume environment prefixes must be rejected by the entry gate');
assert.match(guard, /same-run marketing resume is disabled/);
assert.doesNotMatch(guard, /validate_resume_sources|RESUME_MODE|RESUME_SOURCE_|legacy_run_window|resumedFromRunId/,
  'the disabled resume implementation and its report metadata must not remain as dead code');
assert.ok(preflightAt >= 0 && costCollectorAt > preflightAt,
  'ordinary guard must verify registry before the cost collector');
assert.match(guard, /refresh current marketing cost evidence/);
assert.match(guard, /marketing cost evidence refreshed/);
assert.match(guard, /expected-queue-fingerprint/);
assert.match(guard, /expected-source-guard-hash/);
assert.match(guard, /guard registry hash drift expected=/);
assert.doesNotMatch(guard, /resumeEligible/);
assert.match(guard, /validate_guard_plan_binding "\$GUARD_INPUT_OUT" "\$CURRENT_REGISTRY_HASH"/,
  'managed guard must bind the staged report to its preflight registry hash before publication');
assert.match(guard, /validate_guard_plan_binding "\$GUARD_OUT" "\$CURRENT_REGISTRY_HASH"/,
  'managed guard plan build must re-read the published guard binding');
assert.match(guard, /--price-overrides "\$price_overrides_path" \\\s+--expected-price-overrides-sha256 "\$price_overrides_hash" \\\s+--no-supplemental-price-overrides true/,
  'managed guard must pass the guard-bound explicit price path, SHA-256, and no-supplement flag');
assert.match(repair, /validate_guard_plan_binding "\$guard_out"/,
  'managed repair plan build must read and validate the same published guard');
assert.match(repair, /--price-overrides "\$price_overrides_path" \\\s+--expected-price-overrides-sha256 "\$price_overrides_hash" \\\s+--expected-marketing-cost-map-sha256 "\$marketing_cost_map_hash" \\\s+--cost-map "\$marketing_cost_map_path" \\\s+--no-supplemental-price-overrides true/,
  'managed repair must pass the guard-bound price and marketing cost-map paths/SHA-256 values');
assert.match(terminalSnapshot, /bind_marketing_cost_map \|\| return \$\?[\s\S]*--marketing-cost-map "\$MARKETING_COST_MAP_PATH" \\\s+--expected-marketing-cost-map-sha256 "\$MARKETING_COST_MAP_SHA256"/,
  'repair terminal guard must bind and pass the exact marketing cost-map SHA-256');
assert.match(repair, /verifyMarketingPlanRegistrySync/,
  'repair worker must use the shared durable registry verifier');
assert.match(repair, /if refresh_queue_pair_locked && assert_current_queue_registry_locked; then/,
  'repair worker must verify the queue guard against current.json before any stage');
assert.match(repair, /if assert_current_queue_pair_locked && assert_current_queue_registry_locked; then/,
  'repair worker must verify the queue guard against current.json at queue mutation boundaries');
assert.match(repair, /assert_stage_current\(\)[\s\S]*assert_current_queue_registry_locked/,
  'repair worker must recheck the durable registry immediately before each business stage');

const unit = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-marketing-live-guard.service'),
  'utf8',
);
assert.match(unit, /^Environment=SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE=\/srv\/shein-bi\/runtime\/marketing-plans\/current\.json$/m);
const repairUnit = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-marketing-repair.service'),
  'utf8',
);
assert.match(repairUnit, /^Environment=SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE=\/srv\/shein-bi\/runtime\/marketing-plans\/current\.json$/m);
assert.doesNotMatch(unit, /^PassEnvironment=.*SHEIN_BI_MARKETING_(?:LIVE_|LIVE_GUARD_)?RESUME_/m,
  'the managed unit must not expose retired resume manager variables');
assert.doesNotMatch(unit, /^ExecStopPost=.*SHEIN_BI_MARKETING_(?:LIVE_|LIVE_GUARD_)?RESUME_/m,
  'the managed unit must not retain resume cleanup machinery');

console.log('marketing plan consumer/guard source contracts: ok');
