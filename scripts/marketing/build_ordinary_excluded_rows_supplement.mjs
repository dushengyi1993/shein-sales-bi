#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateOrdinaryCampaignDocuments} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {
    sourceSelection: '',
    sourcePrices: '',
    sourceReport: '',
    outputDir: '',
    label: '',
    approvalText: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--source-selection') args.sourceSelection = path.resolve(argv[++i] || '');
    else if (key === '--source-prices') args.sourcePrices = path.resolve(argv[++i] || '');
    else if (key === '--source-report') args.sourceReport = path.resolve(argv[++i] || '');
    else if (key === '--output-dir') args.outputDir = path.resolve(argv[++i] || '');
    else if (key === '--label') args.label = String(argv[++i] || '').trim();
    else if (key === '--approval-text') args.approvalText = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.sourceSelection || !args.sourcePrices || !args.sourceReport || !args.outputDir || !args.label || !args.approvalText) {
    throw new Error('Required: --source-selection --source-prices --source-report --output-dir --label --approval-text');
  }
  const relativeOutput = path.relative(ROOT, args.outputDir);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) {
    throw new Error('--output-dir must stay inside repository root');
  }
  return args;
}

function rowKey(row) {
  return `${String(row.storeKey || row['店铺'] || '').trim().toUpperCase()}:${Number(row.activityId || row['活动ID'] || 0)}:${String(row.skc || row['SKC'] || '').trim().toLowerCase()}`;
}

