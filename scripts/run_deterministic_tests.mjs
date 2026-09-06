#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {selectDeterministicTestShard} from '../lib/deterministic_test_shards.mjs';

const tests = [
  'scripts/test_pending_discuss_shared_delivery_entry.mjs',
  'scripts/test_cloud_team_report_process_lifecycle.mjs',
  'scripts/test_inventory_v6_owner_resume_validation.mjs',
  'scripts/test_bi_v6_d1_d2_identity_and_display.mjs',
  'scripts/test_inventory_v6_e3_e4.mjs',
  'scripts/test_inventory_v6_cross_journal.mjs',
  'scripts/test_inventory_sealed_batch_reconciliation.mjs',
  'scripts/test_inventory_v6_occupancy.mjs',
  'scripts/test_inventory_guard_process_group.mjs',
  'scripts/test_link_ops_a2_c1_integrated.mjs',
  'scripts/test_link_ops_job_worker_heartbeat.mjs',
  'scripts/test_pending_discuss_a3.mjs',
  'scripts/test_marketing_a1_explicit_pricing.mjs',
  'scripts/test_marketing_b2_session_lifecycle.mjs',
  'scripts/test_marketing_transaction_mutation_evidence.mjs',
  'scripts/test_marketing_inventory_durable.mjs',
  'scripts/test_ops_business_result_formatter.mjs',
  'scripts/test_ops_business_result_pipeline.mjs',
  'scripts/test_ops_business_delivery_hooks.mjs',
  'scripts/test_cloud_marketing_primary_entry.mjs',
  'scripts/test_host_v6_resource_concurrency.mjs',
  'scripts/test_manual_discount_runtime.mjs',
  'scripts/test_manual_discount_session_recovery.mjs',
  'scripts/test_legacy_low_et_receipt_continuation.mjs',
  'scripts/test_marketing_runtime_artifacts.mjs',
  'scripts/test_chrome_profile_startup.mjs',
  'scripts/marketing/smoke_coupon_budget_guard.mjs',
  'scripts/marketing/smoke_known_ordinary_price_guard.mjs',
  'scripts/marketing/smoke_limited_discount_drift_rescue_files.mjs',
  'scripts/marketing/smoke_limited_discount_drift_rescue_plan.mjs',
  'scripts/marketing/smoke_limited_repair_status.mjs',
  'scripts/marketing/smoke_marketing_repair_manifest.mjs',
  'scripts/marketing/smoke_marketing_repair_queue.mjs',
  'scripts/marketing/smoke_marketing_daily_group_report.mjs',
  'scripts/marketing/smoke_marketing_terminal_report_readiness.mjs',
  'scripts/marketing/smoke_bounded_fallback_resume.mjs',
  'scripts/marketing/smoke_high_click_special_policy.mjs',
  'scripts/marketing/smoke_shared_storage_cost.mjs',
  'scripts/marketing/smoke_marketing_cost_map_model.mjs',
  'scripts/marketing/smoke_ordinary_campaign_approval.mjs',
  'scripts/marketing/smoke_limited_discount_target_price_guard.mjs',
  'scripts/marketing/smoke_marketing_classifiers.mjs',
  'scripts/marketing/smoke_marketing_automation_authorization.mjs',
  'scripts/marketing/smoke_marketing_activity_inventory_transaction_policy.mjs',
  'scripts/marketing/smoke_marketing_activity_inventory_transaction.mjs',
  'scripts/marketing/smoke_marketing_activity_inventory_integration.mjs',
  'scripts/marketing/smoke_low_et_fast_seller_pricing.mjs',
  'scripts/marketing/smoke_low_et_fast_seller_integrations.mjs',
  'scripts/marketing/smoke_transactional_limited_discount_replacement.mjs',
  'scripts/marketing/smoke_transactional_limited_discount_deadline.mjs',
  'scripts/marketing/smoke_marketing_pricing_policy.mjs',
  'scripts/marketing/smoke_authorized_fallback_inventory_top_up.mjs',
  'scripts/marketing/smoke_latest_raw_marketing_link_overlay.mjs',
  'scripts/marketing/smoke_current_marketing_live_scan_selection.mjs',
  'scripts/marketing/smoke_ordinary_activity_list_gap.mjs',
  'scripts/marketing/smoke_limited_discount_default_activity_stock.mjs',
  'scripts/marketing/smoke_manual_limited_discount_protection.mjs',
  'scripts/marketing/smoke_marketing_link_key_index.mjs',
  'scripts/marketing/smoke_merge_current_marketing_price_scans.mjs',
  'scripts/marketing/smoke_new_listing_limited_discount_plan_exact_price.mjs',
  'scripts/marketing/smoke_order_audit_linksdata_exact_target.mjs',
  'scripts/marketing/smoke_cloud_order_warehouse_fallback.mjs',
  'scripts/marketing/smoke_order_mitigation_history.mjs',
  'scripts/marketing/smoke_order_target_price_windows.mjs',
  'scripts/marketing/smoke_ordinary_composite_plan_tools.mjs',
  'scripts/marketing/smoke_ordinary_platform_price_policy.mjs',
  'scripts/marketing/smoke_ordinary_platform_tier_evidence.mjs',
  'scripts/marketing/smoke_platform_new_label_policy.mjs',
  'scripts/marketing/smoke_relisted_link_cost_fallback.mjs',
  'scripts/marketing/smoke_relisted_link_limited_discount_plan.mjs',
  'scripts/marketing/smoke_limited_discount_drift_activity_stock.mjs',
  'scripts/marketing/smoke_split_limited_discount_target_price_guard.mjs',
  'scripts/marketing/smoke_split_recreate_limited_discount_target_guard.mjs',
  'scripts/marketing/smoke_limited_discount_rescue_registry_source.mjs',
  'scripts/test_product_display_name.mjs',
  'scripts/test_product_match_key_schema.mjs',
  'scripts/test_product_sku_normalizer.mjs',
  'scripts/test_business_domain_fetch_contract.mjs',
  'scripts/test_marketing_plan_selector.mjs',
  'scripts/test_marketing_coupon_low_price_overlap_scanner.mjs',
  'scripts/test_marketing_coupon_risk_artifact_bindings.mjs',
  'scripts/test_marketing_repair_queue_cas.mjs',
  'scripts/test_marketing_plan_registry.mjs',
  'scripts/test_marketing_plan_promotion_registry.mjs',
  'scripts/test_marketing_plan_source_contracts.mjs',
  'scripts/test_marketing_repair_worker_registry.mjs',
  'scripts/test_cloud_marketing_repair_serial_contract.mjs',
  'scripts/test_cloud_marketing_immediate_run.mjs',
  'scripts/test_marketing_executor_cli_compatibility.mjs',
  'scripts/test_marketing_high_click_recovery_contract.mjs',
  'scripts/test_marketing_unified_login_recovery_contract.mjs',
  'scripts/test_new_listing_limited_discount_plan_price_source.mjs',
  'scripts/test_cloud_marketing_live_guard_resume.mjs',
  'scripts/test_cloud_marketing_source_contracts.mjs',
  'scripts/test_marketing_scan_resilience.mjs',
  'scripts/test_marketing_price_lead_merge.mjs',
  'scripts/test_cloud_watchdog_recovery.mjs',
  'scripts/test_cloud_watchdog_alert_state.mjs',
  'scripts/test_cloud_watchdog_issue_collapse.mjs',
  'scripts/test_cloud_watchdog_release_audit.mjs',
  'scripts/test_cloud_maintenance_mode.mjs',
  'scripts/test_cloud_data_coverage_policy.mjs',
  'scripts/test_cloud_manual_login_recovery.mjs',
  'scripts/test_session_manager_webapi_export_contract.mjs',
  'scripts/test_bi_session_secret_provision.mjs',
  'scripts/test_bi_runtime_shutdown_lifecycle.mjs',
  'scripts/test_bi_live_accounting_refresh_guard.mjs',
  'scripts/test_bi_client_resilience.mjs',
  'scripts/test_bi_query_surface_isolation.mjs',
  'scripts/test_bi_frontend_accessibility.mjs',
  'scripts/test_bi_home_period_comparison.mjs',
  'scripts/test_bi_section_cache.mjs',
  'scripts/test_bi_section_parse_slot.mjs',
  'scripts/test_bi_core_stream_reuse.mjs',
  'scripts/test_bi_query_reader_lifecycle.mjs',
  'scripts/test_bi_response_completeness.mjs',
  'scripts/test_bi_section_streaming.mjs',
  'scripts/test_bi_section_portal_streaming.mjs',
  'scripts/test_bi_portal_section_queue.mjs',
  'scripts/test_bi_portal_section_queue_window.mjs',
  'scripts/test_bi_portal_core_warmup_queue_owned.mjs',
  'scripts/test_bi_portal_external_queue_reconciliation.mjs',
  'scripts/test_bi_portal_core_run_identity.mjs',
  'scripts/test_bi_core_warmup_health.mjs',
  'scripts/test_bi_portal_section_terminal.mjs',
  'scripts/test_bi_portal_data_mode.mjs',
  'scripts/test_bi_portal_direct_cache.mjs',
  'scripts/test_bi_live_page_recovery.mjs',
  'scripts/test_bounded_top_level_json.mjs',
  'scripts/test_atomic_file_publish.mjs',
  'scripts/test_ops_run_bundle.mjs',
  'scripts/test_bi_profit_mart_freshness.mjs',
  'scripts/test_bi_portal_accounting_state_cache.mjs',
  'scripts/test_profit_refresh_pipeline_contract.mjs',
  'scripts/test_marketing_price_snapshot_health.mjs',
  'scripts/test_cloud_session_manager_reliability.mjs',
  'scripts/test_cloud_session_manager_latest_scope.mjs',
  'scripts/test_bi_ops_agent_governor.mjs',
  'scripts/test_bi_ops_model_policy.mjs',
  'scripts/test_bi_ops_intent_planner.mjs',
  'scripts/test_bi_ops_query_context.mjs',
  'scripts/test_bi_ops_direct_query.mjs',
  'scripts/test_bi_ops_p0_cli_runtime_snapshot.mjs',
  'scripts/test_bi_ops_query_retry.mjs',
  'scripts/test_owner_knowledge_policy.mjs',
  'scripts/test_owner_knowledge_service.mjs',
  'scripts/test_owner_knowledge_local_collector.mjs',
  'scripts/test_owner_knowledge_event_watch.mjs',
  'scripts/test_owner_knowledge_turn_ended.mjs',
  'scripts/test_owner_knowledge_distribution.mjs',
  'scripts/test_partner_knowledge_cache.mjs',
  'scripts/test_partner_cli_package.mjs',
  'scripts/test_partner_cli_version_change.mjs',
  'scripts/test_partner_cli_updater.mjs',
  'scripts/test_partner_cli_portal_release.mjs',
  'scripts/test_partner_cli_release_pipeline.mjs',
  'scripts/test_link_ops_publish_asset_binding.mjs',
  'scripts/test_link_business_audit_nonblocking.mjs',
  'scripts/test_link_ops_uploaded_asset_binding_recovery.mjs',
  'scripts/test_link_ops_uploaded_asset_binding_recovery_e2e.mjs',
  'scripts/test_link_ops_reuse_normal_binding_payload.mjs',
  'scripts/test_link_ops_product_descriptions.mjs',
  'scripts/test_link_ops_empty_description_authorization.mjs',
  'scripts/test_link_ops_duplicate_publish_override.mjs',
  'scripts/test_link_ops_description_material_extract.mjs',
  'scripts/test_link_ops_extract_sk11004.mjs',
  'scripts/test_link_ops_prepare_descriptions_flow.mjs',
  'scripts/test_link_ops_update_description_flow.mjs',
  'scripts/test_link_ops_prepare_product_attribute_flow.mjs',
  'scripts/test_link_ops_executor_copy_batch_features.mjs',
  'scripts/test_link_ops_executor_live_source_titles.mjs',
  'scripts/test_link_ops_executor_source_detail_lock.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/test_retire_execute_best_effort.mjs',
  'scripts/test_shein_openapi_client_timeout.mjs',
  'scripts/test_openapi_stock_refresh_contract.mjs',
  'scripts/test_shein_webhook_receiver.mjs',
  'scripts/test_shein_webhook_audit_context.mjs',
  'scripts/test_shein_webhook_config.mjs',
  'scripts/test_shein_webhook_repository.mjs',
  'scripts/test_shein_webhook_write_gate.mjs',
  'scripts/test_shein_webhook_external_write_guard.mjs',
  'scripts/test_shein_webhook_handlers.mjs',
  'scripts/test_shein_webhook_product_state_migration.mjs',
  'scripts/test_shein_webhook_task_reconciler.mjs',
  'scripts/test_shein_webhook_order_return_sync.mjs',
  'scripts/test_shein_webhook_service.mjs',
  'scripts/test_notify_sync_issue.mjs',
  'scripts/test_lark_delivery_target.mjs',
  'scripts/test_cloud_team_report_delivery.mjs',
  'scripts/test_shein_webhook_portal_contract.mjs',
  'scripts/test_webhook_primary_sales_migration.mjs',
  'scripts/test_cloud_primary_sales_finalize_contract.mjs',
  'scripts/test_primary_sales_cutover_guard.mjs',
  'scripts/test_bi_live_events_bridge.mjs',
  'scripts/test_bi_webhook_frontend.mjs',
  'scripts/test_link_ops_json_repository.mjs',
  'scripts/test_link_ops_store_gateway.mjs',
  'scripts/test_link_ops_job_worker.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_ops_product_model_identity_boundary.mjs',
  'scripts/test_link_ops_schema_sync.mjs',
  'scripts/test_link_ops_migration_compat.mjs',
  'scripts/test_migrate_link_ops_runtime_to_postgres.mjs',
  'scripts/test_morning_chain_reliability.mjs',
  'scripts/test_morning_coordinator_portal_async.mjs',
  'scripts/test_authorize_cloud_morning_chain_recovery.mjs',
  'scripts/test_morning_chain_final_resume.mjs',
  'scripts/test_morning_chain_watchdog_stale_running.mjs',
  'scripts/test_morning_chain_wrapper_reliability.mjs',
  'scripts/test_daily_operating_refresh_validator.mjs',
  'scripts/test_shared_lock_security.mjs',
  'scripts/test_pipeline_marker.mjs',
  'scripts/test_morning_resume_evidence.mjs',
  'scripts/test_morning_metric_refetch.mjs',
  'scripts/test_cloud_link_metric_readiness.mjs',
  'scripts/test_systemd_unit_snapshot.mjs',
  'scripts/test_systemd_unit_inventory_contract.mjs',
  'scripts/test_install_cloud_maintenance_guards.mjs',
  'scripts/test_cloud_runtime_path_policy.mjs',
  'scripts/test_install_cloud_runtime_path_namespaces.mjs',
  'scripts/test_migrate_cloud_runtime_mount_layout.mjs',
  'scripts/test_systemd_runtime_bind_paths_probe_contract.mjs',
  'scripts/test_cloud_runtime_snapshot.mjs',
  'scripts/test_cloud_disk_maintenance_contract.mjs',
  'scripts/test_host_resource_schedule_contract.mjs',
  'scripts/test_release_source_state.mjs',
  'scripts/test_emergency_local_release_receipt.mjs',
  'scripts/test_source_release_workflow_contract.mjs',
  'scripts/test_systemd_security_contract.mjs',
  'scripts/test_bi_product_section_contract.mjs',
  'scripts/test_bi_product_profit_section_contract.mjs',
  'scripts/test_inventory_projection_contract.mjs',
  'scripts/test_inventory_replenishment_policy.mjs',
  'scripts/test_inventory_compatibility_preflight_cli.mjs',
  'scripts/test_inventory_compatibility_rotation.mjs',
  'scripts/test_inventory_default_cutover_lock.mjs',
  'scripts/test_inventory_detail_manifest_terminal.mjs',
  'scripts/test_inventory_identity_alias_guard.mjs',
  'scripts/test_inventory_manual_resolution.mjs',
  'scripts/test_inventory_manual_resolution_executor_fence.mjs',
  'scripts/test_inventory_minimal_compatibility_normal_flows.mjs',
  'scripts/test_inventory_owner_confirmed_same_target_resume.mjs',
  'scripts/test_inventory_planner_alias_identity.mjs',
  'scripts/test_inventory_planner_kj102_separation.mjs',
  'scripts/test_inventory_reconcile_extra_scope.mjs',
  'scripts/test_inventory_v2_fence_entrypoints.mjs',
  'scripts/test_inventory_write_cutover_activation.mjs',
  'scripts/test_inventory_writer_release_alignment.mjs',
  'scripts/test_daily_inventory_replenishment_plan.mjs',
  'scripts/test_daily_inventory_current_detail_targeting.mjs',
  'scripts/test_daily_inventory_guard_targeted_detail.mjs',
  'scripts/test_durable_inventory_write.mjs',
  'scripts/test_link_ops_maintenance_inventory_durable.mjs',
  'scripts/test_daily_inventory_executor_lifecycle.mjs',
  'scripts/test_execute_inventory_durable_recovery.mjs',
  'scripts/test_inventory_cross_day_intent.mjs',
  'scripts/test_inventory_journal_discovery_domain.mjs',
  'scripts/test_et_low_inventory_safety_guard.mjs',
  'scripts/test_et_low_inventory_detail_evidence.mjs',
  'scripts/test_inventory_cost_ledger.mjs',
  'scripts/test_shein_openapi_readonly_retry.mjs',
  'scripts/test_shein_finance_check_orders.mjs',
  'scripts/test_storage_fee_bill_canonicalization.mjs',
  'scripts/test_et_storage_fee_sync_contract.mjs',
  'scripts/test_et_http_transport.mjs',
  'scripts/test_et_forwarder_runtime_contract.mjs',
  'scripts/test_read_transport_policy.mjs',
  'scripts/test_warehouse_business_logic_contract.mjs',
  'scripts/test_order_status_effective_evidence_contract.mjs',
  'scripts/test_order_closure_idempotency.mjs',
  'scripts/smoke_browser_task_lease.mjs',
  'scripts/smoke_cloud_marketing_live_guard_resilience.mjs',
  'scripts/test_marketing_api_light_lane.mjs',
  'scripts/test_marketing_artifact_publication_lock.mjs',
  'scripts/test_marketing_virtual_last_row_fill.mjs',
  'scripts/test_marketing_visible_fast_path_contract.mjs',
  'scripts/test_openapi_sales_loader_validity.mjs',
  'scripts/test_openapi_sales_mapping_contract.mjs',
  'scripts/test_historical_store_identity.mjs',
  'scripts/test_historical_store_identity_repair_contract.mjs',
  'scripts/test_openapi_product_reconciliation_policy.mjs',
  'scripts/test_openapi_product_detail_cache.mjs',
  'scripts/test_openapi_product_cache_runtime_path.mjs',
  'scripts/test_link_ops_source_skc_precedence.mjs',
  'scripts/test_fetch_shein_openapi_products_stock_retry.mjs',
  'scripts/test_cloud_bi_refresh_lock_handoff.mjs',
  'scripts/test_portal_section_queue_recovery.mjs',
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
  'scripts/test_local_browser_profile_cache_cleanup.mjs',
  'scripts/test_chrome_profile_atomic_metadata.mjs',
  'scripts/test_local_repo_hygiene_contract.mjs',
  'scripts/test_chrome_tmp_hygiene.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
  'scripts/test_pending_discuss_batch.mjs',
  'scripts/test_pending_discuss_daily.mjs',
  'scripts/test_deterministic_timeout_contract.mjs',
  'scripts/test_deterministic_test_shards.mjs',
  'scripts/test_deterministic_focused_selection.mjs',
  'scripts/test_cloud_db_backup_contract.mjs',
  'scripts/test_cos_backup_remote_verifier.mjs',
  'scripts/test_encrypted_browser_state_backup.mjs',
  // Portal repository safety tests are registered here exactly once, so every
  // four-shard green run proves each of them ran. The release-gate job is the
  // sole owner of scripts/test_bi_ops_release_gate.mjs, and ci-terminal still
  // fails closed unless both deterministic shards and that dedicated job pass.
  'scripts/test_bi_portal_repository_crud.mjs',
  'scripts/test_bi_portal_mutation_queue.mjs',
  'scripts/test_links_data_store_coverage.mjs',
];

