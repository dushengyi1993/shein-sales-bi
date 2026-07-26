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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');

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
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.date) args.date = inferDateFromPath(args.guard) || formatLocalDate(new Date());
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  if (!Number.isInteger(args.maxGroups) || args.maxGroups < 0) throw new Error(`Invalid --max-groups: ${args.maxGroups}`);
  if (args.expectedWorkFingerprint && !/^[a-f0-9]{64}$/.test(args.expectedWorkFingerprint)) {
    throw new Error(`Invalid --expected-work-fingerprint: ${args.expectedWorkFingerprint}`);
  }
  return args;
}

function splitCsv(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
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
      clearTimeout(timer);
      resolve({ok: false, exitCode: null, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr, error: error.message});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, exitCode: code, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr});
    });
  });
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

function storeConfigByKey() {
  const doc = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  return new Map((doc.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => [String(store.storeKey || '').toUpperCase(), store]));
}

async function launchStore(storeKey) {
  return await runCommand(process.execPath, ['scripts/launch_store_browser.mjs', storeKey, '--headless'], {timeoutMs: 45000});
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

async function applyRescue({storeKey, port, rescuePath, execute}) {
  const result = await runCommand(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store-key',
    storeKey,
    '--port',
    String(port),
    '--rescue',
    rescuePath,
    execute ? '--execute' : '--dry-run',
  ], {timeoutMs: execute ? 1200000 : 900000});
  return await loadToolOutput(result);
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
  return await loadToolOutput(result);
}

