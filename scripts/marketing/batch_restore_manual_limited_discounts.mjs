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
  classifyActivityInventoryFailureStatus,
  executeLimitedDiscountWithInventoryTransaction,
  planLimitedDiscountInventoryTransaction,
} from '../../lib/marketing_activity_inventory_integration.mjs';
import {createMarketingActivityInventoryOpenApiAdapter} from '../../lib/marketing_activity_inventory_openapi.mjs';
import {revalidateLowEtFastSellerRescueArtifact} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {
  classifyUnifiedLoginRecovery,
  hasConcreteStoreIdentityConflict,
  isMarketingLoginRedirect,
} from '../../lib/marketing_unified_login_recovery_contract.mjs';
import {
  assertBeforeOuter,
  assertCanStartUnit,
  boundedRecoveryTimeoutMs,
  boundedTimeoutMs,
  createDeadlineContract,
  deadlineBoundAdapterFactory,
  findPersistedMarketingTransactionContinuation,
  isMarketingDeadlineError,
} from '../../lib/cloud_marketing_deadline_contract.mjs';

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
    gracefulCutoffEpochRaw: '',
    outerHardDeadlineEpochRaw: '',
    continuation: false,
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
    else if (arg === '--graceful-cutoff-epoch') args.gracefulCutoffEpochRaw = String(argv[++i] || '').trim();
    else if (arg === '--outer-hard-deadline-epoch') args.outerHardDeadlineEpochRaw = String(argv[++i] || '').trim();
    else if (arg === '--continuation') args.continuation = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  if (!args.outDir) args.outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'manual-limited-discount-restore', date);
  if (!Number.isInteger(args.maxItems) || args.maxItems < 0) throw new Error('--max-items must be a non-negative integer');
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error('--expected-work-fingerprint must be a SHA256 hash');
  }
  if (args.continuation && args.dryRunOnly) throw new Error('--continuation requires --execute');
  args.date = date;
  args.deadline = createDeadlineContract({
    gracefulCutoffEpoch: args.gracefulCutoffEpochRaw,
    outerHardDeadlineEpoch: args.outerHardDeadlineEpochRaw,
  });
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

let ACTIVE_DEADLINE = null;

function deadlineTimeout(timeoutMs, {recovery = false, label = 'bounded operation'} = {}) {
  if (!ACTIVE_DEADLINE) return timeoutMs;
  return recovery
    ? boundedRecoveryTimeoutMs(ACTIVE_DEADLINE, {capMs: timeoutMs, label})
    : boundedTimeoutMs(ACTIVE_DEADLINE, {capMs: timeoutMs, label});
}

async function runBounded(command, args, timeoutMs, options = {}) {
  return await run(command, args, deadlineTimeout(timeoutMs, options));
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
  return await runBounded(process.execPath, ['scripts/launch_store_browser.mjs', storeKey, '--headless'], 60000, {
    label: `launch ${storeKey}`,
  });
}

async function closeStore(storeKey) {
  const cleanupArgs = ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'];
  const leaseTask = String(process.env.SHEIN_BI_BROWSER_LEASE_TASK || '').trim();
  const leaseRunId = String(process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID || '').trim();
  if (leaseTask && leaseRunId) cleanupArgs.push('--owned-lease-task', leaseTask, '--owned-lease-run-id', leaseRunId);
  return await run(process.execPath, cleanupArgs, 90000);
}

async function applyRescue(storeKey, port, rescuePath, execute, {recovery = false} = {}) {
  return await loadCommandOutput(await runBounded(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    execute ? '--execute' : '--dry-run',
  ], execute ? 1200000 : 900000, {
    recovery,
    label: `${execute ? 'inventory restore/readback' : 'inventory preflight'} ${storeKey}`,
  }));
}

function reportPathFromOutput(text, field) {
  const summary = lastJson(text);
  const value = String(summary?.[field] || '').trim();
  return value ? path.resolve(ROOT, value) : '';
}