const V6_TEST_TIMEOUTS = {
  'scripts/test_cloud_team_report_process_lifecycle.mjs': 60000,
  'scripts/test_inventory_v6_e3_e4.mjs': 120000,
  'scripts/test_inventory_v6_cross_journal.mjs': 60000,
  'scripts/test_inventory_sealed_batch_reconciliation.mjs': 60000,
  'scripts/test_inventory_guard_process_group.mjs': 90000,
  'scripts/test_link_ops_a2_c1_integrated.mjs': 120000,
  'scripts/test_link_ops_job_worker_heartbeat.mjs': 60000,
  'scripts/test_marketing_b2_session_lifecycle.mjs': 120000,
  'scripts/test_marketing_transaction_mutation_evidence.mjs': 120000,
  'scripts/test_marketing_inventory_durable.mjs': 120000,
  'scripts/test_ops_business_delivery_hooks.mjs': 90000,
  'scripts/test_cloud_marketing_primary_entry.mjs': 120000,
  'scripts/test_host_v6_resource_concurrency.mjs': 90000,
  'scripts/test_chrome_profile_startup.mjs': 60000,
  'scripts/test_install_cloud_runtime_path_namespaces.mjs': 120000,
};

const TEST_ESTIMATES_MS = {
  ...V6_TEST_TIMEOUTS,
  'scripts/test_link_ops_uploaded_asset_binding_recovery.mjs': 2_000,
  'scripts/test_link_ops_uploaded_asset_binding_recovery_e2e.mjs': 5_000,
  'scripts/test_link_ops_reuse_normal_binding_payload.mjs': 5_000,
  'scripts/test_link_ops_prepare_product_attribute_flow.mjs': 1_200_000,
  'scripts/test_link_ops_prepare_descriptions_flow.mjs': 300_000,
  'scripts/test_link_ops_update_description_flow.mjs': 240_000,
  'scripts/test_morning_chain_reliability.mjs': 120_000,
  'scripts/test_morning_chain_wrapper_reliability.mjs': 120_000,
  'scripts/test_morning_metric_refetch.mjs': 120_000,
  'scripts/test_cloud_session_manager_reliability.mjs': 120_000,
  'scripts/test_bi_query_surface_isolation.mjs': 120_000,
  'scripts/test_cloud_marketing_immediate_run.mjs': 90_000,
  'scripts/test_bi_section_streaming.mjs': 120_000,
  'scripts/test_bi_section_portal_streaming.mjs': 120_000,
  'scripts/test_bi_portal_section_queue_window.mjs': 60_000,
  'scripts/test_bi_portal_core_warmup_queue_owned.mjs': 120_000,
  'scripts/test_bi_portal_external_queue_reconciliation.mjs': 60_000,
  'scripts/test_bi_portal_core_run_identity.mjs': 30_000,
  'scripts/test_morning_coordinator_portal_async.mjs': 120_000,
  'scripts/test_bi_ops_cli_flow.mjs': 90_000,
  'scripts/test_partner_cli_version_change.mjs': 30_000,
  'scripts/test_partner_cli_updater.mjs': 35_000,
  'scripts/test_daily_inventory_executor_lifecycle.mjs': 90_000,
  'scripts/test_link_ops_executor_source_detail_lock.mjs': 60_000,
  'scripts/test_et_forwarder_runtime_contract.mjs': 60_000,
  'scripts/test_migrate_cloud_runtime_mount_layout.mjs': 1_800_000,
  'scripts/test_cloud_db_backup_contract.mjs': 120_000,
  'scripts/test_cos_backup_remote_verifier.mjs': 60_000,
  'scripts/test_bi_portal_mutation_queue.mjs': 60_000,
  'scripts/test_order_closure_idempotency.mjs': 60_000,
};

