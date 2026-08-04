#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    args[key] = String(argv[++i] || '').trim();
  }
  if (!args.guard) throw new Error('Missing --guard');
  return args;
}

function keyOf(row) {
  const storeKey = String(row?.storeKey || row?.store || '').trim().toUpperCase();
  const skc = String(row?.skc || row?.SKC || '').trim();
  return storeKey && skc ? `${storeKey}::${skc}` : '';
}

function addRows(target, rows) {
  for (const row of rows || []) {
    const key = keyOf(row);
    if (key) target.add(key);
  }
}

function fallbackBlockedKeys(result) {
  const keys = new Set();
  for (const row of result?.results || []) {
    const blockedSkcs = row?.blocked?.blockedSkcs || [];
    for (const skc of blockedSkcs) {
      const key = keyOf({storeKey: row.storeKey, skc});
      if (key) keys.add(key);
    }
  }
  return keys;
}

async function driftBlockedKeys(result, root) {
  const keys = new Set();
  for (const row of result?.results || []) {
    if (!String(row?.status || '').includes('blocked')) continue;
    const rescuePath = String(row?.rescuePath || '').trim();
    if (!rescuePath) continue;
    const rescue = await readJsonOptional(path.resolve(root, rescuePath));
    addRows(keys, rescue?.rows);
  }
  return keys;
}

function directBlockedKeys(result) {
  const keys = new Set();
  for (const row of result?.results || []) {
    if (!String(row?.status || '').includes('blocked')) continue;
    const key = keyOf(row);
    if (key) keys.add(key);
  }
  return keys;
}

function plannedKeys({guard, highClickPlan, manualPlan, driftPlan, fallbackPlan}) {
  const stages = {
    highClickSpecial: new Set(),
    manualSpecialRestore: new Set(),
    driftRepair: new Set(),
    fallbackRepair: new Set(),
  };
  if (Number(guard?.highClickLowConversionSpecial?.actionCount || 0) > 0) {
    addRows(stages.highClickSpecial, highClickPlan?.rows);
  }
  if (Number(guard?.manualSpecialLimitedDiscount?.actionCount || 0) > 0) {
    addRows(stages.manualSpecialRestore, manualPlan?.rows);
  }
  if ((guard?.limitedDiscountTargetPriceDrift?.belowRows || []).length > 0) {
    for (const group of driftPlan?.groups || []) addRows(stages.driftRepair, group?.rows);
  }
  addRows(stages.fallbackRepair, fallbackPlan?.rows);
  return stages;
}

export async function assessTerminalReportReadiness({
  guard,
  highClickPlan = {},
  manualPlan = {},
  driftPlan = {},
  fallbackPlan = {},
  highClickResult = {},
  manualResult = {},
  driftResult = {},
  fallbackResult = {},
  root = ROOT,
} = {}) {
  const planned = plannedKeys({guard, highClickPlan, manualPlan, driftPlan, fallbackPlan});
  const accounted = {
    highClickSpecial: directBlockedKeys(highClickResult),
    manualSpecialRestore: directBlockedKeys(manualResult),
    driftRepair: await driftBlockedKeys(driftResult, root),
    fallbackRepair: fallbackBlockedKeys(fallbackResult),
  };
  const stages = {};
  const unhandled = [];
  for (const name of Object.keys(planned)) {
    const plannedKeysForStage = [...planned[name]].sort();
    const unhandledKeys = plannedKeysForStage.filter(key => !accounted[name].has(key));
    stages[name] = {
      plannedCount: plannedKeysForStage.length,
      accountedBlockedCount: plannedKeysForStage.length - unhandledKeys.length,
      unhandledCount: unhandledKeys.length,
      unhandledKeys,
    };
    unhandled.push(...unhandledKeys.map(key => ({stage: name, key})));
  }
  return {
    ready: unhandled.length === 0,
    unhandledCount: unhandled.length,
    stages,
    unhandled,
  };
}

async function readJsonOptional(file) {
  if (!file) return {};
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolve = value => value ? path.resolve(ROOT, value) : '';
  const result = await assessTerminalReportReadiness({
    guard: await readJsonOptional(resolve(args.guard)),
    highClickPlan: await readJsonOptional(resolve(args.highClickPlan)),
    manualPlan: await readJsonOptional(resolve(args.manualPlan)),
    driftPlan: await readJsonOptional(resolve(args.driftPlan)),
    fallbackPlan: await readJsonOptional(resolve(args.fallbackPlan)),
    highClickResult: await readJsonOptional(resolve(args.highClickResult)),
    manualResult: await readJsonOptional(resolve(args.manualResult)),
    driftResult: await readJsonOptional(resolve(args.driftResult)),
    fallbackResult: await readJsonOptional(resolve(args.fallbackResult)),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 3;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
