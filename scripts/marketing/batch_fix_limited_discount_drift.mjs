#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
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

async function findRescueFiles(planDir, storeKey) {
  const entries = await fs.readdir(planDir, {withFileTypes: true});
  const matches = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => new RegExp(`^limited-drift-rescue-${storeKey}-.*\\.json$`, 'i').test(name))
    .sort();
  if (!matches.length) {
    throw new Error(`Expected at least one rescue file for ${storeKey}, found none`);
  }
  return matches.map(name => path.join(planDir, name));
}

async function discoverStores(planDir) {
  const entries = await fs.readdir(planDir, {withFileTypes: true});
  const stores = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^limited-drift-rescue-([A-Z0-9]+)-.*\.json$/i);
    if (!match) continue;
    const storeKey = match[1].toUpperCase();
    if (seen.has(storeKey)) continue;
    seen.add(storeKey);
    stores.push(storeKey);
  }
  stores.sort((a, b) => a.localeCompare(b));
  return stores;
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
  return await runCommand(
    process.execPath,
    ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'],
    {timeoutMs: 90000},
  );
}

async function applyRescue({storeKey, port, rescuePath, execute}) {
  const result = await runCommand(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store',
    storeKey,
    '--port',
    String(port),
    '--rescue',
    rescuePath,
    execute ? '--execute' : '--dry-run',
  ], {timeoutMs: 900000});
  const loaded = await loadToolOutputFromStdout(result);
  return {...result, parsed: loaded.summary, full: loaded.full, outPath: loaded.outPath};
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
  const result = await runCommand(process.execPath, commandArgs, {timeoutMs: 300000});
  const loaded = await loadToolOutputFromStdout(result);
  return {...result, parsed: loaded.summary, full: loaded.full, outPath: loaded.outPath};
}