async function recoverMarketingLogin(storeKey, date) {
  const reloginRun = await runBounded(process.execPath, [
    'scripts/auto_relogin_shein_store.mjs',
    storeKey,
    '--date', date,
    '--headless',
    '--require-marketing',
  ], 240000, {label: `login recovery ${storeKey}`});
  const reloginPath = reportPathFromOutput(reloginRun.stdout, 'reportFile');
  const reloginReport = await readJsonIfExists(reloginPath);
  const relogin = reloginReport?.results?.find(row => String(row?.storeKey || '').toUpperCase() === storeKey)
    || {ok: reloginRun.ok, blocker: '', blockerReason: reloginRun.stderr || ''};
  if (relogin.ok !== true) {
    return {
      ok: false,
      relogin: {ok: false, blocker: relogin.blocker || '', reason: relogin.blockerReason || relogin.reason || ''},
      identity: null,
      assessment: classifyUnifiedLoginRecovery({relogin}),
    };
  }

  const identityRun = await runBounded(process.execPath, [
    'scripts/marketing/check_store_profile_identity.mjs',
    '--stores', storeKey,
    '--no-launch',
    '--no-close',
    '--no-login-recovery',
  ], 180000, {label: `identity readback ${storeKey}`});
  const identityMatch = String(identityRun.stdout || '').match(/^JSON\s+(.+)$/m);
  const identityReport = await readJsonIfExists(identityMatch?.[1] ? path.resolve(identityMatch[1].trim()) : '');
  const identityRow = identityReport?.rows?.find(row => String(row?.storeKey || '').toUpperCase() === storeKey) || null;
  const identity = {
    ok: identityRun.ok && identityRow?.ok === true,
    mismatch: hasConcreteStoreIdentityConflict(identityRow),
    reason: identityRow?.reason || identityRun.stderr || 'identity audit did not return an exact store match',
  };
  return {
    ok: identity.ok,
    relogin: {ok: true, blocker: '', reason: ''},
    identity,
    assessment: classifyUnifiedLoginRecovery({relogin, identity}),
  };
}

async function replaceTransactionally(storeKey, port, rescuePath, execute, continuation = false, sourceRescuePath = rescuePath) {
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescuePath)).digest('hex');
  const sourceRescueHash = crypto.createHash('sha256').update(await fs.readFile(sourceRescuePath)).digest('hex');
  const deadlineArgs = execute && ACTIVE_DEADLINE ? [
    '--graceful-cutoff-epoch', String(ACTIVE_DEADLINE.gracefulCutoffEpoch),
    '--outer-hard-deadline-epoch', String(ACTIVE_DEADLINE.outerHardDeadlineEpoch),
    '--min-finalization-budget-sec', String(ACTIVE_DEADLINE.minFinalizationBudgetSec),
  ] : [];
  return await loadCommandOutput(await runBounded(process.execPath, [
    'scripts/marketing/replace_limited_discount_transactionally.mjs',
    '--store', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash,
    '--source-rescue', sourceRescuePath,
    '--expected-source-rescue-hash', sourceRescueHash,
    ...deadlineArgs,
    ...(execute && continuation ? ['--continuation'] : []),
    execute ? '--execute' : '--dry-run',
  ], execute ? 1200000 : 900000, {
    recovery: execute,
    label: `${execute ? 'activity submit' : 'activity dry-run'} ${storeKey}`,
  }));
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
  assertBeforeOuter(ACTIVE_DEADLINE, {label: `manual registry update ${storeKey}::${skc}`});
  return await runBounded(process.execPath, [
    'scripts/marketing/manage_manual_limited_discount_override.mjs',
    'update-activity', '--store', storeKey, '--skc', skc,
    '--activity-id', String(activityId), '--readback-artifact', artifact,
  ], 30000, {label: `manual registry update ${storeKey}::${skc}`});
}

