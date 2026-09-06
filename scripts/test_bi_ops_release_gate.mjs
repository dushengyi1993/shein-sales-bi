#!/usr/bin/env node
/**
 * Release gate for the SHEIN BI automation workbench.
 *
 * This is intentionally conservative and side-effect-light: the flow tests
 * start isolated local portal instances with temporary auth/task/audit files;
 * they do not touch production tasks and do not enable real SHEIN writes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_FILES = [
  'scripts/serve_bi_portal.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/bi_ops_cli.mjs',
  'scripts/test_bi_ops_cli_reuse_approved_binding.mjs',
  'scripts/test_bi_ops_publish_asset_reuse_guard.mjs',
  'lib/shein_openapi_client.mjs',
  'scripts/test_shein_openapi_client_windows_guard.mjs',
  'scripts/test_bi_ops_local_openapi_boundary.mjs',
  'scripts/test_bi_ops_cloud_image_asset.mjs',
  'lib/link_ops_image_role_planner.mjs',
  'scripts/link_ops_plan_image_roles.mjs',
  'scripts/test_sk5110_batch_draft_plan.mjs',
  'scripts/test_sk5110_cloud_handoff_plan.mjs',
  'scripts/link_ops_hl_openapi_executor.mjs',
  'scripts/link_ops_maintenance_openapi_executor.mjs',
  'scripts/fetch_shein_openapi_products.mjs',
  'scripts/load_shein_openapi_products_warehouse.mjs',
  'scripts/link_ops_build_product_master_candidate_from_openapi.mjs',
  'scripts/probe_shein_openapi_hl.mjs',
  'lib/link_ops_product_draft_mapper.mjs',
  'lib/link_retire_candidate_policy.mjs',
  'lib/retire_supplier_code_repair_payload.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/build_link_retire_candidates_from_csv.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/repair_retire_supplier_code_openapi.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/generate_bi_portal.mjs',
  'scripts/bi_app/client.js',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_chat_inference.mjs',
  'scripts/test_bi_ops_bad_transcript_replay.mjs',
  'scripts/test_bi_ops_chat_action_matrix.mjs',
  'scripts/test_bi_ops_chat_maintenance_flow.mjs',
  'scripts/test_bi_ops_task_projection.mjs',
  'scripts/test_bi_ops_frontend_confirm_feedback.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
  'scripts/test_bi_ops_source_candidate_policy.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_ops_product_model_identity_boundary.mjs',
  'scripts/test_link_ops_product_draft_openapi_detail.mjs',
  'scripts/test_link_ops_executor_live_source_titles.mjs',
  'scripts/test_link_ops_executor_source_detail_lock.mjs',
  'scripts/test_shein_store_identity_merchant_fallback.mjs',
  'scripts/test_bi_ops_write_whitelist_scope.mjs',
  'scripts/check_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_copy_product_success_flow.mjs',
  'scripts/test_bi_ops_copy_product_all_stores_capability.mjs',
  'scripts/test_bi_ops_maintenance_executor_flow.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/openapi_image_asset_executor.mjs',
  'scripts/test_openapi_image_asset_executor.mjs',
  'scripts/openapi_readonly_executor.mjs',
  'scripts/test_openapi_readonly_executor.mjs',
  'scripts/openapi_order_fulfillment_executor.mjs',
  'scripts/test_openapi_order_fulfillment_executor.mjs',
  'scripts/openapi_catalog_executor.mjs',
  'scripts/test_openapi_catalog_executor.mjs',
  'scripts/openapi_image_asset_executor.mjs',
  'scripts/test_openapi_image_asset_executor.mjs',
  'scripts/verify_shein_openapi_doc_detail.mjs',
  'scripts/test_shein_openapi_doc_detail_parser.mjs',
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  'scripts/test_bi_ops_maintenance_readiness.mjs',
  'lib/pending_discuss_batch.mjs',
  'scripts/pending_discuss_batch.mjs',
  'scripts/test_pending_discuss_batch.mjs',
  'lib/pending_discuss_daily.mjs',
  'scripts/pending_discuss_daily.mjs',
  'scripts/test_pending_discuss_daily.mjs',
  'scripts/test_bi_portal_repository_crud.mjs',
  'scripts/test_bi_portal_mutation_queue.mjs',
  'scripts/test_bi_runtime_shutdown_lifecycle.mjs',
];
const DIFF_CHECK_FILES = [
  'scripts/serve_bi_portal.mjs',
  'scripts/test_portal_security.mjs',
  'infra/nginx/shein-bi.conf',
  'infra/caddy/Caddyfile.shein-bi',
  'scripts/bi_ops_cli.mjs',
  'scripts/test_bi_ops_cli_reuse_approved_binding.mjs',
  'scripts/test_bi_ops_publish_asset_reuse_guard.mjs',
  'lib/shein_openapi_client.mjs',
  'scripts/test_shein_openapi_client_windows_guard.mjs',
  'scripts/test_bi_ops_local_openapi_boundary.mjs',
  'scripts/test_bi_ops_cloud_image_asset.mjs',
  'lib/link_ops_image_role_planner.mjs',
  'scripts/link_ops_plan_image_roles.mjs',
  'scripts/test_sk5110_batch_draft_plan.mjs',
  'scripts/test_sk5110_cloud_handoff_plan.mjs',
  'scripts/link_ops_hl_openapi_executor.mjs',
  'scripts/link_ops_maintenance_openapi_executor.mjs',
  'scripts/fetch_shein_openapi_products.mjs',
  'scripts/load_shein_openapi_products_warehouse.mjs',
  'scripts/link_ops_build_product_master_candidate_from_openapi.mjs',
  'scripts/probe_shein_openapi_hl.mjs',
  'lib/link_ops_product_draft_mapper.mjs',
  'lib/link_retire_candidate_policy.mjs',
  'lib/retire_supplier_code_repair_payload.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/build_link_retire_candidates_from_csv.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/repair_retire_supplier_code_openapi.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_chat_inference.mjs',
  'scripts/test_bi_ops_bad_transcript_replay.mjs',
  'scripts/test_bi_ops_chat_action_matrix.mjs',
  'scripts/test_bi_ops_chat_maintenance_flow.mjs',
  'scripts/test_bi_ops_task_projection.mjs',
  'scripts/test_bi_ops_frontend_confirm_feedback.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
  'outputs/bi-portal/index.html',
  'scripts/bi_app/client.js',
  'scripts/bi_app/styles.css',
  'scripts/test_bi_ops_source_candidate_policy.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_ops_product_model_identity_boundary.mjs',
  'scripts/test_link_ops_product_draft_openapi_detail.mjs',
  'scripts/test_link_ops_executor_live_source_titles.mjs',
  'scripts/test_link_ops_executor_source_detail_lock.mjs',
  'scripts/test_shein_store_identity_merchant_fallback.mjs',
  'scripts/test_bi_ops_write_whitelist_scope.mjs',
  'scripts/check_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_copy_product_success_flow.mjs',
  'scripts/test_bi_ops_copy_product_all_stores_capability.mjs',
  'scripts/test_bi_ops_maintenance_executor_flow.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/openapi_image_asset_executor.mjs',
  'scripts/test_openapi_image_asset_executor.mjs',
  'scripts/openapi_readonly_executor.mjs',
  'scripts/test_openapi_readonly_executor.mjs',
  'scripts/openapi_order_fulfillment_executor.mjs',
  'scripts/test_openapi_order_fulfillment_executor.mjs',
  'scripts/openapi_catalog_executor.mjs',
  'scripts/test_openapi_catalog_executor.mjs',
  'scripts/verify_shein_openapi_doc_detail.mjs',
  'scripts/test_shein_openapi_doc_detail_parser.mjs',
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  'scripts/test_bi_ops_maintenance_readiness.mjs',
  'lib/pending_discuss_batch.mjs',
  'scripts/pending_discuss_batch.mjs',
  'scripts/test_pending_discuss_batch.mjs',
  'lib/pending_discuss_daily.mjs',
  'scripts/pending_discuss_daily.mjs',
  'scripts/test_pending_discuss_daily.mjs',
  'docs/partner-codex-ops-setup.md',
  'docs/ops-workflow-contract.md',
  'docs/bi-ops-openapi-automation-plan.md',
  'docs/shein-openapi-integration.md',
  'docs/pending-discuss-batch.md',
  'scripts/test_bi_portal_repository_crud.mjs',
  'scripts/test_bi_portal_mutation_queue.mjs',
  'scripts/test_bi_runtime_shutdown_lifecycle.mjs',
];
const BI_OPS_V2_JS_FILES = [
  'lib/bi_ops_query_retry.mjs',
  'lib/deterministic_test_shards.mjs',
  'lib/cloud_runtime_inventory.mjs',
  'lib/cloud_runtime_snapshot.mjs',
  'lib/morning_resume_evidence.mjs',
  'lib/ops_run_bundle.mjs',
  'lib/systemd_unit_snapshot.mjs',
  'lib/warehouse_pg.mjs',
  'lib/link_ops_repository.mjs',
  'lib/link_ops_json_repository.mjs',
  'lib/link_ops_store_gateway.mjs',
  'lib/link_ops_job_worker.mjs',
  'lib/link_ops_migration_compat.mjs',
  'lib/bi_ops_intent_planner.mjs',
  'lib/bi_ops_model_policy.mjs',
  'lib/bi_ops_agent_governor.mjs',
  'lib/bi_ops_query_context.mjs',
  'lib/cross_process_ticket_lock.mjs',
  'lib/owner_knowledge_policy.mjs',
  'lib/owner_knowledge_service.mjs',
  'lib/owner_knowledge_local_collector.mjs',
  'lib/owner_knowledge_distribution.mjs',
  'lib/partner_knowledge_cache.mjs',
  'lib/partner_cli_release.mjs',
  'lib/partner_cli_release_store.mjs',
  'lib/partner_cli_updater.mjs',
  'lib/link_ops_publish_asset_binding.mjs',
  'lib/link_ops_product_attribute_binding.mjs',
  'scripts/owner_knowledge_sync.mjs',
  'scripts/owner_knowledge_admin.mjs',
  'scripts/validate_owner_knowledge_distribution.mjs',
  'scripts/test_owner_knowledge_policy.mjs',
  'scripts/test_owner_knowledge_service.mjs',
  'scripts/test_owner_knowledge_local_collector.mjs',
  'scripts/test_owner_knowledge_event_watch.mjs',
  'scripts/test_owner_knowledge_turn_ended.mjs',
  'scripts/test_owner_knowledge_distribution.mjs',
  'scripts/test_partner_knowledge_cache.mjs',
  'scripts/test_partner_cli_package.mjs',
  'scripts/test_partner_cli_updater.mjs',
  'scripts/test_partner_cli_portal_release.mjs',
  'scripts/test_partner_cli_release_pipeline.mjs',
  'scripts/test_deterministic_test_shards.mjs',
  'scripts/test_deterministic_timeout_contract.mjs',
  'scripts/build_partner_cli_deploy_payload.mjs',
  'scripts/verify_partner_cli_package_artifact.mjs',
  'scripts/partner_cli_bootstrap.mjs',
  'scripts/test_link_ops_publish_asset_binding.mjs',
  'scripts/test_link_ops_prepare_product_attribute_flow.mjs',
  'scripts/test_owner_knowledge_portal_flow.mjs',
  'scripts/test_owner_knowledge_execute_distribution_guard.mjs',
  'scripts/test_owner_knowledge_execute_toctou_guard.mjs',
  'scripts/bi_ops_intent_planner.mjs',
  'scripts/migrate_link_ops_runtime_to_postgres.mjs',
  'scripts/export_link_ops_postgres_snapshot.mjs',
  'scripts/test_bi_ops_intent_job_flow.mjs',
  'scripts/test_bi_ops_multitenant_isolation.mjs',
  'scripts/test_migrate_link_ops_runtime_to_postgres.mjs',
  'scripts/test_link_ops_job_worker.mjs',
  'scripts/test_link_ops_json_repository.mjs',
  'scripts/test_link_ops_migration_compat.mjs',
  'scripts/test_link_ops_schema_sync.mjs',
  'scripts/test_link_ops_store_gateway.mjs',
  'scripts/test_bi_ops_intent_planner.mjs',
  'scripts/test_bi_ops_model_policy.mjs',
  'scripts/test_bi_ops_agent_governor.mjs',
  'scripts/test_bi_ops_query_context.mjs',
  'scripts/capture_ops_runtime_snapshot.mjs',
  'scripts/inspect_ops_run.mjs',
  'scripts/cloud_ops_watchdog.mjs',
  'scripts/build_morning_resume_evidence.mjs',
  'scripts/pipeline_marker.mjs',
  'scripts/test_bi_ops_query_retry.mjs',
  'scripts/test_cloud_runtime_snapshot.mjs',
  'scripts/test_morning_resume_evidence.mjs',
  'scripts/test_ops_run_bundle.mjs',
  'scripts/test_pipeline_marker.mjs',
  'scripts/test_systemd_unit_snapshot.mjs',
];
const BI_OPS_V2_REQUIRED_ARTIFACTS = [
  'infra/warehouse/schema.sql',
  'infra/warehouse/migrations/20260711_001_link_ops_runtime.sql',
  'scripts/provision_link_ops_postgres_role.sh',
  'scripts/bi_app/styles.css',
  'outputs/bi-portal/index.html',
  'docs/bi-ops-v2-release-2026-07-12.md',
  'docs/cloud-bi-operations.md',
  'docs/partner-codex-ops-setup.md',
  'docs/scripts-inventory.md',
  'infra/systemd/shein-bi-portal.service',
  'infra/systemd/shein-bi-lark-sales-qa.service',
  'infra/systemd/README.md',
  'scripts/install_owner_knowledge_sync_task.ps1',
  'scripts/install_partner_bi_ops_cli.ps1',
  'scripts/build_partner_bi_ops_cli_package.ps1',
  'config/partner_cli_package.json',
  'AGENTS.md',
  'codex/skills/shein-bi-ops/SKILL.md',
  'docs/partner-cli-release-2026-07-13.md',
  'docs/partner-cli-automatic-deployment.md',
  '.github/workflows/owner-knowledge.yml',
  '.github/workflows/partner-cli-release.yml',
];
CHECK_FILES.push(...BI_OPS_V2_JS_FILES);
DIFF_CHECK_FILES.push(...BI_OPS_V2_JS_FILES, ...BI_OPS_V2_REQUIRED_ARTIFACTS);
const STALE_CONFIRM_TEXT = 'SHEIN_' + 'HL_OPENAPI_SUBMIT';
const SK5110_LOCAL_ARTIFACTS = [
  'tmp/sk5110-batch-prep/sk5110-batch-draft-plan.local-only.json',
  'tmp/sk5110-batch-prep/sk5110-cloud-execution-handoff.local-only.json',
];
const PRODUCT_ATTRIBUTE_FLOW_TEST = 'scripts/test_link_ops_prepare_product_attribute_flow.mjs';
const PRODUCT_ATTRIBUTE_FLOW_TIMEOUT_MS = 1_800_000;
const RELEASE_GATE_TEST = 'scripts/test_bi_ops_release_gate.mjs';
const OWNERSHIP_BASELINE_DETERMINISTIC_TEST_COUNT = 233;
const OWNERSHIP_BASELINE_DIRECT_CALL_COUNT = 49;
const OWNERSHIP_BASELINE_DIRECT_UNIQUE_TEST_COUNT = 41;
const OWNERSHIP_BASELINE_INTERSECTION_COUNT = 19;
const OWNERSHIP_BASELINE_UNION_COUNT = OWNERSHIP_BASELINE_DETERMINISTIC_TEST_COUNT
  + OWNERSHIP_BASELINE_DIRECT_UNIQUE_TEST_COUNT
  - OWNERSHIP_BASELINE_INTERSECTION_COUNT;
// Provenance: commit f0d5301 fixed the post-transfer ownership snapshot
// (deterministic runner = 233 - dedicated release gate = 232 entries,
// direct gate calls 49 -> 30, direct unique 41 -> 22, owner union 255).
// The old parser omitted 49 scripts/marketing/smoke_ entries in this baseline.
// Deterministic registrations added after that snapshot are tracked with an
// explicit count so the exact-equality assertions below stay source-
// explainable instead of drifting silently or being loosened to >=.
// Exact list comparison: f0d5301 -> PR119 2fb4afa adds 64 (including one smoke),
// and 2fb4afa -> PR120 88d6140 adds 24; neither interval removes a registration.
// PR123 adds test_manual_discount_session_recovery.mjs; no test is removed.
const OWNERSHIP_POST_BASELINE_DETERMINISTIC_ADDITIONS = 89;
const OWNERSHIP_CURRENT_DETERMINISTIC_TEST_COUNT = OWNERSHIP_BASELINE_DETERMINISTIC_TEST_COUNT
  - 1
  + OWNERSHIP_POST_BASELINE_DETERMINISTIC_ADDITIONS;
const OWNERSHIP_CURRENT_UNION_COUNT = OWNERSHIP_BASELINE_UNION_COUNT
  + OWNERSHIP_POST_BASELINE_DETERMINISTIC_ADDITIONS;
const DIRECT_TESTS_TRANSFERRED_TO_DETERMINISTIC_SHARDS = [
  'scripts/test_bi_ops_chat_action_matrix.mjs',
  'scripts/test_bi_ops_chat_inference.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_frontend_confirm_feedback.mjs',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
  'scripts/test_bi_ops_task_projection.mjs',
  'scripts/test_bi_portal_mutation_queue.mjs',
  'scripts/test_bi_portal_repository_crud.mjs',
  'scripts/test_bi_runtime_shutdown_lifecycle.mjs',
  'scripts/test_link_ops_executor_live_source_titles.mjs',
  'scripts/test_link_ops_executor_source_detail_lock.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/test_shein_store_identity_merchant_fallback.mjs',
];

function extractDeterministicRunnerTests(source) {
  const testsBlock = String(source || '').match(/const tests = \[([\s\S]*?)\r?\n\];/u)?.[1];
  if (!testsBlock) throw new Error('Deterministic registration array is missing');
  return testsBlock.split(/\r?\n/u).flatMap(line => {
    if (!line.trim() || /^\s*\/\//u.test(line)) return [];
    const entry = line.match(/^\s*(['"])(scripts\/[^'"]+\.mjs)\1\s*,?\s*(?:\/\/.*)?$/u);
    if (!entry) throw new Error('Unrecognized deterministic registration: ' + line.trim());
    return [entry[2]];
  });
}

function extractDirectReleaseGateTestInvocations(source) {
  const pattern = /\brun\s*\(\s*process\.execPath\s*,\s*\[\s*['"](scripts\/test_[^'"]+\.mjs)['"]/gu;
  return [...String(source || '').matchAll(pattern)].map(match => match[1]);
}

function extractWorkflowJobBlock(source, jobName) {
  const lines = String(source || '').split(/\r?\n/u);
  const start = lines.findIndex(line => line === `  ` + jobName + ':');
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^  [a-zA-Z0-9_-]+:\s*$/u.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

function countLiteral(source, literal) {
  return String(source || '').split(literal).length - 1;
}

function terminalJobIsExactAndFailClosed(workflow) {
  const terminalJob = extractWorkflowJobBlock(workflow, 'ci-terminal');
  return /^    needs: \[source-checks, deterministic-shards, release-gate\]$/mu.test(terminalJob)
    && /^          SOURCE_CHECKS_RESULT: \$\{\{ needs\.source-checks\.result \}\}$/mu.test(terminalJob)
    && /^          DETERMINISTIC_SHARDS_RESULT: \$\{\{ needs\.deterministic-shards\.result \}\}$/mu.test(terminalJob)
    && /^          RELEASE_GATE_RESULT: \$\{\{ needs\.release-gate\.result \}\}$/mu.test(terminalJob)
    && /if \[ "\$SOURCE_CHECKS_RESULT" != 'success' \] \|\| \[ "\$DETERMINISTIC_SHARDS_RESULT" != 'success' \] \|\| \[ "\$RELEASE_GATE_RESULT" != 'success' \]; then[\s\S]*?^            exit 1$/mu.test(terminalJob);
}

function countDirectProductAttributeFlowInvocations(source) {
  const escapedTarget = PRODUCT_ATTRIBUTE_FLOW_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetExpression = `(?:PRODUCT_ATTRIBUTE_FLOW_TEST|['"]${escapedTarget}['"])`;
  const directInvocationPattern = new RegExp(
    `\\brun\\s*\\(\\s*process\\.execPath\\s*,\\s*\\[\\s*${targetExpression}(?=\\s*(?:,|\\]))`,
    'gu',
  );
  return [...String(source || '').matchAll(directInvocationPattern)].length;
}

function run(command, args, {allowFailure = false, env = process.env} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      const result = {command, args, code, durationMs: Date.now() - startedAt, stdout, stderr, ok: code === 0 || allowFailure};
      resolve(result);
    });
  });
}

async function pathExists(rel) {
  try {
    await fs.access(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

async function checkDeterministicProductAttributeRegistration() {
  const startedAt = Date.now();
  const [runner, releaseGateSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'scripts/run_deterministic_tests.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts/test_bi_ops_release_gate.mjs'), 'utf8'),
  ]);
  const testsBlock = runner.match(/const tests = \[([\s\S]*?)\n\];/u)?.[1] || '';
  const registeredCount = testsBlock.split(`'${PRODUCT_ATTRIBUTE_FLOW_TEST}'`).length - 1;
  const timeoutSourceLiteral = String(PRODUCT_ATTRIBUTE_FLOW_TIMEOUT_MS).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  const timeoutPattern = new RegExp(
    `file === ['"]${PRODUCT_ATTRIBUTE_FLOW_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\?\\s*${timeoutSourceLiteral}`,
    'u',
  );
  const timeoutRegistered = timeoutPattern.test(runner);
  const directInvocationCount = countDirectProductAttributeFlowInvocations(releaseGateSource);
  const ok = registeredCount === 1 && timeoutRegistered && directInvocationCount === 0;
  return {
    command: 'static deterministic product-attribute registration check',
    args: [],
    code: ok ? 0 : 1,
    durationMs: Date.now() - startedAt,
    stdout: ok ? `${PRODUCT_ATTRIBUTE_FLOW_TEST} registered once with timeoutMs=${PRODUCT_ATTRIBUTE_FLOW_TIMEOUT_MS} directInvocationCount=0` : '',
    stderr: ok ? '' : `registeredCount=${registeredCount} timeoutRegistered=${timeoutRegistered} directInvocationCount=${directInvocationCount}`,
    ok,
  };
}

async function checkDeterministicSuiteDelegation(sources) {
  const startedAt = Date.now();
  const [runner, workflow, releaseGateSource] = sources || await Promise.all([
    fs.readFile(path.join(ROOT, 'scripts/run_deterministic_tests.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts/test_bi_ops_release_gate.mjs'), 'utf8'),
  ]);
  const nestedFullRun = /results\.push\(\{name:\s*['"]deterministic BI Ops V2 suite['"][\s\S]{0,240}run_deterministic_tests\.mjs/u.test(releaseGateSource);
  const requiredShards = ['1/4', '2/4', '3/4', '4/4'];
  const deterministicTests = extractDeterministicRunnerTests(runner);
  const directInvocations = extractDirectReleaseGateTestInvocations(releaseGateSource);
  const deterministicSet = new Set(deterministicTests);
  const directSet = new Set(directInvocations);
  const intersection = [...deterministicSet].filter(file => directSet.has(file)).sort();
  const transferredOwnership = DIRECT_TESTS_TRANSFERRED_TO_DETERMINISTIC_SHARDS.map(file => ({
    file,
    deterministicCount: deterministicTests.filter(candidate => candidate === file).length,
    directCount: directInvocations.filter(candidate => candidate === file).length,
  }));
  const releaseGateJob = extractWorkflowJobBlock(workflow, 'release-gate');
  const releaseGateCommand = 'node ' + RELEASE_GATE_TEST;
  const ownershipUnion = new Set([...deterministicSet, ...directSet, RELEASE_GATE_TEST]);
  const ownership = {
    baseline: {
      deterministicUnique: OWNERSHIP_BASELINE_DETERMINISTIC_TEST_COUNT,
      directCalls: OWNERSHIP_BASELINE_DIRECT_CALL_COUNT,
      directUnique: OWNERSHIP_BASELINE_DIRECT_UNIQUE_TEST_COUNT,
      intersection: OWNERSHIP_BASELINE_INTERSECTION_COUNT,
      union: OWNERSHIP_BASELINE_UNION_COUNT,
      provenanceCommit: 'f0d5301',
      postBaselineDeterministicAdditions: OWNERSHIP_POST_BASELINE_DETERMINISTIC_ADDITIONS,
    },
    current: {
      deterministicEntries: deterministicTests.length,
      deterministicUnique: deterministicSet.size,
      directCalls: directInvocations.length,
      directUnique: directSet.size,
      intersection: intersection.length,
      unionIncludingDedicatedReleaseGate: ownershipUnion.size,
      dedicatedReleaseGateCiCommands: countLiteral(workflow, releaseGateCommand),
    },
    intersection,
    transferredOwnership,
  };
  const checks = {
    runnerUsesDeterministicShardSelector: /selectDeterministicTestShard/.test(runner)
      && /--shard/.test(runner),
    shardContractTestsRegistered: [
      'scripts/test_deterministic_test_shards.mjs',
      'scripts/test_deterministic_timeout_contract.mjs',
    ].every(file => runner.split(`'${file}'`).length - 1 === 1),
    workflowOwnsAllFourShards: requiredShards.every(shard => workflow.includes(`'${shard}'`))
      && /max-parallel:\s*4/.test(workflow)
      && /node scripts\/run_deterministic_tests\.mjs --shard/.test(workflow),
    deterministicRegistrationsAreUnique: deterministicTests.length === deterministicSet.size,
    deterministicCountPreservedAfterDedicatedGateTransfer:
      deterministicSet.size === OWNERSHIP_CURRENT_DETERMINISTIC_TEST_COUNT,
    directCallCountReducedOnlyByTransferredTests:
      directInvocations.length === OWNERSHIP_BASELINE_DIRECT_CALL_COUNT - DIRECT_TESTS_TRANSFERRED_TO_DETERMINISTIC_SHARDS.length,
    directUniqueCountReducedOnlyByTransferredTests:
      directSet.size === OWNERSHIP_BASELINE_DIRECT_UNIQUE_TEST_COUNT - DIRECT_TESTS_TRANSFERRED_TO_DETERMINISTIC_SHARDS.length,
    releaseGateAbsentFromDeterministicRunner: !deterministicSet.has(RELEASE_GATE_TEST),
    deterministicAndDirectOwnershipIntersectionEmpty: intersection.length === 0,
    transferredTestsOwnedExactlyOnceByDeterministicRunner: transferredOwnership.every(
      entry => entry.deterministicCount === 1 && entry.directCount === 0,
    ),
    dedicatedReleaseGateCiOwnerExactlyOnce: countLiteral(releaseGateJob, releaseGateCommand) === 1
      && countLiteral(workflow, releaseGateCommand) === 1,
    ownershipUnionPreserved: ownershipUnion.size === OWNERSHIP_CURRENT_UNION_COUNT,
    terminalGateRequiresExactThreeJobsAndFailsClosed: terminalJobIsExactAndFailClosed(workflow),
    releaseGateDoesNotNestFullSuite: !nestedFullRun,
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    command: 'static deterministic shard ownership check',
    args: [],
    code: ok ? 0 : 1,
    durationMs: Date.now() - startedAt,
    stdout: ok ? JSON.stringify({checks, ownership}) : '',
    stderr: ok ? '' : JSON.stringify({checks, ownership}),
    ok,
  };
}

async function checkCiReleaseGateReachability() {
  const startedAt = Date.now();
  const [runner, workflow] = await Promise.all([
    fs.readFile(path.join(ROOT, 'scripts/run_deterministic_tests.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
  ]);
  const deterministicTests = extractDeterministicRunnerTests(runner);
  const registeredCount = file => deterministicTests.filter(candidate => candidate === file).length;
  const releaseGateJob = extractWorkflowJobBlock(workflow, 'release-gate');
  const releaseGateCommand = 'node ' + RELEASE_GATE_TEST;
  const releaseGateBuildCommand = 'npm run build:portal-shell';
  const releaseGateEstimateCount = [...runner.matchAll(/['"]scripts\/test_bi_ops_release_gate\.mjs['"]\s*:/gu)].length;
  const releaseGateTimeoutTierCount = [...runner.matchAll(/file === ['"]scripts\/test_bi_ops_release_gate\.mjs['"]\s*\?/gu)].length;
  const checks = {
    releaseGateAbsentFromDeterministicRunner: registeredCount(RELEASE_GATE_TEST) === 0,
    releaseGateAbsentFromDeterministicEstimates: releaseGateEstimateCount === 0,
    releaseGateAbsentFromDeterministicTimeoutTiers: releaseGateTimeoutTierCount === 0,
    repositoryCrudRegisteredOnce: registeredCount('scripts/test_bi_portal_repository_crud.mjs') === 1,
    mutationQueueRegisteredOnce: registeredCount('scripts/test_bi_portal_mutation_queue.mjs') === 1,
    mutationQueueBoundedTier: /file === 'scripts\/test_bi_portal_mutation_queue\.mjs'\s*\? 120_000/.test(runner),
    ciHasExactlyOneDedicatedReleaseGateOwner: /^  release-gate:$/mu.test(releaseGateJob)
      && /^    needs: source-checks$/mu.test(releaseGateJob)
      && countLiteral(releaseGateJob, releaseGateBuildCommand) === 1
      && countLiteral(releaseGateJob, releaseGateCommand) === 1
      && releaseGateJob.indexOf(releaseGateBuildCommand) < releaseGateJob.indexOf(releaseGateCommand)
      && countLiteral(workflow, releaseGateCommand) === 1,
    terminalGateRequiresExactThreeJobsAndFailsClosed: terminalJobIsExactAndFailClosed(workflow),
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    command: 'static CI release-gate reachability check',
    args: [],
    code: ok ? 0 : 1,
    durationMs: Date.now() - startedAt,
    stdout: ok ? JSON.stringify(checks) : '',
    stderr: ok ? '' : JSON.stringify(checks),
    ok,
  };
}

async function scanStaleConfirmText() {
  const roots = ['docs', 'scripts'];
  const hits = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(path.join(ROOT, dir), {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (/\.(?:md|mjs|js)$/i.test(entry.name)) {
        const text = await fs.readFile(path.join(ROOT, rel), 'utf8').catch(() => '');
        const idx = text.indexOf(STALE_CONFIRM_TEXT);
        if (idx >= 0) hits.push({file: rel, index: idx});
      }
    }
  }
  for (const root of roots) await walk(root);
  return {ok: hits.length === 0, hits};
}

async function checkBiOpsV2DeploymentBoundary() {
  const portalUnit = await fs.readFile(path.join(ROOT, 'infra/systemd/shein-bi-portal.service'), 'utf8');
  const systemdReadme = await fs.readFile(path.join(ROOT, 'infra/systemd/README.md'), 'utf8');
  const releaseDoc = await fs.readFile(path.join(ROOT, 'docs/bi-ops-v2-release-2026-07-12.md'), 'utf8');
  const ownerSync = await fs.readFile(path.join(ROOT, 'scripts/owner_knowledge_sync.mjs'), 'utf8');
  const ownerInstaller = await fs.readFile(path.join(ROOT, 'scripts/install_owner_knowledge_sync_task.ps1'), 'utf8');
  const ownerWorkflow = await fs.readFile(path.join(ROOT, '.github/workflows/owner-knowledge.yml'), 'utf8');
  const portalSource = await fs.readFile(path.join(ROOT, 'scripts/serve_bi_portal.mjs'), 'utf8');
  const partnerCliManifest = JSON.parse(await fs.readFile(path.join(ROOT, 'config/partner_cli_package.json'), 'utf8'));
  const partnerCache = await fs.readFile(path.join(ROOT, 'lib/partner_knowledge_cache.mjs'), 'utf8');
  const ticketLock = await fs.readFile(path.join(ROOT, 'lib/cross_process_ticket_lock.mjs'), 'utf8');
  const activeLarkCommand = /^[ \t]*(?!#)systemctl\s+(?:enable|start|restart)(?:\s+--now)?[^\r\n]*shein-bi-lark-sales-qa\.service/im;
  const checks = {
    postgresRepository: /SHEIN_LINK_OPS_STORE=postgres/.test(portalUnit),
    restrictedPostgresRole: /SHEIN_WAREHOUSE_PG_USER=shein_link_ops/.test(portalUnit),
    durableJobWorker: /SHEIN_BI_JOB_WORKER_ENABLED=1/.test(portalUnit),
    boundedAgentConcurrency: /SHEIN_BI_AGENT_MAX_CONCURRENT=2/.test(portalUnit),
    tieredModelRouting: /SHEIN_BI_AGENT_MODEL_INTENT=gpt-5\.6-luna/.test(portalUnit)
      && /SHEIN_BI_AGENT_MODEL_BALANCED=gpt-5\.6-terra/.test(portalUnit)
      && /SHEIN_BI_AGENT_MODEL_DEEP=gpt-5\.6-sol/.test(portalUnit),
    githubKnowledgeDistribution: /SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR=\/srv\/shein-bi\/owner-knowledge-repo/.test(portalUnit)
      && /SHEIN_OWNER_KNOWLEDGE_GIT_BRANCH=owner-knowledge/.test(portalUnit),
    ciGatedKnowledgeActivation: /validate_owner_knowledge_distribution\.mjs/.test(ownerWorkflow)
      && /OWNER_KNOWLEDGE_ACTIVATION_TOKEN/.test(ownerWorkflow)
      && /\/api\/owner-knowledge\/distribution\/activate/.test(ownerWorkflow)
      && /activatePendingDistribution/.test(portalSource),
    serverExecuteFailsClosed: /GitHub 校验并同步到当前版本/.test(portalSource)
      && /startControlledLinkOpsExecution/.test(portalSource)
      && /withOwnerKnowledgeConsistencyLock/.test(portalSource)
      && /getOwnerKnowledgeGeneration/.test(portalSource),
    atomicPartnerKnowledgeCache: /acquireCrossProcessTicketLock/.test(partnerCache)
      && /generations/.test(partnerCache)
      && /assertManifestNotOlder/.test(partnerCache)
      && /latestPointer/.test(partnerCache)
      && /\.tickets/.test(ticketLock)
      && /process\.hrtime\.bigint/.test(ticketLock)
      && /handle\.utimes/.test(ticketLock)
      && /removeDeadStaleTicket/.test(ticketLock),
    partnerCliVersionBoundary: /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(String(partnerCliManifest.version || ''))
      && /minimumVersion:\s*process\.env\.SHEIN_BI_OPS_CLI_MIN_VERSION\s*\|\|\s*BI_OPS_CLI_VERSION/.test(portalSource)
      && !/SHEIN_BI_OPS_CLI_MIN_VERSION=/.test(portalUnit),
    eventDrivenOwnerSync: /completion-spool/.test(ownerSync)
      && /\/api\/owner-knowledge\/completions/.test(ownerSync)
      && /SHEIN-Owner-Knowledge-Completion-Uploader/.test(ownerInstaller)
      && /Unregister-ScheduledTask -TaskName \$LegacyTaskName/.test(ownerInstaller),
    larkPausedInRunbook: /shein-bi-lark-sales-qa\.service[^\r\n]*disabled\s*\+\s*inactive/i.test(systemdReadme),
    larkPausedInRelease: /shein-bi-lark-sales-qa\.service[^\r\n]*disabled\s*\+\s*inactive/i.test(releaseDoc),
    noActiveLarkStartCommand: !activeLarkCommand.test(systemdReadme) && !activeLarkCommand.test(releaseDoc),
  };
  return {ok: Object.values(checks).every(Boolean), checks};
}

async function main() {
  if (process.argv.includes('--ci-ownership-only')) {
    const sources = await Promise.all([
      fs.readFile(path.join(ROOT, 'scripts/run_deterministic_tests.mjs'), 'utf8'),
      fs.readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'),
      fs.readFile(path.join(ROOT, 'scripts/test_bi_ops_release_gate.mjs'), 'utf8'),
    ]);
    const positive = await checkDeterministicSuiteDelegation(sources);
    const smoke = "  'scripts/marketing/smoke_coupon_budget_guard.mjs',";
    if (!sources[0].includes(smoke)) throw new Error('Ownership regression smoke fixture is missing');
    const variants = [
      [sources[0].replace(smoke, ''), sources[1], sources[2]],
      [sources[0].replace(smoke, smoke + '\n' + smoke), sources[1], sources[2]],
      [sources[0].replace(smoke, smoke + "\n  'scripts/test_bi_ops_release_gate.mjs',"), sources[1], sources[2]],
      [sources[0], sources[1].replace('needs: [source-checks, deterministic-shards, release-gate]', 'needs: [source-checks, deterministic-shards]'), sources[2]],
    ];
    const negatives = await Promise.all(variants.map(variant => checkDeterministicSuiteDelegation(variant)));
    const ok = positive.ok && negatives.every(result => !result.ok);
    console.log(JSON.stringify({ok, ...JSON.parse(positive.stdout || positive.stderr), negativeCasesRejected: negatives.map(result => !result.ok)}, null, 2));
    if (!ok) process.exitCode = 1;
    return;
  }
  const results = [];
  const inventoryTestEnv = {
    ...process.env,
    SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE: path.join(
      os.tmpdir(),
      `shein-bi-release-gate-${process.pid}-${Date.now()}.lock`,
    ),
  };
  const missing = [];
  for (const rel of [...CHECK_FILES, ...BI_OPS_V2_REQUIRED_ARTIFACTS]) {
    if (!(await pathExists(rel))) missing.push(rel);
  }
  if (missing.length) {
    console.error(JSON.stringify({ok: false, error: 'Missing release-gate files', missing}, null, 2));
    process.exit(1);
  }

  for (const rel of CHECK_FILES) {
    results.push({name: `node --check ${rel}`, ...(await run(process.execPath, ['--check', rel]))});
  }
  results.push({name: 'CLI approved-binding reuse zero-upload smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_cli_reuse_approved_binding.mjs']))});
  results.push({name: 'approved-binding reuse integrity and sparse-merge smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_publish_asset_reuse_guard.mjs']))});
  results.push({name: 'shared OpenAPI client Windows guard smoke', ...(await run(process.execPath, ['scripts/test_shein_openapi_client_windows_guard.mjs']))});
  results.push({name: 'local OpenAPI boundary smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_local_openapi_boundary.mjs']))});
  results.push({name: 'cloud image asset through BI session smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_cloud_image_asset.mjs']))});
  results.push({name: 'bad transcript replay smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_bad_transcript_replay.mjs']))});
  results.push({name: 'chat maintenance flow smoke', ...(await run(
    process.execPath,
    ['scripts/test_bi_ops_chat_maintenance_flow.mjs'],
    {env: inventoryTestEnv},
  ))});
  results.push({name: 'source candidate policy smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_source_candidate_policy.mjs']))});
  results.push({name: 'OpenAPI product-detail payload mapper smoke', ...(await run(process.execPath, ['scripts/test_link_ops_product_draft_openapi_detail.mjs']))});
  results.push({name: 'account writeStores scope smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_write_whitelist_scope.mjs']))});
  results.push({name: 'production real-write safety smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_production_safety.mjs']))});
  results.push({name: 'deterministic product attribute registration and timeout guard', ...(await checkDeterministicProductAttributeRegistration())});
  results.push({name: 'copy_product_draft success lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs']))});
  results.push({name: 'copy_product_draft approved asset binding smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--asset-binding']))});
  results.push({name: 'copy_product_draft searchProduct readback smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--search-product-readback']))});
  results.push({name: 'copy_product_draft generic product lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--generic-product']))});
  results.push({name: 'copy_product_draft chat natural generic lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--generic-product', '--chat-natural']))});
  results.push({name: 'copy_product_draft pre-valid failure lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--prevalid-fail']))});
  results.push({name: 'copy_product_draft chat pre-valid retry lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--chat-natural', '--prevalid-retry']))});
  results.push({name: 'copy_product_draft weak-readback guard smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--weak-readback']))});
  results.push({name: 'copy_product_draft chat locked lifecycle guard smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--chat-natural', '--weak-readback']))});
  results.push({name: 'copy_product_draft all-stores capability smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_all_stores_capability.mjs']))});
  results.push({name: 'maintenance executor fake OpenAPI smoke', ...(await run(
    process.execPath,
    ['scripts/test_bi_ops_maintenance_executor_flow.mjs'],
    {env: inventoryTestEnv},
  ))});
  const hasSk5110LocalArtifacts = (await Promise.all(SK5110_LOCAL_ARTIFACTS.map(pathExists))).every(Boolean);
  if (hasSk5110LocalArtifacts) {
    results.push({name: 'SK-5110 batch draft static guard', ...(await run(process.execPath, ['scripts/test_sk5110_batch_draft_plan.mjs']))});
    results.push({name: 'SK-5110 cloud handoff static guard', ...(await run(process.execPath, ['scripts/test_sk5110_cloud_handoff_plan.mjs']))});
  } else {
    const missingArtifacts = [];
    for (const artifact of SK5110_LOCAL_ARTIFACTS) if (!(await pathExists(artifact))) missingArtifacts.push(artifact);
    const skipped = {code: 0, ok: true, skipped: true, durationMs: 0, reason: `local-only artifacts unavailable: ${missingArtifacts.join(', ')}`};
    results.push({name: 'SK-5110 batch draft static guard', ...skipped});
    results.push({name: 'SK-5110 cloud handoff static guard', ...skipped});
  }
  results.push({name: 'OpenAPI image asset executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_image_asset_executor.mjs']))});
  results.push({name: 'OpenAPI readonly executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_readonly_executor.mjs']))});
  results.push({name: 'OpenAPI order fulfillment executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_order_fulfillment_executor.mjs']))});
  results.push({name: 'OpenAPI catalog executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_catalog_executor.mjs']))});
  results.push({name: 'official doc detail parser smoke', ...(await run(process.execPath, ['scripts/test_shein_openapi_doc_detail_parser.mjs']))});
  results.push({name: 'maintenance readiness smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_maintenance_readiness.mjs']))});
  results.push({name: 'CI test ownership: zero runner/gate overlap and preserved owner union', ...(await checkDeterministicSuiteDelegation())});
  results.push({name: 'CI release gate reachability: dedicated sole owner and fail-closed terminal dependency', ...(await checkCiReleaseGateReachability())});

  if (await pathExists('.git')) {
    results.push({name: 'git diff --check automation scope', ...(await run('git', ['diff', '--check', '--', ...DIFF_CHECK_FILES]))});
  }

  const staleConfirm = await scanStaleConfirmText();
  const biOpsV2DeploymentBoundary = await checkBiOpsV2DeploymentBoundary();
  const ok = results.every(r => r.ok) && staleConfirm.ok && biOpsV2DeploymentBoundary.ok;
  const summary = {
    ok,
    checks: results.map(r => ({name: r.name, code: r.code, ok: r.ok, skipped: Boolean(r.skipped), reason: r.reason || '', durationMs: r.durationMs})),
    staleConfirm,
    biOpsV2DeploymentBoundary,
    notes: [
      'bad transcript replay smoke proves old Feishu/V1/read-only/task-pool assistant prose cannot pollute source/target facts, natural confirmation or user-facing browser responses',
      'chat maintenance flow smoke proves non-copy actions enter the same natural-language chat path, persist exact write claims, and never turn an identity-only probe into mutation success; only exact inventory evidence auto-closes while other fake writes remain manual-resolve',
      'source candidate policy smoke proves explicit cross-store sources are respected while same-store source links remain valid when no source is explicit',
      'OpenAPI product-detail mapper smoke proves copy_product_draft dynamically maps spu-info attributes, SKU dimensions and cost without inventing supplier_sku',
      'account scope smoke proves BI writeStores authorizes assigned stores while safeWriteOperations remains the platform action gate',
      'production safety smoke checks locked and narrow-pilot configs through temporary files only',
      'copy_product_draft success smoke uses a local fake OpenAPI server only',
      'copy_product_draft generic product smoke proves the success path is not tied to SM-505A/505-specific defaults',
      'copy_product_draft chat natural generic smoke proves create/check/natural confirm/submit/readback all run through the BI chat entry, not only task APIs',
      'copy_product_draft pre-valid smoke proves code=0/success=false is not treated as created/submitted',
      'copy_product_draft chat pre-valid retry smoke proves a later natural-language confirm can refresh a formerly failed task and continue execution in the same turn when checks pass',
      'copy_product_draft weak-readback smoke proves weak evidence cannot auto-close a write task',
      'copy_product_draft chat locked lifecycle smoke proves submitted/needs-manual-resolve tasks cannot be rechecked or resubmitted from chat',
      'copy_product_draft all-stores capability smoke proves non-HL stores can become confirmable when authorized, probed, platform-gated and inside the actor writeStores scope',
      'maintenance executor smoke uses a local fake OpenAPI server to verify activate/retire/inventory/supply-price/product-price/title/image/certificate payloads, mandatory claims, exact inventory readback and fail-closed identity-only mutation probes',
      'SK-5110 batch draft static guard proves local-only 19-store draft keeps NM/HL old-link scope, XC dopamine set, title groups and product-cover exclusion before cloud execution',
      'SK-5110 cloud handoff static guard proves the post-sample batch handoff remains local-only, keeps the HL/DX user-review gate, and requires cloud dry-run/hash before any execute',
      'SK-5110 local-only artifact guards run only when both private draft files exist; clean CI/cloud worktrees report an explicit skip instead of treating absent private tmp data as a code failure',
      'cloud image asset smoke proves bi_ops_cli image execute uses the BI session/cloud endpoint and fake OpenAPI, not local SHEIN credentials',
      'official doc detail parser smoke uses offline fixtures and never prints/saves cookies',
      'maintenance readiness smoke requires schema, per-store permission and strong readback before pilot_ready',
      'the full deterministic suite is owned by four balanced CI shards and is not nested inside this already-serial release gate',
      'all tests removed from direct release-gate execution remain registered exactly once in deterministic shards, with a zero ownership intersection and preserved union',
      'CI runs the release gate only in its dedicated release-gate job; ci-terminal exact-needs source checks, all deterministic shards and that gate and fails closed unless all three owners succeed',
      'owner knowledge distribution smokes cover event-driven local capture, GitHub-safe immutable bundles, CI-gated activation, server-side execute blocking, locked generation caches, minimum CLI version and source-metadata redaction',
      'BI Ops V2 deployment boundary requires the restricted PostgreSQL role, durable worker, bounded model routing and an explicitly paused Lark service',
      'production safety smoke asserts production-style configs remain locked unless explicitly configured; write-enabled smokes use temporary fake OpenAPI only',
      'this gate does not submit real SHEIN writes',
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) {
    for (const r of results.filter(x => !x.ok)) {
      console.error(`\n--- FAILED: ${r.name} ---`);
      if (r.stdout) console.error(r.stdout.slice(-4000));
      if (r.stderr) console.error(r.stderr.slice(-4000));
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exit(1);
});