async function removeSkcs({storeKey, activityId, skcs, execute}) {
  const result = await runCommand(process.execPath, [
    'scripts/marketing/remove_skc_from_limited_discount.mjs',
    '--stores',
    storeKey,
    '--activity-id',
    String(activityId),
    '--skcs',
    skcs.join(','),
    execute ? '--execute' : '--dry-run',
  ], {timeoutMs: 600000});
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

function conflictActivitiesFromApply(full) {
  const activities = full?.before?.conflictActivities || [];
  return activities.map(activity => ({
    activityId: Number(activity.activity_id),
    actName: activity.act_name,
    state: activity.state,
    startTime: activity.start_time,
    endTime: activity.end_time,
    goodsCount: Number(activity.goodsCount || 0),
    targetCount: Number(activity.targetCount || 0),
    extraCount: Number(activity.extraCount || 0),
    targetSkcs: [...new Set((activity.targetSkcs || []).map(String).filter(Boolean))],
    extraSkcs: [...new Set((activity.extraSkcs || []).map(String).filter(Boolean))],
  })).filter(activity => Number.isFinite(activity.activityId) && activity.activityId > 0);
}

function oldActivitiesToRemove(full, rescue) {
  const sourceName = String(rescue.sourceLimitedDiscountName || '').trim();
  const targetSet = new Set((rescue.rows || []).map(row => String(row.skc || '').trim()).filter(Boolean));
  return conflictActivitiesFromApply(full)
    .filter(activity => {
      const nameMatches = sourceName && String(activity.actName || '').trim() === sourceName;
      const hasTargetSkc = activity.targetSkcs.some(skc => targetSet.has(skc));
      return nameMatches && hasTargetSkc;
    })
    .map(activity => ({
      ...activity,
      targetSkcs: activity.targetSkcs.filter(skc => targetSet.has(skc)),
    }))
    .filter(activity => activity.targetSkcs.length);
}

function alreadyCoveredActivities(full, rescue) {
  const sourceName = String(rescue.sourceLimitedDiscountName || '').trim();
  const targetSet = new Set((rescue.rows || []).map(row => String(row.skc || '').trim()).filter(Boolean));
  return conflictActivitiesFromApply(full)
    .filter(activity => String(activity.actName || '').trim() !== sourceName)
    .filter(activity => activity.extraCount === 0)
    .filter(activity => activity.targetSkcs.some(skc => targetSet.has(skc)));
}

function platformBlockedSkcs(full) {
  const invalid = full?.validation?.invalid || [];
  const blocked = [];
  for (const row of invalid) {
    const skc = String(row.skc || '').trim();
    if (!skc) continue;
    const isOnlyOldLimitedConflict =
      row.reason === 'query_goods error_code' &&
      row.error_code === 'mrs-simple_platform_limit_discounts-0006';
    if (!isOnlyOldLimitedConflict) {
      blocked.push({
        skc,
        reason: row.reason || '',
        error_code: row.error_code || '',
        inventory: row.inventory,
        minStock: row.minStock,
        price: row.price,
        maxSupplyPrice: row.maxSupplyPrice,
        interceptSupplyPrice: row.interceptSupplyPrice,
      });
    }
  }
  const bySkc = new Map();
  for (const row of blocked) if (!bySkc.has(row.skc)) bySkc.set(row.skc, row);
  return [...bySkc.values()];
}

async function writeSubsetRescue({storeKey, originalRescue, originalPath, blockedRows, outDir}) {
  const blockedSet = new Set(blockedRows.map(row => row.skc));
  const keptRows = (originalRescue.rows || []).filter(row => !blockedSet.has(String(row.skc)));
  const subset = {
    ...originalRescue,
    createdAt: new Date().toISOString(),
    parentRescue: rel(originalPath),
    purpose: `${originalRescue.purpose || 'limited_discount_target_price_drift_rescue'}_platform_blocked_subset`,
    excludedPlatformBlockedSkcs: blockedRows,
    originalRowCount: (originalRescue.rows || []).length,
    executableRowCount: keptRows.length,
    rows: keptRows,
  };
  const date = inferDateFromPath(originalRescue.purpose) || inferDateFromPath(originalRescue.sourceGuard) || inferDateFromPath(originalPath) || 'unknown';
  const file = path.join(outDir, `limited-drift-rescue-${storeKey}-platform-blocked-subset-${date}.json`);
  await fs.writeFile(file, JSON.stringify(subset, null, 2), 'utf8');
  return {path: file, rescue: subset};
}

function verifyExecuteResult(full, expectedSkcs) {
  const expected = [...new Set(expectedSkcs.map(String).filter(Boolean))].sort();
  const conflictActivities = full?.after?.conflictActivities || [];
  const overlapSkcs = [...new Set(conflictActivities
    .flatMap(activity => activity.targetSkcs || [])
    .map(row => String(row || '').trim())
    .filter(Boolean))].sort();
  const createdActivityId = full?.createdActivityId || null;
  const uncovered = expected.filter(skc => !overlapSkcs.includes(skc));
  const duplicateOverlapSkcs = full?.after?.duplicateOverlapSkcs || [];
  return {
    ok: !!full?.ok && uncovered.length === 0 && duplicateOverlapSkcs.length === 0,
    createdActivityId,
    expectedSkcs: expected,
    overlapSkcs,
    uncovered,
    duplicateOverlapSkcs,
    afterSummary: full?.after ? {
      overlapSkcCount: full.after.overlapSkcCount,
      unexpectedUncoveredAfter: full.after.unexpectedUncoveredAfter,
      activeOrFuture: full.after.activeOrFuture,
      conflictActivities: conflictActivities.map(activity => ({
        activityId: activity.activity_id,
        actName: activity.act_name,
        state: activity.state,
        targetCount: activity.targetCount,
        extraCount: activity.extraCount,
        targetSkcs: activity.targetSkcs,
      })),
    } : null,
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

async function processStore(storeKey, rescuePath, args, manualIndex) {
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
    record.launched = summarizeRaw(await launchStore(storeKey));

    const initialDryRun = await applyRescue({storeKey, port: store.port, rescuePath: activeRescuePath, execute: false});
    record.initialDryRun = summarizeCommand(initialDryRun);
    if (!initialDryRun.full) {
      throw new Error(`initial dry-run did not produce a readable result for ${storeKey}: ${initialDryRun.stderr || initialDryRun.stdout || initialDryRun.error || ''}`);
    }
    record.discoveredOldActivities = conflictActivitiesFromApply(initialDryRun.full);

    const existingCovered = alreadyCoveredActivities(initialDryRun.full, rescue);
    if (existingCovered.length && !oldActivitiesToRemove(initialDryRun.full, rescue).length) {
      const coveredSkcs = [...new Set(existingCovered.flatMap(activity => activity.targetSkcs))].sort();
      const missing = targetSkcs.filter(skc => !coveredSkcs.includes(skc));
      if (!missing.length) {
        record.readback = {
          ok: true,
          createdActivityId: existingCovered[0].activityId,
          expectedSkcs: targetSkcs.slice().sort(),
          overlapSkcs: coveredSkcs,
          uncovered: [],
          duplicateOverlapSkcs: [],
          afterSummary: {conflictActivities: existingCovered},
        };
        record.ok = true;
        record.status = 'already_created';
        return record;
      }
    }

    let activitiesToRemove = oldActivitiesToRemove(initialDryRun.full, rescue);
    if (!activitiesToRemove.length) {
      record.removals.push({
        skipped: true,
        reason: 'no matching old limited-discount activity currently contains target SKCs; treating as already removed',
        skcs: targetSkcs,
      });
    }
    for (const activity of activitiesToRemove) {
      const skcs = activity.targetSkcs.length ? activity.targetSkcs : targetSkcs;
      const removeResult = await removeSkcs({
        storeKey,
        activityId: activity.activityId,
        skcs,
        execute: true,
      });
      record.removals.push({
        activityId: activity.activityId,
        actName: activity.actName,
        skcs,
        command: summarizeCommand(removeResult),
        result: removeResult.full?.results?.[0] ? {
          ok: removeResult.full.results[0].ok,
          beforeTotalSkcs: removeResult.full.results[0].before?.totalSkcs,
          afterTotalSkcs: removeResult.full.results[0].after?.totalSkcs,
          stillPresent: removeResult.full.results[0].after?.stillPresent,
          missingPreserved: removeResult.full.results[0].after?.missingPreserved,
          reason: removeResult.full.results[0].reason || removeResult.full.results[0].error?.message || '',
        } : null,
      });
      if (!removeResult.full?.ok) {
        throw new Error(`remove_skc failed for ${storeKey} activity ${activity.activityId}`);
      }
    }

    let postDeleteDryRun = await applyRescue({storeKey, port: store.port, rescuePath: activeRescuePath, execute: false});
    record.postDeleteDryRun = summarizeCommand(postDeleteDryRun);

    const remainingOld = oldActivitiesToRemove(postDeleteDryRun.full, rescue);
    if (remainingOld.length) {
      for (const activity of remainingOld) {
        const removeResult = await removeSkcs({
          storeKey,
          activityId: activity.activityId,
          skcs: activity.targetSkcs,
          execute: true,
        });
        record.removals.push({
          activityId: activity.activityId,
          actName: activity.actName,
          skcs: activity.targetSkcs,
          retryAfterPostDeleteDryRun: true,
          command: summarizeCommand(removeResult),
          result: removeResult.full?.results?.[0] ? {
            ok: removeResult.full.results[0].ok,
            beforeTotalSkcs: removeResult.full.results[0].before?.totalSkcs,
            afterTotalSkcs: removeResult.full.results[0].after?.totalSkcs,
            stillPresent: removeResult.full.results[0].after?.stillPresent,
            missingPreserved: removeResult.full.results[0].after?.missingPreserved,
            reason: removeResult.full.results[0].reason || removeResult.full.results[0].error?.message || '',
          } : null,
        });
        if (!removeResult.full?.ok) {
          throw new Error(`retry remove_skc failed for ${storeKey} activity ${activity.activityId}`);
        }
      }
      postDeleteDryRun = await applyRescue({storeKey, port: store.port, rescuePath: activeRescuePath, execute: false});
      record.postRetryRemoveDryRun = summarizeCommand(postDeleteDryRun);
    }

    const coveredAfterRemoval = alreadyCoveredActivities(postDeleteDryRun.full, rescue);
    if (coveredAfterRemoval.length) {
      const coveredSkcs = [...new Set(coveredAfterRemoval.flatMap(activity => activity.targetSkcs))].sort();
      const missing = targetSkcs.filter(skc => !coveredSkcs.includes(skc));
      if (!missing.length) {
        record.readback = {
          ok: true,
          createdActivityId: coveredAfterRemoval[0].activityId,
          expectedSkcs: targetSkcs.slice().sort(),
          overlapSkcs: coveredSkcs,
          uncovered: [],
          duplicateOverlapSkcs: [],
          afterSummary: {conflictActivities: coveredAfterRemoval},
        };
        record.ok = true;
        record.status = 'already_created';
        return record;
      }
    }

    const inventoryBlocked = (postDeleteDryRun.full?.validation?.invalid || [])
      .filter(row => row.reason === 'inventory below configured activity stock')
      .map(row => String(row.skc || '').trim())
      .filter(Boolean);
    if (inventoryBlocked.length && !args.dryRunOnly) {
      for (const skc of [...new Set(inventoryBlocked)]) {
        const inventoryDryRun = await topUpAuthorizedFallbackInventory({
          storeKey,
          skc,
          rescuePath: activeRescuePath,
          execute: false,
        });
        const inventoryExecute = inventoryDryRun.full?.ok
          ? await topUpAuthorizedFallbackInventory({
            storeKey,
            skc,
            rescuePath: activeRescuePath,
            execute: true,
          })
          : null;
        record.inventoryTopUps.push({
          skc,
          dryRun: inventoryDryRun.full || inventoryDryRun.parsed || summarizeRaw(inventoryDryRun),
          execute: inventoryExecute ? (inventoryExecute.full || inventoryExecute.parsed || summarizeRaw(inventoryExecute)) : null,
        });
      }
      if (record.inventoryTopUps.some(item => item.execute?.ok)) {
        postDeleteDryRun = await applyRescue({storeKey, port: store.port, rescuePath: activeRescuePath, execute: false});
        record.postInventoryTopUpDryRun = summarizeCommand(postDeleteDryRun);
      }
    }

    record.blockedSkcs = platformBlockedSkcs(postDeleteDryRun.full);

    const subset = await writeSubsetRescue({
      storeKey,
      originalRescue: rescue,
      originalPath: rescuePath,
      blockedRows: record.blockedSkcs,
      outDir: args.outDir,
    });
    record.subsetRescuePath = rel(subset.path);

    const executableSkcs = subset.rescue.rows.map(row => String(row.skc));
    if (!executableSkcs.length) {
      record.skippedCreate = true;
      record.status = 'all_platform_blocked';
      record.ok = true;
      return record;
    }

    if (args.dryRunOnly) {
      record.skippedCreate = true;
      record.status = 'dry_run_only';
      record.ok = false;
      return record;
    }

    const executeApply = await applyRescue({storeKey, port: store.port, rescuePath: subset.path, execute: true});
    record.executeApply = summarizeCommand(executeApply);
    record.readback = verifyExecuteResult(executeApply.full, executableSkcs);
    if (!record.readback.ok) {
      throw new Error(`execute/readback failed for ${storeKey}`);
    }
    record.ok = true;
    record.status = record.blockedSkcs.length ? 'created_subset_with_platform_blockers' : 'created_all';
    return record;
  } catch (error) {
    record.ok = false;
    record.status = 'failed';
    record.error = error.message;
    return record;
  } finally {
    const closeResult = await closeStore(storeKey);
    record.close = summarizeRaw(closeResult);
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

const args = parseArgs(process.argv.slice(2));
const automationAuthorization = args.dryRunOnly ? null : await assertMarketingAutomationAuthorization({
  action: MARKETING_AUTOMATION_ACTIONS.REPAIR_TARGET_PRICE_DRIFT,
});
const manualRegistry = await loadManualLimitedDiscountRegistry();
const manualIndex = buildManualLimitedDiscountIndex(manualRegistry, new Date());
await fs.mkdir(args.outDir, {recursive: true});
if (!fssync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
const buildPlan = await buildRescuePlanIfNeeded(args);
if (!buildPlan.skipped && !buildPlan.ok) {
  throw new Error(`build_limited_discount_drift_rescue_plan failed: ${buildPlan.stderr || buildPlan.stdout || buildPlan.error || ''}`);
}
if (!fssync.existsSync(args.planDir)) throw new Error(`Plan dir does not exist after build step: ${args.planDir}`);
if (!args.stores.length) args.stores = await discoverStores(args.planDir);
if (!args.stores.length) {
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
    totals: summarizeTotals([]),
    results: [],
  };
  await fs.writeFile(args.out, JSON.stringify(emptyDoc, null, 2), 'utf8');
  console.log(JSON.stringify({ok: true, out: rel(args.out), reason: 'no rescue files discovered', totals: emptyDoc.totals}, null, 2));
  process.exit(0);
}

const startedAt = new Date().toISOString();
const results = [];
for (const storeKey of args.stores) {
  const rescuePaths = await findRescueFiles(args.planDir, storeKey);
  for (const rescuePath of rescuePaths) {
    console.log(`[${new Date().toISOString()}] processing ${storeKey} rescue=${rel(rescuePath)}`);
    const result = await processStore(storeKey, rescuePath, args, manualIndex);
    results.push(result);
    await fs.writeFile(args.out, JSON.stringify({
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
      guard: rel(args.guard),
      date: args.date,
      planDir: rel(args.planDir),
      outDir: rel(args.outDir),
      dryRunOnly: args.dryRunOnly,
      automationAuthorization,
      buildPlan,
      totals: summarizeTotals(results),
      results,
    }, null, 2), 'utf8');
    console.log(JSON.stringify({
      storeKey,
      rescuePath: rel(rescuePath),
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
        ok: item.skipped ? true : item.result?.ok,
        skipped: item.skipped || false,
      })),
      blockedSkcs: result.blockedSkcs,
      createdActivityId: result.readback?.createdActivityId || null,
      subsetRescuePath: result.subsetRescuePath,
      error: result.error,
    }, null, 2));
  }
}

const finalDoc = {
  createdAt: startedAt,
  finishedAt: new Date().toISOString(),
  guard: rel(args.guard),
  date: args.date,
  planDir: rel(args.planDir),
  outDir: rel(args.outDir),
  dryRunOnly: args.dryRunOnly,
  automationAuthorization,
  buildPlan,
  totals: summarizeTotals(results),
  results,
};
await fs.writeFile(args.out, JSON.stringify(finalDoc, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: results.every(result => result.ok),
  out: rel(args.out),
  totals: finalDoc.totals,
}, null, 2));
if (!results.every(result => result.ok)) process.exitCode = 2;

function summarizeTotals(results) {
  const storeKeys = [...new Set(results.map(result => result.storeKey).filter(Boolean))];
  const failedStoreKeys = new Set(results.filter(result => !result.ok).map(result => result.storeKey).filter(Boolean));
  const targetSkcs = results.reduce((sum, result) => sum + (result.targetSkcs?.length || 0), 0);
  const removedSkcs = results.reduce((sum, result) => (
    sum + (result.removals || [])
      .filter(item => !item.skipped && item.result?.ok)
      .reduce((inner, item) => inner + (item.skcs?.length || 0), 0)
  ), 0);
  const blockedSkcs = results.reduce((sum, result) => sum + (result.blockedSkcs?.length || 0), 0);
  const createdSkcs = results.reduce((sum, result) => sum + (result.readback?.overlapSkcs?.length || 0), 0);
  return {
    storesProcessed: storeKeys.length,
    storesOk: storeKeys.length - failedStoreKeys.size,
    storesFailed: failedStoreKeys.size,
    groupsProcessed: results.length,
    targetSkcs,
    removedSkcs,
    blockedSkcs,
    createdSkcs,
    statuses: results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] || 0) + 1;
      return acc;
    }, {}),
  };
}
