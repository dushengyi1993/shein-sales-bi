#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
const biPublishHelper = fs.readFileSync(path.join(root, 'scripts', 'publish_marketing_price_leads_to_bi.sh'), 'utf8');
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
execFileSync('bash', ['-n', 'scripts/publish_marketing_price_leads_to_bi.sh'], {cwd: root, stdio: 'inherit'});
for (const script of ['scripts/cloud_daily_refresh.sh','scripts/cloud_link_business_sync.sh','scripts/cloud_shein_session_manager.sh','scripts/cloud_rtv_verify.sh']) {
  execFileSync('bash', ['-n', script], {cwd: root, stdio: 'inherit'});
}
assert.match(guard, /RUN_ID=.*randomUUID/);
assert.match(guard, /browserless inspection via session HTTP/);
assert.match(guard, /--session-http/);
assert.doesNotMatch(guard, /manage_browser_task_leases\.mjs/);
assert.doesNotMatch(guard, /cleanup_shein_store_browsers/);
assert.match(guard, /build_repair_queue/);
assert.match(guard, /IGNORE_RESERVED_WINDOW="\$\{SHEIN_BI_MARKETING_LIVE_IGNORE_RESERVED_WINDOW:-1\}"/);
assert.match(guard, /refresh_marketing_cost_map/);
assert.match(guard, /manage_marketing_repair_queue\.mjs handoff-local/);
assert.match(guard, /cloud inspection is complete and all writes are handed to local controlled execution/);
assert.match(guard, /Later timer slots are retries for a failed inspection/);
assert.doesNotMatch(guard, /batch_(?:fix_limited_discount_drift|apply_new_listing_limited_discount)\.mjs[^\n]*--execute/);
assert.doesNotMatch(guard, /batch_restore_manual_limited_discounts\.mjs[^\n]*--execute/);
assert.match(guard, /on_shelf_limited_discount_plan_count\(\)[\s\S]*?NODE\s*\}/,
  'on-shelf plan count heredoc must close before later shell function declarations');