function parseRunnerArgs(argv) {
  const args = {shard: '', shardProvided: false, files: null, list: false};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--shard') {
      args.shardProvided = true;
      // Preserve the existing --shard parser/default semantics. The
      // --files conflict is checked separately after all options are read.
      args.shard = argv[++i] || '';
    } else if (argv[i] === '--files') {
      if (args.files !== null) throw new Error('--files may be specified only once');
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--files requires a non-empty comma-separated value');
      }
      args.files = value;
    } else if (argv[i] === '--list') args.list = true;
    else throw new Error(`Unknown deterministic test runner argument: ${argv[i]}`);
  }
  if (args.files !== null && args.shardProvided) {
    throw new Error('--files cannot be combined with --shard');
  }
  return args;
}

function parseFocusedFiles(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('--files requires a non-empty comma-separated value');
  }
  const requestedFiles = value.split(',').map(file => file.trim());
  const emptyEntry = requestedFiles.find(file => !file);
  if (emptyEntry !== undefined) {
    throw new Error('--files cannot contain empty file paths');
  }
  const traversalEntry = requestedFiles.find(file => file.split(/[\\/]/u).includes('..'));
  if (traversalEntry !== undefined) {
    throw new Error(`--files rejects path traversal: ${traversalEntry}`);
  }
  const registered = new Set(tests);
  const unknownEntry = requestedFiles.find(file => !registered.has(file));
  if (unknownEntry !== undefined) {
    throw new Error(`--files path is not registered: ${unknownEntry}`);
  }
  return [...new Set(requestedFiles)];
}

