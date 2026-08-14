#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  buildManualLimitedDiscountIndex,
  loadManualLimitedDiscountRegistry,
  partitionRowsByManualLimitedDiscount,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  applyLowEtFastSellerPricePullback,
  buildLowEtFastSellerPricingContext,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
  mergeMarketingLinkRows,
} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {buildLinkRowIndexFromBi} from '../../lib/marketing_pricing_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ACTIVITY_NAME_PREFIX = '限时折扣目标价漂移修复';
const DEFAULT_ACTIVITY_STOCK = 10;

function parseArgs(argv) {
  const args = {
    guard: '',
    outDir: '',
    endTime: '',
    activityNamePrefix: DEFAULT_ACTIVITY_NAME_PREFIX,
    maxRows: 0,
    rawLinkHistory: '',
    storesConfig: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (a.startsWith('--guard=')) args.guard = path.resolve(a.slice('--guard='.length));
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (a.startsWith('--out-dir=')) args.outDir = path.resolve(a.slice('--out-dir='.length));
    else if (a === '--end-time') args.endTime = String(argv[++i] || '');
    else if (a.startsWith('--end-time=')) args.endTime = String(a.slice('--end-time='.length));
    else if (a === '--activity-name-prefix') args.activityNamePrefix = String(argv[++i] || '');
    else if (a.startsWith('--activity-name-prefix=')) args.activityNamePrefix = String(a.slice('--activity-name-prefix='.length));
    else if (a === '--max-rows') args.maxRows = Number(argv[++i] || 0);
    else if (a.startsWith('--max-rows=')) args.maxRows = Number(a.slice('--max-rows='.length));
    else if (a === '--raw-link-history') args.rawLinkHistory = path.resolve(argv[++i] || '');
    else if (a.startsWith('--raw-link-history=')) args.rawLinkHistory = path.resolve(a.slice('--raw-link-history='.length));
    else if (a === '--stores-config') args.storesConfig = path.resolve(argv[++i] || '');
    else if (a.startsWith('--stores-config=')) args.storesConfig = path.resolve(a.slice('--stores-config='.length));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  const reportDate = String(args.guard).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || '';
  if (!reportDate) throw new Error('Could not infer report date from --guard; use a marketing-daily-guard-YYYY-MM-DD.json path.');
  if (!args.outDir) args.outDir = path.join(ROOT, 'tmp', 'marketing-signup', 'limited-discount-fallback', `target-price-drift-${reportDate}`);
  if (!args.endTime) args.endTime = `${addDays(reportDate, 7)} 23:59:59`;
  return args;
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

function ymdFromText(value) {
  const match = String(value || '').match(/20\d{6}/);
  return match ? match[0] : '';
}

function safeFilePart(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unknown';
}

function rescueGroupFileName(group, reportDate) {
  const datePart = String(group.limitedDiscountNameDate || 'unknown');
  const namePart = safeFilePart(group.limitedDiscountName);
  const sourceHash = createHash('sha1')
    .update([group.storeKey, group.limitedDiscountName, group.limitedDiscountEnd].join('::'))
    .digest('hex')
    .slice(0, 8);
  return `limited-drift-rescue-${group.storeKey}-${datePart}-${namePart}-${sourceHash}-${reportDate || 'unknown'}.json`;
}

async function clearGeneratedRescueFiles(outDir) {
  const entries = await fs.readdir(outDir, {withFileTypes: true}).catch(() => []);
  const stale = entries
    .filter(entry => entry.isFile() && /^limited-drift-rescue-[A-Z0-9]+-.*\.json$/i.test(entry.name))
    .map(entry => path.join(outDir, entry.name));
  await Promise.all(stale.map(file => fs.unlink(file)));
  return stale.length;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function groupKey(row) {
  return [
    row.storeKey,
    row.limitedDiscountName || row.sourceLimitedDiscountName || '',
    row.limitedDiscountEnd || row.sourceLimitedDiscountEnd || '',
  ].join('::');
}

function exactStageKey(storeKey, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}::${String(skc || '').trim()}`;
}

function normalizeRow(row, activityStock) {
  const finalTargetPrice = num(row.finalTargetPrice);
  const limitedDiscountPrice = finalTargetPrice;
  return {
    storeKey: row.storeKey,
    skc: row.skc,
    canonical: row.canonical || '',
    supplierNo: row.canonical || row.supplierNo || '',
    currentPrice: null,
    finalTargetPrice,
    targetPrice: finalTargetPrice,
    needsLimitedDiscount: true,
    activityStock,
    limitedDiscountPrice,
    previousLimitedPrice: num(row.limitedDiscountPrice),
    previousDeltaSar: num(row.deltaSar),
    sourceRule: 'limited_discount_target_price_drift_current_window_target',
    targetPriceSource: row.targetPriceSource || '',
    priceSourceActivityId: row.activityId || '',
    sourceLimitedDiscountName: row.limitedDiscountName || '',
    sourceLimitedDiscountStart: row.limitedDiscountStart || '',
    sourceLimitedDiscountEnd: row.limitedDiscountEnd || '',
    note: 'live 限时折扣价低于当前窗口 finalTargetPrice；修正价直接兜到当前链接+窗口目标价，不使用机械15%。',
  };
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export function buildLimitedDiscountDriftRescuePlan(guard, options = {}) {
  const activityStock = Number.isInteger(Number(options.activityStock)) && Number(options.activityStock) > 0
    ? Number(options.activityStock)
    : DEFAULT_ACTIVITY_STOCK;
  const candidateRows = (guard.limitedDiscountTargetPriceDrift?.belowRows || [])
    .filter(row => row && row.storeKey && row.skc)
    .filter(row => num(row.finalTargetPrice) !== null)
    .filter(row => num(row.limitedDiscountPrice) !== null)
    .filter(row => num(row.limitedDiscountPrice) < num(row.finalTargetPrice) - 0.01);
  const highClickSpecialStageKeys = new Set((guard.highClickLowConversionSpecial?.rows || [])
    .map(row => exactStageKey(row?.storeKey || row?.store_key, row?.skc || row?.SKC))
    .filter(key => key !== '::'));
  const handledByHighClickSpecialStageRows = [];
  const ordinaryCandidateRows = [];
  for (const row of candidateRows) {
    if (highClickSpecialStageKeys.has(exactStageKey(row.storeKey, row.skc))) {
      handledByHighClickSpecialStageRows.push({
        storeKey: row.storeKey,
        skc: row.skc,
        canonical: row.canonical || '',
        limitedDiscountPrice: num(row.limitedDiscountPrice),
        finalTargetPrice: num(row.finalTargetPrice),
        reason: 'handled_by_high_click_special_stage',
      });
      continue;
    }
    ordinaryCandidateRows.push(row);
  }
  const manualIndex = options.manualIndex || buildManualLimitedDiscountIndex(options.manualRegistry || {entries: []}, options.now || new Date());
  const partitioned = partitionRowsByManualLimitedDiscount(ordinaryCandidateRows, manualIndex, options.now || new Date());
  const rows = partitioned.ordinaryRows;
  const limitedRows = [];
  const lowEtBlockedRows = [];
  for (const sourceRow of rows) {
    const normalized = normalizeRow(sourceRow, activityStock);
    if (!options.lowEtContext) {
      limitedRows.push(normalized);
      continue;
    }
    const decision = applyLowEtFastSellerPricePullback({
      row: normalized,
      context: options.lowEtContext,
      costDoc: options.costDoc || {},
    });
    if (decision.blocked) {
      lowEtBlockedRows.push({
        storeKey: normalized.storeKey,
        skc: normalized.skc,
        canonical: normalized.canonical,
        reason: decision.reason,
        evidence: decision.evidence || null,
      });
      continue;
    }
    limitedRows.push({
      ...decision.row,
      lowEtFastSellerPricePullback: decision.audit || {
        applied: false,
        reason: decision.reason,
        contextEvidenceHash: options.lowEtContext.evidenceHash,
      },
    });
  }
  const selectedRows = Number(options.maxRows || 0) > 0 ? limitedRows.slice(0, Number(options.maxRows)) : limitedRows;
  const groups = new Map();
  for (const row of selectedRows) {
    const key = groupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        storeKey: row.storeKey,
        limitedDiscountName: row.limitedDiscountName || row.sourceLimitedDiscountName || '',
        limitedDiscountNameDate: ymdFromText(row.limitedDiscountName || row.sourceLimitedDiscountName),
        limitedDiscountEnd: row.limitedDiscountEnd || row.sourceLimitedDiscountEnd || '',
        activityId: row.activityId || row.priceSourceActivityId || '',
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  const byStore = {};
  const rescueFiles = [];
  for (const group of groups.values()) {
    byStore[group.storeKey] = (byStore[group.storeKey] || 0) + group.rows.length;
  }
  return {
    createdAt: new Date().toISOString(),
    reportDate: guard.reportDate || '',
    sourceGuard: options.guardPath || '',
    sourceLiveScan: guard.limitedDiscountTargetPriceDrift?.source || '',
    sourcePriceOverrides: guard.limitedDiscountTargetPriceDrift?.planSourcePath || '',
    rule: '修正 live 限时折扣价低于当前窗口 finalTargetPrice 的行；同一 storeKey+SKC 命中高点击专属折扣时由高点击阶段优先并排除；单一目标活动可用 apply_hl_limited_discount_rescue dry-run/execute，混合活动由脚本 fail-closed 后再 split-preserve。',
    totals: {
      belowTarget: candidateRows.length,
      handledByHighClickSpecialStage: handledByHighClickSpecialStageRows.length,
      ordinaryBelowTarget: rows.length,
      protectedManualSpecial: partitioned.protectedRows.length,
      lowEtBlocked: lowEtBlockedRows.length,
      selected: selectedRows.length,
      groups: groups.size,
      stores: Object.keys(byStore).length,
    },
    byStore,
    handledByHighClickSpecialStageKeys: [...highClickSpecialStageKeys].sort(),
    handledByHighClickSpecialStageRows,
    protectedManualSpecialRows: partitioned.protectedRows.map(({row, entry}) => ({
      storeKey: entry.storeKey,
      skc: entry.skc,
      staleLimitedDiscountPrice: num(row.limitedDiscountPrice),
      staleFinalTargetPrice: num(row.finalTargetPrice),
      protectedSpecialPrice: entry.specialPrice,
      validTo: entry.validTo,
      reason: 'active manual-special registry entry defensively removed from ordinary drift rescue plan',
    })),
    lowEtBlockedRows,
    lowEtFastSellerPricePullback: options.lowEtContext ? {
      evidenceHash: options.lowEtContext.evidenceHash,
      appliedCount: selectedRows.filter(row => row.lowEtFastSellerPricePullback?.applied === true).length,
    } : null,
    groups: [...groups.values()].sort((a, b) => a.storeKey.localeCompare(b.storeKey) || String(a.limitedDiscountName).localeCompare(String(b.limitedDiscountName))),
    rescueFiles,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guard = JSON.parse(await fs.readFile(args.guard, 'utf8'));
  const manualRegistry = await loadManualLimitedDiscountRegistry();
  const endTime = args.endTime;
  const pricingPolicy = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'marketing_pricing_policy.json'), 'utf8'));
  const sourceLinksData = guard.highClickLowConversionSpecial?.sourceLinksData || 'outputs/bi-portal/sections/linksData.json';
  const sourceInventoryTrend = guard.highClickLowConversionSpecial?.sourceInventoryTrend || 'outputs/bi-portal/sections/inventoryTrend.json';
  const sourceCostMap = guard.highClickLowConversionSpecial?.sourceCostMap || 'tmp/mbrs/marketing-cost-map.json';
  const sourcePriceOverrides = guard.limitedDiscountTargetPriceDrift?.planSourcePath || guard.targetPlanSelection?.priceOverrides || '';
  const sourceRawLinkHistory = args.rawLinkHistory || 'outputs/shein_links';
  const sourceStoresConfig = args.storesConfig || 'config/stores.json';
  const [linksDataDoc, inventoryTrendDoc, baselineDoc, costDoc, storesConfig] = await Promise.all([
    fs.readFile(path.resolve(ROOT, sourceLinksData), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(ROOT, sourceInventoryTrend), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(ROOT, sourcePriceOverrides), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(ROOT, sourceCostMap), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(ROOT, sourceStoresConfig), 'utf8').then(JSON.parse),
  ]);
  const storeKeys = [...new Set((storesConfig?.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => String(store?.storeKey || store?.key || store?.store || '').trim().toUpperCase())
    .filter(Boolean))].sort();
  const latestRawLinks = collectLatestRawMarketingLinkRows({
    historyDir: path.resolve(ROOT, sourceRawLinkHistory),
    reportDate: guard.reportDate,
    storeKeys,
  });
  const latestRawCoverage = assessLatestRawMarketingLinkCoverage({
    sourceFiles: latestRawLinks.sourceFiles,
    errors: latestRawLinks.errors,
    storeKeys,
  });
  if (!latestRawCoverage.complete) {
    throw new Error(
      `Low-ET raw-link overlay incomplete: missing=${latestRawCoverage.missingStoreKeys.join(',') || '(none)'} `
      + `parseErrors=${latestRawCoverage.parseErrorCount}`,
    );
  }
  const linkRowIndex = buildLinkRowIndexFromBi(linksDataDoc);
  const mergedLinks = mergeMarketingLinkRows(
    [...linkRowIndex.byLinkKey.values()],
    latestRawLinks.rows,
  );
  const lowEtContext = buildLowEtFastSellerPricingContext({
    inventoryTrendDoc,
    linksDataDoc: {storeLinks: mergedLinks.rows},
    baselineDoc,
    costDoc,
    marketingPolicy: pricingPolicy,
    reportDate: guard.reportDate,
  });
  const activityStock = Number.isInteger(Number(pricingPolicy?.limitedDiscount?.defaultActivityStock))
    && Number(pricingPolicy.limitedDiscount.defaultActivityStock) > 0
    ? Number(pricingPolicy.limitedDiscount.defaultActivityStock)
    : DEFAULT_ACTIVITY_STOCK;
  const plan = buildLimitedDiscountDriftRescuePlan(guard, {
    guardPath: rel(args.guard),
    maxRows: args.maxRows,
    manualRegistry,
    activityStock,
    lowEtContext,
    costDoc,
  });
  await fs.mkdir(args.outDir, {recursive: true});
  const clearedStaleRescueFiles = await clearGeneratedRescueFiles(args.outDir);
  for (const group of plan.groups) {
    const file = path.join(args.outDir, rescueGroupFileName(group, plan.reportDate));
    const rescue = {
      createdAt: plan.createdAt,
      storeKey: group.storeKey,
      purpose: `limited_discount_target_price_drift_rescue_${plan.reportDate || ''}`,
      sourceGuard: plan.sourceGuard,
      sourceLiveScan: plan.sourceLiveScan,
      sourcePriceOverrides: plan.sourcePriceOverrides,
      sourceLinksData,
      sourceInventoryTrend,
      sourceCostMap,
      sourceRawLinkHistory,
      sourceStoresConfig,
      sourceLimitedDiscountName: group.limitedDiscountName,
      sourceLimitedDiscountEnd: group.limitedDiscountEnd,
      endTime,
      activityStock: group.rows[0]?.activityStock || activityStock,
      activityNamePrefix: args.activityNamePrefix,
      rows: group.rows,
    };
    await writeJson(file, rescue);
    plan.rescueFiles.push({
      storeKey: group.storeKey,
      path: rel(file),
      count: group.rows.length,
      sourceLimitedDiscountName: group.limitedDiscountName,
      sourceLimitedDiscountEnd: group.limitedDiscountEnd,
    });
  }
  const jsonPath = path.join(args.outDir, `limited-discount-target-drift-rescue-plan-${plan.reportDate || 'unknown'}.json`);
  await writeJson(jsonPath, plan);
  const mdPath = path.join(args.outDir, `limited-discount-target-drift-rescue-plan-${plan.reportDate || 'unknown'}.md`);
  const lines = [
    `# ${plan.reportDate || ''} 限时折扣目标价漂移修正计划`,
    '',
    `- belowTarget: ${plan.totals.belowTarget}`,
    `- handledByHighClickSpecialStage: ${plan.totals.handledByHighClickSpecialStage}`,
    `- selected: ${plan.totals.selected}`,
    `- groups: ${plan.totals.groups}`,
    `- stores: ${plan.totals.stores}`,
    '',
    ...(plan.handledByHighClickSpecialStageRows.length ? [
      '## 高点击专属折扣优先排除',
      ...plan.handledByHighClickSpecialStageRows.map(row => `- ${exactStageKey(row.storeKey, row.skc)} ${row.reason}`),
      '',
    ] : []),
    '## rescue files',
    ...plan.rescueFiles.map(file => `- ${file.storeKey} ${file.sourceLimitedDiscountName}: ${file.count} 行，${file.path}`),
    '',
    '执行边界：先 dry-run；单一目标活动安全通过后才 execute；混合/计划外/人工特殊价由 apply 脚本 fail-closed 后再走 split-preserve。',
  ];
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    json: rel(jsonPath),
    md: rel(mdPath),
    rescueFiles: plan.rescueFiles.length,
    rows: plan.totals.selected,
    clearedStaleRescueFiles,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build_limited_discount_drift_rescue_plan.mjs')) {
  await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