assert.doesNotMatch(guard, /consider_reserved_time "browser-cleanup/);
assert.match(guard, /flag: 'wx'/);
assert.match(cleanup, /reclaimStaleBrowserLeases/);
assert.match(cleanup, /active_store_lease/);
assert.match(cleanupTimer, /03:20:00/);
assert.match(cleanupTimer, /09:25:00/);
assert.match(cleanupTimer, /21:20:00/);
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
assert.match(repairWorker, /run_terminal_final_snapshot\(\)[\s\S]*export_marketing_stack_review\.mjs[\s\S]*scan_current_marketing_prices_for_bi\.mjs[\s\S]*build_marketing_daily_guard_report\.mjs/,
  'repair final readback must refresh ordinary/coupon session HTTP evidence before the latest price scan and final guard rebuild');
assert.match(repairWorker, /run_final_readback\(\)[\s\S]*run_terminal_final_snapshot/,
  'completed repair queues must reuse the terminal final snapshot before rebuilding the queue');
assert.match(repairWorker, /check_marketing_terminal_report_readiness\.mjs/,
  'blocked queues must not send the final report before final-snapshot work is terminally accounted');
assert.match(
  repairWorker,
  /if \[\[ "\$QUEUE_STATUS" == "completed" \|\| "\$QUEUE_STATUS" == "blocked" \]\]; then[\s\S]*?terminal_report_ready[\s\S]*?send_daily_group_report/,
  'terminal readiness gate must run before blocked-queue report delivery',
);
assert.match(repairWorker, /export SHEIN_BI_BROWSER_LEASE_TASK="\$LEASE_TASK"/);
assert.match(repairWorker, /export SHEIN_BI_BROWSER_LEASE_RUN_ID="\$RUN_ID"/);
assert.doesNotMatch(dailyRefresh, /manage_browser_task_leases\.mjs/);
assert.doesNotMatch(dailyRefresh, /cleanup_shein_store_browsers|close_store_browsers/);
assert.doesNotMatch(dailyRefresh, /scan_current_marketing_prices_for_bi\.mjs/);
for (const source of [linkBusiness, sessionManager]) {
  assert.match(source, /manage_browser_task_leases\.mjs/);
}
assert.match(rtvVerify, /--transport webapi/);
assert.doesNotMatch(rtvVerify, /manage_browser_task_leases\.mjs|launch_store_browser|--headless/,
  'RTV direct WebAPI verification must not reserve a browser lease');
assert.doesNotMatch(linkBusiness, /pkill\s+-f/);
assert.match(
  linkBusiness,
  /lease_action acquire\s+LEASE_ACTIVE=1\s+close_store_browsers/,
  'link/business sync must acquire its all-store lease before cleaning browsers',
);
assert.match(cleanup, /ownedLeaseTask/);
assert.match(repairWorker, /--owned-lease-task "\$LEASE_TASK"/);
for (const source of repairBatchSources) {
  assert.match(source, /SHEIN_BI_BROWSER_LEASE_TASK/);
  assert.match(source, /--owned-lease-task/);
}
const helperExportAt = biPublishHelper.indexOf('export_marketing_price_leads_for_bi.mjs');
const helperEnqueueAt = biPublishHelper.indexOf('enqueue_bi_portal_sections.sh');
assert.ok(helperExportAt !== -1 && helperEnqueueAt !== -1 && helperExportAt < helperEnqueueAt,
  'shared BI publish helper must run the price-lead export before enqueueing the portal section');
assert.match(biPublishHelper, /set -Eeuo pipefail/);
assert.doesNotMatch(biPublishHelper, /\|\| true/,
  'shared BI publish helper must not swallow export/enqueue failures');
assert.deepEqual(
  [...biPublishHelper.matchAll(/--sections\s+([A-Za-z0-9,]+)/g)].map(match => match[1]),
  ['linksData'],
  'shared BI publish helper must enqueue only the linksData section',
);
assert.doesNotMatch(biPublishHelper, /prewarm_bi_portal_sections|scan_current_marketing_prices_for_bi|cleanup_shein_store_browsers|manage_browser_task_leases|--headless|curl/,
  'shared BI publish helper must never scrape, launch browsers, or prewarm sections');
assert.match(biPublishHelper, /--priority "\$PRIORITY"/);
assert.match(biPublishHelper, /--reason "\$REASON"/);
assert.match(biPublishHelper, /SHEIN_BI_MARKETING_BI_PUBLISH_PRIORITY:-10/);
assert.match(biPublishHelper, /SHEIN_BI_MARKETING_BI_PUBLISH_REASON:-marketing-live-/);
assert.match(biPublishHelper, /export_marketing_price_leads_for_bi\.mjs --require-fresh/,
  'shared BI publish helper must reject stale/error preserved price snapshots before enqueue');
const helperHarness = stage => [
  `FAIL_STAGE=${stage}`,
  'SHEIN_BI_ROOT=.',
  'node() { echo EXPORT; if [[ "$FAIL_STAGE" == "export" ]]; then return 31; fi; return 0; }',
  'bash() { echo ENQUEUE; if [[ "$FAIL_STAGE" == "enqueue" ]]; then return 32; fi; return 0; }',
  biPublishHelper,
].join('\n');
const helperExportFailure = spawnSync('bash', [], {cwd: root, encoding: 'utf8', input: helperHarness('export')});
assert.notEqual(helperExportFailure.status, 0, 'price export failure must propagate out of the BI publish helper');
assert.doesNotMatch(helperExportFailure.stdout || '', /^ENQUEUE$/m, 'failed export must stop before linksData enqueue');
const helperEnqueueFailure = spawnSync('bash', [], {cwd: root, encoding: 'utf8', input: helperHarness('enqueue')});
assert.notEqual(helperEnqueueFailure.status, 0, 'linksData enqueue failure must propagate out of the BI publish helper');
assert.match(helperEnqueueFailure.stdout, /^EXPORT$/m);
assert.match(helperEnqueueFailure.stdout, /^ENQUEUE$/m);
const helperSuccess = spawnSync('bash', [], {cwd: root, encoding: 'utf8', input: helperHarness('none')});
assert.equal(helperSuccess.status, 0, helperSuccess.stderr || helperSuccess.stdout);
assert.ok(helperSuccess.stdout.indexOf('EXPORT') < helperSuccess.stdout.indexOf('ENQUEUE'), 'helper must export before enqueue at runtime');
const ordinaryReadyAt = guard.indexOf('ORDINARY_LIVE_READY=');
const guardPublishAt = guard.indexOf('publish complete marketing live snapshot to BI portal queue');
assert.ok(ordinaryReadyAt !== -1 && guardPublishAt > ordinaryReadyAt,
  'live guard must publish only after the guard report has proved ordinary evidence readiness');
assert.match(guard, /if \[\[ "\$STACK_REVIEW_STATUS" -eq 0 && "\$ORDINARY_LIVE_READY" -eq 1 && "\$SCAN_STATUS" -eq 0 && "\$GUARD_STATUS" -eq 0 \]\]; then[\s\S]*?bash scripts\/publish_marketing_price_leads_to_bi\.sh/,
  'live guard must require complete ordinary, limited-discount, and guard evidence before BI publish');
assert.match(guard, /BI_PUBLISH_STATUS=\$\?/,
  'live guard must record a failed BI publish status');
assert.match(guard, /"\$BI_PUBLISH_STATUS" -eq 0/,
  'live guard ok state must require a successful BI publish');
assert.match(guard, /biPublish=\$BI_PUBLISH_STATUS/,
  'live guard warning state must surface the BI publish status');
assert.match(repairWorker, /run_terminal_final_snapshot\(\)[\s\S]*build_marketing_daily_guard_report\.mjs[\s\S]*FINAL_SCAN_OUT="\$scan_out"[\s\S]*publish_marketing_price_leads_to_bi\.sh \|\| return \$\?/,
  'repair worker must publish to BI after a successful terminal final snapshot and propagate publish failure');
assert.match(repairWorker, /run_final_readback\(\)[\s\S]*run_terminal_final_snapshot \|\| return \$\?/,
  'repair worker final readback must not report ok when the terminal snapshot publish fails');

function shellFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

const repairFailureHarness = [
  'set -u',
  'ROOT=/tmp/shein-bi-repair-smoke',
  'TZ_NAME=UTC',
  'DATE=2026-08-11',
  'STACK_REVIEW_KILL_AFTER_SEC=1',
  'STACK_REVIEW_TIMEOUT_SEC=2',
  'SCAN_KILL_AFTER_SEC=1',
  'SCAN_TIMEOUT_SEC=2',
  'GUARD_CLOUD_BI_SSH=local',
  'GUARD_CLOUD_BI_ROOT=/tmp/shein-bi-repair-smoke',
  'GUARD_MAX_AGE_HOURS=96',
  'QUEUE_FILE=/tmp/shein-bi-repair-smoke/queue.json',
  'FINAL_SCAN_OUT=',
  'lease_action() { return 0; }',
  'timeout() { if [[ "$1" == "-k" ]]; then shift 3; fi; "$@"; }',
  `node() {
    local joined="$*" stage=""
    case "$joined" in
      *export_marketing_stack_review.mjs*) stage=stack_review ;;
      *scan_current_marketing_prices_for_bi.mjs*) stage=scan ;;
      *build_marketing_daily_guard_report.mjs*) stage=guard ;;
      *build_high_click_special_discount_plan.mjs*) stage=high_click ;;
      *targetPlanSelection*) stage=price_overrides ;;
      *build_new_listing_limited_discount_plan.mjs*) stage=new_listing ;;
      *manualSpecialLimitedDiscount*) stage=manual_count ;;
      *build_manual_limited_discount_restore_plan.mjs*) stage=manual_plan ;;
      *limitedDiscountTargetPriceDrift*) stage=drift_count ;;
      *build_limited_discount_drift_rescue_plan.mjs*) stage=drift_plan ;;
      *manage_marketing_repair_queue.mjs*) stage=queue ;;
    esac
    if [[ "$FAIL_STAGE" == "$stage" ]]; then return 41; fi
    case "$stage" in
      price_overrides) printf '%s\\n' tmp/price-overrides.json ;;
      manual_count|drift_count) printf '0\\n' ;;
    esac
    return 0
  }`,
  'bash() { if [[ "$FAIL_STAGE" == "publish" ]]; then return 42; fi; return 0; }',
  shellFunction(repairWorker, 'run_terminal_final_snapshot'),
  shellFunction(repairWorker, 'run_final_readback'),
  shellFunction(repairWorker, 'build_current_repair_plans'),
  shellFunction(repairWorker, 'rebuild_repair_queue'),
  'if run_final_readback; then echo OK; exit 0; else status=$?; echo "FAIL:$status"; exit "$status"; fi',
].join('\n');

for (const stage of ['stack_review','scan','guard','publish','high_click','price_overrides','new_listing','manual_count','drift_count','queue']) {
  const result = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: `FAIL_STAGE=${stage}\n${repairFailureHarness}`,
  });
  assert.notEqual(result.status, 0, `repair final readback must propagate ${stage} failure even when called from an if condition`);
  assert.doesNotMatch(result.stdout || '', /^OK$/m, `${stage} failure must never be reported as final-readback success`);
}
const repairSuccess = spawnSync('bash', [], {
  cwd: root,
  encoding: 'utf8',
  input: `FAIL_STAGE=none\n${repairFailureHarness}`,
});
assert.equal(repairSuccess.status, 0, repairSuccess.stderr || repairSuccess.stdout);
assert.match(repairSuccess.stdout, /^OK$/m);
console.log('marketing live guard resilience smoke: ok');
