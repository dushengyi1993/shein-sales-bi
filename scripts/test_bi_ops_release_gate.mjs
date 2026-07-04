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
const STALE_CONFIRM_TEXT = 'SHEIN_' + 'HL_OPENAPI_SUBMIT';

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

async function main() {
  const results = [];
  const missing = [];
  for (const rel of CHECK_FILES) {
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
  results.push({name: 'OpenAPI product-detail payload mapper smoke', ...(await run(process.execPath, ['scripts/test_link_ops_product_draft_openapi_detail.mjs']))});
  results.push({name: 'OpenAPI live source title enrichment smoke', ...(await run(process.execPath, ['scripts/test_link_ops_executor_live_source_titles.mjs']))});
  results.push({name: 'store identity merchant fallback smoke', ...(await run(process.execPath, ['scripts/test_shein_store_identity_merchant_fallback.mjs']))});
  results.push({name: 'real-write whitelist scope smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_write_whitelist_scope.mjs']))});
  results.push({name: 'production real-write safety smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_production_safety.mjs']))});
  results.push({name: 'copy_product_draft success lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs']))});
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
  results.push({name: 'SK-5110 batch draft static guard', ...(await run(process.execPath, ['scripts/test_sk5110_batch_draft_plan.mjs']))});
  results.push({name: 'SK-5110 cloud handoff static guard', ...(await run(process.execPath, ['scripts/test_sk5110_cloud_handoff_plan.mjs']))});
  results.push({name: 'OpenAPI image asset executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_image_asset_executor.mjs']))});
  results.push({name: 'OpenAPI readonly executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_readonly_executor.mjs']))});
  results.push({name: 'OpenAPI order fulfillment executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_order_fulfillment_executor.mjs']))});
  results.push({name: 'OpenAPI catalog executor smoke', ...(await run(process.execPath, ['scripts/test_openapi_catalog_executor.mjs']))});
  results.push({name: 'official doc detail parser smoke', ...(await run(process.execPath, ['scripts/test_shein_openapi_doc_detail_parser.mjs']))});
  results.push({name: 'maintenance readiness smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_maintenance_readiness.mjs']))});

  if (await pathExists('.git')) {
    results.push({name: 'git diff --check automation scope', ...(await run('git', ['diff', '--check', '--', ...DIFF_CHECK_FILES]))});
  }

  const staleConfirm = await scanStaleConfirmText();
  const ok = results.every(r => r.ok) && staleConfirm.ok;
  const summary = {
    ok,
    checks: results.map(r => ({name: r.name, code: r.code, ok: r.ok, durationMs: r.durationMs})),
    staleConfirm,
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
      'OpenAPI product-detail mapper smoke proves copy_product_draft dynamically maps spu-info attributes, SKU dimensions and cost without inventing supplier_sku',
      'OpenAPI live source title enrichment smoke proves stale source caches missing Arabic titles are repaired from official spu-info before publish validation',
      'store identity merchant fallback smoke proves merchant-only OpenAPI identity is accepted only when static truth matches and no GS/merchant conflicts exist',
      'whitelist scope smoke enables safeWriteOperations only inside an isolated temporary portal',
      'production safety smoke checks locked and narrow-pilot configs through temporary files only',
      'copy_product_draft success smoke uses a local fake OpenAPI server only',
      'copy_product_draft generic product smoke proves the success path is not tied to SM-505A/505-specific defaults',
      'copy_product_draft chat natural generic smoke proves create/check/natural confirm/submit/readback all run through the BI chat entry, not only task APIs',
      'copy_product_draft pre-valid smoke proves code=0/success=false is not treated as created/submitted',
      'copy_product_draft chat pre-valid retry smoke proves a later natural-language confirm can refresh a formerly failed task and continue execution in the same turn when checks pass',
      'copy_product_draft weak-readback smoke proves weak evidence cannot auto-close a write task',
      'copy_product_draft chat locked lifecycle smoke proves submitted/needs-manual-resolve tasks cannot be rechecked or resubmitted from chat',
      'copy_product_draft all-stores capability smoke proves non-HL stores can become confirmable when authorized, probed, gated and whitelisted',
      'maintenance executor smoke uses a local fake OpenAPI server to verify activate/retire/inventory/supply-price/product-price/title/image/certificate payloads and readback',
      'local image role planner smoke proves 本地图包规划 only scans files and does not upload or submit SHEIN writes',
      'SK-5110 batch draft static guard proves local-only 19-store draft keeps NM/HL old-link scope, XC dopamine set, title groups and product-cover exclusion before cloud execution',
      'SK-5110 cloud handoff static guard proves the post-sample batch handoff remains local-only, keeps the HL/DX user-review gate, and requires cloud dry-run/hash before any execute',
      'cloud image asset smoke proves bi_ops_cli image execute uses the BI session/cloud endpoint and fake OpenAPI, not local SHEIN credentials',
      'official doc detail parser smoke uses offline fixtures and never prints/saves cookies',
      'maintenance readiness smoke requires schema, per-store permission and strong readback before pilot_ready',
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
