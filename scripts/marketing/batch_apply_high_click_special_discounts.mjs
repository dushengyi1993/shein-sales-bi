#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  assertMarketingAutomationAuthorization,
  MARKETING_AUTOMATION_ACTIONS,
} from '../../lib/marketing_automation_authorization.mjs';
import {
  buildManualLimitedDiscountIndex,
  loadManualLimitedDiscountRegistry,
  manualLimitedDiscountKey,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  getHighClickSpecialPolicy,
  revalidateHighClickSpecialCandidate,
  uniqueLinkRows,
} from '../../lib/marketing_high_click_special_policy.mjs';
import {loadMarketingPricingPolicy} from '../../lib/marketing_pricing_policy.mjs';
import {
  buildLowEtFastSellerPricingContext,
  revalidateLowEtFastSellerPricePullback,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {
  loadExactHighClickSpecialPlan,
  loadExactManualRepairPlan,
} from '../../lib/marketing_repair_manifest.mjs';
import {
  classifyHighClickRestoreResult,
  highClickItemKey,
  isHighClickResultSettled,
  planHighClickStageResume,
} from '../../lib/marketing_high_click_stage_resume.mjs';
import {
  assertBeforeOuter,
  assertCanStartUnit,
  boundedRecoveryTimeoutMs,
  boundedTimeoutMs,
  createDeadlineContract,
  findPersistedMarketingTransactionContinuation,
  isMarketingDeadlineError,
} from '../../lib/cloud_marketing_deadline_contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_PATH = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
const LEDGER_PATH = path.join(ROOT, 'state', 'marketing_high_click_special_effects.json');

function parseArgs(argv) {
  const args = {
    date: '',
    guard: '',
    plan: '',
    execute: false,
    maxItems: 0,
    result: '',
    expectedWorkFingerprint: '',
    gracefulCutoffEpochRaw: '',
    outerHardDeadlineEpochRaw: '',
    continuation: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = String(argv[++i] || '').trim();
    else if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg === '--plan') args.plan = path.resolve(argv[++i] || '');
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--dry-run-only') args.execute = false;
    else if (arg === '--max-items') args.maxItems = Number(argv[++i] || 0);
    else if (arg === '--result') args.result = path.resolve(argv[++i] || '');
    else if (arg === '--expected-work-fingerprint') args.expectedWorkFingerprint = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--graceful-cutoff-epoch') args.gracefulCutoffEpochRaw = String(argv[++i] || '').trim();
    else if (arg === '--outer-hard-deadline-epoch') args.outerHardDeadlineEpochRaw = String(argv[++i] || '').trim();
    else if (arg === '--continuation') args.continuation = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date: ${args.date || 'missing'}`);
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  if (!args.plan) args.plan = path.join(ROOT, 'outputs', 'reports', `high-click-low-conversion-special-plan-${args.date}.json`);
  if (!args.result) args.result = path.join(ROOT, 'outputs', 'reports', `high-click-low-conversion-special-execution-${args.date}.json`);
  if (!Number.isInteger(args.maxItems) || args.maxItems < 0) throw new Error('--max-items must be a non-negative integer');
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error('--expected-work-fingerprint must be a SHA256 hash');
  }
  args.deadline = createDeadlineContract({
    gracefulCutoffEpoch: args.gracefulCutoffEpochRaw,
    outerHardDeadlineEpoch: args.outerHardDeadlineEpochRaw,
  });
  if (args.continuation && !args.execute) throw new Error('--continuation requires --execute');
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

async function run(command, commandArgs, {timeoutMs = 900000, env = {}, recovery = false, label = 'bounded operation'} = {}) {
  const boundedMs = args?.deadline
    ? (recovery
      ? boundedRecoveryTimeoutMs(args.deadline, {capMs: timeoutMs, label})
      : boundedTimeoutMs(args.deadline, {capMs: timeoutMs, label}))
    : timeoutMs;
  return await new Promise(resolve => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: {...process.env, ...env},
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, boundedMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ok: false, exitCode: null, timedOut, stdout, stderr, error: error.message});
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ok: exitCode === 0 && !timedOut, exitCode, timedOut, stdout, stderr});
    });
  });
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (fallback !== null && error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

async function persistImmutablePlan(exactPlan) {
  const file = path.join(
    ROOT,
    'outputs',
    'reports',
    'high-click-special-plans',
    exactPlan.plan.reportDate,
    `high-click-special-${exactPlan.workFingerprint}.json`,
  );
  await fs.mkdir(path.dirname(file), {recursive: true});
  try {
    const existing = await fs.readFile(file, 'utf8');
    const source = await fs.readFile(exactPlan.planPath, 'utf8');
    if (existing !== source) throw new Error(`Immutable high-click plan collision: ${file}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.writeFile(file, await fs.readFile(exactPlan.planPath));
  }
  return rel(file);
}