async function processOne(file, storeMap, args, browserSession = {}) {
  const keepOpen = Boolean(browserSession.keepOpen);
  const rescuePath = path.resolve(ROOT, file.path);
  const rescue = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
  const row = rescue.rows?.[0];
  const storeKey = String(rescue.storeKey || row?.storeKey || '').toUpperCase();
  const store = storeMap.get(storeKey);
  const record = {storeKey, skc: row?.skc || '', specialPrice: row?.limitedDiscountPrice, rescuePath: rel(rescuePath), dryRun: null, lowEtFastSellerPricePullbackRevalidation: null, inventoryTransactionPlan: null, inventoryTransaction: null, transaction: null, execute: null, readback: null, registryUpdate: null, close: null, status: 'pending', ok: false, terminalBlocked: false, recoverableDeferred: false, error: ''};
  try {
    assertCanStartUnit(ACTIVE_DEADLINE, {
      continuation: args.continuation,
      label: `manual limited-discount item ${storeKey}::${row?.skc || ''}`,
    });
    if (!store) throw new Error(`Unknown store ${storeKey}`);
    if (args.continuation) {
      const persisted = await findPersistedMarketingTransactionContinuation({
        root: ROOT,
        storeKey,
        workFingerprint: args.expectedWorkFingerprint || process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH,
        rescuePath,
      });
      if (!persisted) {
        record.status = 'deadline_deferred';
        record.deferred = true;
        record.recoverableDeferred = true;
        record.error = 'continuation mode found no persisted transaction; no new item was started';
        return record;
      }
      record.persistedContinuation = rel(persisted.file);
    }
    record.lowEtFastSellerPricePullbackRevalidation = await revalidateLowEtFastSellerRescueArtifact({
      root: ROOT,
      rescue,
      reportDate: args.date,
    });
    if (!record.lowEtFastSellerPricePullbackRevalidation.ok) {
      record.status = 'manual_special_low_et_review_blocked';
      record.terminalBlocked = true;
      record.error = record.lowEtFastSellerPricePullbackRevalidation.reason;
      return record;
    }
    const launch = (browserSession?.launchSummary) || await launchStore(storeKey);
    if (!launch.ok) throw new Error(`launch failed: ${launch.stderr || launch.stdout}`);
    let dry = await applyRescue(storeKey, store.port, rescuePath, false);
    if (isMarketingLoginRedirect(dry)) {
      const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
      const recovery = await recoverMarketingLogin(storeKey, date);
      record.loginRecovery = recovery;
      if (recovery.assessment.terminal) {
        record.status = 'login_terminal_blocker';
        record.classification = 'login_terminal_blocker';
        record.terminalBlocked = true;
        record.terminal = true;
        record.writeAttempted = false;
        record.error = recovery.assessment.blocker;
        return record;
      }
      if (!recovery.ok) {
        record.status = 'recoverable_login_pending';
        record.classification = 'recoverable_pending';
        record.recoverableDeferred = true;
        record.deferred = true;
        record.writeAttempted = false;
        record.error = recovery.assessment.blocker || 'login recovery incomplete';
        return record;
      }
      dry = await applyRescue(storeKey, store.port, rescuePath, false);
      const retryAssessment = classifyUnifiedLoginRecovery({
        relogin: recovery.relogin,
        identity: recovery.identity,
        retry: dry,
      });
      record.loginRecovery = {...recovery, retryAssessment};
      if (isMarketingLoginRedirect(dry)) {
        record.status = 'recoverable_login_pending';
        record.classification = 'recoverable_pending';
        record.recoverableDeferred = true;
        record.deferred = true;
        record.writeAttempted = false;
        record.error = retryAssessment.blocker || 'login redirect remained after one controlled recovery';
        return record;
      }
    }
    record.dryRun = summarizeDryRun(dry.full, dry.outPath);
    if (!dry.full) throw new Error('dry-run produced no readable output');
    let dryAssessment = assessRecoverableDryRun(dry.full);
    if (!dryAssessment.ok && !dryAssessment.recoverable) {
      record.status = 'dry_run_blocked';
      record.terminalBlocked = true;
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
        record.terminalBlocked = true;
        record.error = record.inventoryTransactionPlan.blockers?.map(item => item.error || item.reason).join('; ') || 'inventory transaction plan blocked';
        return record;
      }
      record.status = dry.full.ok === true ? 'dry_run_ready' : 'dry_run_recoverable';
      record.recovery = dryAssessment;
      record.ok = true;
      return record;
    }
    assertCanStartUnit(ACTIVE_DEADLINE, {
      continuation: args.continuation,
      label: `manual inventory transaction ${storeKey}::${row.skc}`,
    });
    const activityInventoryTransaction = await executeLimitedDiscountWithInventoryTransaction({
      root: ROOT,
      storeKey,
      rescue,
      preflightFull: dry.full,
      transactionHash,
      adapterFactory: deadlineBoundAdapterFactory(createMarketingActivityInventoryOpenApiAdapter, ACTIVE_DEADLINE, {
        label: `manual inventory ${storeKey}::${row.skc}`,
      }),
      readMutationEvidence: () => readLimitedDiscountMutationEvidence({root: ROOT, storeKey, sourceRescuePath: rescuePath}),
      runSubmit: async () => {
        assertBeforeOuter(ACTIVE_DEADLINE, {
          reserveSec: ACTIVE_DEADLINE?.minFinalizationBudgetSec || 0,
          label: `manual activity submit ${storeKey}::${row.skc}`,
        });
        return await replaceTransactionally(storeKey, store.port, rescuePath, true, args.continuation);
      },
      runEnrollmentReadback: async context => await applyRescue(
        storeKey,
        store.port,
        rescuePath,
        false,
        {recovery: context?.phase === 'after_submit_without_inventory_transaction'
          || context?.phase === 'after_submit_before_restore'
          || context?.phase === 'after_restore'},
      ),
    });
    record.inventoryTransaction = activityInventoryTransaction;
    const transaction = activityInventoryTransaction.commandResult;
    if (!activityInventoryTransaction.ok) {
      record.status = classifyActivityInventoryFailureStatus(activityInventoryTransaction);
      const deadlineDeferred = (activityInventoryTransaction.blockers || [])
        .some(blocker => isMarketingDeadlineError({
          code: blocker?.code,
          message: blocker?.error || blocker?.reason,
        }));
      record.deferred = deadlineDeferred;
      record.recoverableDeferred = deadlineDeferred;
      record.terminalBlocked = !deadlineDeferred && (activityInventoryTransaction.safe === true
        || activityInventoryTransaction.writeAttempted !== true);
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
      writeAttempted: transaction.full?.writeAttempted === true,
      mutationsStarted: transaction.full?.mutationsStarted === true,
      submittedWithoutExactReadback: transaction.full?.submittedWithoutExactReadback === true
        || transaction.full?.classification === 'submitted_without_exact_readback',
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
      const finalDryRun = await applyRescue(storeKey, store.port, rescuePath, false, {recovery: true});
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
    if (isMarketingDeadlineError(error)) {
      record.status = 'deadline_deferred';
      record.classification = 'recoverable_pending';
      record.deferred = true;
      record.recoverableDeferred = true;
    } else {
      record.status = 'failed';
    }
    record.error = error.message;
    return record;
  } finally {
    if (!keepOpen) {
      const close = await closeStore(storeKey);
      record.close = {ok: close.ok, stderr: close.stderr || '', stdout: close.stdout?.slice(-1000) || ''};
    } else {
      record.close = {ok: true, keptOpenForNextItem: true};
    }
  }
}

