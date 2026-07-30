#!/usr/bin/env node
/**
 * Release gate for the SHEIN BI automation workbench.
 *
 * This is intentionally conservative and side-effect-light: the flow tests
 * start isolated local portal instances with temporary auth/task/audit files;
 * they do not touch production tasks and do not enable real SHEIN writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_FILES = [
  'scripts/serve_bi_portal.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/bi_ops_cli.mjs',
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
];
const DIFF_CHECK_FILES = [
  'scripts/serve_bi_portal.mjs',
  'scripts/test_portal_security.mjs',
  'infra/nginx/shein-bi.conf',
  'infra/caddy/Caddyfile.shein-bi',
  'scripts/bi_ops_cli.mjs',
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
  'docs/partner-codex-ops-setup.md',
  'docs/bi-ops-openapi-automation-plan.md',
  'docs/shein-openapi-integration.md',
];
const BI_OPS_V2_JS_FILES = [
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
  'scripts/owner_knowledge_sync.mjs',
  'scripts/owner_knowledge_admin.mjs',
  'scripts/validate_owner_knowledge_distribution.mjs',
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
  'scripts/build_partner_cli_deploy_payload.mjs',
  'scripts/verify_partner_cli_package_artifact.mjs',
  'scripts/partner_cli_bootstrap.mjs',
  'scripts/test_link_ops_publish_asset_binding.mjs',
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

function run(command, args, {allowFailure = false} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
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
    partnerCliVersionBoundary: /SHEIN_BI_OPS_CLI_MIN_VERSION=2026\.07\.12\.1/.test(portalUnit),
    eventDrivenOwnerSync: /fsSync\.watch\(/.test(ownerSync)
      && /debounceSeconds:\s*15/.test(ownerSync)
      && /reconcileSeconds:\s*60\s*\*\s*60/.test(ownerSync)
      && /ReconcileMinutes\s*=\s*60/.test(ownerInstaller),
    larkPausedInRunbook: /shein-bi-lark-sales-qa\.service[^\r\n]*disabled\s*\+\s*inactive/i.test(systemdReadme),
    larkPausedInRelease: /shein-bi-lark-sales-qa\.service[^\r\n]*disabled\s*\+\s*inactive/i.test(releaseDoc),
    noActiveLarkStartCommand: !activeLarkCommand.test(systemdReadme) && !activeLarkCommand.test(releaseDoc),
  };
  return {ok: Object.values(checks).every(Boolean), checks};
}

async function main() {
  const results = [];
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
  results.push({name: 'permission matrix smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_permissions.mjs']))});
  results.push({name: 'portal security and TLS proxy-chain config smoke', ...(await run(process.execPath, ['scripts/test_portal_security.mjs']))});
  results.push({name: 'CLI flow smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_cli_flow.mjs']))});
  results.push({name: 'shared OpenAPI client Windows guard smoke', ...(await run(process.execPath, ['scripts/test_shein_openapi_client_windows_guard.mjs']))});
  results.push({name: 'local OpenAPI boundary smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_local_openapi_boundary.mjs']))});
  results.push({name: 'cloud image asset through BI session smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_cloud_image_asset.mjs']))});
  results.push({name: 'chat inference smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_chat_inference.mjs']))});
  results.push({name: 'bad transcript replay smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_bad_transcript_replay.mjs']))});
  results.push({name: 'chat action matrix smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_chat_action_matrix.mjs']))});
  results.push({name: 'chat maintenance flow smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_chat_maintenance_flow.mjs']))});
  results.push({name: 'task projection smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_task_projection.mjs']))});
  results.push({name: 'ops frontend confirm feedback smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_frontend_confirm_feedback.mjs']))});
  results.push({name: 'ops portal shell sync smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_portal_shell_sync.mjs']))});
  results.push({name: 'source candidate policy smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_source_candidate_policy.mjs']))});
  results.push({name: 'preflight product source/date lock smoke', ...(await run(process.execPath, ['scripts/test_link_ops_preflight_product_lock.mjs']))});
  results.push({name: 'OpenAPI product-detail payload mapper smoke', ...(await run(process.execPath, ['scripts/test_link_ops_product_draft_openapi_detail.mjs']))});
  results.push({name: 'OpenAPI live source title enrichment smoke', ...(await run(process.execPath, ['scripts/test_link_ops_executor_live_source_titles.mjs']))});
  results.push({name: 'link retire candidate 15-day guard smoke', ...(await run(process.execPath, ['scripts/test_link_retire_candidate_policy.mjs']))});
  results.push({name: 'link retire candidate CSV report smoke', ...(await run(process.execPath, ['scripts/test_link_retire_candidates_from_csv.mjs']))});
  results.push({name: 'retire supplier-code repair payload smoke', ...(await run(process.execPath, ['scripts/test_retire_supplier_code_repair_payload.mjs']))});
  results.push({name: 'store identity merchant fallback smoke', ...(await run(process.execPath, ['scripts/test_shein_store_identity_merchant_fallback.mjs']))});
  results.push({name: 'account writeStores scope smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_write_whitelist_scope.mjs']))});
  results.push({name: 'production real-write safety smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_production_safety.mjs']))});
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
  results.push({name: 'maintenance executor fake OpenAPI smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_maintenance_executor_flow.mjs']))});
  results.push({name: 'local image role planner smoke', ...(await run(process.execPath, ['scripts/test_link_ops_image_role_planner.mjs']))});
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
  results.push({name: 'deterministic BI Ops V2 suite', ...(await run(process.execPath, ['scripts/run_deterministic_tests.mjs']))});

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
      'permission and CLI flow smokes use isolated temporary auth/task/audit files',
      'chat inference smoke proves one chat send can create a current-session same-store copy task without calling the LLM or SHEIN',
      'bad transcript replay smoke proves old Feishu/V1/read-only/task-pool assistant prose cannot pollute source/target facts, natural confirmation or user-facing browser responses',
      'chat action matrix smoke proves copy, shelf, title, image, inventory, price and certificate commands all enter the same BI chat state machine through askAgent=true',
      'chat maintenance flow smoke proves non-copy actions enter the same natural-language chat path, then natural confirmation can execute against an isolated fake OpenAPI server and read back success',
      'task projection smoke proves the automation page receives only safe task progress summaries, not historical internals, confirm tokens or old cross-entry wording',
      'ops frontend confirm feedback smoke proves the page stays chat-only, slow actions show busy feedback, task evidence is summarized, and Markdown rendering has readable structure',
      'ops portal shell sync smoke proves the generated production HTML carries the current-session task filtering and no stale global task loader',
      'source candidate policy smoke proves explicit cross-store sources are respected while same-store source links remain valid when no source is explicit',
      'preflight product source/date lock smoke proves execute reuses the source link and scheduled date approved during dry-run, including recovery from a later blocked run',
      'OpenAPI product-detail mapper smoke proves copy_product_draft dynamically maps spu-info attributes, SKU dimensions and cost without inventing supplier_sku',
      'OpenAPI live source title enrichment smoke proves stale source caches missing Arabic titles are repaired from official spu-info before publish validation',
      'link retire candidate smoke proves low-exposure zero-sales candidates exclude first-shelf links inside the fixed 15-day protection window even when newGoodsTag is empty',
      'link retire CSV report smoke proves the batch confirmation table uses the same 15-day and newGoodsTag guards and does not submit writes',
      'retire supplier-code repair smoke proves failed waste-code partialEdit is not counted as done, repair mode never emits shelf payloads, FY/SK-5110 stays hard-excluded, and payloads fill required attributes/titles without local OpenAPI',
      'store identity merchant fallback smoke proves merchant-only OpenAPI identity is accepted only when static truth matches and no GS/merchant conflicts exist',
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
      'maintenance executor smoke uses a local fake OpenAPI server to verify activate/retire/inventory/supply-price/product-price/title/image/certificate payloads and readback',
      'local image role planner smoke proves 本地图包规划 only scans files and does not upload or submit SHEIN writes',
      'SK-5110 batch draft static guard proves local-only 19-store draft keeps NM/HL old-link scope, XC dopamine set, title groups and product-cover exclusion before cloud execution',
      'SK-5110 cloud handoff static guard proves the post-sample batch handoff remains local-only, keeps the HL/DX user-review gate, and requires cloud dry-run/hash before any execute',
      'SK-5110 local-only artifact guards run only when both private draft files exist; clean CI/cloud worktrees report an explicit skip instead of treating absent private tmp data as a code failure',
      'cloud image asset smoke proves bi_ops_cli image execute uses the BI session/cloud endpoint and fake OpenAPI, not local SHEIN credentials',
      'official doc detail parser smoke uses offline fixtures and never prints/saves cookies',
      'maintenance readiness smoke requires schema, per-store permission and strong readback before pilot_ready',
      'deterministic BI Ops V2 suite covers PostgreSQL repositories, migration compatibility, durable jobs, intent planning, model governance, account isolation, CLI and frontend projections',
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
