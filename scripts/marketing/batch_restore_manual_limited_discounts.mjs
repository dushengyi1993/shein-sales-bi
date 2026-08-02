#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';
import {loadExactManualRepairPlan} from '../../lib/marketing_repair_manifest.mjs';
import {
  activityExecutionTransactionHash,
  executeLimitedDiscountWithInventoryTransaction,
  planLimitedDiscountInventoryTransaction,
} from '../../lib/marketing_activity_inventory_integration.mjs';
import {revalidateLowEtFastSellerRescueArtifact} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {
    guard: '',
    outDir: '',
    stores: [],
    dryRunOnly: true,
    skipBuild: false,
    maxItems: 0,
    result: '',
    expectedWorkFingerprint: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else if (arg === '--execute') args.dryRunOnly = false;
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--max-items') args.maxItems = Number(argv[++i] || 0);
    else if (arg === '--result') args.result = path.resolve(argv[++i] || '');
    else if (arg === '--expected-work-fingerprint') args.expectedWorkFingerprint = String(argv[++i] || '').trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  if (!args.outDir) args.outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'manual-limited-discount-restore', date);
  if (!Number.isInteger(args.maxItems) || args.maxItems < 0) throw new Error('--max-items must be a non-negative integer');
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error('--expected-work-fingerprint must be a SHA256 hash');
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

async function readJsonIfExists(file) {
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
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
  const cleanupArgs = ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'];
  const leaseTask = String(process.env.SHEIN_BI_BROWSER_LEASE_TASK || '').trim();
  const leaseRunId = String(process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID || '').trim();
  if (leaseTask && leaseRunId) cleanupArgs.push('--owned-lease-task', leaseTask, '--owned-lease-run-id', leaseRunId);
  return await run(process.execPath, cleanupArgs, 90000);
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

async function replaceTransactionally(storeKey, port, rescuePath, execute) {
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescuePath)).digest('hex');
  return await loadCommandOutput(await run(process.execPath, [
    'scripts/marketing/replace_limited_discount_transactionally.mjs',
    '--store', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash,
    execute ? '--execute' : '--dry-run',
  ], execute ? 1200000 : 900000));
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
  const record = {storeKey, skc: row?.skc || '', specialPrice: row?.limitedDiscountPrice, rescuePath: rel(rescuePath), dryRun: null, lowEtFastSellerPricePullbackRevalidation: null, inventoryTransactionPlan: null, inventoryTransaction: null, transaction: null, execute: null, readback: null, registryUpdate: null, close: null, status: 'pending', ok: false, error: ''};
  try {
    if (!store) throw new Error(`Unknown store ${storeKey}`);
    record.lowEtFastSellerPricePullbackRevalidation = await revalidateLowEtFastSellerRescueArtifact({
      root: ROOT,
      rescue,
      reportDate: args.date,
    });
    if (!record.lowEtFastSellerPricePullbackRevalidation.ok) {
      record.status = 'manual_special_low_et_review_blocked';
      record.error = record.lowEtFastSellerPricePullbackRevalidation.reason;
      return record;
    }
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
    if (dry.full.alreadyCovered) {
      const readback = exactReadback(dry.full, row.skc, row.limitedDiscountPrice);
      record.readback = readback;
      if (!readback.ok || !readback.activityId) throw new Error('already-covered readback did not identify exact price/activity');
      if (!args.dryRunOnly) record.registryUpdate = {ok: (await updateRegistry(storeKey, row.skc, readback.activityId, record.dryRun.out)).ok};
      record.status = 'already_covered_exact';
      record.ok = true;
      return record;
    }

    const transactionHash = activityExecutionTransactionHash(
      'manual_special_limited_discount_restore',
      storeKey,
      rescuePath,
      rescue,
      dry.full?.validation || null,
    );
    if (args.dryRunOnly) {
      record.inventoryTransactionPlan = await planLimitedDiscountInventoryTransaction({
        root: ROOT,
        storeKey,
        rescue,
        preflightFull: dry.full,
        transactionHash,
      });
      if (!record.inventoryTransactionPlan.ok) {
        record.status = 'inventory_transaction_plan_blocked';
        record.error = record.inventoryTransactionPlan.blockers?.map(item => item.error || item.reason).join('; ') || 'inventory transaction plan blocked';
        return record;
      }
      record.status = dry.full.ok === true ? 'dry_run_ready' : 'dry_run_recoverable';
      record.recovery = dryAssessment;
      record.ok = true;
      return record;
    }
    const activityInventoryTransaction = await executeLimitedDiscountWithInventoryTransaction({
      root: ROOT,
      storeKey,
      rescue,
      preflightFull: dry.full,
      transactionHash,
      runSubmit: async () => await replaceTransactionally(storeKey, store.port, rescuePath, true),
      runEnrollmentReadback: async () => await applyRescue(storeKey, store.port, rescuePath, false),
    });
    record.inventoryTransaction = activityInventoryTransaction;
    const transaction = activityInventoryTransaction.commandResult;
    if (!activityInventoryTransaction.ok) {
      record.status = activityInventoryTransaction.safe === true
        ? 'inventory_transaction_or_enrollment_blocked'
        : 'inventory_transaction_restore_failed';
      record.error = activityInventoryTransaction.blockers?.map(item => item.error || item.reason).join('; ')
        || 'activity inventory transaction failed';
      return record;
    }
    record.transaction = {
      ok: transaction.full?.ok === true,
      safe: transaction.full?.safe === true,
      status: transaction.full?.status || '',
      out: transaction.outPath ? rel(transaction.outPath) : '',
      journalPath: transaction.full?.journalPath || '',
      desiredCoveredSkcs: transaction.full?.desiredCoveredSkcs || [],
      restoredCoveredSkcs: transaction.full?.compensation?.restoredCoveredSkcs || [],
      uncoveredSkcs: transaction.full?.uncoveredSkcs || [],
    };
    record.execute = record.transaction;
    if (!transaction.full) throw new Error(`transaction produced no readable output: ${transaction.stderr || transaction.stdout || ''}`);
    if (transaction.full.ok !== true) {
      record.status = String(transaction.full.status || 'transaction_failed');
      record.error = transaction.full.safe === true
        ? '目标特价未能安全替换；旧限时折扣已恢复，任务保留为待处理。'
        : `限时折扣替换失败且仍有失保 SKC：${(transaction.full.uncoveredSkcs || []).join(',') || 'unknown'}`;
      return record;
    }
    const createdActivityId = transaction.full.desiredCreate?.createdActivityId || null;
    record.readback = {
      ok: (transaction.full.desiredCoveredSkcs || []).includes(String(row.skc)),
      activityId: createdActivityId,
      rows: transaction.full.desiredCoveredSkcs || [],
    };
    if (record.readback.ok && !record.readback.activityId) {
      const finalDryRun = await applyRescue(storeKey, store.port, rescuePath, false);
      record.readback = exactReadback(finalDryRun.full, row.skc, row.limitedDiscountPrice);
    }
    if (!record.readback.ok || !record.readback.activityId) throw new Error('execute readback did not prove exact special price/activity');
    const registry = await updateRegistry(storeKey, row.skc, record.readback.activityId, record.transaction.out);
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
let automationAuthorization = null;
await fs.mkdir(args.outDir, {recursive: true});
if (!args.skipBuild) {
  const build = await run(process.execPath, ['scripts/marketing/build_manual_limited_discount_restore_plan.mjs', '--guard', args.guard, '--out-dir', args.outDir], 120000);
  if (!build.ok) throw new Error(`restore-plan build failed: ${build.stderr || build.stdout}`);
}
const planPath = path.join(args.outDir, 'manual-limited-discount-restore-plan.json');
const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
const exactPlan = await loadExactManualRepairPlan({root: ROOT, planPath, guardPath: args.guard, date});
const plan = exactPlan.plan;
const workFingerprint = exactPlan.workFingerprint;
if (args.expectedWorkFingerprint && args.expectedWorkFingerprint !== workFingerprint) {
  throw new Error(`Manual repair work fingerprint mismatch: expected=${args.expectedWorkFingerprint} actual=${workFingerprint}`);
}
automationAuthorization = args.dryRunOnly ? null : await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.RESTORE_MANUAL_SPECIAL,
  payloadHash: workFingerprint,
});
if (!args.dryRunOnly) process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH = workFingerprint;
const storesDoc = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const storeMap = new Map((storesDoc.stores || []).map(store => [String(store.storeKey || '').toUpperCase(), store]));
const filter = new Set(args.stores);
const files = (plan.rescueFiles || []).filter(file => !filter.size || filter.has(String(file.storeKey).toUpperCase()));
const resultPath = args.result || path.join(args.outDir, `manual-limited-discount-restore-result-${Date.now()}.json`);
const previous = await readJsonIfExists(resultPath);
const previousResults = previous?.workFingerprint === workFingerprint && Array.isArray(previous.results)
  ? previous.results
  : [];
