#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  buildManualLimitedDiscountIndex,
  loadManualLimitedDiscountRegistry,
  partitionRowsByManualLimitedDiscount,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';
import {
  driftRepairBatchExitCode,
  isCompletedDriftRepairResult,
  isSettledDriftRepairResult,
  isTerminalDriftBusinessBlock,
  summarizeDriftRepairOutcomes,
} from '../../lib/marketing_drift_repair_outcome.mjs';
import {loadExactDriftRepairManifest} from '../../lib/marketing_repair_manifest.mjs';
import {
  activityExecutionTransactionHash,
  executeLimitedDiscountWithInventoryTransaction,
  planLimitedDiscountInventoryTransaction,
} from '../../lib/marketing_activity_inventory_integration.mjs';
import {revalidateLowEtFastSellerRescueArtifact} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');
const DEFAULT_ACTIVITY_NAME_PREFIX = '限时折扣目标价漂移修复';

const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8'));
const storesByKey = new Map((storesConfig.stores || []).map(store => [String(store.storeKey).toUpperCase(), store]));

function parseArgs(argv) {
  const args = {
    guard: '',
    date: '',
    planDir: '',
    outDir: DEFAULT_OUT_DIR,
    out: '',
    stores: [],
    dryRunOnly: true,
    skipBuildPlan: false,
    maxGroups: 0,
    resume: true,
    expectedWorkFingerprint: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--guard=')) args.guard = path.resolve(arg.slice('--guard='.length));
    else if (arg === '--date') args.date = String(argv[++i] || '');
    else if (arg.startsWith('--date=')) args.date = String(arg.slice('--date='.length));
    else if (arg === '--plan-dir') args.planDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--plan-dir=')) args.planDir = path.resolve(arg.slice('--plan-dir='.length));
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--out=')) args.out = path.resolve(arg.slice('--out='.length));
    else if (arg === '--stores') args.stores = splitCsv(argv[++i]).map(s => s.toUpperCase());
    else if (arg.startsWith('--stores=')) args.stores = splitCsv(arg.slice('--stores='.length)).map(s => s.toUpperCase());
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else if (arg === '--execute') args.dryRunOnly = false;
    else if (arg === '--skip-build-plan') args.skipBuildPlan = true;
    else if (arg === '--max-groups') args.maxGroups = Number(argv[++i] || 0);
    else if (arg.startsWith('--max-groups=')) args.maxGroups = Number(arg.slice('--max-groups='.length));
    else if (arg === '--no-resume') args.resume = false;
    else if (arg === '--expected-work-fingerprint') args.expectedWorkFingerprint = String(argv[++i] || '').trim().toLowerCase();
    else if (arg.startsWith('--expected-work-fingerprint=')) args.expectedWorkFingerprint = String(arg.slice('--expected-work-fingerprint='.length)).trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing required --guard <marketing-daily-guard-YYYY-MM-DD.json>');
  if (!args.date) args.date = inferDateFromPath(args.guard);
  if (!args.date) throw new Error('Missing --date and could not infer YYYY-MM-DD from --guard path');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date: ${args.date}`);
  if (!args.planDir) {
    args.planDir = path.join(ROOT, 'tmp/marketing-signup/limited-discount-fallback', `target-price-drift-${args.date}`);
  }
  if (!args.outDir) throw new Error('Missing --out-dir');
  if (!args.out) args.out = path.join(args.outDir, `batch-drift-fix-result-${args.date}.json`);
  if (!Number.isInteger(args.maxGroups) || args.maxGroups < 0) throw new Error(`Invalid --max-groups: ${args.maxGroups}`);
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error(`Invalid --expected-work-fingerprint: ${args.expectedWorkFingerprint}`);
  }
  return args;
}

function splitCsv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function inferDateFromPath(value) {
  const match = String(value || '').match(/20\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function buildRescuePlanIfNeeded(args) {
  if (args.skipBuildPlan && fssync.existsSync(args.planDir)) {
    return {skipped: true, reason: '--skip-build-plan', planDir: rel(args.planDir)};
  }
  await fs.mkdir(args.planDir, {recursive: true});
  const result = await runCommand(process.execPath, [
    'scripts/marketing/build_limited_discount_drift_rescue_plan.mjs',
    '--guard',
    args.guard,
    '--out-dir',
    args.planDir,
    '--end-time',
    `${addDays(args.date, 7)} 23:59:59`,
    '--activity-name-prefix',
    DEFAULT_ACTIVITY_NAME_PREFIX,
  ], {timeoutMs: 300000});
  const parsed = parseLastJson(result.stdout) || parseLastJson(result.stderr);
  return {
    ...summarizeRaw(result),
    stdoutSummary: parsed,
    planDir: rel(args.planDir),
  };
}

async function runCommand(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 600000;
  const cwd = options.cwd || ROOT;
  const startedAt = new Date().toISOString();
  return await new Promise(resolve => {
    const child = spawn(command, commandArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill races
      }
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        ok: false,
        command,
        args: commandArgs,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command,
        args: commandArgs,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    const candidate = source.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep searching; stdout can contain nested JSON
    }
  }
  return null;
}

async function loadToolOutputFromStdout(commandResult) {
  const parsed = parseLastJson(commandResult.stdout) || parseLastJson(commandResult.stderr);
  if (!parsed?.out) return {summary: parsed, full: null};
  const outPath = path.resolve(ROOT, parsed.out);
  if (!(await pathExists(outPath))) return {summary: parsed, full: null};
  const full = JSON.parse(await fs.readFile(outPath, 'utf8'));
  return {summary: parsed, full, outPath};
}

async function launchStore(storeKey) {
  const result = await runCommand(process.execPath, ['scripts/launch_store_browser.mjs', storeKey, '--headless'], {
    timeoutMs: 30000,
  });
  if (!result.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${result.stderr || result.stdout}`);
  await sleep(3000);
  return result;
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

async function replaceTransactionally({storeKey, port, rescuePath, execute}) {
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescuePath)).digest('hex');
  const result = await runCommand(process.execPath, [
    'scripts/marketing/replace_limited_discount_transactionally.mjs',
    '--store', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash,
    execute ? '--execute' : '--dry-run',
  ], {timeoutMs: 1800000});
  const loaded = await loadToolOutputFromStdout(result);
  return {...result, parsed: loaded.summary, full: loaded.full, outPath: loaded.outPath};
}