async function registerCandidate(row, exactPlan, sourceArtifact) {
  const args = [
    'scripts/marketing/manage_manual_limited_discount_override.mjs',
    'register',
    '--store', row.storeKey,
    '--skc', row.skc,
    '--canonical', row.canonical,
    '--special-price', String(row.specialPrice),
    '--valid-from', row.validFrom,
    '--valid-to', row.validTo,
    '--activity-stock', String(row.activityStock),
    '--reason', exactPlan.plan.reason,
    '--source-thread-id', exactPlan.plan.sourceThreadId,
    '--source-artifact', sourceArtifact,
    '--status', 'active',
    '--replace', 'true',
  ];
  if (row.fixedTierPricing) args.push('--fixed-tier-pricing',JSON.stringify(row.fixedTierPricing));
  if (row.previousRegistryEntry?.currentActivityId) {
    args.push('--original-activity-id', String(row.previousRegistryEntry.currentActivityId));
  }
  return await run(process.execPath, args, {timeoutMs: 60_000});
}

async function writeSyntheticGuard({sourceGuard, selectedKeys, outDir}) {
  const registry = await loadManualLimitedDiscountRegistry();
  const active = buildManualLimitedDiscountIndex(registry, new Date());
  const rows = [...active.activeByKey.values()].map(entry => {
    const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
    return {
      storeKey: entry.storeKey,
      skc: entry.skc,
      status: selectedKeys.has(key) ? 'missing' : 'covered_exact',
      livePrices: selectedKeys.has(key) ? [] : [entry.specialPrice],
      activityIds: selectedKeys.has(key) ? [] : [entry.currentActivityId].filter(Boolean),
      activityNames: [],
    };
  });
  const synthetic = {
    ...sourceGuard,
    manualSpecialLimitedDiscount: {
      activeCount: active.activeByKey.size,
      actionCount: selectedKeys.size,
      rows,
    },
  };
  const file = path.join(outDir, 'high-click-special-synthetic-guard.json');
  await writeJsonAtomic(file, synthetic);
  return file;
}

async function updateLedger(exactPlan, records, sourceArtifact) {
  const ledger = await readJson(LEDGER_PATH, {schemaVersion: 1, experiments: []});
  const byId = new Map((ledger.experiments || []).map(row => [String(row.experimentId || ''), row]));
  for (const record of records) {
    const experimentId = `${exactPlan.workFingerprint}:${record.storeKey}::${record.skc}`;
    byId.set(experimentId, {
      ...(byId.get(experimentId) || {}),
      experimentId,
      planFingerprint: exactPlan.workFingerprint,
      sourcePlan: sourceArtifact,
      sourceGuard: exactPlan.plan.sourceGuard,
      reportDate: exactPlan.plan.reportDate,
      storeKey: record.storeKey,
      skc: record.skc,
      canonical: record.canonical,
      baseline: record.metrics || null,
      specialPrice: record.specialPrice,
      activityStock: record.activityStock,
      validFrom: record.validFrom,
      validTo: record.validTo,
      status: record.status,
      ok: record.ok,
      reason: record.reason || '',
      currentActivityId: record.currentActivityId || null,
      restoreResult: record.restoreResult || null,
      updatedAt: new Date().toISOString(),
    });
  }
  await writeJsonAtomic(LEDGER_PATH, {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    experiments: [...byId.values()].sort((a, b) => String(a.reportDate || '').localeCompare(String(b.reportDate || ''))
      || String(a.storeKey || '').localeCompare(String(b.storeKey || ''))
      || String(a.skc || '').localeCompare(String(b.skc || ''))),
  });
}