const successfulByPath = new Map(previousResults
  .filter(row => row?.ok === true && row?.rescuePath)
  .map(row => [String(row.rescuePath), row]));
const pendingFiles = files.filter(file => !successfulByPath.has(String(file.path)));
const selectedFiles = args.maxItems > 0 ? pendingFiles.slice(0, args.maxItems) : pendingFiles;
const processedThisRun = [];
for (const file of selectedFiles) processedThisRun.push(await processOne(file, storeMap, args));
const resultByPath = new Map(successfulByPath);
for (const row of processedThisRun) resultByPath.set(String(row.rescuePath), row);
const results = files.map(file => resultByPath.get(String(file.path))).filter(Boolean);
const successfulPaths = new Set(results.filter(row => row?.ok === true).map(row => String(row.rescuePath)));
const remainingItems = files.filter(file => !successfulPaths.has(String(file.path))).length;
const output = {
  createdAt: new Date().toISOString(),
  guard: rel(args.guard),
  plan: rel(planPath),
  workFingerprint,
  dryRunOnly: args.dryRunOnly,
  automationAuthorization,
  totals: {
    processed: results.length,
    processedThisRun: processedThisRun.length,
    resumedItems: successfulByPath.size,
    remainingItems,
    restored: results.filter(row => row.status === 'restored').length,
    alreadyCovered: results.filter(row => row.status === 'already_covered_exact').length,
    blocked: results.filter(row => !row.ok).length,
  },
  results,
};
await writeJsonAtomic(resultPath, output);
const attemptedFailure = processedThisRun.some(row => !row.ok);
const ok = !attemptedFailure && remainingItems === 0 && results.length === files.length && results.every(row => row.ok);
console.log(JSON.stringify({ok, out: rel(resultPath), totals: output.totals}, null, 2));
if (attemptedFailure) process.exitCode = 2;
else if (remainingItems > 0) process.exitCode = 3;