async function applyRescue({storeKey, port, rescuePath}) {
  const result = await runCommand(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store-key', storeKey,
    '--port', String(port),
    '--rescue', rescuePath,
    '--dry-run',
  ], {timeoutMs: 900000});
  const loaded = await loadToolOutputFromStdout(result);
  return {...result, parsed: loaded.summary, full: loaded.full, outPath: loaded.outPath};
}

function summarizeCommand(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    out: result.parsed?.out || (result.outPath ? rel(result.outPath) : ''),
    stdoutSummary: result.parsed || null,
    stderrTail: result.stderr ? result.stderr.slice(-2000) : '',
  };
}

export function filterDriftRescueRowsDefensively(rescue, manualIndex) {
  const partitioned = partitionRowsByManualLimitedDiscount(rescue?.rows || [], manualIndex);
  return {
    rescue: {...rescue, rows: partitioned.ordinaryRows},
    protectedManualSpecialRows: partitioned.protectedRows.map(({row, entry}) => ({
      storeKey: entry.storeKey,
      skc: entry.skc,
      staleTargetPrice: row.finalTargetPrice ?? row.targetPrice ?? null,
      protectedSpecialPrice: entry.specialPrice,
      validTo: entry.validTo,
    })),
  };
}

async function processStore(storeKey, rescuePath, args, manualIndex, browserSession = {}) {
  const store = storesByKey.get(storeKey);
  if (!store) throw new Error(`Unknown store ${storeKey}`);
  let rescue = JSON.parse(await fs.readFile(rescuePath, 'utf8'));
  let activeRescuePath = rescuePath;
  const defensive = filterDriftRescueRowsDefensively(rescue, manualIndex);
  const protectedManualSpecialRows = defensive.protectedManualSpecialRows;
  const ordinaryRows = defensive.rescue.rows;
  if (protectedManualSpecialRows.length && ordinaryRows.length) {
    rescue = {...defensive.rescue, protectedManualSpecialRows};
    activeRescuePath = path.join(args.outDir, `defensive-filtered-${path.basename(rescuePath)}`);
    await fs.writeFile(activeRescuePath, `${JSON.stringify(rescue, null, 2)}\n`, 'utf8');
  }
  const targetSkcs = [...new Set((rescue.rows || []).map(row => String(row.skc || '').trim()).filter(Boolean))];
  const record = {
    storeKey,
    port: store.port,
    rescuePath: rel(activeRescuePath),
    sourceRescuePath: rel(rescuePath),
    sourceLimitedDiscountName: rescue.sourceLimitedDiscountName,
    endTime: rescue.endTime,
    activityNamePrefix: rescue.activityNamePrefix,
    targetSkcs,
    protectedManualSpecialRows,
    launched: null,
    initialDryRun: null,
    discoveredOldActivities: [],
    removals: [],
    postDeleteDryRun: null,
    inventoryTopUps: [],
    postInventoryTopUpDryRun: null,
    blockedSkcs: [],
    subsetRescuePath: '',
    executeApply: null,
    readback: null,
    skippedCreate: false,
    close: null,
    ok: false,
    status: 'pending',
    error: '',
  };

  try {
    if (!ordinaryRows.length) {
      record.ok = true;
      record.status = 'protected_manual_special_skipped';
      record.skippedCreate = true;
      return record;
    }
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
    if (browserSession.ready) {
      record.launched = browserSession.launchSummary || {ok: true, reused: true};
    } else {
      record.launched = summarizeRaw(await launchStore(storeKey));
    }

    const inventoryPreflight = await applyRescue({
      storeKey,
      port: store.port,
      rescuePath: activeRescuePath,
    });
    record.inventoryPreflight = summarizeCommand(inventoryPreflight);
    if (!inventoryPreflight.full) {
      throw new Error(`inventory preflight did not produce a readable result for ${storeKey}`);
    }
    const transactionHash = activityExecutionTransactionHash(
      'limited_discount_target_price_drift',
      storeKey,
      activeRescuePath,
      rescue,
      inventoryPreflight.full?.validation || null,
    );
    let transaction;
    if (args.dryRunOnly) {
      record.inventoryTransactionPlan = await planLimitedDiscountInventoryTransaction({
        root: ROOT,
        storeKey,
        rescue,
        preflightFull: inventoryPreflight.full,
        transactionHash,
      });
      if (!record.inventoryTransactionPlan.ok) {
        record.status = 'inventory_transaction_plan_blocked';
        record.error = record.inventoryTransactionPlan.blockers?.map(item => item.error || item.reason).join('; ') || 'inventory transaction plan blocked';
        return record;
      }
      transaction = await replaceTransactionally({
        storeKey,
        port: store.port,
        rescuePath: activeRescuePath,
        execute: false,
      });
    } else {
      const inventoryTransaction = await executeLimitedDiscountWithInventoryTransaction({
        root: ROOT,
        storeKey,
        rescue,
        preflightFull: inventoryPreflight.full,
        transactionHash,
        runSubmit: async () => await replaceTransactionally({
          storeKey,
          port: store.port,
          rescuePath: activeRescuePath,
          execute: true,
        }),
        runEnrollmentReadback: async () => await applyRescue({
          storeKey,
          port: store.port,
          rescuePath: activeRescuePath,
        }),
      });
      record.inventoryTransaction = inventoryTransaction;
      if (!inventoryTransaction.ok) {
        record.status = inventoryTransaction.safe === true
          ? 'inventory_transaction_or_enrollment_blocked'
          : 'inventory_transaction_restore_failed';
        record.error = inventoryTransaction.blockers?.map(item => item.error || item.reason).join('; ')
          || 'activity inventory transaction failed';
        return record;
      }
      transaction = inventoryTransaction.commandResult;
    }
    record.transaction = summarizeCommand(transaction);
    if (!transaction.full) {
      throw new Error(`transactional replacement did not produce a readable result for ${storeKey}: ${transaction.stderr || transaction.stdout || transaction.error || ''}`);
    }
    const tx = transaction.full;
    record.initialDryRun = tx.initialDryRun || null;
    record.discoveredOldActivities = (tx.snapshots || []).map(snapshot => ({
      activityId: snapshot.activityId,
      actName: snapshot.actName,
      state: snapshot.state,
      startTime: snapshot.startTime,
      endTime: snapshot.endTime,
      goodsCount: snapshot.beforeGoods?.length || 0,
      targetCount: snapshot.plannedSkcs?.length || 0,
      extraCount: Math.max(0, (snapshot.beforeGoods?.length || 0) - (snapshot.plannedSkcs?.length || 0)),
      targetSkcs: snapshot.plannedSkcs || [],
      extraSkcs: [],
    }));
    record.removals = (tx.removals || []).map(removal => ({
      activityId: removal.activityId,
      skcs: removal.skcs || [],
      result: {ok: removal.ok === true, reason: removal.command?.reason || ''},
      command: removal.command || null,
    }));
    record.postDeleteDryRun = tx.postDeleteDryRun || null;
    record.blockedSkcs = [...new Set([
      ...(tx.initiallyBlockedSkcs || []),
      ...(tx.postDeleteBlockedSkcs || []),
    ])].map(skc => ({skc}));
    record.executeApply = tx.desiredCreate || null;
    record.compensation = tx.compensation || null;
    record.readback = {
      ok: tx.ok === true,
      createdActivityId: tx.desiredCreate?.createdActivityId || null,
      expectedSkcs: targetSkcs.slice().sort(),
      overlapSkcs: (tx.desiredCoveredSkcs || []).slice().sort(),
      uncovered: tx.uncoveredSkcs || [],
      duplicateOverlapSkcs: [],
      safe: tx.safe === true,
      restoredCoveredSkcs: tx.compensation?.restoredCoveredSkcs || [],
    };
    record.safe = tx.safe === true;
    record.terminal = tx.terminal === true;
    record.initialBlockers = tx.initialBlockers || {};
    const inventoryTransactionReady = args.dryRunOnly
      && (record.inventoryTransactionPlan?.rows || []).some(row => row.requiresTemporaryRaise === true);
    record.ok = tx.ok === true || inventoryTransactionReady;
    record.status = inventoryTransactionReady
      ? 'dry_run_inventory_transaction_ready'
      : String(tx.status || (record.ok ? 'replaced_all' : 'failed'));
    record.error = record.ok ? '' : (tx.safe === true
      ? 'replacement was not completed; previous protection was restored and the queue remains blocked for review'
      : 'replacement failed and one or more SKCs remain uncovered');
    return record;
  } catch (error) {
    record.ok = false;
    record.status = 'failed';
    record.error = error.message;
    return record;
  } finally {
    if (!browserSession.keepOpen) {
      const closeResult = await closeStore(storeKey);
      record.close = summarizeRaw(closeResult);
    }
  }
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

async function loadResumableResults(args, workFingerprint) {
  if (!args.resume || !(await pathExists(args.out))) return [];
  try {
    const previous = JSON.parse(await fs.readFile(args.out, 'utf8'));
    if (previous.workFingerprint !== workFingerprint || previous.dryRunOnly !== args.dryRunOnly) return [];
    // A platform/inventory blocker is settled for this immutable daily
    // manifest. Replaying it in every worker window cannot make progress and
    // used to turn safe business conditions into a false system failure. A
    // new daily guard/fingerprint will reconsider the link automatically.
    return (previous.results || []).filter(isSettledDriftRepairResult);
  } catch {
    return [];
  }
}

function resultKey(result) {
  return String(result?.sourceRescuePath || result?.rescuePath || '').replaceAll('\\', '/').toLowerCase();
}

async function writeProgress(args, common, results, deferredEntries = []) {
  const doc = {
    ...common,
    updatedAt: new Date().toISOString(),
    finishedAt: deferredEntries.length ? null : new Date().toISOString(),
    complete: deferredEntries.length === 0,
    deferredGroups: deferredEntries.length,
    deferredRescueFiles: deferredEntries.map(entry => entry.relativePath),
    totals: summarizeTotals(results),
    results,
  };
  await fs.writeFile(args.out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

const args = parseArgs(process.argv.slice(2));
let automationAuthorization = null;
const manualRegistry = await loadManualLimitedDiscountRegistry();
const manualIndex = buildManualLimitedDiscountIndex(manualRegistry, new Date());
await fs.mkdir(args.outDir, {recursive: true});
if (!fssync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
const buildPlan = await buildRescuePlanIfNeeded(args);
if (!buildPlan.skipped && !buildPlan.ok) {
  throw new Error(`build_limited_discount_drift_rescue_plan failed: ${buildPlan.stderr || buildPlan.stdout || buildPlan.error || ''}`);
}
if (!fssync.existsSync(args.planDir)) throw new Error(`Plan dir does not exist after build step: ${args.planDir}`);
const exactManifest = await loadExactDriftRepairManifest({
  root: ROOT,
  planDir: args.planDir,
  guardPath: args.guard,
  date: args.date,
});
if (args.expectedWorkFingerprint && exactManifest.workFingerprint !== args.expectedWorkFingerprint) {
  throw new Error(`Exact drift work fingerprint mismatch: expected=${args.expectedWorkFingerprint} actual=${exactManifest.workFingerprint}`);
}
automationAuthorization = args.dryRunOnly ? null : await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.REPAIR_TARGET_PRICE_DRIFT,
  payloadHash: exactManifest.workFingerprint,
});
const storesFilter = new Set(args.stores);
const exactEntries = exactManifest.entries
  .filter(entry => !storesFilter.size || storesFilter.has(entry.storeKey))
  .sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.relativePath.localeCompare(b.relativePath));
if (!exactEntries.length) {
  const emptyDoc = {
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    guard: rel(args.guard),
    date: args.date,
    planDir: rel(args.planDir),
    outDir: rel(args.outDir),
    dryRunOnly: args.dryRunOnly,
    automationAuthorization,
    buildPlan,
    manifestPath: exactManifest.manifestRelativePath,
    manifestHash: exactManifest.manifestHash,
    workFingerprint: exactManifest.workFingerprint,
    complete: true,
    deferredGroups: 0,
    totals: summarizeTotals([]),
    results: [],
  };
  await fs.writeFile(args.out, `${JSON.stringify(emptyDoc, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok: true, out: rel(args.out), reason: 'no exact rescue files selected', totals: emptyDoc.totals}, null, 2));
  process.exit(0);
}

const startedAt = new Date().toISOString();
const resumedResults = await loadResumableResults(args, exactManifest.workFingerprint);
const completedKeys = new Set(resumedResults.map(resultKey));
const pendingEntries = exactEntries.filter(entry => !completedKeys.has(entry.relativePath.toLowerCase()));
const selectedEntries = args.maxGroups > 0 ? pendingEntries.slice(0, args.maxGroups) : pendingEntries;
const deferredEntries = args.maxGroups > 0 ? pendingEntries.slice(args.maxGroups) : [];
const results = [...resumedResults];
const common = {
  createdAt: startedAt,
  guard: rel(args.guard),
  date: args.date,
  planDir: rel(args.planDir),
  outDir: rel(args.outDir),
  dryRunOnly: args.dryRunOnly,
  automationAuthorization,
  buildPlan,
  manifestPath: exactManifest.manifestRelativePath,
  manifestHash: exactManifest.manifestHash,
  workFingerprint: exactManifest.workFingerprint,
  exactGroupCount: exactEntries.length,
  resumedGroups: resumedResults.length,
};

const entriesByStore = new Map();
for (const entry of selectedEntries) {
  if (!entriesByStore.has(entry.storeKey)) entriesByStore.set(entry.storeKey, []);
  entriesByStore.get(entry.storeKey).push(entry);
}

for (const [storeKey, storeEntries] of entriesByStore.entries()) {
  let launchSummary = null;
  try {
    launchSummary = summarizeRaw(await launchStore(storeKey));
    for (const entry of storeEntries) {
      console.log(`[${new Date().toISOString()}] processing ${storeKey} rescue=${entry.relativePath}`);
      const result = await processStore(storeKey, entry.path, args, manualIndex, {
        ready: true,
        keepOpen: true,
        launchSummary: {...launchSummary, reusedForStoreBatch: true},
      });
      results.push(result);
      await writeProgress(args, common, results, deferredEntries);
      console.log(JSON.stringify({
        storeKey,
        rescuePath: entry.relativePath,
        sourceLimitedDiscountName: result.sourceLimitedDiscountName,
        ok: result.ok,
        status: result.status,
        oldActivities: result.discoveredOldActivities.map(activity => ({
          activityId: activity.activityId,
          targetCount: activity.targetSkcs.length,
          extraCount: activity.extraCount,
        })),
        removed: result.removals.map(item => ({
          activityId: item.activityId,
          skcCount: item.skcs?.length || 0,
          ok: item.plannedOnly || item.skipped ? true : item.result?.ok,
          plannedOnly: item.plannedOnly || false,
          skipped: item.skipped || false,
        })),
        blockedSkcs: result.blockedSkcs,
        createdActivityId: result.readback?.createdActivityId || null,
        subsetRescuePath: result.subsetRescuePath,
        error: result.error,
      }, null, 2));
    }
  } catch (error) {
    for (const entry of storeEntries) {
      if (results.some(result => resultKey(result) === entry.relativePath.toLowerCase())) continue;
      results.push({
        storeKey,
        rescuePath: entry.relativePath,
        sourceRescuePath: entry.relativePath,
        targetSkcs: entry.rescue.rows.map(row => String(row.skc || '')).filter(Boolean),
        launched: launchSummary,
        ok: false,
        status: 'browser_launch_failed',
        error: error.message,
        removals: [],
        blockedSkcs: [],
        readback: null,
      });
    }
    await writeProgress(args, common, results, deferredEntries);
  } finally {
    const closeResult = summarizeRaw(await closeStore(storeKey));
    common.storeBrowserSessions = common.storeBrowserSessions || [];
    common.storeBrowserSessions.push({storeKey, launch: launchSummary, close: closeResult, groupCount: storeEntries.length});
  }
}

const finalDoc = await writeProgress(args, common, results, deferredEntries);
const outcomeTotals = summarizeDriftRepairOutcomes(results);
console.log(JSON.stringify({
  ok: outcomeTotals.failedGroups === 0
    && outcomeTotals.businessBlockedGroups === 0
    && deferredEntries.length === 0,
  complete: deferredEntries.length === 0,
  out: rel(args.out),
  totals: finalDoc.totals,
  outcomes: outcomeTotals,
  resumedGroups: resumedResults.length,
  deferredGroups: deferredEntries.length,
}, null, 2));
process.exitCode = driftRepairBatchExitCode({
  ...outcomeTotals,
  deferredGroups: deferredEntries.length,
});

function summarizeTotals(results) {
  const storeKeys = [...new Set(results.map(result => result.storeKey).filter(Boolean))];
  const resultsByStore = new Map(storeKeys.map(storeKey => [
    storeKey,
    results.filter(result => result.storeKey === storeKey),
  ]));
  const failedStoreKeys = new Set(storeKeys.filter(storeKey => (
    resultsByStore.get(storeKey).some(result => !isCompletedDriftRepairResult(result) && !isTerminalDriftBusinessBlock(result))
  )));
  const blockedStoreKeys = new Set(storeKeys.filter(storeKey => (
    !failedStoreKeys.has(storeKey)
    && resultsByStore.get(storeKey).some(isTerminalDriftBusinessBlock)
  )));
  const completedStoreKeys = new Set(storeKeys.filter(storeKey => (
    resultsByStore.get(storeKey).every(isCompletedDriftRepairResult)
  )));
  const targetSkcs = results.reduce((sum, result) => sum + (result.targetSkcs?.length || 0), 0);
  const removedSkcs = results.reduce((sum, result) => (
    sum + (result.removals || [])
      .filter(item => !item.skipped && item.result?.ok)
      .reduce((inner, item) => inner + (item.skcs?.length || 0), 0)
  ), 0);
  const blockedSkcs = results.reduce((sum, result) => sum + (result.blockedSkcs?.length || 0), 0);
  const createdSkcs = results.reduce((sum, result) => sum + (result.readback?.overlapSkcs?.length || 0), 0);
  const outcomes = summarizeDriftRepairOutcomes(results);
  return {
    storesProcessed: storeKeys.length,
    storesOk: completedStoreKeys.size,
    storesBlocked: blockedStoreKeys.size,
    storesFailed: failedStoreKeys.size,
    groupsProcessed: results.length,
    targetSkcs,
    removedSkcs,
    blockedSkcs,
    createdSkcs,
    ...outcomes,
    statuses: results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {}),
  };
}