function estimateFocusedTests(selectedTests) {
  return selectedTests.reduce((total, file) => {
    const configured = Number(TEST_ESTIMATES_MS[file]);
    const estimateMs = Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : 2_000;
    return total + estimateMs;
  }, 0);
}

const runnerArgs = parseRunnerArgs(process.argv.slice(2));
const shard = runnerArgs.files === null
  ? selectDeterministicTestShard(tests, runnerArgs.shard || '1/1', TEST_ESTIMATES_MS)
  : null;
const focusedFiles = runnerArgs.files === null ? null : parseFocusedFiles(runnerArgs.files);
const selectedTests = shard?.tests || tests.filter(file => focusedFiles.includes(file));
const estimatedMs = shard?.estimatedMs || estimateFocusedTests(selectedTests);
if (runnerArgs.list) {
  if (shard) {
    console.log(JSON.stringify({ok: true, shard: `${shard.index}/${shard.count}`, estimatedMs, tests: selectedTests}, null, 2));
  } else {
    console.log(JSON.stringify({
      ok: true,
      mode: 'files',
      order: 'registered',
      requestedFiles: runnerArgs.files.split(',').map(file => file.trim()),
      deduplicatedFiles: focusedFiles,
      estimatedMs,
      tests: selectedTests,
    }, null, 2));
  }
  process.exit(0);
}
if (shard) {
  console.error(`TEST_SHARD ${shard.index}/${shard.count} selected=${selectedTests.length} total=${tests.length} estimatedMs=${estimatedMs}`);
} else {
  console.error(`TEST_FILES order=registered selected=${selectedTests.length} requested=${runnerArgs.files.split(',').length} unique=${focusedFiles.length} total=${tests.length} estimatedMs=${estimatedMs}`);
}

