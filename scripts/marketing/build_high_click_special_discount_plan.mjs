#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {date: '', guard: '', out: '', sourceThreadId: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = String(argv[++i] || '').trim();
    else if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg === '--out') args.out = path.resolve(argv[++i] || '');
    else if (arg === '--source-thread-id') args.sourceThreadId = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date: ${args.date || 'missing'}`);
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  if (!args.out) args.out = path.join(ROOT, 'outputs', 'reports', `high-click-low-conversion-special-plan-${args.date}.json`);
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function buildHighClickSpecialDiscountPlan({
  guard,
  guardPath,
  guardHash,
  sourceThreadId = '',
} = {}) {
  const audit = guard?.highClickLowConversionSpecial || {};
  const rows = (audit.rows || []).map(row => ({
    storeKey: String(row.storeKey || '').trim().toUpperCase(),
    skc: String(row.skc || '').trim(),
    canonical: String(row.canonical || '').trim(),
    productName: String(row.productName || row.canonical || '').trim(),
    metrics: row.metrics || {},
    specialPrice: Number(row.specialPrice),
    pricing: row.pricing || {},
    activityStock: Number(row.activityStock || audit.activityStock || 10),
    validFrom: String(row.validFrom || ''),
    validTo: String(row.validTo || ''),
    replacesExpiredRegistryEntry: row.replacesExpiredRegistryEntry === true,
    previousRegistryEntry: row.previousRegistryEntry || null,
    action: 'register_then_restore_exact_high_click_special',
  }));
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.storeKey}::${row.skc}`;
    if (!row.storeKey || !row.skc || !row.canonical) throw new Error(`High-click plan row is missing identity: ${key}`);
    if (!(row.specialPrice > 0)) throw new Error(`High-click plan row has invalid specialPrice: ${key}`);
    if (!Number.isInteger(row.activityStock) || row.activityStock <= 0) throw new Error(`High-click plan row has invalid activityStock: ${key}`);
    if (!row.validFrom || !row.validTo) throw new Error(`High-click plan row has invalid activity window: ${key}`);
    if (seen.has(key)) throw new Error(`Duplicate high-click plan key: ${key}`);
    seen.add(key);
  }
  if (Number(audit.actionCount || 0) !== rows.length) {
    throw new Error(`High-click guard count mismatch: actionCount=${audit.actionCount || 0} rows=${rows.length}`);
  }
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    reportDate: String(guard?.reportDate || ''),
    sourceGuard: rel(guardPath),
    sourceGuardHash: guardHash,
    sourceLinksData: audit.sourceLinksData || '',
    sourcePriceOverrides: audit.sourcePriceOverrides || guard?.targetPlanSelection?.priceOverrides || '',
    sourceCostMap: audit.sourceCostMap || '',
    sourceThreadId: sourceThreadId || process.env.SHEIN_BI_MARKETING_SOURCE_THREAD_ID || 'automation:shein-2',
    sourceAutomationId: 'shein-2',
    reason: 'automated_high_click_zero_sales_top5_minus_2_margin_points',
    criteria: audit.criteria || {},
    pricingRule: audit.pricingRule || {},
    activity: {
      activityStock: Number(audit.activityStock || 10),
      durationDays: Number(audit.durationDays || 7),
    },
    qualifyingCount: Number(audit.qualifyingCount || 0),
    protectedCount: Number(audit.protectedCount || 0),
    blockedCount: Number(audit.blockedCount || 0),
    actionCount: rows.length,
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guardText = await fs.readFile(args.guard, 'utf8');
  const guard = JSON.parse(guardText);
  if (String(guard.reportDate || '') !== args.date) {
    throw new Error(`Guard reportDate mismatch: expected=${args.date} actual=${guard.reportDate || 'missing'}`);
  }
  const plan = buildHighClickSpecialDiscountPlan({
    guard,
    guardPath: args.guard,
    guardHash: sha256(guardText),
    sourceThreadId: args.sourceThreadId,
  });
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  const temp = `${args.out}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await fs.rename(temp, args.out);
  console.log(JSON.stringify({
    ok: true,
    out: rel(args.out),
    actionCount: plan.actionCount,
    protectedCount: plan.protectedCount,
    blockedCount: plan.blockedCount,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build_high_click_special_discount_plan.mjs')) {
  await main();
}