function number(value) {
  const text = String(value ?? '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

const args = parseArgs(process.argv.slice(2));
const [sourceSelection, sourcePrices, sourceReport] = await Promise.all([
  fs.readFile(args.sourceSelection, 'utf8').then(JSON.parse),
  fs.readFile(args.sourcePrices, 'utf8').then(JSON.parse),
  fs.readFile(args.sourceReport, 'utf8').then(JSON.parse),
]);

const excluded = Array.isArray(sourcePrices.excluded) ? sourcePrices.excluded : [];
if (!excluded.length) throw new Error('Source prices contain no excluded rows');
const unsupportedExcluded = excluded.filter(row => (
  String(row?.excludeReason || '').trim() !== 'row_full_cost_including_storage_margin_below_floor'
));
if (unsupportedExcluded.length) {
  throw new Error(`Supplement may only include rows excluded solely by the full-cost margin floor: ${unsupportedExcluded.map(rowKey).join(',')}`);
}
const sourceExcludedKeys = new Set((sourceSelection.excluded || []).map(rowKey));
const reportByKey = new Map((sourceReport.detailRows || []).map(row => [rowKey(row), row]));
const duplicateKeys = excluded
  .map(rowKey)
  .filter((key, index, keys) => keys.indexOf(key) !== index);
if (duplicateKeys.length) throw new Error(`Duplicate excluded rows: ${duplicateKeys.join(',')}`);

const missingSelectionExcluded = excluded.filter(row => !sourceExcludedKeys.has(rowKey(row))).map(rowKey);
const missingReportRows = excluded.filter(row => !reportByKey.has(rowKey(row))).map(rowKey);
if (missingSelectionExcluded.length || missingReportRows.length) {
  throw new Error(JSON.stringify({missingSelectionExcluded, missingReportRows}));
}

const priceItems = excluded.map(row => {
  const reportRow = reportByKey.get(rowKey(row));
  const cost = number(reportRow['商品完整成本SAR']);
  const storageUnitCostSar = number(reportRow['仓储费摊销SAR/件']);
  const fullCost = number(reportRow['含仓储费成本SAR']);
  const targetPrice = number(row.targetPrice);
  const finalTargetPrice = number(row.finalTargetPrice);
  const intendedFinalTargetPrice = number(row.intendedFinalTargetPrice ?? row.finalTargetPrice);
  const marginBeforeStorage = number(row.marginBeforeStorage);
  const marginAfterStorage = number(row.marginAfterStorage);
  const marginForSelection = number(row.marginForSelection);
  if (!(cost > 0) || storageUnitCostSar === null || storageUnitCostSar < 0 || !(fullCost > 0)) {
    throw new Error(`Missing cost evidence for ${rowKey(row)}`);
  }
  if (
    !(targetPrice > 0)
    || !(finalTargetPrice > 0)
    || !(intendedFinalTargetPrice > 0)
    || marginBeforeStorage === null
    || marginAfterStorage === null
    || marginForSelection === null
  ) {
    throw new Error(`Missing price or margin evidence for ${rowKey(row)}`);
  }
  return {
    storeKey: String(row.storeKey).toUpperCase(),
    activityId: Number(row.activityId),
    skc: row.skc,
    canonical: row.canonical,
    targetPrice,
    finalTargetPrice,
    intendedFinalTargetPrice,
    cost,
    fullCost,
    storageUnitCostSar,
    marginBeforeStorage,
    marginAfterStorage,
    marginForSelection,
    selectionMarginBasis: row.selectionMarginBasis || 'full_cost_including_storage',
    isTopExposureLink: Boolean(row.isTopExposureLink),
    couponFactor: 1,
    minMarginFloor: 0.15,
    allowBelowFloor: true,
    userApprovedBelowFloor: true,
    rule: 'user_approved_include_excluded_below_full_cost_margin_floor',
    combo: '普通活动；不叠加优惠券',
    note: [
      row.note,
      `用户明确批准原剔除行全部报名：${args.approvalText}`,
      `商品成本 ${cost} SAR，仓储费 ${storageUnitCostSar} SAR/件，含仓储成本 ${fullCost} SAR`,
      '本次仅豁免含仓储成本利润率15%筛选线，不授权优惠券',
    ].filter(Boolean).join('；'),
    source: rel(args.sourcePrices),
    confirmMatch: 'user_approved_excluded_row_supplement',
  };
});

const selectionItems = priceItems.map(row => ({
  storeKey: row.storeKey,
  activityId: row.activityId,
  skc: row.skc,
  canonical: row.canonical,
  selected: true,
  rule: row.rule,
  isTopExposureLink: row.isTopExposureLink,
  allowBelowFloor: true,
  userApprovedBelowFloor: true,
}));
const stores = [...new Set(selectionItems.map(row => row.storeKey))].sort();
const activityIds = [...new Set(selectionItems.map(row => row.activityId))].sort((a, b) => a - b);
const integerPriceRows = priceItems.filter(row => Number.isInteger(row.targetPrice));
if (integerPriceRows.length) throw new Error(`Integer target prices remain: ${integerPriceRows.length}`);

const createdAt = new Date().toISOString();
const commonPolicy = {
  rule: 'user_approved_include_excluded_below_full_cost_margin_floor',
  approvalText: args.approvalText,
  targetFloorMarginPct: 15,
  exception: 'User explicitly approved all rows previously excluded only because full-cost-including-storage margin was below 15%.',
  couponPolicy: 'ordinary_campaign_only_no_coupon',
};
const selection = {
  createdAt,
  sourceSelection: rel(args.sourceSelection),
  sourcePrices: rel(args.sourcePrices),
  sourceReport: rel(args.sourceReport),
  activityIds,
  stores,
  selectionPolicy: commonPolicy,
  totals: {
    reviewRows: sourceReport.detailRows?.length || 0,
    selectedRows: selectionItems.length,
    excludedRows: 0,
    selectionItems: selectionItems.length,
  },
  scope: {
    storeKeys: stores,
    phase: `${args.label}-supplement-plan`,
    submit: false,
  },
  mode: 'allowlist',
  items: selectionItems,
  excluded: [],
};
const prices = {
  createdAt,
  sourceSelection: rel(args.sourceSelection),
  sourcePrices: rel(args.sourcePrices),
  sourceReport: rel(args.sourceReport),
  activityIds,
  stores,
  selectionPolicy: commonPolicy,
  totals: {
    reviewRows: sourceReport.detailRows?.length || 0,
    selectedRows: priceItems.length,
    excludedRows: 0,
    priceOverrideItems: priceItems.length,
  },
  scope: {
    storeKeys: stores,
    phase: `${args.label}-supplement-plan`,
  },
  items: priceItems,
  excluded: [],
};
validateOrdinaryCampaignDocuments(selection, prices);

await fs.mkdir(args.outputDir, {recursive: true});
const selectionFile = path.join(args.outputDir, `selection-plan-${args.label}.json`);
const pricesFile = path.join(args.outputDir, `price-overrides-${args.label}.json`);
const auditFile = path.join(args.outputDir, `audit-${args.label}.json`);
await fs.writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
await fs.writeFile(pricesFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8');
const audit = {
  ok: true,
  createdAt,
  sourceExcludedRows: excluded.length,
  selectedRows: selectionItems.length,
  stores,
  activityIds,
  byActivity: Object.fromEntries(activityIds.map(activityId => [
    String(activityId),
    selectionItems.filter(row => row.activityId === activityId).length,
  ])),
  byStore: Object.fromEntries(stores.map(storeKey => [
    storeKey,
    selectionItems.filter(row => row.storeKey === storeKey).length,
  ])),
  integerPriceRows: integerPriceRows.length,
  priceRange: {
    min: Math.min(...priceItems.map(row => row.targetPrice)),
    max: Math.max(...priceItems.map(row => row.targetPrice)),
  },
  marginAfterStorageRange: {
    min: Math.min(...priceItems.map(row => row.marginAfterStorage)),
    max: Math.max(...priceItems.map(row => row.marginAfterStorage)),
  },
  files: {
    selection: rel(selectionFile),
    prices: rel(pricesFile),
  },
};
await fs.writeFile(auditFile, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({...audit, auditFile: rel(auditFile)}, null, 2));
