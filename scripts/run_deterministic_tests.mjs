#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const tests = [
  'scripts/marketing/smoke_coupon_budget_guard.mjs',
  'scripts/marketing/smoke_known_ordinary_price_guard.mjs',
  'scripts/marketing/smoke_limited_discount_drift_rescue_plan.mjs',
  'scripts/marketing/smoke_limited_discount_target_price_guard.mjs',
  'scripts/marketing/smoke_marketing_classifiers.mjs',
  'scripts/marketing/smoke_marketing_pricing_policy.mjs',
  'scripts/marketing/smoke_new_listing_limited_discount_plan_exact_price.mjs',
  'scripts/marketing/smoke_order_audit_linksdata_exact_target.mjs',
  'scripts/marketing/smoke_order_target_price_windows.mjs',
  'scripts/marketing/smoke_platform_new_label_policy.mjs',
  'scripts/marketing/smoke_split_limited_discount_target_price_guard.mjs',
  'scripts/marketing/smoke_split_recreate_limited_discount_target_guard.mjs',
  'scripts/test_product_display_name.mjs',
  'scripts/test_product_match_key_schema.mjs',
  'scripts/test_product_sku_normalizer.mjs',
  'scripts/test_marketing_plan_selector.mjs',
  'scripts/test_marketing_scan_resilience.mjs',
  'scripts/test_cloud_watchdog_recovery.mjs',
  'scripts/test_bi_client_resilience.mjs',
  'scripts/test_bi_frontend_accessibility.mjs',
  'scripts/test_bi_section_cache.mjs',
  'scripts/test_shared_lock_security.mjs',
  'scripts/test_systemd_security_contract.mjs',
  'scripts/test_bi_product_section_contract.mjs',
  'scripts/test_openapi_sales_loader_validity.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/test_portal_http_security.mjs',
  'scripts/test_shein_store_identity_merchant_fallback.mjs',
  'scripts/test_shein_browser_cdp.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
];

const failures = [];
for (const file of tests) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  if (result.status !== 0) {
    failures.push({file, status: result.status, signal: result.signal, durationMs, stdout: result.stdout, stderr: result.stderr});
    console.error(`FAIL ${file} (${durationMs}ms)`);
  } else {
    console.log(`PASS ${file} (${durationMs}ms)`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ok: false, passed: tests.length - failures.length, failed: failures}, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ok: true, passed: tests.length, failed: 0}, null, 2));
