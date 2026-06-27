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
  'scripts/link_ops_hl_openapi_executor.mjs',
  'scripts/link_ops_maintenance_openapi_executor.mjs',
  'scripts/generate_bi_portal.mjs',
  'scripts/bi_app/client.js',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_write_whitelist_scope.mjs',
  'scripts/check_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_copy_product_success_flow.mjs',
  'scripts/test_bi_ops_maintenance_executor_flow.mjs',
  'scripts/verify_shein_openapi_doc_detail.mjs',
  'scripts/test_shein_openapi_doc_detail_parser.mjs',
  'scripts/check_bi_ops_maintenance_readiness.mjs',
  'scripts/test_bi_ops_maintenance_readiness.mjs',
];
const DIFF_CHECK_FILES = [
  'scripts/serve_bi_portal.mjs',
  'scripts/bi_ops_cli.mjs',
  'scripts/link_ops_hl_openapi_executor.mjs',
  'scripts/link_ops_maintenance_openapi_executor.mjs',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_write_whitelist_scope.mjs',
  'scripts/check_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_production_safety.mjs',
  'scripts/test_bi_ops_copy_product_success_flow.mjs',
  'scripts/test_bi_ops_maintenance_executor_flow.mjs',
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
  results.push({name: 'real-write whitelist scope smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_write_whitelist_scope.mjs']))});
  results.push({name: 'production real-write safety smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_production_safety.mjs']))});
  results.push({name: 'copy_product_draft success lifecycle smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs']))});
  results.push({name: 'copy_product_draft weak-readback guard smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_copy_product_success_flow.mjs', '--weak-readback']))});
  results.push({name: 'maintenance executor fake OpenAPI smoke', ...(await run(process.execPath, ['scripts/test_bi_ops_maintenance_executor_flow.mjs']))});
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
      'whitelist scope smoke enables safeWriteOperations only inside an isolated temporary portal',
      'production safety smoke checks locked and narrow-pilot configs through temporary files only',
      'copy_product_draft success smoke uses a local fake OpenAPI server only',
      'copy_product_draft weak-readback smoke proves weak evidence cannot auto-close a write task',
    'maintenance executor smoke uses a local fake OpenAPI server to verify activate/retire/inventory/supply-price/product-price/title/image/certificate payloads and readback',
      'official doc detail parser smoke uses offline fixtures and never prints/saves cookies',
      'maintenance readiness smoke requires schema, per-store permission and strong readback before pilot_ready',
      'safeWriteOperations and real-submit whitelist are asserted disabled inside smoke flows',
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
