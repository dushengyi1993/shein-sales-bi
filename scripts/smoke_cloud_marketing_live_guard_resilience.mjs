#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
const cleanup = fs.readFileSync(path.join(root, 'scripts', 'cleanup_shein_store_browsers.mjs'), 'utf8');
const cleanupTimer = fs.readFileSync(path.join(root, 'infra/systemd/shein-bi-cloud-browser-cleanup.timer'), 'utf8');
const repairWorker = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
const dailyRefresh = fs.readFileSync(path.join(root, 'scripts', 'cloud_daily_refresh.sh'), 'utf8');
const linkBusiness = fs.readFileSync(path.join(root, 'scripts', 'cloud_link_business_sync.sh'), 'utf8');
const sessionManager = fs.readFileSync(path.join(root, 'scripts', 'cloud_shein_session_manager.sh'), 'utf8');
const rtvVerify = fs.readFileSync(path.join(root, 'scripts', 'cloud_rtv_verify.sh'), 'utf8');
const stackReview = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'export_marketing_stack_review.mjs'), 'utf8');
const guardReport = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'build_marketing_daily_guard_report.mjs'), 'utf8');
const repairBatchSources = [
  'batch_apply_new_listing_limited_discount.mjs',
  'batch_fix_limited_discount_drift.mjs',
  'batch_restore_manual_limited_discounts.mjs',
].map(file => fs.readFileSync(path.join(root, 'scripts', 'marketing', file), 'utf8'));

execFileSync('bash', ['-n', 'scripts/cloud_marketing_live_guard.sh'], {cwd: root, stdio: 'inherit'});
execFileSync('bash', ['-n', 'scripts/cloud_marketing_repair_worker.sh'], {cwd: root, stdio: 'inherit'});
for (const script of ['scripts/cloud_daily_refresh.sh','scripts/cloud_link_business_sync.sh','scripts/cloud_shein_session_manager.sh','scripts/cloud_rtv_verify.sh']) {
  execFileSync('bash', ['-n', script], {cwd: root, stdio: 'inherit'});
}
assert.match(guard, /RUN_ID=.*randomUUID/);
assert.match(guard, /browserless inspection via session HTTP/);
assert.match(guard, /--session-http/);
assert.doesNotMatch(guard, /manage_browser_task_leases\.mjs/);
assert.doesNotMatch(guard, /cleanup_shein_store_browsers/);
assert.match(guard, /build_repair_queue/);
assert.match(guard, /inspection is read-only and all writes are deferred/);
assert.match(guard, /Later timer slots are retries for a failed inspection/);
assert.doesNotMatch(guard, /batch_(?:fix_limited_discount_drift|apply_new_listing_limited_discount)\.mjs[^\n]*--execute/);
assert.doesNotMatch(guard, /batch_restore_manual_limited_discounts\.mjs[^\n]*--execute/);
assert.match(guard, /on_shelf_limited_discount_plan_count\(\)[\s\S]*?NODE\s*\}/,
  'on-shelf plan count heredoc must close before later shell function declarations');
assert.doesNotMatch(guard, /consider_reserved_time "browser-cleanup/);
assert.match(guard, /flag: 'wx'/);
assert.match(cleanup, /reclaimStaleBrowserLeases/);
assert.match(cleanup, /active_store_lease/);
assert.match(cleanupTimer, /03:45:00/);
assert.match(cleanupTimer, /09:50:00/);
assert.match(cleanupTimer, /21:00:00/);
assert.doesNotMatch(cleanupTimer, /\*:15:00/);
assert.match(stackReview, /fetchCoupon15PctRuleStatsHttp/);
assert.match(stackReview, /MULTI_LEVEL_RULE_ENROLLED_GOODS/);
assert.match(stackReview, /level_rule_id: levelRuleId/);
assert.match(guardReport, /summarizeFreshLiveLowPriceOverlap/);
assert.match(guardReport, /freshCouponEvidenceSupersedesLegacy/);
assert.match(guardReport, /active_coupon_outside_allowed_plan/);
assert.match(repairWorker, /--max-groups "\$REMAINING_GROUPS"/);
assert.match(repairWorker, /new_groups_in_result/);
assert.match(repairWorker, /--skip-build-plan --execute/);
assert.match(repairWorker, /--expected-work-fingerprint/);
assert.match(repairWorker, /SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH/);
assert.match(repairWorker, /awaiting_final_readback/);
assert.match(repairWorker, /run_final_readback\(\)[\s\S]*export_marketing_stack_review\.mjs[\s\S]*scan_current_marketing_prices_for_bi\.mjs[\s\S]*build_marketing_daily_guard_report\.mjs/,
  'repair final readback must refresh ordinary/coupon session HTTP evidence before the latest price scan and final guard rebuild');
assert.match(repairWorker, /export SHEIN_BI_BROWSER_LEASE_TASK="\$LEASE_TASK"/);
assert.match(repairWorker, /export SHEIN_BI_BROWSER_LEASE_RUN_ID="\$RUN_ID"/);
assert.doesNotMatch(dailyRefresh, /manage_browser_task_leases\.mjs/);
assert.doesNotMatch(dailyRefresh, /cleanup_shein_store_browsers|close_store_browsers/);
assert.doesNotMatch(dailyRefresh, /scan_current_marketing_prices_for_bi\.mjs/);
for (const source of [linkBusiness, sessionManager, rtvVerify]) {
  assert.match(source, /manage_browser_task_leases\.mjs/);
}
assert.doesNotMatch(linkBusiness, /pkill\s+-f/);
assert.ok(linkBusiness.indexOf('lease_action acquire') < linkBusiness.indexOf('LEASE_ACTIVE=1\nclose_store_browsers'),
  'link/business sync must acquire its all-store lease before cleaning browsers');
assert.match(cleanup, /ownedLeaseTask/);
assert.match(repairWorker, /--owned-lease-task "\$LEASE_TASK"/);
for (const source of repairBatchSources) {
  assert.match(source, /SHEIN_BI_BROWSER_LEASE_TASK/);
  assert.match(source, /--owned-lease-task/);
}
console.log('marketing live guard resilience smoke: ok');
