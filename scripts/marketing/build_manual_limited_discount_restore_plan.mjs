#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildManualLimitedDiscountIndex,
  loadManualLimitedDiscountRegistry,
  manualLimitedDiscountKey,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {guard: '', outDir: '', now: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg === '--now') args.now = String(argv[++i] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  const date = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || new Date().toISOString().slice(0, 10);
  if (!args.outDir) args.outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'manual-limited-discount-restore', date);
  return args;
}

function parseNow(value) {
  if (!value) return new Date();
  const raw = String(value).replace(' ', 'T');
  return new Date(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}+08:00`);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

export function buildManualLimitedDiscountRestorePlan(guard, registry, now = new Date()) {
  const index = buildManualLimitedDiscountIndex(registry, now);
  const audit = guard.manualSpecialLimitedDiscount
    || guard.limitedDiscountTargetPriceDrift?.manualSpecialLimitedDiscount
    || {rows: []};
  const auditByKey = new Map((audit.rows || []).map(row => [manualLimitedDiscountKey(row.storeKey, row.skc), row]));
  const rows = [];
  for (const entry of index.activeByKey.values()) {
    const auditRow = auditByKey.get(manualLimitedDiscountKey(entry.storeKey, entry.skc)) || null;
    const status = auditRow?.status || 'missing';
    if (status === 'covered_exact') continue;
    rows.push({
      storeKey: entry.storeKey,
      skc: entry.skc,
      canonical: entry.canonical,
      specialPrice: entry.specialPrice,
      fixedTierPricing: entry.fixedTierPricing || null,
      activityStock: entry.activityStock,
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      currentActivityId: entry.currentActivityId,
      liveStatus: status,
      livePrices: auditRow?.livePrices || [],
      liveActivityIds: auditRow?.activityIds || [],
      liveActivityNames: auditRow?.activityNames || [],
      sourceThreadId: entry.sourceThreadId,
      sourceArtifact: entry.sourceArtifact,
    });
  }
  return {
    createdAt: new Date().toISOString(),
    reportDate: String(guard.reportDate || '').trim() || now.toISOString().slice(0, 10),
    sourceGuard: guard.sourcePath || '',
    registrySource: registry.sourcePath || '',
    activeRegistryCount: index.activeByKey.size,
    restoreCount: rows.length,
    byStatus: rows.reduce((acc, row) => ({...acc, [row.liveStatus]: (acc[row.liveStatus] || 0) + 1}), {}),
    rows,
    rescueFiles: [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guard = JSON.parse(await fs.readFile(args.guard, 'utf8'));
  guard.sourcePath = rel(args.guard);
  const registry = await loadManualLimitedDiscountRegistry();
  const plan = buildManualLimitedDiscountRestorePlan(guard, registry, parseNow(args.now));
  await fs.mkdir(args.outDir, {recursive: true});
  for (const row of plan.rows) {
    const file = path.join(args.outDir, `manual-limited-restore-${row.storeKey}-${row.skc}.json`);
    const rescue = {
    createdAt: plan.createdAt,
    storeKey: row.storeKey,
    purpose: 'manual_special_limited_discount_registry_restore',
    sourceGuard: plan.sourceGuard,
    sourceRegistry: plan.registrySource,
    sourceLimitedDiscountName: row.liveActivityNames[0] || '',
    sourceLimitedDiscountActivityIds: row.liveActivityIds,
    endTime: row.validTo,
    activityStock: row.activityStock,
    activityNamePrefix: `${row.storeKey}人工特殊限时折扣保护恢复`,
    rows: [{
      storeKey: row.storeKey,
      skc: row.skc,
      canonical: row.canonical,
      supplierNo: row.canonical,
      needsLimitedDiscount: true,
      fixedTierPricing: row.fixedTierPricing || null,
      limitedDiscountPrice: row.specialPrice,
      finalTargetPrice: row.specialPrice,
      targetPrice: row.specialPrice,
      expectedFinalNoCoupon: row.specialPrice,
      couponFactor: 1,
      sourceRule: 'manual_special_limited_discount_override',
      manualSpecialLimitedDiscount: true,
      manualSpecialValidFrom: row.validFrom,
      manualSpecialValidTo: row.validTo,
      manualSpecialCurrentActivityId: row.currentActivityId,
      action: 'restore_manual_special_limited_discount',
      note: `按保护登记恢复精确人工特殊价 ${row.specialPrice} SAR，有效至 ${row.validTo}`,
    }],
    };
    await fs.writeFile(file, `${JSON.stringify(rescue, null, 2)}\n`, 'utf8');
    plan.rescueFiles.push({storeKey: row.storeKey, skc: row.skc, path: rel(file), liveStatus: row.liveStatus});
  }
  const out = path.join(args.outDir, 'manual-limited-discount-restore-plan.json');
  await fs.writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ok: true, out: rel(out), restoreCount: plan.restoreCount, rescueFiles: plan.rescueFiles}, null, 2));
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build_manual_limited_discount_restore_plan.mjs')) {
  await main();
}