const args = parseArgs(process.argv.slice(2));
const exactPlan = await loadExactHighClickSpecialPlan({
  root: ROOT,
  planPath: args.plan,
  guardPath: args.guard,
  date: args.date,
});
const immutablePlanArtifact = await persistImmutablePlan(exactPlan);
if (args.expectedWorkFingerprint && args.expectedWorkFingerprint !== exactPlan.workFingerprint) {
  throw new Error(`High-click special work fingerprint mismatch: expected=${args.expectedWorkFingerprint} actual=${exactPlan.workFingerprint}`);
}
if (args.execute && shanghaiDate() !== args.date) {
  throw new Error(`High-click special plan is not for the current Shanghai date: plan=${args.date} current=${shanghaiDate()}`);
}
const authorization = args.execute
  ? await assertMarketingAutomationAuthorization({
    action: MARKETING_AUTOMATION_ACTIONS.APPLY_HIGH_CLICK_SPECIAL,
    payloadHash: exactPlan.workFingerprint,
  })
  : null;
const marketingPricingPolicy = await loadMarketingPricingPolicy(POLICY_PATH);
const policy = getHighClickSpecialPolicy(marketingPricingPolicy);
const linksPath = path.resolve(ROOT, exactPlan.plan.sourceLinksData || 'outputs/bi-portal/sections/linksData.json');
const linksDoc = await readJson(linksPath);
const inventoryTrendPath = path.resolve(ROOT, exactPlan.plan.sourceInventoryTrend || 'outputs/bi-portal/sections/inventoryTrend.json');
const priceOverridesPath = path.resolve(ROOT, exactPlan.plan.sourcePriceOverrides || '');
const costMapPath = path.resolve(ROOT, exactPlan.plan.sourceCostMap || 'tmp/mbrs/marketing-cost-map.json');
const [inventoryTrendDoc, priceOverridesDoc, costDoc] = await Promise.all([
  readJson(inventoryTrendPath),
  readJson(priceOverridesPath),
  readJson(costMapPath),
]);
const lowEtContext = buildLowEtFastSellerPricingContext({
  inventoryTrendDoc,
  linksDataDoc: linksDoc,
  baselineDoc: priceOverridesDoc,
  costDoc,
  marketingPolicy: marketingPricingPolicy,
  reportDate: args.date,
});
const liveRowsByKey = new Map(uniqueLinkRows(linksDoc).map(row => [
  manualLimitedDiscountKey(row?.store_key || row?.storeKey || row?.store, row?.skc || row?.SKC),
  row,
]));
const previous = await readJson(args.result, {workFingerprint: '', results: []});
const previousResults = previous.workFingerprint === exactPlan.workFingerprint
  && previous.execute === args.execute
  && Array.isArray(previous.results)
  ? previous.results
  : [];
const currentRunId = String(process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID || process.env.SHEIN_BI_MARKETING_RUN_ID || '').trim();
const resume = planHighClickStageResume({entries: exactPlan.entries, previousResults, currentRunId});
let continuationEligible = resume.eligible;
if (args.continuation) {
  const continuationRegistry = await loadManualLimitedDiscountRegistry();
  const continuationIndex = buildManualLimitedDiscountIndex(continuationRegistry, new Date());
  continuationEligible = resume.eligible.filter(row => {
    const active = continuationIndex.activeByKey.get(row.key) || null;
    return active
      && String(active.sourceArtifact || '') === immutablePlanArtifact
      && Math.abs(Number(active.specialPrice) - Number(row.specialPrice)) <= 0.01;
  });
}
const selected = args.maxItems > 0 ? continuationEligible.slice(0, args.maxItems) : continuationEligible;
const processedThisRun = [];
const restoreKeys = new Set();
let deadlineDeferred = args.continuation && resume.eligible.length > 0 && selected.length === 0;

