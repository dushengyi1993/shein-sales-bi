#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadExactHighClickSpecialPlan,
  loadExactManualRepairPlan,
  loadExactDriftRepairManifest,
  loadExactFallbackRepairPlan,
  sha256File,
} from '../../lib/marketing_repair_manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'build';
  const args = {command};
  const start = command === argv[0] ? 1 : 0;
  for (let i = start; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    args[key] = value;
  }
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

function preserveStage(existing, next) {
  if (!existing || existing.inputFingerprint !== next.inputFingerprint) return next;
  if (!['completed', 'blocked', 'failed'].includes(String(existing.status || ''))) return next;
  return {...next, ...existing, inputFingerprint: next.inputFingerprint};
}

function queueStatusFromStages(stages, {empty = false, afterUpdate = false} = {}) {
  if (empty) return 'completed';
  const statuses = Object.values(stages).map(stage => String(stage?.status || 'pending'));
  if (statuses.some(status => status === 'failed')) return 'failed';
  const terminal = statuses.every(status => ['not_required', 'completed', 'blocked'].includes(status));
  if (!terminal) return 'pending';
  if (statuses.some(status => status === 'blocked')) return 'blocked';
  return afterUpdate ? 'awaiting_final_readback' : 'completed';
}

async function buildQueue(args) {
  const date = String(args.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date: ${date || 'missing'}`);
  const guardPath = path.resolve(ROOT, args.guard || `outputs/reports/marketing-daily-guard-${date}.json`);
  const manualPlanPath = path.resolve(ROOT, args.manualPlan || `tmp/marketing-signup/manual-limited-discount-restore/${date}/manual-limited-discount-restore-plan.json`);
  const highClickPlanPath = path.resolve(ROOT, args.highClickPlan || `outputs/reports/high-click-low-conversion-special-plan-${date}.json`);
  const driftPlanDir = path.resolve(ROOT, args.driftPlanDir || `tmp/marketing-signup/limited-discount-fallback/target-price-drift-${date}`);
  const fallbackPlanPath = path.resolve(ROOT, args.fallbackPlan || `outputs/reports/new-listing-7d-limited-discount-plan-${date}.json`);
  const queuePath = path.resolve(ROOT, args.queue || `state/cloud_marketing_live_guard/repair-queues/marketing-repair-${date}.json`);
  const guard = await readJson(guardPath);
  if (String(guard.reportDate || '') !== date) throw new Error(`Guard reportDate mismatch: expected=${date} actual=${guard.reportDate || 'missing'}`);

  const manualRows = Number(guard?.manualSpecialLimitedDiscount?.actionCount || 0);
  const highClickRows = Number(guard?.highClickLowConversionSpecial?.actionCount || 0);
  const driftRows = Number((guard?.limitedDiscountTargetPriceDrift?.belowRows || []).length);
  const guardHash = await sha256File(guardPath);
  const highClick = await loadExactHighClickSpecialPlan({
    root: ROOT,
    planPath: highClickPlanPath,
    guardPath,
    date,
  });
  if (highClick.entries.length !== highClickRows) {
    throw new Error(`High-click queue row mismatch: guard=${highClickRows} plan=${highClick.entries.length}`);
  }

  let manual = null;
  if (manualRows > 0) {
    manual = await loadExactManualRepairPlan({root: ROOT, planPath: manualPlanPath, guardPath, date});
    if (manual.entries.length !== manualRows) {
      throw new Error(`Manual queue row mismatch: guard=${manualRows} plan=${manual.entries.length}`);
    }
  }

  let drift = null;
  if (driftRows > 0) {
    drift = await loadExactDriftRepairManifest({root: ROOT, planDir: driftPlanDir, guardPath, date});
    const manifestRows = drift.entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
    if (manifestRows !== driftRows) throw new Error(`Drift queue row mismatch: guard=${driftRows} manifest=${manifestRows}`);
  }

  const fallback = await loadExactFallbackRepairPlan({root: ROOT, planPath: fallbackPlanPath, guardPath, date});
  const fallbackRows = fallback.entries.reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const driftKeys = new Set((drift?.entries || []).flatMap(entry => entry.rescue.rows || [])
    .map(row => `${String(row?.storeKey || '').trim().toUpperCase()}::${String(row?.skc || '').trim()}`));
  const fallbackKeys = new Set(fallback.entries.flatMap(entry => entry.rescue.rows || [])
    .map(row => `${String(row?.storeKey || '').trim().toUpperCase()}::${String(row?.skc || '').trim()}`));
  const manualKeys = new Set((manual?.entries || []).map(entry => `${entry.storeKey}::${entry.skc}`));
  const highClickKeys = new Set(highClick.entries.map(entry => entry.key));
  const allKeys = [...highClickKeys, ...manualKeys, ...driftKeys, ...fallbackKeys];
  const countsByKey = allKeys.reduce((acc, key) => acc.set(key, (acc.get(key) || 0) + 1), new Map());
  const overlappingWorkKeys = [...countsByKey.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
  if (overlappingWorkKeys.length) {
    throw new Error(`Repair stages overlap on ${overlappingWorkKeys.length} exact store+SKC keys: ${overlappingWorkKeys.slice(0, 20).join(',')}`);
  }
  const existing = await readJson(queuePath).catch(() => null);
  const now = new Date().toISOString();
  const stageDefinitions = {
    highClickSpecial: {
      status: highClickRows > 0 ? 'pending' : 'not_required',
      rows: highClickRows,
      groups: highClick.entries.length,
      planPath: highClick.planRelativePath,
      inputFingerprint: hashJson({guardHash, workFingerprint: highClick.workFingerprint}),
      workFingerprint: highClick.workFingerprint,
      updatedAt: now,
    },
    manualSpecialRestore: {
      status: manualRows > 0 ? 'pending' : 'not_required',
      rows: manualRows,
      groups: manual?.entries.length || 0,
      planPath: manual?.planRelativePath || '',
      inputFingerprint: manual
        ? hashJson({guardHash, workFingerprint: manual.workFingerprint})
        : hashJson({guardHash, stage: 'manualSpecialRestore', manualRows: 0}),
      workFingerprint: manual?.workFingerprint || '',
      updatedAt: now,
    },
    driftRepair: {
      status: driftRows > 0 ? 'pending' : 'not_required',
      rows: driftRows,
      groups: drift?.entries.length || 0,
      planPath: drift?.manifestRelativePath || '',
      inputFingerprint: drift
        ? hashJson({guardHash, workFingerprint: drift.workFingerprint})
        : hashJson({guardHash, stage: 'driftRepair', driftRows: 0}),
      workFingerprint: drift?.workFingerprint || '',
      updatedAt: now,
    },
    fallbackRepair: {
      status: fallbackRows > 0 ? 'pending' : 'not_required',
      rows: fallbackRows,
      groups: fallback.entries.length,
      planPath: fallback.planRelativePath,
      inputFingerprint: hashJson({guardHash, workFingerprint: fallback.workFingerprint}),
      workFingerprint: fallback.workFingerprint,
      updatedAt: now,
    },
  };
  const stages = Object.fromEntries(Object.entries(stageDefinitions).map(([name, stage]) => [
    name,
    preserveStage(existing?.stages?.[name], stage),
  ]));
  const totalRows = highClickRows + manualRows + driftRows + fallbackRows;
  const totalGroups = stageDefinitions.highClickSpecial.groups + stageDefinitions.manualSpecialRestore.groups + stageDefinitions.driftRepair.groups + stageDefinitions.fallbackRepair.groups;
  const queue = {
    schemaVersion: 1,
    date,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: queueStatusFromStages(stages, {empty: totalRows === 0}),
    sourceGuard: rel(guardPath),
    sourceGuardHash: guardHash,
    queueFingerprint: hashJson({
      guardHash,
      stages: Object.fromEntries(Object.entries(stageDefinitions).map(([name, stage]) => [name, stage.inputFingerprint])),
    }),
    counts: {
      totalRows,
      totalGroups,
      highClickRows,
      highClickGroups: stageDefinitions.highClickSpecial.groups,
      manualRows,
      manualGroups: stageDefinitions.manualSpecialRestore.groups,
      driftRows,
      driftGroups: stageDefinitions.driftRepair.groups,
      fallbackRows,
      fallbackGroups: stageDefinitions.fallbackRepair.groups,
    },
    deduplication: {key: 'storeKey+skc', overlappingWorkKeys: 0},
    stages,
  };
  await writeJsonAtomic(queuePath, queue);
  console.log(JSON.stringify({ok: true, queue: rel(queuePath), status: queue.status, counts: queue.counts, queueFingerprint: queue.queueFingerprint}, null, 2));
}

async function updateStage(args) {
  const queuePath = path.resolve(ROOT, args.queue || '');
  if (!args.queue) throw new Error('Missing --queue');
  const stageName = String(args.stage || '');
  const status = String(args.status || '');
  if (!stageName || !status) throw new Error('Missing --stage or --status');
  const queue = await readJson(queuePath);
  if (!queue.stages?.[stageName]) throw new Error(`Unknown queue stage: ${stageName}`);
  queue.stages[stageName] = {
    ...queue.stages[stageName],
    status,
    readbackOk: String(args.readbackOk || 'false') === 'true',
    detail: String(args.detail || ''),
    resultPath: String(args.resultPath || ''),
    updatedAt: new Date().toISOString(),
  };
  queue.status = queueStatusFromStages(queue.stages, {afterUpdate: true});
  queue.updatedAt = new Date().toISOString();
  await writeJsonAtomic(queuePath, queue);
  console.log(JSON.stringify({ok: true, queue: rel(queuePath), stage: stageName, status, queueStatus: queue.status}, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.command === 'build') await buildQueue(args);
else if (args.command === 'update-stage') await updateStage(args);
else throw new Error(`Unknown command: ${args.command}`);
