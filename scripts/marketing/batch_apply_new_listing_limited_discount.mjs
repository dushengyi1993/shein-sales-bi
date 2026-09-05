#!/usr/bin/env node
/**
 * Build and apply the new-listing 7-day limited-discount fallback plan.
 *
 * This is the write-side companion for build_marketing_daily_guard_report.mjs.
 * It is intentionally fail-closed: every store is dry-run first; only a clean
 * dry-run is executed. Mixed/unsafe existing limited-discount activities,
 * platform blocks, login/identity failures, or query_goods errors are recorded
 * and not forced.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  applyManualLimitedDiscountOverride,
  buildManualLimitedDiscountIndex,
  loadManualLimitedDiscountRegistry,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';
import {
  countBlockedFallbackTargets,
  fallbackBatchExitCode,
  isResumableFallbackResult,
} from '../../lib/marketing_bounded_batch_resume.mjs';
import {loadExactFallbackRepairPlan} from '../../lib/marketing_repair_manifest.mjs';
import {readLimitedDiscountMutationEvidence} from '../../lib/marketing_transaction_attempt_evidence.mjs';
import {
  activityExecutionTransactionHash,
  classifyActivityInventoryFailureStatus,
  executeLimitedDiscountWithInventoryTransaction,
  planLimitedDiscountInventoryTransaction,
} from '../../lib/marketing_activity_inventory_integration.mjs';
import {createMarketingActivityInventoryOpenApiAdapter} from '../../lib/marketing_activity_inventory_openapi.mjs';
import {revalidateLowEtFastSellerRescueArtifact} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {classifyUnifiedLoginRecovery, isMarketingLoginRedirect} from '../../lib/marketing_unified_login_recovery_contract.mjs';
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
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MIN_START_BUDGET_SEC = 15 * 60;

function parseArgs(argv) {
  const args = {
    date: '',
    guard: '',
    priceOverrides: '',
    currentMarketingLiveScan: '',
    outDir: DEFAULT_OUT_DIR,
    stores: [],
    dryRunOnly: true,
    skipBuild: false,
    maxGroups: 0,
    resume: true,
    expectedWorkFingerprint: '',
    gracefulCutoffEpochRaw: '',
    gracefulCutoffEpoch: null,
    outerHardDeadlineEpochRaw: '',
    outerHardDeadlineEpoch: null,
    continuation: false,
    minStartBudgetSec: DEFAULT_MIN_START_BUDGET_SEC,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = String(argv[++i] || '').trim();
    else if (arg.startsWith('--date=')) args.date = String(arg.slice('--date='.length)).trim();
    else if (arg === '--guard') args.guard = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--guard=')) args.guard = path.resolve(ROOT, arg.slice('--guard='.length));
    else if (arg === '--price-overrides') args.priceOverrides = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--price-overrides=')) args.priceOverrides = path.resolve(ROOT, arg.slice('--price-overrides='.length));
    else if (arg === '--current-marketing-live-scan') args.currentMarketingLiveScan = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--current-marketing-live-scan=')) args.currentMarketingLiveScan = path.resolve(ROOT, arg.slice('--current-marketing-live-scan='.length));
    else if (arg === '--out-dir') args.outDir = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(ROOT, arg.slice('--out-dir='.length));
    else if (arg === '--stores') args.stores = splitCsv(argv[++i]).map(s => s.toUpperCase());
    else if (arg.startsWith('--stores=')) args.stores = splitCsv(arg.slice('--stores='.length)).map(s => s.toUpperCase());
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else if (arg === '--execute') args.dryRunOnly = false;
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--max-groups') args.maxGroups = Number(argv[++i] || 0);
    else if (arg.startsWith('--max-groups=')) args.maxGroups = Number(arg.slice('--max-groups='.length));
    else if (arg === '--no-resume') args.resume = false;
    else if (arg === '--expected-work-fingerprint') args.expectedWorkFingerprint = String(argv[++i] || '').trim().toLowerCase();
    else if (arg.startsWith('--expected-work-fingerprint=')) args.expectedWorkFingerprint = String(arg.slice('--expected-work-fingerprint='.length)).trim().toLowerCase();
    else if (arg === '--graceful-cutoff-epoch' || arg === '--deadline-epoch') args.gracefulCutoffEpochRaw = String(argv[++i] || '').trim();
    else if (arg.startsWith('--graceful-cutoff-epoch=') || arg.startsWith('--deadline-epoch=')) args.gracefulCutoffEpochRaw = String(arg.slice(arg.indexOf('=') + 1)).trim();
    else if (arg === '--outer-hard-deadline-epoch') args.outerHardDeadlineEpochRaw = String(argv[++i] || '').trim();
    else if (arg.startsWith('--outer-hard-deadline-epoch=')) args.outerHardDeadlineEpochRaw = String(arg.slice(arg.indexOf('=') + 1)).trim();
    else if (arg === '--continuation') args.continuation = true;
    else if (arg === '--min-start-budget-sec') args.minStartBudgetSec = Number(argv[++i] || 0);
    else if (arg.startsWith('--min-start-budget-sec=')) args.minStartBudgetSec = Number(arg.slice('--min-start-budget-sec='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.date) args.date = inferDateFromPath(args.guard) || formatLocalDate(new Date());
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  if (!Number.isInteger(args.maxGroups) || args.maxGroups < 0) throw new Error(`Invalid --max-groups: ${args.maxGroups}`);
  if (!Number.isInteger(args.minStartBudgetSec) || args.minStartBudgetSec < DEFAULT_MIN_START_BUDGET_SEC) {
    throw new Error(`Invalid --min-start-budget-sec: must be an integer >= ${DEFAULT_MIN_START_BUDGET_SEC}`);
  }
  if (args.gracefulCutoffEpochRaw) {
    if (!/^[1-9][0-9]*$/.test(args.gracefulCutoffEpochRaw)) {
      throw new Error(`Invalid absolute graceful cutoff epoch: ${args.gracefulCutoffEpochRaw}`);
    }
    const epoch = Number(args.gracefulCutoffEpochRaw);
    if (!Number.isSafeInteger(epoch) || epoch <= Math.floor(Date.now() / 1000)) {
      throw new Error(`Absolute graceful cutoff epoch must be a future safe integer: ${args.gracefulCutoffEpochRaw}`);
    }
    args.gracefulCutoffEpoch = epoch;
  }
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error(`Invalid --expected-work-fingerprint: ${args.expectedWorkFingerprint}`);
  }
  if (args.continuation && args.dryRunOnly) throw new Error('--continuation requires --execute');
  args.deadline = createDeadlineContract({
    gracefulCutoffEpoch: args.gracefulCutoffEpochRaw,
    outerHardDeadlineEpoch: args.outerHardDeadlineEpochRaw,
    minFinalizationBudgetSec: args.minStartBudgetSec,
  });
  return args;
}

function splitCsv(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function groupStartBudget(args) {
  if (args.continuation) {
    const remainingSec = args.deadline
      ? args.deadline.outerHardDeadlineEpoch - Math.floor(Date.now() / 1000)
      : null;
    return {ok: remainingSec === null || remainingSec > 0, remainingSec};
  }
  if (args.gracefulCutoffEpoch === null) return {ok: true, remainingSec: null};
  const remainingSec = args.gracefulCutoffEpoch - Math.floor(Date.now() / 1000);
  return {
    ok: remainingSec >= args.minStartBudgetSec,
    remainingSec,
  };
}

function inferDateFromPath(value) {
  const match = String(value || '').match(/20\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function normalizedAbsolute(file) {
  return path.resolve(file).replace(/[\\/]+$/, '').toLowerCase();
}

async function loadGuardPriceOverridesBinding(guard) {
  const rawPath = String(guard?.targetPlanSelection?.priceOverrides || '').trim();
  if (!rawPath || /[\r\n]/.test(rawPath)) {
    throw new Error('Guard targetPlanSelection.priceOverrides must be a non-empty single-line path');
  }
  const priceOverridesPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(ROOT, rawPath);
  const expectedSha256 = String(guard?.targetPlanSelection?.priceOverridesHash || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`Guard targetPlanSelection.priceOverridesHash must be a 64-hex SHA-256; got=${expectedSha256 || 'missing'}`);
  }
  const stat = await fs.lstat(priceOverridesPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Guard price overrides must be a regular non-symlink file: ${priceOverridesPath}`);
  }
  const bytes = await fs.readFile(priceOverridesPath);
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Price overrides SHA-256 mismatch: guard=${expectedSha256} actual=${actualSha256} file=${priceOverridesPath}`,
    );
  }
  return {
    path: priceOverridesPath,
    relativePath: rel(priceOverridesPath),
    sha256: expectedSha256,
  };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function pathExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function runCommand(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 900000;
  const startedAt = new Date().toISOString();
  return await new Promise(resolve => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, exitCode: null, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr, error: error.message});
    });
    child.on('close', finish);
    // Some browser-backed helpers leave inherited pipe handles open after the
    // direct child has exited. Do not hold the inventory transaction and its
    // finally restore path hostage to those unrelated handles.
    child.on('exit', code => setTimeout(() => finish(code), 500));
  });
}

let ACTIVE_DEADLINE = null;

function deadlineTimeout(timeoutMs, {recovery = false, label = 'bounded operation'} = {}) {
  if (!ACTIVE_DEADLINE) return timeoutMs;
  return recovery
    ? boundedRecoveryTimeoutMs(ACTIVE_DEADLINE, {capMs: timeoutMs, label})
    : boundedTimeoutMs(ACTIVE_DEADLINE, {capMs: timeoutMs, label});
}

async function runBounded(command, commandArgs, options = {}) {
  const timeoutMs = deadlineTimeout(options.timeoutMs ?? 900000, options);
  return await runCommand(command, commandArgs, {...options, timeoutMs});
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(source.slice(start));
    } catch {
      // stdout can contain nested JSON; keep scanning backwards.
    }
  }
  return null;
}

async function loadToolOutput(commandResult) {
  const parsed = parseLastJson(commandResult.stdout) || parseLastJson(commandResult.stderr);
  const outPath = parsed?.out ? path.resolve(ROOT, parsed.out) : '';
  const full = outPath && await pathExists(outPath) ? await readJson(outPath) : null;
  return {...commandResult, parsed, outPath, full};
}

function summarizeRaw(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout ? result.stdout.slice(-4000) : '',
    stderr: result.stderr ? result.stderr.slice(-4000) : '',
    error: result.error || '',
  };
}

export function hasFallbackSubmittedPendingEvidence(result) {
  return result?.classification === 'submitted_without_exact_readback'
    || result?.status === 'submitted_without_exact_readback'
    || result?.inventoryTransaction?.submitAttempted === true
    || result?.execute?.writeAttempted === true
    || result?.execute?.result?.writeAttempted === true
    || result?.execute?.result?.mutationsStarted === true
    || Number(result?.createdActivityId || result?.execute?.result?.createdActivityId || 0) > 0;
}

export function normalizeFallbackResumeResult(result) {
  if (!result) return result;
  const status = String(result?.status || '');
  const classification = String(result?.classification || '');
  const isInventoryRestoreFailed = status === 'inventory_transaction_restore_failed'
    || classification === 'inventory_transaction_restore_failed'
    || result?.blocked?.type === 'inventory_transaction_restore_failed';
  if (isInventoryRestoreFailed) {
    const blockedSkcs = Array.isArray(result?.blocked?.blockedSkcs) && result.blocked.blockedSkcs.length > 0
      ? result.blocked.blockedSkcs
      : Array.isArray(result?.targetSkcs) ? result.targetSkcs : [];
    const reason = result?.blocked?.reason
      || result?.error
      || 'inventory transaction temporary raise or restore failed';
    return {
      ...result,
      ok: false,
      terminal: true,
      terminalBlocked: true,
      deferred: false,
      recoverableDeferred: false,
      writeAttempted: true,
      status: 'inventory_transaction_restore_failed',
      classification: 'inventory_transaction_restore_failed',
      blocked: {
        ...(result?.blocked || {}),
        type: 'inventory_transaction_restore_failed',
        reason,
        blockedSkcs,
      },
    };
  }
  if (isResumableFallbackResult(result) || !hasFallbackSubmittedPendingEvidence(result)) return result;
  const blockedSkcs = Array.isArray(result.targetSkcs) ? result.targetSkcs : [];
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
    blocked: {
      type: 'submitted_without_exact_readback',
      reason: 'activity mutation was submitted or attempted, but official exact readback is pending or unverifiable; replay is forbidden',
      blockedSkcs,
    },
  };
}

export function isFallbackResumeResultSettled(result) {
  return isResumableFallbackResult(result)
    || result?.classification === 'submitted_without_exact_readback'
    || result?.classification === 'inventory_transaction_restore_failed';
}

function storeConfigByKey() {
  const doc = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  return new Map((doc.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => [String(store.storeKey || '').toUpperCase(), store]));
}

async function launchStore(storeKey) {
  return await runBounded(process.execPath, [
    'scripts/launch_store_browser.mjs',
    storeKey,
    '--headless',
    '--url',
    'https://sso.geiwohuo.com/#/mbrs/marketing/list',
  ], {timeoutMs: 60000, label: `launch ${storeKey}`});
}

async function closeStore(storeKey) {
  const cleanupArgs = ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'];
  const leaseTask = String(process.env.SHEIN_BI_BROWSER_LEASE_TASK || '').trim();
  const leaseRunId = String(process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID || '').trim();
  if (leaseTask && leaseRunId) cleanupArgs.push('--owned-lease-task', leaseTask, '--owned-lease-run-id', leaseRunId);
  return await runCommand(
    process.execPath,
    cleanupArgs,
    {timeoutMs: 90000},
  );
}

async function recoverMarketingLogin(storeKey, date) {
  const reloginRun = await runBounded(process.execPath, [
    'scripts/auto_relogin_shein_store.mjs',
    storeKey,
    '--date', date,
    '--headless',
    '--require-marketing',
  ], {timeoutMs: 240000, label: 'login recovery ' + storeKey});
  const parsed = parseLastJson(reloginRun.stdout) || parseLastJson(reloginRun.stderr);
  const outPath = parsed?.reportFile ? path.resolve(ROOT, parsed.reportFile) : '';
  const reloginReport = outPath && (await pathExists(outPath)) ? await readJson(outPath) : null;
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
  ], {timeoutMs: 180000, label: 'identity readback ' + storeKey});
  const identityMatch = String(identityRun.stdout || '').match(/^JSON\s+(.+)$/m);
  const identityPath = identityMatch?.[1] ? path.resolve(identityMatch[1].trim()) : '';
  const identityReport = identityPath && (await pathExists(identityPath)) ? await readJson(identityPath) : null;
  const identityRow = identityReport?.rows?.find(row => String(row?.storeKey || '').toUpperCase() === storeKey) || null;
  const identity = {
    ok: identityRun.ok && identityRow?.ok === true,
    mismatch: Boolean((identityRow?.identity?.accountConflicts || []).length || (identityRow?.identity?.merchantConflicts || []).length),
    reason: identityRow?.reason || identityRun.stderr || 'identity audit did not return an exact store match',
  };
  return {
    ok: identity.ok,
    relogin: {ok: true, blocker: '', reason: ''},
    identity,
    assessment: classifyUnifiedLoginRecovery({relogin, identity}),
  };
}

async function applyRescue({storeKey, port, rescuePath, execute, recovery = false}) {
  const result = await runBounded(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store-key',
    storeKey,
    '--port',
    String(port),
    '--rescue',
    rescuePath,
    execute ? '--execute' : '--dry-run',
  ], {
    timeoutMs: execute ? 1200000 : 900000,
    recovery,
    label: `${recovery ? 'inventory restore/readback' : 'inventory preflight'} ${storeKey}`,
  });
  return await loadToolOutput(result);
}

async function replaceTransactionally({storeKey, port, rescuePath, sourceRescuePath = rescuePath, execute, continuation = false}) {
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescuePath)).digest('hex');
  const sourceRescueHash = crypto.createHash('sha256').update(await fs.readFile(sourceRescuePath)).digest('hex');
  const deadlineArgs = execute && ACTIVE_DEADLINE ? [
    '--graceful-cutoff-epoch', String(ACTIVE_DEADLINE.gracefulCutoffEpoch),
    '--outer-hard-deadline-epoch', String(ACTIVE_DEADLINE.outerHardDeadlineEpoch),
    '--min-finalization-budget-sec', String(ACTIVE_DEADLINE.minFinalizationBudgetSec),
  ] : [];
  const result = await runBounded(process.execPath, [
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
  ], {timeoutMs: 1800000, recovery: execute, label: `${execute ? 'activity submit' : 'activity dry-run'} ${storeKey}`});
  return await loadToolOutput(result);
}

async function writeInventoryExecutableSubset({storeKey, rescue, rescuePath, blockedSkcs, outDir}) {
  const blockedSet = new Set(blockedSkcs.map(String));
  const rows = (rescue.rows || []).filter(row => !blockedSet.has(String(row.skc || '').trim()));
  const subset = {
    ...rescue,
    createdAt: new Date().toISOString(),
    parentRescue: rel(rescuePath),
    purpose: `${rescue.purpose || 'limited_discount_fallback'}_inventory_executable_subset`,
    excludedInventoryBlockedSkcs: [...blockedSet],
    originalRowCount: (rescue.rows || []).length,
    executableRowCount: rows.length,
    rows,
  };
  const file = path.join(outDir, `inventory-executable-${storeKey}-${path.basename(rescuePath)}`);
  await fs.writeFile(file, `${JSON.stringify(subset, null, 2)}\n`, 'utf8');
  return {path: file, rescue: subset};
}

async function buildPlan(args, guard, guardPriceOverrides) {
  const priceOverrides = args.priceOverrides || guardPriceOverrides.path;
  if (normalizedAbsolute(priceOverrides) !== normalizedAbsolute(guardPriceOverrides.path)) {
    throw new Error(`Explicit price-overrides path mismatch: guard=${guardPriceOverrides.relativePath} explicit=${rel(priceOverrides)}`);
  }
  const liveScan = args.currentMarketingLiveScan
    || path.resolve(ROOT, guard?.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.liveLimitedDiscountSource || '');
  if (!priceOverrides || !fsSync.existsSync(priceOverrides)) throw new Error(`price-overrides file not found: ${priceOverrides || '(empty)'}`);
  const buildArgs = [
    'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
    '--date',
    args.date,
    '--source-guard',
    args.guard,
    '--price-overrides',
    priceOverrides,
    '--expected-price-overrides-sha256',
    guardPriceOverrides.sha256,
  ];
  if (liveScan && fsSync.existsSync(liveScan)) buildArgs.push('--current-marketing-live-scan', liveScan);
  const build = await runCommand(process.execPath, buildArgs, {timeoutMs: 300000});
  const loaded = await loadToolOutput(build);
  if (!build.ok) throw new Error(`build_new_listing_limited_discount_plan failed: ${build.stderr || build.stdout || build.error || ''}`);
  const planPath = loaded.parsed?.reportJson ? path.resolve(ROOT, loaded.parsed.reportJson) : path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${args.date}.json`);
  return {command: buildArgs, result: summarizeRaw(build), planPath};
}

function classifyBlockedDryRun(full) {
  const reason = full?.reason || full?.parsed?.reason || '';
  const unsafe = Array.isArray(full?.unsafeExistingLimitedDiscounts) ? full.unsafeExistingLimitedDiscounts : [];
  const invalid = Array.isArray(full?.validation?.invalid) ? full.validation.invalid : [];
  const skipped = Array.isArray(full?.skippedUnreportable) ? full.skippedUnreportable : [];
  const platformCodes = [...new Set([
    ...invalid.map(row => row.error_code || row.code || '').filter(Boolean),
    ...skipped.flatMap(row => (row.reasons || []).map(r => r.error_code || r.code || '')).filter(Boolean),
  ])];
  if (unsafe.length) return {type: 'unsafe_existing_limited_discount', reason, unsafeExistingLimitedDiscounts: unsafe};
  if (platformCodes.length || invalid.length || skipped.length) return {type: 'platform_or_inventory_blocked', reason, platformCodes, invalid, skipped};
  return {type: 'dry_run_not_ok', reason};
}

function transactionBlockedSkcs(full, inventoryTransactionPlan = null) {
  const blocked = [];
  const inventoryTransactionSkcs = new Set(
    (inventoryTransactionPlan?.rows || [])
      .filter(row => row?.requiresTemporaryRaise === true)
      .map(row => String(row?.skc || '').trim())
      .filter(Boolean),
  );
  for (const row of full?.validation?.invalid || []) {
    const skc = String(row?.skc || '').trim();
    const isExistingActivityConflict = row?.reason === 'query_goods error_code'
      && row?.error_code === 'mrs-simple_platform_limit_discounts-0006';
    const handledByInventoryTransaction = row?.reason === 'inventory below configured activity stock';
    const sameSkcHasInventoryTransaction = inventoryTransactionSkcs.has(skc);
    const inventoryMinimumOrPlatformGate = sameSkcHasInventoryTransaction && (
      row?.reason === 'inventory below min_stock'
      || row?.error_code === 'mrs-simple_platform_limit_discounts-101018'
    );
    if (!isExistingActivityConflict && !handledByInventoryTransaction && !inventoryMinimumOrPlatformGate && skc) {
      blocked.push(skc);
    }
  }
  for (const skc of full?.validation?.missing || []) blocked.push(String(skc));
  for (const row of full?.skippedUnreportable || []) {
    if (row?.skc) blocked.push(String(row.skc));
  }
  return [...new Set(blocked.filter(Boolean))];
}

async function processStore({file, storeMap, args, manualIndex, browserSession = {}}) {
  const storeKey = String(file.storeKey || '').toUpperCase();
  const store = storeMap.get(storeKey);
  let rescuePath = path.resolve(ROOT, file.path || '');
  const sourceRescuePath = rescuePath;
  const record = {
    storeKey,
    rescuePath: rel(rescuePath),
    targetCount: Number(file.count || 0),
    launched: null,
    dryRun: null,
    execute: null,
    inventoryTopUps: [],
    inventoryBlockedSkcs: [],
    inventorySubsetRescuePath: '',
    close: null,
    ok: false,
    status: 'pending',
    createdActivityId: null,
    targetSkcs: [],
    blocked: null,
    protectedManualSpecialRows: [],
    terminalBlocked: false,
    recoverableDeferred: false,
    deferred: false,
    error: '',
  };
  try {
    assertCanStartUnit(ACTIVE_DEADLINE, {
      continuation: args.continuation,
      label: `new-listing limited-discount group ${storeKey}`,
    });
    if (!store) throw new Error(`Unknown or disabled store: ${storeKey}`);
    let rescue = await readJson(rescuePath);
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
        record.error = 'continuation mode found no persisted transaction; no new group was started';
        return record;
      }
      record.persistedContinuation = rel(persisted.file);
      const fencedPath = persisted.journal?.createAttempt?.exactScope?.rescuePath
        || persisted.journal?.operationRescuePath;
      if (fencedPath) {
        rescuePath = path.resolve(ROOT, fencedPath);
        rescue = await readJson(rescuePath);
        record.rescuePath = rel(rescuePath);
      }
    }
    const transformedRows = (rescue.rows || []).map(row => {
      const entry = manualIndex.activeByKey.get(`${storeKey}::${String(row.skc || '').trim()}`) || null;
      if (!entry) return row;
      record.protectedManualSpecialRows.push({skc: entry.skc, specialPrice: entry.specialPrice, validTo: entry.validTo, activityStock: entry.activityStock});
      return applyManualLimitedDiscountOverride({...row, storeKey}, entry);
    });
    if (!args.continuation && record.protectedManualSpecialRows.length) {
      rescue = {...rescue, rows: transformedRows};
      const allManual = transformedRows.every(row => row.manualSpecialLimitedDiscount === true);
      if (allManual) {
        const endTimes = [...new Set(transformedRows.map(row => row.manualSpecialValidTo))];
        const stocks = [...new Set(transformedRows.map(row => Number(row.activityStock)))];
        if (endTimes.length === 1) rescue.endTime = endTimes[0];
        if (stocks.length === 1) rescue.activityStock = stocks[0];
        rescue.activityNamePrefix = `${storeKey}人工特殊限时折扣保护恢复`;
      }
      const preparedPath = path.join(args.outDir, `manual-protected-${path.basename(rescuePath)}`);
      await fs.writeFile(preparedPath, `${JSON.stringify(rescue, null, 2)}\n`, 'utf8');
      rescuePath = preparedPath;
      record.rescuePath = rel(rescuePath);
    }
    record.targetSkcs = (rescue.rows || []).map(row => String(row.skc || '').trim()).filter(Boolean);
    record.lowEtFastSellerPricePullbackRevalidation = await revalidateLowEtFastSellerRescueArtifact({
      root: ROOT,
      rescue,
      reportDate: args.date,
    });
    if (!record.lowEtFastSellerPricePullbackRevalidation.ok) {
      record.status = 'low_et_price_pullback_evidence_drift';
      record.error = record.lowEtFastSellerPricePullbackRevalidation.reason;
      return record;
    }
    record.launched = browserSession.ready
      ? (browserSession.launchSummary || {ok: true, reused: true})
      : summarizeRaw(await launchStore(storeKey));
    if (!record.launched.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${record.launched.stderr || record.launched.stdout || record.launched.error}`);
    let dryRun = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
    if (isMarketingLoginRedirect(dryRun.full || dryRun.parsed || dryRun.stdout || dryRun.stderr)) {
      const recovery = await recoverMarketingLogin(storeKey, args.date);
      record.loginRecovery = recovery;
      if (recovery.assessment?.terminal) {
        record.status = 'login_terminal_blocker';
        record.classification = 'login_terminal_blocker';
        record.terminalBlocked = true;
        record.error = recovery.assessment.blocker;
        return record;
      }
      if (!recovery.ok) {
        record.status = 'recoverable_login_pending';
        record.classification = 'recoverable_pending';
        record.recoverableDeferred = true;
        record.deferred = true;
        record.error = recovery.assessment?.blocker || 'login recovery incomplete';
        return record;
      }
      dryRun = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
      if (isMarketingLoginRedirect(dryRun.full || dryRun.parsed || dryRun.stdout || dryRun.stderr)) {
        record.status = 'recoverable_login_pending';
        record.classification = 'recoverable_pending';
        record.recoverableDeferred = true;
        record.deferred = true;
        record.error = 'login redirect remained after one controlled recovery';
        return record;
      }
    }
    record.dryRun = {
      ...summarizeRaw(dryRun),
      out: dryRun.outPath ? rel(dryRun.outPath) : '',
      parsed: dryRun.parsed || null,
      result: dryRun.full ? {
        ok: dryRun.full.ok,
        reason: dryRun.full.reason || '',
        targetCount: dryRun.full.targetCount,
        validation: dryRun.full.validation || null,
        unsafeExistingLimitedDiscounts: dryRun.full.unsafeExistingLimitedDiscounts || [],
      } : null,
    };
    if (!dryRun.full) {
      throw new Error(`dry-run did not produce a readable result for ${storeKey}: ${dryRun.stderr || dryRun.stdout || dryRun.error || ''}`);
    }
    const transactionHash = activityExecutionTransactionHash(
      'new_listing_relisted_or_missing_limited_discount',
      storeKey,
      rescuePath,
      rescue,
      dryRun.full?.validation || null,
    );
    record.inventoryTransactionPlan = await planLimitedDiscountInventoryTransaction({
      root: ROOT,
      storeKey,
      rescue,
      preflightFull: dryRun.full,
      transactionHash,
    });
    if (!record.inventoryTransactionPlan.ok) {
      record.blocked = {
        type: 'inventory_transaction_plan_blocked',
        reason: record.inventoryTransactionPlan.blockers?.map(item => item.error || item.reason).join('; ') || 'inventory transaction plan blocked',
        blockedSkcs: record.inventoryTransactionPlan.blockers?.map(item => item.skc).filter(Boolean) || [],
      };
      record.status = record.blocked.type;
      record.terminalBlocked = true;
      return record;
    }

    const blockedSkcs = transactionBlockedSkcs(
      dryRun.full,
      record.inventoryTransactionPlan,
    );
    if (blockedSkcs.length && !args.continuation) {
      const subset = await writeInventoryExecutableSubset({
        storeKey,
        rescue,
        rescuePath,
        blockedSkcs,
        outDir: args.outDir,
      });
      record.inventorySubsetRescuePath = rel(subset.path);
      record.blocked = {
        ...classifyBlockedDryRun(dryRun.full || dryRun.parsed || {}),
        blockedSkcs,
        reason: dryRun.full?.reason || 'one or more SKCs failed the exact platform/inventory preflight',
      };
      if (!subset.rescue.rows.length) {
        record.status = record.blocked.type;
        record.ok = false;
        return record;
      }
      rescuePath = subset.path;
      record.rescuePath = rel(rescuePath);
      const subsetDryRun = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
      record.inventorySubsetDryRun = {
        ...summarizeRaw(subsetDryRun),
        out: subsetDryRun.outPath ? rel(subsetDryRun.outPath) : '',
        parsed: subsetDryRun.parsed || null,
        result: subsetDryRun.full || null,
      };
      if (!subsetDryRun.full) throw new Error(`executable-subset dry-run produced no readable result for ${storeKey}`);
      dryRun.full = subsetDryRun.full;
    } else if (blockedSkcs.length) {
      record.blocked = {
        ...classifyBlockedDryRun(dryRun.full || dryRun.parsed || {}),
        blockedSkcs,
        reason: dryRun.full?.reason || 'continuation retains its previously fenced executable rescue',
      };
    }
    if (dryRun.full?.alreadyCovered) {
      record.createdActivityId = dryRun.full.createdActivityId || null;
      record.status = record.blocked ? 'already_covered_subset_with_blockers' : 'manual_special_already_covered';
      record.ok = !record.blocked;
      return record;
    }
    if (args.dryRunOnly) {
      const transactionDryRun = await replaceTransactionally({storeKey, port: store.port, rescuePath, sourceRescuePath, execute: false});
      record.transactionDryRun = {
        ...summarizeRaw(transactionDryRun),
        out: transactionDryRun.outPath ? rel(transactionDryRun.outPath) : '',
        result: transactionDryRun.full || null,
      };
      if (!transactionDryRun.full) throw new Error(`transactional dry-run produced no readable result for ${storeKey}`);
      const inventoryTransactionReady = (record.inventoryTransactionPlan?.rows || [])
        .some(row => row.requiresTemporaryRaise === true);
      if (!transactionDryRun.full.ok && !record.blocked && !inventoryTransactionReady) {
        record.blocked = classifyBlockedDryRun(transactionDryRun.full);
      }
      record.status = record.blocked
        ? record.blocked.type
        : inventoryTransactionReady
          ? 'dry_run_inventory_transaction_ready'
          : String(transactionDryRun.full.status || 'dry_run_ok');
      record.ok = !record.blocked && (transactionDryRun.full.ok === true || inventoryTransactionReady);
      return record;
    }
    assertCanStartUnit(ACTIVE_DEADLINE, {
      continuation: args.continuation,
      label: `new-listing inventory transaction ${storeKey}`,
    });
    const inventoryTransaction = await executeLimitedDiscountWithInventoryTransaction({
      root: ROOT,
      storeKey,
      rescue,
      preflightFull: dryRun.full,
      transactionHash,
      adapterFactory: deadlineBoundAdapterFactory(createMarketingActivityInventoryOpenApiAdapter, ACTIVE_DEADLINE, {
        label: `new-listing inventory ${storeKey}`,
      }),
      readMutationEvidence: () => readLimitedDiscountMutationEvidence({root: ROOT, storeKey, sourceRescuePath}),
      runSubmit: async () => {
        assertBeforeOuter(ACTIVE_DEADLINE, {
          reserveSec: ACTIVE_DEADLINE?.minFinalizationBudgetSec || 0,
          label: `new-listing activity submit ${storeKey}`,
        });
        return await replaceTransactionally({storeKey, port: store.port, rescuePath, sourceRescuePath, execute: true, continuation: args.continuation});
      },
      runEnrollmentReadback: async context => await applyRescue({
        storeKey,
        port: store.port,
        rescuePath,
        execute: false,
        recovery: context?.phase === 'after_submit_without_inventory_transaction'
          || context?.phase === 'after_submit_before_restore'
          || context?.phase === 'after_restore',
      }),
    });
    record.inventoryTransaction = inventoryTransaction;
    if (!inventoryTransaction.ok) {
      record.blocked = {
        type: classifyActivityInventoryFailureStatus(inventoryTransaction),
        reason: inventoryTransaction.blockers?.map(item => item.error || item.reason).join('; ')
          || 'activity inventory transaction failed',
        blockedSkcs: inventoryTransaction.extractedTargets?.map(item => item.skc) || [],
      };
      record.status = record.blocked.type;
      const deadlineDeferred = (inventoryTransaction.blockers || [])
        .some(blocker => isMarketingDeadlineError({
          code: blocker?.code,
          message: blocker?.error || blocker?.reason,
        }));
      record.deferred = deadlineDeferred;
      record.recoverableDeferred = deadlineDeferred;
      record.terminalBlocked = !deadlineDeferred && (inventoryTransaction.safe === true
        || inventoryTransaction.writeAttempted !== true);
      return record;
    }
    const execute = inventoryTransaction.commandResult;
    record.execute = {
      ...summarizeRaw(execute),
      out: execute.outPath ? rel(execute.outPath) : '',
      parsed: execute.parsed || null,
      result: execute.full ? {
        ok: execute.full.ok,
        safe: execute.full.safe,
        terminal: execute.full.terminal,
        status: execute.full.status,
        reason: execute.full.reason || '',
        targetCount: execute.full.targetSkcs?.length || record.targetSkcs.length,
        targetCountForCreate: execute.full.desiredCoveredSkcs?.length || 0,
        createdActivityId: execute.full.desiredCreate?.createdActivityId || null,
        writeAttempted: execute.full.writeAttempted === true,
        mutationsStarted: execute.full.mutationsStarted === true,
        submittedWithoutExactReadback: execute.full.submittedWithoutExactReadback === true
          || execute.full.classification === 'submitted_without_exact_readback',
        desiredCoveredSkcs: execute.full.desiredCoveredSkcs || [],
        restoredCoveredSkcs: execute.full.compensation?.restoredCoveredSkcs || [],
        uncoveredSkcs: execute.full.uncoveredSkcs || [],
      } : null,
    };
    if (!execute.full) throw new Error(`transactional execute did not produce a readable result for ${storeKey}`);
    if (!execute.full.ok) {
      if (execute.full.safe === true) {
        record.blocked = {
          type: execute.full.status || 'transactionally_blocked_previous_protection_preserved',
          reason: 'SHEIN did not accept the replacement; every removed SKC was restored to its previous limited-discount protection',
          blockedSkcs: [...new Set([
            ...(execute.full.initiallyBlockedSkcs || []),
            ...(execute.full.postDeleteBlockedSkcs || []),
          ])],
          compensation: execute.full.compensation || null,
        };
        record.status = record.blocked.type;
        record.terminalBlocked = true;
        record.ok = false;
        return record;
      }
      throw new Error(`transactional execute/readback failed for ${storeKey}: status=${execute.full.status || 'unknown'} safe=${execute.full.safe === true}`);
    }
    record.createdActivityId = execute.full.desiredCreate?.createdActivityId || null;
    record.status = record.blocked ? 'executed_subset_with_platform_or_inventory_blockers' : 'executed';
    record.ok = !record.blocked;
    return record;
  } catch (error) {
    record.ok = false;
    if (isMarketingDeadlineError(error)) {
      record.status = 'deadline_deferred';
      record.recoverableDeferred = true;
      record.deferred = true;
    } else {
      record.status = 'failed';
    }
    record.error = error.message;
    return record;
  } finally {
    if (!browserSession.keepOpen) record.close = summarizeRaw(await closeStore(storeKey));
  }
}

function summarizeTotals(results, plan) {
  const executed = results.filter(row => String(row.status || '').startsWith('executed'));
  const dryRunOk = results.filter(row => row.status === 'dry_run_ok');
  const blocked = results.filter(row => Boolean(row.blocked));
  const failed = results.filter(row => !row.ok && !row.blocked && !row.deferred);
  return {
    planActionable: Number(plan?.totals?.actionable || 0),
    planCreateLimitedDiscount: Number(plan?.totals?.createLimitedDiscount || 0),
    planReplaceExistingLimitedDiscount: Number(plan?.totals?.replaceExistingLimitedDiscount || 0),
    storesProcessed: results.length,
    storesExecuted: executed.length,
    storesDryRunOnlyOk: dryRunOk.length,
    storesBlocked: blocked.length,
    storesFailed: failed.length,
    executedTargetCount: executed.reduce((sum, row) => sum + Number(row.execute?.result?.targetCountForCreate ?? row.execute?.result?.targetCount ?? row.targetCount ?? 0), 0),
    blockedTargetCount: countBlockedFallbackTargets(results),
    failedTargetCount: failed.reduce((sum, row) => sum + Number(row.targetCount || 0), 0),
    createdActivities: executed.map(row => ({storeKey: row.storeKey, activityId: row.createdActivityId, targetCount: row.execute?.result?.targetCountForCreate ?? row.targetCount})),
    blockedByType: blocked.reduce((acc, row) => {
      const key = row.blocked?.type || 'blocked';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildMarkdown(doc) {
  const lines = [];
  lines.push(`# 新上架 7 天限时折扣自动执行 ${doc.date}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 计划可处理 ${doc.totals.planActionable} 个链接；本次实际新建/重建 ${doc.totals.executedTargetCount} 个。`);
  lines.push(`- 平台/库存/混合旧活动阻断 ${doc.totals.blockedTargetCount} 个；异常失败 ${doc.totals.failedTargetCount} 个。`);
  lines.push(`- 价格来源：\`${doc.sourcePriceOverrides}\`；SHA-256：\`${doc.sourcePriceOverridesSha256}\`。`);
  lines.push(`- dry-run-only=${doc.dryRunOnly ? '是' : '否'}；所有店铺执行后均调用浏览器清理。`);
  lines.push('');
  lines.push('## 已执行');
  for (const item of doc.totals.createdActivities) {
    lines.push(`- ${item.storeKey}: 活动 ${item.activityId || '(未返回)'}，${item.targetCount} 个 SKC`);
  }
  if (!doc.totals.createdActivities.length) lines.push('- 无。');
  const blocked = doc.results.filter(row => row.blocked);
  if (blocked.length) {
    lines.push('');
    lines.push('## 阻断');
    for (const row of blocked) {
      lines.push(`- ${row.storeKey}: ${row.targetCount} 个，${row.blocked.type}，${row.blocked.reason || ''}`);
    }
  }
  const failed = doc.results.filter(row => !row.ok && !row.blocked);
  if (failed.length) {
    lines.push('');
    lines.push('## 异常失败');
    for (const row of failed) lines.push(`- ${row.storeKey}: ${row.error}`);
  }
  lines.push('');
  lines.push('## 文件');
  lines.push(`- 执行 JSON：\`${doc.outputJson}\``);
  lines.push(`- 计划 JSON：\`${doc.planPath}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function resultKey(result) {
  return String(result?.sourceRescuePath || result?.rescuePath || '').replaceAll('\\', '/').toLowerCase();
}

async function loadResumableResults(outputJson, {workFingerprint, dryRunOnly}) {
  if (!(await pathExists(outputJson))) return [];
  try {
    const previous = await readJson(outputJson);
    if (previous.workFingerprint !== workFingerprint || previous.dryRunOnly !== dryRunOnly) return [];
    // A group may create the safe subset and retain per-SKC blockers. Replaying
    // that whole group would duplicate the activity already created for safe rows.
    return (previous.results || []).map(normalizeFallbackResumeResult).filter(isFallbackResumeResultSettled);
  } catch {
    return [];
  }
}

async function writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries, processingComplete = false}) {
  const complete = processingComplete && deferredEntries.length === 0;
  const doc = {
    ...common,
    updatedAt: new Date().toISOString(),
    finishedAt: complete ? new Date().toISOString() : null,
    complete,
    deferredGroups: deferredEntries.length,
    deferredRescueFiles: deferredEntries.map(entry => entry.relativePath),
    results,
  };
  doc.totals = summarizeTotals(results, plan);
  await fs.writeFile(outputJson, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fs.writeFile(outputMd, buildMarkdown(doc), 'utf8');
  return doc;
}

export async function runNewListingFallbackBatch(customArgs, customOverrides = {}) {
  const args = customArgs || parseArgs(process.argv.slice(2));
  ACTIVE_DEADLINE = args.deadline;
  const effectiveLaunchStore = customOverrides.launchStore || launchStore;
  const effectiveCloseStore = customOverrides.closeStore || closeStore;
  const effectiveProcessStore = customOverrides.processStore || processStore;
let automationAuthorization = null;
const manualRegistry = await loadManualLimitedDiscountRegistry();
const manualIndex = buildManualLimitedDiscountIndex(manualRegistry, new Date());
if (!fsSync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
const guard = await readJson(args.guard);
const guardPriceOverrides = await loadGuardPriceOverridesBinding(guard);
await fs.mkdir(args.outDir, {recursive: true});
await fs.mkdir(path.join(ROOT, 'outputs', 'reports'), {recursive: true});
let build = null;
if (!args.skipBuild) build = await buildPlan(args, guard, guardPriceOverrides);
const planPath = build?.planPath || path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${args.date}.json`);
if (!fsSync.existsSync(planPath)) throw new Error(`New-listing plan does not exist: ${planPath}`);
const exactPlan = await loadExactFallbackRepairPlan({root: ROOT, planPath, guardPath: args.guard, date: args.date});
if (args.expectedWorkFingerprint && exactPlan.workFingerprint !== args.expectedWorkFingerprint) {
  throw new Error(`Exact fallback work fingerprint mismatch: expected=${args.expectedWorkFingerprint} actual=${exactPlan.workFingerprint}`);
}
automationAuthorization = args.dryRunOnly ? null : await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.APPLY_NEW_LISTING_FALLBACK,
  payloadHash: exactPlan.workFingerprint,
});
const plan = exactPlan.plan;
const storesFilter = new Set(args.stores || []);
const rescueFiles = exactPlan.entries
  .filter(file => !storesFilter.size || storesFilter.has(file.storeKey))
  .sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.relativePath.localeCompare(b.relativePath));
const storeMap = storeConfigByKey();
const outputJson = path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${args.date}.json`);
const outputMd = path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${args.date}.md`);
const resumedResults = args.resume
  ? await loadResumableResults(outputJson, {workFingerprint: exactPlan.workFingerprint, dryRunOnly: args.dryRunOnly})
  : [];
const completedKeys = new Set(resumedResults.map(resultKey));
const pendingEntries = rescueFiles.filter(entry => !completedKeys.has(entry.relativePath.toLowerCase()));
let continuationEntries = pendingEntries;
if (args.continuation) {
  continuationEntries = [];
  for (const entry of pendingEntries) {
    if (await findPersistedMarketingTransactionContinuation({
      root: ROOT,
      storeKey: entry.storeKey,
      workFingerprint: exactPlan.workFingerprint,
      rescuePath: path.resolve(ROOT, entry.relativePath),
    })) continuationEntries.push(entry);
  }
}
const selectedEntries = args.maxGroups > 0 ? continuationEntries.slice(0, args.maxGroups) : continuationEntries;
let deferredEntries = pendingEntries.filter(entry => !selectedEntries.some(selected => selected.relativePath === entry.relativePath));
const continuationDeferredWithoutMatch = args.continuation && pendingEntries.length > 0 && selectedEntries.length === 0;
const results = [...resumedResults];
const common = {
  createdAt: new Date().toISOString(),
  date: args.date,
  dryRunOnly: args.dryRunOnly,
  automationAuthorization,
  guard: rel(args.guard),
  build,
  planPath: rel(planPath),
  planHash: exactPlan.planHash,
  workFingerprint: exactPlan.workFingerprint,
  sourcePriceOverrides: exactPlan.priceOverridesRelativePath,
  sourcePriceOverridesSha256: exactPlan.priceOverridesSha256,
  priceOverridesPath: exactPlan.priceOverridesRelativePath,
  priceOverridesSha256: exactPlan.priceOverridesSha256,
  priceOverridesHash: exactPlan.priceOverridesSha256,
  priceOverridesBinding: {
    source: 'guard_target_plan_selection',
    expectedSha256: exactPlan.priceOverridesSha256,
    actualSha256: exactPlan.priceOverridesSha256,
    verified: true,
  },
  planTotals: plan.totals || null,
  rescueFiles: rescueFiles.map(entry => ({...entry, path: entry.relativePath, rescue: undefined})),
  resumedGroups: resumedResults.length,
  outputJson: rel(outputJson),
  outputMd: rel(outputMd),
  gracefulCutoffEpoch: args.gracefulCutoffEpoch,
  outerHardDeadlineEpoch: args.deadline?.outerHardDeadlineEpoch || null,
  minStartBudgetSec: args.minStartBudgetSec,
};

const entriesByStore = new Map();
for (const entry of selectedEntries) {
  if (!entriesByStore.has(entry.storeKey)) entriesByStore.set(entry.storeKey, []);
  entriesByStore.get(entry.storeKey).push(entry);
}
const processedSelectedKeys = new Set();
const entryKey = entry => String(entry?.relativePath || entry?.path || '').replaceAll('\\', '/').toLowerCase();
function mergeUnprocessedSelectedEntriesIntoDeferred() {
  const existingDeferredKeys = new Set(deferredEntries.map(entryKey));
  const unprocessed = selectedEntries.filter(entry => {
    const key = entryKey(entry);
    return key && !processedSelectedKeys.has(key) && !existingDeferredKeys.has(key);
  });
  deferredEntries = [...unprocessed, ...deferredEntries];
}
let stoppedBeforeNextGroup = continuationDeferredWithoutMatch;
let stoppedReason = continuationDeferredWithoutMatch
  ? 'continuation mode found no persisted transaction; no new group started'
  : '';
for (const [storeKey, storeEntries] of entriesByStore.entries()) {
  let launchSummary = null;
  let processedInStore = 0;
  try {
    if (args.continuation && !await findPersistedMarketingTransactionContinuation({
      root: ROOT,
      storeKey,
      workFingerprint: args.expectedWorkFingerprint || process.env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH,
      rescuePath: path.resolve(ROOT, storeEntries[0].relativePath),
    })) {
      stoppedBeforeNextGroup = true;
      stoppedReason = `continuation mode found no persisted transaction for ${storeKey}; no new group started`;
      continue;
    }
    for (const file of storeEntries) {
      // This is the only graceful-stop boundary: once a group has started,
      // processStore owns its complete transaction, inventory restore and
      // terminal readback. No deadline timer is allowed inside that path.
      const startBudget = groupStartBudget(args);
      if (!startBudget.ok) {
        stoppedBeforeNextGroup = true;
        stoppedReason = `graceful cutoff reached with ${startBudget.remainingSec}s remaining; no new group started`;
        mergeUnprocessedSelectedEntriesIntoDeferred();
        break;
      }
      try {
        assertCanStartUnit(ACTIVE_DEADLINE, {
          continuation: args.continuation,
          label: `new-listing group ${storeKey}`,
        });
      } catch (error) {
        if (!isMarketingDeadlineError(error)) throw error;
        stoppedBeforeNextGroup = true;
        stoppedReason = error.message;
        mergeUnprocessedSelectedEntriesIntoDeferred();
        break;
      }
      if (!launchSummary) {
        launchSummary = summarizeRaw(await effectiveLaunchStore(storeKey));
        if (!launchSummary.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${launchSummary.stderr || launchSummary.stdout || launchSummary.error}`);
      }
      const result = await effectiveProcessStore({
        file: {...file, path: file.path},
        storeMap,
        args,
        manualIndex,
        browserSession: {ready: true, keepOpen: true, launchSummary: {...launchSummary, reusedForStoreBatch: true}},
      });
      result.sourceRescuePath = file.relativePath;
      results.push(normalizeFallbackResumeResult(result));
      processedSelectedKeys.add(entryKey(file));
      if (result.deferred === true && !deferredEntries.some(entry => entryKey(entry) === entryKey(file))) {
        deferredEntries = [file, ...deferredEntries];
      }
      processedInStore += 1;
      await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
    }
  } catch (error) {
    if (isMarketingDeadlineError(error)) {
      stoppedBeforeNextGroup = true;
      stoppedReason = error.message;
      mergeUnprocessedSelectedEntriesIntoDeferred();
      await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
      continue;
    }
    for (const file of storeEntries.slice(processedInStore)) {
      if (results.some(result => resultKey(result) === file.relativePath.toLowerCase())) continue;
      results.push({
        storeKey,
        rescuePath: file.relativePath,
        sourceRescuePath: file.relativePath,
        targetCount: Number(file.count || 0),
        targetSkcs: file.rescue.rows.map(row => String(row.skc || '')).filter(Boolean),
        launched: launchSummary,
        ok: false,
        status: 'browser_launch_failed',
        error: error.message,
      });
      processedSelectedKeys.add(entryKey(file));
    }
    await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
  } finally {
    common.storeBrowserSessions = common.storeBrowserSessions || [];
    common.storeBrowserSessions.push({
      storeKey,
      launch: launchSummary,
      close: launchSummary ? summarizeRaw(await effectiveCloseStore(storeKey)) : null,
      groupCount: processedInStore,
    });
  }
  if (stoppedBeforeNextGroup) break;
}
if (stoppedBeforeNextGroup) {
  common.gracefulStopReason = stoppedReason;
  await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
}
const processedThisRunResults = selectedEntries
  .map(entry => results.find(result => resultKey(result) === entry.relativePath.toLowerCase()))
  .filter(Boolean);
const deadlineDeferred = processedThisRunResults.filter(result => result.deferred === true).length
  + (stoppedBeforeNextGroup ? 1 : 0);
common.deadlineDeferred = deadlineDeferred;
const doc = await writeExecutionProgress({
  outputJson,
  outputMd,
  common,
  results,
  plan,
  deferredEntries,
  processingComplete: !stoppedBeforeNextGroup,
});
const fullyClear = doc.totals.storesFailed === 0 && doc.totals.storesBlocked === 0 && deferredEntries.length === 0;
console.log(JSON.stringify({
  ok: fullyClear,
  complete: deferredEntries.length === 0,
  out: rel(outputJson),
  md: rel(outputMd),
  totals: doc.totals,
  resumedGroups: resumedResults.length,
  deferredGroups: deferredEntries.length,
  deadlineDeferred,
}, null, 2));
  process.exitCode = fallbackBatchExitCode({
    failedCount: doc.totals.storesFailed,
    deferredCount: deferredEntries.length,
  });
  return {ok: fullyClear, doc, results, plan, deferredEntries};
}
if (import.meta.url === 'file://' + process.argv[1]?.replaceAll('\\', '/') || process.argv[1]?.endsWith('batch_apply_new_listing_limited_discount.mjs')) {
  runNewListingFallbackBatch().catch(err => { console.error(err); process.exit(1); });
}