const failures = [];
for (const file of selectedTests) {
  const startedAt = Date.now();
  // Keep deterministic tests bounded and fail-fast, with explicit tiers only
  // where measured evidence exceeds the default. PR #99 CI attempt 1 killed
  // source-detail-lock at 30042ms on the default 30s tier; attempt 2 passed it
  // in 26012ms, then killed the attribute flow at 720017ms on its old 720s
  // tier, both by timeout SIGTERM with no assertion failure. Local evidence is
  // 24.7s for source-detail-lock and 709s for attribute flow.
  // Attempt 3 then hit the description flow's former 240s bound at 240099ms
  // and the attribute flow's 900s bound at 900128ms.
  // The latest complete product-attribute flow measured about 20 minutes
  // (1,180,547ms) in the release gate. Its bounded 30-minute budget keeps
  // deterministic headroom without disabling timeout. Update descriptions
  // keeps 240s, morning reliability keeps 120s, and every other deterministic
  // test keeps the default 30s budget.
  // Shard 2 evidence: portal warmup queue-owned (30016ms), morning coordinator
  // portal async (30014ms), bi-ops CLI flow (30021ms), and ET forwarder runtime
  // contract (30011ms) were all killed on the default 30s tier. Warmup measured
  // over 58s locally, morning coordinator runs an internal 120s bash harness,
  // CLI flow measured 36,615ms locally before its full pass, and ET forwarder
  // spawns many bash steps on cold CI. Each gets an explicit bounded tier
  // (warmup/morning 120s, CLI flow 90s, ET forwarder 60s); the default stays 30s.
  // The runtime-layout migration A-R crash/fingerprint/path-safety suite takes
  // more than 15 minutes on Windows/Git Bash. A stale default tier killed the
  // earlier A-L suite at 30018ms; after M-P added effective-systemd and complete
  // rollback-evidence gates, the 900s tier reached scenarios A-O successfully
  // and was killed at 900018ms before P. With the Q1-Q4 rollback sub-phase
  // markers and scenario R drift guard added, scenarios A-R and Q1-Q4 now all
  // pass, but the 1200s outer
  // tier still SIGTERMed the completed suite at 1,200,015ms. The latest complete
  // pass on Windows/Git Bash took 1,791,363ms, leaving under 9 seconds of margin
  // against the 1,800,000ms gate. This near-gate margin is a local-only concern:
  // keep the bounded 30-minute tier (1,800,000ms) on every non-Windows platform
  // including the GitHub Linux CI, and TEST_ESTIMATES_MS stays at 1,800,000 for
  // deterministic shard balancing; only local Windows/Git Bash gets a bounded
  // 40-minute (2,400,000ms) timeout margin so the near-gate suite can complete.
  // Never unbounded.
  // The dedicated release-gate job is the sole owner of
  // scripts/test_bi_ops_release_gate.mjs; deterministic shards deliberately do
  // not register or budget it. The Portal repository CRUD and mutation-queue
  // safety tests remain registered here once each; mutation queue keeps an
  // explicit bounded 120s tier (60s estimate), while CRUD stays on the default
  // 30s budget. ci-terminal fails closed on both CI owners.
  // Query-surface isolation is deliberately integration-heavy: its default
  // 30s tier was killed at 30025ms after the direct-query checks, while the
  // separate large-stream runtime was already healthy. A standalone run then
  // completed both large wire modes, the constrained-heap slow-client probe,
  // fail-fast restart, and Portal continuity in about 96.7s; the subsequent
  // full runner pass measured 125946ms. Use a 120s shard estimate and a bounded
  // 240s outer tier; its individual 45s/75s/120s probe and request bounds remain
  // the inner failure controls.
  // The database-backup contract now covers 27 isolated fault-injection
  // scenarios, including hung remote verification, path swaps, retention, and
  // browser-profile receipts. A frozen-candidate standalone run completed in
  // 103081ms; the old default tier killed it at 30023ms without an assertion
  // failure. Keep a bounded 180s outer tier and a 120s shard estimate.
  // Partner CLI version-change validation measured 27014ms in the complete
  // local runner, then the four-shard replay was SIGTERMed at 30013ms with no
  // stdout, stderr, or assertion failure while other shards were active. Give
  // that integration test a bounded 60s outer tier and a measured 30s shard
  // estimate. The updater crash/recovery matrix also needs just over the
  // default tier (31042ms locally), so it gets the same bounded 60s tier and a
  // measured 35s estimate. The daily inventory executor lifecycle spans many
  // isolated subprocess scenarios and crossed even a 60s local outer budget
  // without an assertion failure; its WSL pass measured 85.21s, so it uses a
  // bounded 180s tier and a 90s shard estimate. Unclassified tests keep the
  // 30s fail-fast budget.
  const timeout = V6_TEST_TIMEOUTS[file] || (file === 'scripts/test_link_ops_prepare_descriptions_flow.mjs'
    ? 300_000
    : file === 'scripts/test_link_ops_uploaded_asset_binding_recovery.mjs'
      ? 30_000
      : file === 'scripts/test_link_ops_uploaded_asset_binding_recovery_e2e.mjs'
        ? 60_000
      : file === 'scripts/test_link_ops_reuse_normal_binding_payload.mjs'
        ? 60_000
    : file === 'scripts/test_link_ops_update_description_flow.mjs'
      ? 240_000
      : file === 'scripts/test_bi_query_surface_isolation.mjs'
        ? 240_000
        : file === 'scripts/test_bi_portal_core_warmup_queue_owned.mjs'
          ? 120_000
          : file === 'scripts/test_bi_portal_external_queue_reconciliation.mjs'
            ? 150_000
            : file === 'scripts/test_bi_portal_core_run_identity.mjs'
              ? 60_000
            : file === 'scripts/test_bi_portal_section_queue_window.mjs'
              ? 120_000
          : file === 'scripts/test_bi_section_streaming.mjs'
            ? 120_000
            : file === 'scripts/test_bi_section_portal_streaming.mjs'
              ? 120_000
            : file === 'scripts/test_morning_coordinator_portal_async.mjs'
              ? 120_000
              : file === 'scripts/test_bi_ops_cli_flow.mjs'
              ? 90_000
              : file === 'scripts/test_partner_cli_version_change.mjs'
                ? 60_000
              : file === 'scripts/test_partner_cli_updater.mjs'
                ? 60_000
              : file === 'scripts/test_daily_inventory_executor_lifecycle.mjs'
                ? 180_000
              : file === 'scripts/test_cloud_marketing_immediate_run.mjs'
                ? 90_000
              : file === 'scripts/test_link_ops_executor_source_detail_lock.mjs'
                ? 60_000
                : file === 'scripts/test_et_forwarder_runtime_contract.mjs'
                  ? 60_000
                  : file === 'scripts/test_migrate_cloud_runtime_mount_layout.mjs'
                    ? (process.platform === 'win32' ? 2_400_000 : 1_800_000)
                    : file === 'scripts/test_cloud_db_backup_contract.mjs'
                      ? 180_000
                    : file === 'scripts/test_link_ops_prepare_product_attribute_flow.mjs'
                      ? 1_800_000
                      : file === 'scripts/test_cos_backup_remote_verifier.mjs'
                        ? 60_000
                    : file === 'scripts/test_bi_portal_mutation_queue.mjs'
                      ? 120_000
                      : file === 'scripts/test_order_closure_idempotency.mjs'
                        ? 120_000
                      : file === 'scripts/test_morning_metric_refetch.mjs'
                        ? 180_000
                      : ['scripts/test_morning_chain_reliability.mjs',
                            'scripts/test_morning_chain_wrapper_reliability.mjs',
                            'scripts/test_cloud_session_manager_reliability.mjs'].includes(file)
                            ? 120_000
                          : 30_000);
  console.error(`START ${file} timeoutMs=${timeout}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout,
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
  const failureManifest = {
    ok: false,
    selected: selectedTests.length,
    passed: selectedTests.length - failures.length,
    failed: failures,
  };
  if (shard) failureManifest.shard = `${shard.index}/${shard.count}`;
  else {
    failureManifest.mode = 'files';
    failureManifest.order = 'registered';
    failureManifest.tests = selectedTests;
  }
  console.error(JSON.stringify(failureManifest, null, 2));
  process.exit(1);
}

if (shard) {
  console.log(JSON.stringify({
    ok: true,
    shard: `${shard.index}/${shard.count}`,
    passed: selectedTests.length,
    total: tests.length,
    failed: 0,
  }, null, 2));
} else {
  console.log(JSON.stringify({
    ok: true,
    mode: 'files',
    order: 'registered',
    passed: selectedTests.length,
    total: tests.length,
    failed: 0,
  }, null, 2));
}