async function topUpAuthorizedFallbackInventory({storeKey, skc, rescuePath, execute}) {
  const commandArgs = [
    'scripts/marketing/manage_manual_limited_discount_inventory.mjs',
    '--store',
    storeKey,
    '--skc',
    skc,
    '--rescue',
    rescuePath,
    execute ? '--execute' : '--dry-run',
  ];
  if (execute) commandArgs.push('--confirm', 'AUTHORIZED_LIMITED_DISCOUNT_FALLBACK_STOCK_TOP_UP');
  return await loadToolOutput(await runCommand(process.execPath, commandArgs, {timeoutMs: 300000}));
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

async function buildPlan(args, guard) {
  const priceOverrides = args.priceOverrides || path.resolve(ROOT, guard?.targetPlanSelection?.priceOverrides || '');
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

function transactionBlockedSkcs(full) {
  const blocked = [];
  for (const row of full?.validation?.invalid || []) {
    const isExistingActivityConflict = row?.reason === 'query_goods error_code'
      && row?.error_code === 'mrs-simple_platform_limit_discounts-0006';
    if (!isExistingActivityConflict && row?.skc) blocked.push(String(row.skc));
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
    error: '',
  };
  try {
    if (!store) throw new Error(`Unknown or disabled store: ${storeKey}`);
    let rescue = await readJson(rescuePath);
    const transformedRows = (rescue.rows || []).map(row => {
      const entry = manualIndex.activeByKey.get(`${storeKey}::${String(row.skc || '').trim()}`) || null;
      if (!entry) return row;
      record.protectedManualSpecialRows.push({skc: entry.skc, specialPrice: entry.specialPrice, validTo: entry.validTo, activityStock: entry.activityStock});
      return applyManualLimitedDiscountOverride({...row, storeKey}, entry);
    });
    if (record.protectedManualSpecialRows.length) {
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
    record.launched = browserSession.ready
      ? (browserSession.launchSummary || {ok: true, reused: true})
      : summarizeRaw(await launchStore(storeKey));
    if (!record.launched.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${record.launched.stderr || record.launched.stdout || record.launched.error}`);
    const dryRun = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
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
    if (!dryRun.full?.ok && !args.dryRunOnly && record.protectedManualSpecialRows.length === 0) {
      const inventorySkcs = [...new Set((dryRun.full?.validation?.invalid || [])
        .filter(row => row.reason === 'inventory below configured activity stock')
        .map(row => String(row.skc || '').trim())
        .filter(Boolean))];
      for (const skc of inventorySkcs) {
        const inventoryDryRun = await topUpAuthorizedFallbackInventory({storeKey, skc, rescuePath, execute: false});
        const inventoryExecute = inventoryDryRun.full?.ok
          ? await topUpAuthorizedFallbackInventory({storeKey, skc, rescuePath, execute: true})
          : null;
        record.inventoryTopUps.push({
          skc,
          dryRun: inventoryDryRun.full || inventoryDryRun.parsed || summarizeRaw(inventoryDryRun),
          execute: inventoryExecute ? (inventoryExecute.full || inventoryExecute.parsed || summarizeRaw(inventoryExecute)) : null,
        });
      }
      if (inventorySkcs.length) {
        const retry = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
        record.dryRunAfterInventoryTopUp = {
          ...summarizeRaw(retry),
          out: retry.outPath ? rel(retry.outPath) : '',
          parsed: retry.parsed || null,
          result: retry.full || null,
        };
        dryRun.full = retry.full || dryRun.full;
        const remainingInventorySkcs = [...new Set((dryRun.full?.validation?.invalid || [])
          .filter(row => row.reason === 'inventory below configured activity stock')
          .map(row => String(row.skc || '').trim())
          .filter(Boolean))];
        record.inventoryBlockedSkcs = remainingInventorySkcs;
      }
    }

    const blockedSkcs = transactionBlockedSkcs(dryRun.full);
    if (blockedSkcs.length) {
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
    }
    if (dryRun.full?.alreadyCovered) {
      record.createdActivityId = dryRun.full.createdActivityId || null;
      record.status = record.blocked ? 'already_covered_subset_with_blockers' : 'manual_special_already_covered';
      record.ok = !record.blocked;
      return record;
    }
    if (args.dryRunOnly) {
      const transactionDryRun = await replaceTransactionally({storeKey, port: store.port, rescuePath, execute: false});
      record.transactionDryRun = {
        ...summarizeRaw(transactionDryRun),
        out: transactionDryRun.outPath ? rel(transactionDryRun.outPath) : '',
        result: transactionDryRun.full || null,
      };
      if (!transactionDryRun.full) throw new Error(`transactional dry-run produced no readable result for ${storeKey}`);
      if (!transactionDryRun.full.ok && !record.blocked) {
        record.blocked = classifyBlockedDryRun(transactionDryRun.full);
      }
      record.status = record.blocked ? record.blocked.type : String(transactionDryRun.full.status || 'dry_run_ok');
      record.ok = transactionDryRun.full.ok === true && !record.blocked;
      return record;
    }
    const execute = await replaceTransactionally({storeKey, port: store.port, rescuePath, execute: true});
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
    record.status = 'failed';
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
  const failed = results.filter(row => !row.ok && !row.blocked);
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
    return (previous.results || []).filter(isResumableFallbackResult);
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

const args = parseArgs(process.argv.slice(2));
let automationAuthorization = null;
const manualRegistry = await loadManualLimitedDiscountRegistry();
const manualIndex = buildManualLimitedDiscountIndex(manualRegistry, new Date());
await fs.mkdir(args.outDir, {recursive: true});
await fs.mkdir(path.join(ROOT, 'outputs', 'reports'), {recursive: true});
if (!fsSync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
const guard = await readJson(args.guard);
let build = null;
if (!args.skipBuild) build = await buildPlan(args, guard);
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
const selectedEntries = args.maxGroups > 0 ? pendingEntries.slice(0, args.maxGroups) : pendingEntries;
const deferredEntries = args.maxGroups > 0 ? pendingEntries.slice(args.maxGroups) : [];
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
  planTotals: plan.totals || null,
  rescueFiles: rescueFiles.map(entry => ({...entry, path: entry.relativePath, rescue: undefined})),
  resumedGroups: resumedResults.length,
  outputJson: rel(outputJson),
  outputMd: rel(outputMd),
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
    if (!launchSummary.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${launchSummary.stderr || launchSummary.stdout || launchSummary.error}`);
    for (const file of storeEntries) {
      const result = await processStore({
        file: {...file, path: file.path},
        storeMap,
        args,
        manualIndex,
        browserSession: {ready: true, keepOpen: true, launchSummary: {...launchSummary, reusedForStoreBatch: true}},
      });
      result.sourceRescuePath = file.relativePath;
      results.push(result);
      await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
    }
  } catch (error) {
    for (const file of storeEntries) {
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
    }
    await writeExecutionProgress({outputJson, outputMd, common, results, plan, deferredEntries});
  } finally {
    common.storeBrowserSessions = common.storeBrowserSessions || [];
    common.storeBrowserSessions.push({storeKey, launch: launchSummary, close: summarizeRaw(await closeStore(storeKey)), groupCount: storeEntries.length});
  }
}
const doc = await writeExecutionProgress({
  outputJson,
  outputMd,
  common,
  results,
  plan,
  deferredEntries,
  processingComplete: true,
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
}, null, 2));
process.exitCode = fallbackBatchExitCode({
  failedCount: doc.totals.storesFailed,
  deferredCount: deferredEntries.length,
});