for (const row of selected) {
  try {
    assertCanStartUnit(args.deadline, {
      continuation: args.continuation,
      label: `high-click item ${row.storeKey}::${row.skc}`,
    });
  } catch (error) {
    if (isMarketingDeadlineError(error)) {
      deadlineDeferred = true;
      break;
    }
    throw error;
  }
  const record = {
    storeKey: row.storeKey,
    skc: row.skc,
    canonical: row.canonical,
    metrics: row.metrics,
    specialPrice: Number(row.specialPrice),
    activityStock: Number(row.activityStock),
    validFrom: row.validFrom,
    validTo: row.validTo,
    status: 'pending',
    ok: false,
    reason: '',
    currentActivityId: null,
    restoreResult: null,
    attemptRunId: currentRunId || null,
  };
  let active = null;
  let sameAutomatedRegistration = false;
  if (args.execute) {
    const registry = await loadManualLimitedDiscountRegistry();
    active = buildManualLimitedDiscountIndex(registry, new Date()).activeByKey.get(row.key) || null;
    sameAutomatedRegistration = active
      && String(active.sourceArtifact || '') === immutablePlanArtifact
      && Math.abs(Number(active.specialPrice) - Number(row.specialPrice)) <= 0.01;
    if (active && !sameAutomatedRegistration) {
      record.status = 'protected_by_concurrent_manual_special';
      record.reason = active.reason || 'active_manual_special_exists';
      record.currentActivityId = active.currentActivityId || null;
      record.ok = true;
      processedThisRun.push(record);
      continue;
    }
    if (sameAutomatedRegistration) {
      // Registration is the durable transaction boundary. A prior process may
      // have stopped after the registry write or after the SHEIN write but
      // before persisting its result. Resume exact live readback/repair instead
      // of abandoning the registration or creating a duplicate activity.
      record.status = 'registered_pending_restore';
      record.reason = 'resume_same_immutable_plan_registration';
      record.currentActivityId = active.currentActivityId || null;
      restoreKeys.add(row.key);
      processedThisRun.push(record);
      continue;
    }
    if (args.continuation) {
      deadlineDeferred = true;
      break;
    }
  }
  const latestRow = liveRowsByKey.get(row.key);
  const revalidation = revalidateHighClickSpecialCandidate(row, latestRow, policy);
  record.revalidation = revalidation;
  if (!revalidation.ok) {
    record.status = 'no_longer_qualifies';
    record.reason = revalidation.reason;
    record.ok = true;
    processedThisRun.push(record);
    continue;
  }
  const lowEtRevalidation = revalidateLowEtFastSellerPricePullback({
    row: {
      ...row,
      finalTargetPrice: row.specialPrice,
      targetPrice: row.specialPrice,
      limitedDiscountPrice: row.specialPrice,
    },
    context: lowEtContext,
    costDoc,
  });
  record.lowEtFastSellerPricePullbackRevalidation = lowEtRevalidation;
  if (!lowEtRevalidation.ok) {
    record.status = 'low_et_pricing_evidence_drift';
    record.reason = lowEtRevalidation.reason;
    processedThisRun.push(record);
    continue;
  }
  record.metrics = revalidation.evaluation.metrics;
  if (!args.execute) {
    record.status = 'dry_run_ready_to_register';
    record.ok = true;
    processedThisRun.push(record);
    continue;
  }

  let registration;
  try {
    assertBeforeOuter(args.deadline, {
      reserveSec: args.deadline?.minFinalizationBudgetSec || 0,
      label: `high-click registry write ${row.storeKey}::${row.skc}`,
    });
    registration = await registerCandidate(row, exactPlan, immutablePlanArtifact);
  } catch (error) {
    if (isMarketingDeadlineError(error)) {
      deadlineDeferred = true;
      break;
    }
    throw error;
  }
  record.registration = {
    ok: registration.ok,
    exitCode: registration.exitCode,
    stderr: registration.stderr,
  };
  if (!registration.ok) {
    record.status = 'registry_write_failed';
    record.reason = registration.stderr || registration.stdout || 'manual special registry write failed';
    processedThisRun.push(record);
    continue;
  }
  record.status = 'registered_pending_restore';
  record.reason = 'registered_before_shein_write';
  restoreKeys.add(row.key);
  processedThisRun.push(record);
}