export function hasManualSubmittedPendingEvidence(result) {
  return result?.classification === 'submitted_without_exact_readback'
    || result?.status === 'submitted_without_exact_readback'
    || result?.inventoryTransaction?.submitAttempted === true
    || result?.transaction?.writeAttempted === true
    || result?.transaction?.mutationsStarted === true
    || result?.execute?.writeAttempted === true
    || result?.execute?.mutationsStarted === true
    || Number(result?.readback?.activityId || 0) > 0;
}

export function normalizeManualResumeResult(result) {
  if (!result || result.ok === true || result.terminalBlocked === true
    || !hasManualSubmittedPendingEvidence(result)) return result;
  return {
    ...result,
    ok: false,
    terminal: true,
    terminalBlocked: true,
    deferred: false,
    recoverableDeferred: false,
    writeAttempted: true,
    status: 'submitted_without_exact_readback',
    classification: 'submitted_without_exact_readback',
  };
}

export function isManualResumeResultSettled(result) {
  return result?.ok === true
    || result?.terminalBlocked === true
    || result?.classification === 'submitted_without_exact_readback';
}

export function manualResultDocumentMatches(previous, workFingerprint, dryRunOnly) {
  return previous?.workFingerprint === workFingerprint
    && previous?.dryRunOnly === dryRunOnly
    && Array.isArray(previous?.results);
}

