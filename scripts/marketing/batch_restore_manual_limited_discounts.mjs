#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STOCK_CONFIRM = 'MANUAL_SPECIAL_LIMITED_DISCOUNT_STOCK_TOP_UP';

function parseArgs(argv) {
  const args = {guard: '', outDir: '', stores: [], dryRunOnly: true, skipBuild: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else if (arg === '--execute') args.dryRunOnly = false;
    else if (arg === '--skip-build') args.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  if (!args.outDir) args.outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'manual-limited-discount-restore', date);
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

async function run(command, args, timeoutMs = 900000) {
  return await new Promise(resolve => {
    const child = spawn(command, args, {cwd: ROOT, shell: false, windowsHide: true, env: process.env});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ok: false, exitCode: null, timedOut, stdout, stderr, error: error.message}); });
    child.on('close', code => { clearTimeout(timer); resolve({ok: code === 0 && !timedOut, exitCode: code, timedOut, stdout, stderr}); });
  });
}

function lastJson(text) {
  const source = String(text || '').trim();
  for (let i = source.lastIndexOf('{'); i >= 0; i = source.lastIndexOf('{', i - 1)) {
    try { return JSON.parse(source.slice(i)); } catch {}
  }
  return null;
}

async function loadCommandOutput(result) {
  const summary = lastJson(result.stdout) || lastJson(result.stderr);
  const outPath = summary?.out ? path.resolve(ROOT, summary.out) : '';
  let full = null;
  if (outPath) {
    try { full = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { full = null; }
  }
  return {...result, summary, outPath, full};
}

async function launchStore(storeKey) {
  return await run(process.execPath, ['scripts/launch_store_browser.mjs', storeKey, '--headless'], 60000);
}

async function closeStore(storeKey) {
  return await run(process.execPath, ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'], 90000);
}

async function applyRescue(storeKey, port, rescuePath, execute) {
  return await loadCommandOutput(await run(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    execute ? '--execute' : '--dry-run',
  ], execute ? 1200000 : 900000));
}

async function removeFromMixed(storeKey, activityId, skc) {
  return await loadCommandOutput(await run(process.execPath, [
    'scripts/marketing/remove_skc_from_limited_discount.mjs',
    '--stores', storeKey,
    '--activity-id', String(activityId),
    '--skcs', skc,
    '--execute',
  ], 600000));
}

function inventoryShortage(full) {
  return (full?.validation?.invalid || []).some(row => row.reason === 'inventory below configured activity stock');
}

async function inventoryGuard(storeKey, skc, execute) {
  const args = ['scripts/marketing/manage_manual_limited_discount_inventory.mjs', '--store', storeKey, '--skc', skc];
  if (execute) args.push('--execute', '--confirm', STOCK_CONFIRM);
  else args.push('--dry-run');
  return await loadCommandOutput(await run(process.execPath, args, 600000));
}

function mixedConflicts(full) {
  return (full?.before?.conflictActivities || []).filter(activity => Number(activity.extraCount || 0) > 0);
}

function summarizeDryRun(full, outPath = '') {
  return {
    ok: full?.ok === true,
    out: outPath ? rel(outPath) : '',
    reason: full?.reason || '',
    before: full?.before || null,
    validation: full?.validation || null,
    unsafeExistingLimitedDiscounts: full?.unsafeExistingLimitedDiscounts || [],
  };
}

function assessRecoverableDryRun(full) {
  if (!full) return {ok: false, recoverable: false, reasons: ['missing dry-run artifact']};
  if (full.ok === true) return {ok: true, recoverable: false, reasons: []};

  const missing = full?.validation?.missing || [];
  const invalid = full?.validation?.invalid || [];
  const unsafe = full?.unsafeExistingLimitedDiscounts || [];
  const conflicts = mixedConflicts(full);
  const allowedInvalid = invalid.every(row => (
    row?.reason === 'inventory below configured activity stock'
    || (row?.reason === 'query_goods error_code' && row?.error_code === 'mrs-simple_platform_limit_discounts-0006')
  ));
  const allowedUnsafe = unsafe.every(row => row?.reason === 'activity contains non-target goods');
  const hasInventoryRecovery = invalid.some(row => row?.reason === 'inventory below configured activity stock');
  const hasMixedRecovery = conflicts.length > 0 && unsafe.length > 0;
  const recoverable = (
    missing.length === 0
    && allowedInvalid
    && allowedUnsafe
    && (hasInventoryRecovery || hasMixedRecovery)
  );
  const reasons = [];
  if (missing.length) reasons.push(`missing target goods: ${missing.join(',')}`);
  if (!allowedInvalid) reasons.push('dry-run contains non-recoverable platform validation errors');
  if (!allowedUnsafe) reasons.push('dry-run contains non-recoverable existing-activity conflicts');
  if (!hasInventoryRecovery && !hasMixedRecovery) reasons.push(full.reason || 'dry-run failed without an approved recovery path');
  return {ok: false, recoverable, reasons, hasInventoryRecovery, hasMixedRecovery};
}

function exactReadback(full, expectedSkc, expectedPrice) {
  const rows = (full?.after?.conflictActivities || []).flatMap(activity => activity.targetGoods || []);
  if (full?.createdActivity?.goods) rows.push(...full.createdActivity.goods);
  const exact = rows.some(row => String(row.skc || '') === expectedSkc && Math.abs(Number(row.product_act_price) - Number(expectedPrice)) <= 0.01);
  const activityId = full?.createdActivityId || (full?.after?.conflictActivities || []).find(activity => (activity.targetSkcs || []).includes(expectedSkc))?.activity_id || null;
  return {ok: exact || full?.alreadyCovered === true, activityId, rows};
}

async function updateRegistry(storeKey, skc, activityId, artifact) {
  return await run(process.execPath, [
    'scripts/marketing/manage_manual_limited_discount_override.mjs',
    'update-activity', '--store', storeKey, '--skc', skc,
    '--activity-id', String(activityId), '--readback-artifact', artifact,
  ], 30000);
}

async function processOne(file, storeMap, args) {
  const rescuePath = path.resolve(ROOT, file.path);
  const rescue = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
  const row = rescue.rows?.[0];
  const storeKey = String(rescue.storeKey || row?.storeKey || '').toUpperCase();
  const store = storeMap.get(storeKey);
  const record = {storeKey, skc: row?.skc || '', specialPrice: row?.limitedDiscountPrice, rescuePath: rel(rescuePath), dryRun: null, inventory: null, mixedRemovals: [], execute: null, readback: null, registryUpdate: null, close: null, status: 'pending', ok: false, error: ''};
  try {
    if (!store) throw new Error(`Unknown store ${storeKey}`);
    const launch = await launchStore(storeKey);
    if (!launch.ok) throw new Error(`launch failed: ${launch.stderr || launch.stdout}`);
    let dry = await applyRescue(storeKey, store.port, rescuePath, false);
    record.dryRun = summarizeDryRun(dry.full, dry.outPath);
    if (!dry.full) throw new Error('dry-run produced no readable output');
    let dryAssessment = assessRecoverableDryRun(dry.full);
    if (!dryAssessment.ok && !dryAssessment.recoverable) {
      record.status = 'dry_run_blocked';
      record.error = dryAssessment.reasons.join('; ');
      return record;
    }
    record.inventory = await inventoryGuard(storeKey, row.skc, false);
    const inventoryDecision = record.inventory.full?.decision || record.inventory.summary?.decision || null;
    if (!record.inventory.ok || !inventoryDecision?.ok) {
      record.status = 'et_inventory_blocked';
      record.error = inventoryDecision?.reason || record.inventory.stderr || 'inventory guard failed';
      return record;
    }
    if (dry.full.alreadyCovered) {
      const readback = exactReadback(dry.full, row.skc, row.limitedDiscountPrice);
      record.readback = readback;
      if (!readback.ok || !readback.activityId) throw new Error('already-covered readback did not identify exact price/activity');
      if (!args.dryRunOnly) record.registryUpdate = {ok: (await updateRegistry(storeKey, row.skc, readback.activityId, record.dryRun.out)).ok};
      record.status = 'already_covered_exact';
      record.ok = true;
      return record;
    }

    if (args.dryRunOnly) {
      record.status = dry.full.ok === true ? 'dry_run_ready' : 'dry_run_recoverable';
      record.recovery = dryAssessment;
      record.ok = true;
      return record;
    }
    if (inventoryDecision.action === 'top_up_platform_virtual_stock') {
      record.inventory = await inventoryGuard(storeKey, row.skc, true);
      if (!record.inventory.ok || record.inventory.full?.ok === false) throw new Error('platform virtual inventory top-up/readback failed');
      dry = await applyRescue(storeKey, store.port, rescuePath, false);
      if (!dry.full) throw new Error('post-stock dry-run produced no output');
      record.dryRun = summarizeDryRun(dry.full, dry.outPath);
      dryAssessment = assessRecoverableDryRun(dry.full);
      if (inventoryShortage(dry.full)) throw new Error('inventory remains below activity stock after guarded top-up path');
      if (!dryAssessment.ok && !dryAssessment.recoverable) {
        throw new Error(`post-stock dry-run has non-recoverable blockers: ${dryAssessment.reasons.join('; ')}`);
      }
    }

    for (const conflict of mixedConflicts(dry.full)) {
      const removal = await removeFromMixed(storeKey, conflict.activity_id, row.skc);
      record.mixedRemovals.push({activityId: conflict.activity_id, out: removal.outPath ? rel(removal.outPath) : '', ok: removal.full?.ok === true});
      if (!removal.full?.ok) throw new Error(`mixed activity ${conflict.activity_id} target-only removal failed`);
    }
    if (record.mixedRemovals.length) {
      dry = await applyRescue(storeKey, store.port, rescuePath, false);
      record.dryRun = summarizeDryRun(dry.full, dry.outPath);
      if (!dry.full?.ok) throw new Error(`post-mixed-removal dry-run failed: ${dry.full?.reason || ''}`);
    }
    if (inventoryShortage(dry.full)) throw new Error('inventory remains below activity stock after guarded top-up path');
    if (dry.full?.ok !== true) throw new Error(`final dry-run did not reach ok=true: ${dry.full?.reason || 'unknown blocker'}`);
    const execute = await applyRescue(storeKey, store.port, rescuePath, true);
    record.execute = {ok: execute.full?.ok === true, out: execute.outPath ? rel(execute.outPath) : '', reason: execute.full?.reason || '', createdActivityId: execute.full?.createdActivityId || null};
    if (!execute.full?.ok) throw new Error(`execute failed: ${execute.full?.reason || execute.stderr || ''}`);
    record.readback = exactReadback(execute.full, row.skc, row.limitedDiscountPrice);
    if (!record.readback.ok || !record.readback.activityId) throw new Error('execute readback did not prove exact special price/activity');
    const registry = await updateRegistry(storeKey, row.skc, record.readback.activityId, record.execute.out);
    record.registryUpdate = {ok: registry.ok, stderr: registry.stderr || ''};
    if (!registry.ok) throw new Error('registry activityId update failed after live readback');
    record.status = 'restored';
    record.ok = true;
    return record;
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    return record;
  } finally {
    const close = await closeStore(storeKey);
    record.close = {ok: close.ok, stderr: close.stderr || '', stdout: close.stdout?.slice(-1000) || ''};
  }
}

const args = parseArgs(process.argv.slice(2));
const automationAuthorization = args.dryRunOnly ? null : await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.RESTORE_MANUAL_SPECIAL,
});
await fs.mkdir(args.outDir, {recursive: true});
if (!args.skipBuild) {
  const build = await run(process.execPath, ['scripts/marketing/build_manual_limited_discount_restore_plan.mjs', '--guard', args.guard, '--out-dir', args.outDir], 120000);
  if (!build.ok) throw new Error(`restore-plan build failed: ${build.stderr || build.stdout}`);
}
const planPath = path.join(args.outDir, 'manual-limited-discount-restore-plan.json');
const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
const storesDoc = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const storeMap = new Map((storesDoc.stores || []).map(store => [String(store.storeKey || '').toUpperCase(), store]));
const filter = new Set(args.stores);
const files = (plan.rescueFiles || []).filter(file => !filter.size || filter.has(String(file.storeKey).toUpperCase()));
const results = [];
for (const file of files) results.push(await processOne(file, storeMap, args));
const output = {
  createdAt: new Date().toISOString(),
  guard: rel(args.guard),
  plan: rel(planPath),
  dryRunOnly: args.dryRunOnly,
  automationAuthorization,
  totals: {
    processed: results.length,
    restored: results.filter(row => row.status === 'restored').length,
    alreadyCovered: results.filter(row => row.status === 'already_covered_exact').length,
    blocked: results.filter(row => !row.ok).length,
  },
  results,
};
const out = path.join(args.outDir, `manual-limited-discount-restore-result-${Date.now()}.json`);
await fs.writeFile(out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ok: results.every(row => row.ok), out: rel(out), totals: output.totals}, null, 2));
if (!results.every(row => row.ok)) process.exitCode = 2;