if (args.execute && restoreKeys.size > 0) {
  try {
    assertCanStartUnit(args.deadline, {
      continuation: true,
      label: 'high-click restore continuation',
    });
  } catch (error) {
    if (!isMarketingDeadlineError(error)) throw error;
    deadlineDeferred = true;
  }
  if (!deadlineDeferred) {
  const sourceGuard = await readJson(args.guard);
  const outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'high-click-special', args.date);
  const syntheticGuard = await writeSyntheticGuard({sourceGuard, selectedKeys: restoreKeys, outDir});
  const restoreDir = path.join(outDir, 'restore');
  const build = await run(process.execPath, [
    'scripts/marketing/build_manual_limited_discount_restore_plan.mjs',
    '--guard', syntheticGuard,
    '--out-dir', restoreDir,
  ], {timeoutMs: 120_000});
  if (!build.ok) throw new Error(`High-click manual restore plan build failed: ${build.stderr || build.stdout}`);
  const manualPlanPath = path.join(restoreDir, 'manual-limited-discount-restore-plan.json');
  const exactManual = await loadExactManualRepairPlan({
    root: ROOT,
    planPath: manualPlanPath,
    guardPath: syntheticGuard,
    date: args.date,
  });
  const restoreResultPath = path.join(outDir, 'high-click-special-restore-result.json');
  const childDeadlineArgs = args.deadline ? [
    '--graceful-cutoff-epoch', String(args.deadline.gracefulCutoffEpoch),
    '--outer-hard-deadline-epoch', String(args.deadline.outerHardDeadlineEpoch),
  ] : [];
  const manualRescueFiles = exactManual.rescueFiles || [];
  let manualContinuation = false;
  if (args.continuation && manualRescueFiles.length > 0) {
    for (const rescueFile of manualRescueFiles) {
      const persisted = await findPersistedMarketingTransactionContinuation({
        root: ROOT,
        storeKey: rescueFile.storeKey,
        workFingerprint: exactManual.workFingerprint,
        rescuePath: path.resolve(ROOT, rescueFile.path),
      });
      if (persisted) {
        manualContinuation = true;
        break;
      }
    }
  }
  const restore = await run(process.execPath, [
    'scripts/marketing/batch_restore_manual_limited_discounts.mjs',
    '--guard', syntheticGuard,
    '--out-dir', restoreDir,
    '--skip-build',
    '--execute',
    '--result', restoreResultPath,
    '--expected-work-fingerprint', exactManual.workFingerprint,
    '--max-items', '1',
    ...(manualContinuation ? ['--continuation'] : []),
    ...childDeadlineArgs,
  ], {
    timeoutMs: 30 * 60_000,
    recovery: true,
    label: 'high-click inventory restore/readback continuation',
    env: {SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH: exactManual.workFingerprint},
  });
  const restoreDoc = await readJson(restoreResultPath, {results: []});
  const restoreByKey = new Map((restoreDoc.results || []).map(result => [
    manualLimitedDiscountKey(result.storeKey, result.skc),
    result,
  ]));
  for (const record of processedThisRun) {
    const key = manualLimitedDiscountKey(record.storeKey, record.skc);
    if (!restoreKeys.has(key)) continue;
    const restored = restoreByKey.get(key) || null;
    record.restoreResult = restored ? {
      status: restored.status,
      ok: restored.ok === true,
      terminal: restored.terminal === true,
      classification: restored.classification || '',
      writeAttempted: restored.writeAttempted === true,
      loginRecovery: restored.loginRecovery || null,
      dryRun: restored.dryRun,
      inventoryTransactionPlan: restored.inventoryTransactionPlan || null,
      inventoryTransaction: restored.inventoryTransaction || null,
      transaction: restored.transaction,
      readback: restored.readback,
      close: restored.close,
      error: restored.error || '',
    } : {status: 'missing_restore_result', ok: false};
    record.status = restored?.status || 'missing_restore_result';
    record.ok = restored?.ok === true;
    record.reason = restored?.error
      || (record.ok
        ? 'live_readback_exact'
        : (restored?.status ? String(restored.status) : 'missing_restore_result'));
    record.currentActivityId = restored?.readback?.activityId || null;
    const disposition = classifyHighClickRestoreResult(restored || {});
    record.terminal = disposition.terminal;
    record.writeAttempted = disposition.writeAttempted;
    record.classification = disposition.classification;
    if (!disposition.settled) record.status = 'recoverable_pending';
  }
  if (!restore.ok && !processedThisRun.some(record => record.ok === false)) {
    throw new Error(`High-click restore batch failed without item-level evidence: ${restore.stderr || restore.stdout}`);
  }
  }
}