export async function runManualRestoreBatch(customArgs, customOverrides = {}) {
  const args = customArgs || parseArgs(process.argv.slice(2));
  ACTIVE_DEADLINE = args.deadline;
  const effectiveLaunchStore = customOverrides.launchStore || launchStore;
  const effectiveCloseStore = customOverrides.closeStore || closeStore;
  const effectiveProcessOne = customOverrides.processOne || processOne;
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
const previousResults = manualResultDocumentMatches(previous, workFingerprint, args.dryRunOnly)
  ? previous.results.map(normalizeManualResumeResult)
  : [];
const settledByPath = new Map(previousResults
  .filter(row => isManualResumeResultSettled(row) && row?.rescuePath)
  .map(row => [String(row.rescuePath), row]));
const pendingFiles = files.filter(file => !settledByPath.has(String(file.path)));
let continuationFiles = pendingFiles;
if (args.continuation) {
  continuationFiles = [];
  for (const file of pendingFiles) {
    const persisted = await findPersistedMarketingTransactionContinuation({
      root: ROOT,
      storeKey: file.storeKey,
      workFingerprint,
      rescuePath: path.resolve(ROOT, file.path),
    });
    if (persisted) continuationFiles.push(file);
  }
}
const continuationDeferredWithoutMatch = args.continuation && pendingFiles.length > 0 && continuationFiles.length === 0;
const selectedFiles = args.maxItems > 0 ? continuationFiles.slice(0, args.maxItems) : continuationFiles;
// Sequence by storeKey so consecutive items for the same store reuse one Chrome session
const filesByStore = new Map();
for (const file of selectedFiles) {
  const sk = String(file.storeKey || '').toUpperCase();
  if (!filesByStore.has(sk)) filesByStore.set(sk, []);
  filesByStore.get(sk).push(file);
}

const processedThisRun = [];
for (const [storeKey, storeFiles] of filesByStore.entries()) {
  let launchSummary = null;
  try {
    launchSummary = await effectiveLaunchStore(storeKey);
    for (let i = 0; i < storeFiles.length; i += 1) {
      const file = storeFiles[i];
      const res = await effectiveProcessOne(file, storeMap, args, {keepOpen: true, launchSummary});
      processedThisRun.push(normalizeManualResumeResult(res));
    }
  } finally {
    await effectiveCloseStore(storeKey).catch(() => null);
  }
}
const resultByPath = new Map(settledByPath);
for (const row of processedThisRun) resultByPath.set(String(row.rescuePath), row);
const results = files.map(file => resultByPath.get(String(file.path))).filter(Boolean);
const settledPaths = new Set(results
  .filter(isManualResumeResultSettled)
  .map(row => String(row.rescuePath)));
const remainingItems = files.filter(file => !settledPaths.has(String(file.path))).length;
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
    resumedItems: settledByPath.size,
    remainingItems,
    restored: results.filter(row => row.status === 'restored').length,
    alreadyCovered: results.filter(row => row.status === 'already_covered_exact').length,
    blocked: results.filter(row => !row.ok).length,
    deadlineDeferred: processedThisRun.filter(row => row.deferred === true).length + (continuationDeferredWithoutMatch ? 1 : 0),
    recoverableDeferred: processedThisRun.filter(row => row.recoverableDeferred === true).length,
    terminalBlocked: processedThisRun.filter(row => row.terminalBlocked === true).length,
  },
  processedThisRunResults: processedThisRun,
  results,
};
await writeJsonAtomic(resultPath, output);
const deadlineDeferred = continuationDeferredWithoutMatch || processedThisRun.some(row => row.deferred === true);
const recoverableDeferred = processedThisRun.some(row => row.recoverableDeferred === true);
const attemptedFailure = processedThisRun.some(row => !row.ok && !row.deferred && !row.terminalBlocked);
const ok = !attemptedFailure && remainingItems === 0 && results.length === files.length && results.every(row => row.ok);
console.log(JSON.stringify({ok, out: rel(resultPath), totals: output.totals}, null, 2));
  if (attemptedFailure) process.exitCode = 2;
  else if (deadlineDeferred || recoverableDeferred) process.exitCode = 4;
  else if (remainingItems > 0) process.exitCode = 3;
  return {ok, output, results, processedThisRun};
}
if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('batch_restore_manual_limited_discounts.mjs')) {
  runManualRestoreBatch().catch(err => { console.error(err); process.exit(1); });
}
