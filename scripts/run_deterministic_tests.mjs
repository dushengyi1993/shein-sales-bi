#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const tests = [
  'scripts/marketing/smoke_coupon_budget_guard.mjs',
  'scripts/marketing/smoke_known_ordinary_price_guard.mjs',
  'scripts/marketing/smoke_limited_discount_drift_rescue_files.mjs',
  'scripts/marketing/smoke_limited_discount_drift_rescue_plan.mjs',
  'scripts/marketing/smoke_limited_discount_target_price_guard.mjs',
  'scripts/marketing/smoke_marketing_classifiers.mjs',
  'scripts/marketing/smoke_marketing_automation_authorization.mjs',
  'scripts/marketing/smoke_marketing_pricing_policy.mjs',
  'scripts/marketing/smoke_authorized_fallback_inventory_top_up.mjs',
  'scripts/marketing/smoke_latest_raw_marketing_link_overlay.mjs',
  'scripts/marketing/smoke_limited_discount_default_activity_stock.mjs',
  'scripts/marketing/smoke_manual_limited_discount_protection.mjs',
  'scripts/marketing/smoke_marketing_link_key_index.mjs',
  'scripts/marketing/smoke_merge_current_marketing_price_scans.mjs',
  'scripts/marketing/smoke_new_listing_limited_discount_plan_exact_price.mjs',
  'scripts/marketing/smoke_order_audit_linksdata_exact_target.mjs',
  'scripts/marketing/smoke_order_target_price_windows.mjs',
  'scripts/marketing/smoke_platform_new_label_policy.mjs',
  'scripts/marketing/smoke_relisted_link_cost_fallback.mjs',
  'scripts/marketing/smoke_relisted_link_limited_discount_plan.mjs',
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
  'scripts/test_bi_ops_agent_governor.mjs',
  'scripts/test_bi_ops_model_policy.mjs',
  'scripts/test_bi_ops_intent_planner.mjs',
  'scripts/test_bi_ops_query_context.mjs',
  'scripts/test_owner_knowledge_policy.mjs',
  'scripts/test_owner_knowledge_service.mjs',
  'scripts/test_owner_knowledge_local_collector.mjs',
  'scripts/test_owner_knowledge_event_watch.mjs',
  'scripts/test_owner_knowledge_distribution.mjs',
  'scripts/test_partner_knowledge_cache.mjs',
  'scripts/test_partner_cli_package.mjs',
  'scripts/test_partner_cli_updater.mjs',
  'scripts/test_partner_cli_portal_release.mjs',
  'scripts/test_partner_cli_release_pipeline.mjs',
  'scripts/test_link_ops_publish_asset_binding.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/test_shein_openapi_client_timeout.mjs',
  'scripts/test_link_ops_json_repository.mjs',
  'scripts/test_link_ops_store_gateway.mjs',
  'scripts/test_link_ops_job_worker.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_ops_product_model_identity_boundary.mjs',
  'scripts/test_link_ops_schema_sync.mjs',
  'scripts/test_link_ops_migration_compat.mjs',
  'scripts/test_migrate_link_ops_runtime_to_postgres.mjs',
  'scripts/test_shared_lock_security.mjs',
  'scripts/test_systemd_security_contract.mjs',
  'scripts/test_bi_product_section_contract.mjs',
  'scripts/test_openapi_sales_loader_validity.mjs',
  'scripts/test_openapi_sales_mapping_contract.mjs',
  'scripts/test_cloud_bi_refresh_lock_handoff.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/test_portal_http_security.mjs',
  'scripts/test_owner_knowledge_portal_flow.mjs',
  'scripts/test_owner_knowledge_execute_distribution_guard.mjs',
  'scripts/test_owner_knowledge_execute_toctou_guard.mjs',
  'scripts/test_bi_ops_multitenant_isolation.mjs',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_chat_inference.mjs',
  'scripts/test_bi_ops_chat_action_matrix.mjs',
  'scripts/test_bi_ops_task_projection.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_intent_job_flow.mjs',
  'scripts/test_bi_ops_frontend_confirm_feedback.mjs',
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