for (const record of processedThisRun) {
  if (record.ok !== true && !record.classification) {
    record.classification = 'recoverable_pending';
    record.terminal = false;
    record.writeAttempted = false;
  }
}
const merged = new Map(resume.priorByKey);
for (const record of processedThisRun) merged.set(highClickItemKey(record), record);
const results = exactPlan.entries.map(row => merged.get(highClickItemKey(row))).filter(Boolean);
const successfulKeys = new Set(results
  .filter(isHighClickResultSettled)
  .map(highClickItemKey));
const remainingItems = exactPlan.entries.filter(row => !successfulKeys.has(highClickItemKey(row))).length;
if (args.execute) await updateLedger(exactPlan, processedThisRun, immutablePlanArtifact);
const totals = {
  planned: exactPlan.entries.length,
  processed: results.length,
  processedThisRun: processedThisRun.length,
  resumedItems: resume.settledByKey.size,
  remainingItems,
  restored: results.filter(row => row.status === 'restored').length,
  alreadyCovered: results.filter(row => row.status === 'already_covered_exact').length,
  skippedNoLongerQualifies: results.filter(row => row.status === 'no_longer_qualifies').length,
  protectedByConcurrentManualSpecial: results.filter(row => row.status === 'protected_by_concurrent_manual_special').length,
  recoverablePending: results.filter(row => row.classification === 'recoverable_pending').length,
  blocked: results.filter(row => row.terminal === true).length,
  failed: results.filter(row => row.ok === false && row.terminal !== true && row.classification !== 'recoverable_pending').length,
};
const output = {
  createdAt: new Date().toISOString(),
  date: args.date,
  guard: rel(args.guard),
  plan: exactPlan.planRelativePath,
  immutablePlanArtifact,
  workFingerprint: exactPlan.workFingerprint,
  execute: args.execute,
  gracefulCutoffEpoch: args.deadline?.gracefulCutoffEpoch || null,
  outerHardDeadlineEpoch: args.deadline?.outerHardDeadlineEpoch || null,
  deadlineDeferred,
  authorization,
  totals,
  results,
};
await writeJsonAtomic(args.result, output);
const attemptedFailure = processedThisRun.some(row => row.ok === false && row.terminal !== true && row.classification !== 'recoverable_pending');
const ok = !attemptedFailure && remainingItems === 0;
console.log(JSON.stringify({ok, out: rel(args.result), workFingerprint: exactPlan.workFingerprint, totals}, null, 2));
if (attemptedFailure) process.exitCode = 2;
else if ((deadlineDeferred || resume.deferredSameRun) && processedThisRun.length === 0 && remainingItems > 0) process.exitCode = 4;
else if (remainingItems > 0) process.exitCode = 3;
