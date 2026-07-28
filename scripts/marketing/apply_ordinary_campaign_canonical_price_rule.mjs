#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildExposureTopLinkIndex,
  exposureTopRowsForCanonical,
  loadMarketingPricingPolicy,
  marketingLinkKey,
} from '../../lib/marketing_pricing_policy.mjs';
import {validateOrdinaryCampaignDocuments} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {
    selection: '',
    prices: '',
    exposureData: '',
    pricingPolicy: path.join(ROOT, 'config', 'marketing_pricing_policy.json'),
    canonical: '',
    topPrice: null,
    otherPrice: null,
    outputDir: '',
    label: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--exposure-data') args.exposureData = path.resolve(argv[++i] || '');
    else if (key === '--pricing-policy') args.pricingPolicy = path.resolve(argv[++i] || '');
    else if (key === '--canonical') args.canonical = String(argv[++i] || '').trim();
    else if (key === '--top-price') args.topPrice = Number(argv[++i]);
    else if (key === '--other-price') args.otherPrice = Number(argv[++i]);
    else if (key === '--output-dir') args.outputDir = path.resolve(argv[++i] || '');
    else if (key === '--label') args.label = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (
    !args.selection
    || !args.prices
    || !args.exposureData
    || !args.canonical
    || !Number.isFinite(args.topPrice)
    || !Number.isFinite(args.otherPrice)
    || !args.outputDir
    || !args.label
  ) {
    throw new Error('Required: --selection --prices --exposure-data --canonical --top-price --other-price --output-dir --label');
  }
  const relativeOutput = path.relative(ROOT, args.outputDir);
  if (relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('--output-dir must stay inside repository root');
  return args;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableJitter(basePrice, key) {
  const offsets = [-0.43, -0.31, -0.22, -0.14, 0.17, 0.26, 0.38, 0.47];
  const hash = crypto.createHash('sha256').update(String(key)).digest();
  return round2(Number(basePrice) + offsets[hash[0] % offsets.length]);
}

const args = parseArgs(process.argv.slice(2));
const [selection, prices, exposureData, pricingPolicy] = await Promise.all([
  fs.readFile(args.selection, 'utf8').then(JSON.parse),
  fs.readFile(args.prices, 'utf8').then(JSON.parse),
  fs.readFile(args.exposureData, 'utf8').then(JSON.parse),
  loadMarketingPricingPolicy(args.pricingPolicy),
]);
validateOrdinaryCampaignDocuments(selection, prices);

const exposureIndex = buildExposureTopLinkIndex(exposureData, pricingPolicy);
const topRows = exposureTopRowsForCanonical(exposureIndex, args.canonical);
if (topRows.length !== Number(pricingPolicy?.exposureTopLinks?.topN || 5)) {
  throw new Error(`Expected exact exposure Top ${pricingPolicy?.exposureTopLinks?.topN || 5}, got ${topRows.length}`);
}
const topKeys = new Set(topRows.map(row => marketingLinkKey(row.storeKey, row.skc)));
const changedRows = [];
for (const row of prices.items || []) {
  if (String(row.canonical || '').trim() !== args.canonical) continue;
  const linkKey = marketingLinkKey(row.storeKey, row.skc);
  const isExposureTop = topKeys.has(linkKey);
  const basePrice = isExposureTop ? args.topPrice : args.otherPrice;
  const approvedPrice = stableJitter(basePrice, `${linkKey}:${isExposureTop ? 'top' : 'other'}`);
  const platformCap = finite(row.platformAllowedMaxBasePrice);
  const actualPrice = round2(platformCap !== null && platformCap < approvedPrice ? platformCap : approvedPrice);
  const productCost = finite(row.cost);
  const fullCost = finite(row.fullCost);
  row.targetPrice = actualPrice;
  row.finalTargetPrice = actualPrice;
  row.intendedFinalTargetPrice = approvedPrice;
  row.marginBeforeStorage = productCost !== null && actualPrice > 0 ? round2((actualPrice - productCost) / actualPrice * 100) / 100 : null;
  row.marginAfterStorage = fullCost !== null && actualPrice > 0 ? round2((actualPrice - fullCost) / actualPrice * 100) / 100 : null;
  row.marginForSelection = row.selectionMarginBasis === 'product_cost_excluding_storage'
    ? row.marginBeforeStorage
    : row.marginAfterStorage;
  row.actualExposureTop5 = isExposureTop;
  row.userApprovedCanonicalPriceRule = {
    canonical: args.canonical,
    exposureWindowDays: 7,
    baseTopPriceSar: args.topPrice,
    baseOtherPriceSar: args.otherPrice,
    approvedPriceSar: approvedPrice,
    actualPlatformPriceSar: actualPrice,
    platformForced: platformCap !== null && platformCap < approvedPrice,
  };
  row.note = [
    `用户批准：7天曝光前五约 ${args.topPrice} SAR，其他约 ${args.otherPrice} SAR；按店铺+SKC稳定小数微调`,
    isExposureTop ? '命中当前全局7天曝光前五' : '当前不在全局7天曝光前五',
    platformCap !== null && platformCap < approvedPrice
      ? `平台最低档 ${platformCap} SAR 低于批准微调价 ${approvedPrice} SAR，按平台档执行`
      : '',
  ].filter(Boolean).join('；');
  changedRows.push({
    storeKey: row.storeKey,
    activityId: row.activityId,
    skc: row.skc,
    isExposureTop,
    basePrice,
    approvedPrice,
    platformCap,
    actualPrice,
  });
}
if (!changedRows.length) throw new Error(`No rows matched canonical: ${args.canonical}`);
if (changedRows.some(row => Number.isInteger(row.actualPrice) && !(row.platformCap !== null && row.platformCap < row.approvedPrice))) {
  throw new Error('Non-platform-forced user price remained an integer');
}

for (const doc of [selection, prices]) {
  doc.baselineForNextOrdinaryActivity = false;
  doc.baselineForLimitedDiscountFallback = false;
  doc.executionStatus = 'candidate_user_price_rule_applied_pending_lock';
  doc.scope = {...(doc.scope || {}), phase: args.label, submit: false};
  delete doc.planMetadata;
  delete doc.approvedAt;
  delete doc.executedAt;
}
prices.userApprovedCanonicalPriceRules = [
  ...(prices.userApprovedCanonicalPriceRules || []).filter(rule => rule.canonical !== args.canonical),
  {
    canonical: args.canonical,
    topPriceSar: args.topPrice,
    otherPriceSar: args.otherPrice,
    topN: topRows.length,
    exposureMetricField: topRows[0]?.rankMetricField || '',
    exposureMetricLabel: topRows[0]?.rankMetricLabel || '',
    source: path.relative(ROOT, args.exposureData).replaceAll(path.sep, '/'),
  },
];
validateOrdinaryCampaignDocuments(selection, prices);

await fs.mkdir(args.outputDir, {recursive: true});
const selectionFile = path.join(args.outputDir, `selection-plan-${args.label}.json`);
const priceFile = path.join(args.outputDir, `price-overrides-${args.label}.json`);
const auditFile = path.join(args.outputDir, `user-price-rule-audit-${args.label}.json`);
await Promise.all([
  fs.writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`, 'utf8'),
  fs.writeFile(priceFile, `${JSON.stringify(prices, null, 2)}\n`, 'utf8'),
  fs.writeFile(auditFile, `${JSON.stringify({
    ok: true,
    canonical: args.canonical,
    topPriceSar: args.topPrice,
    otherPriceSar: args.otherPrice,
    topRows,
    changedRows,
  }, null, 2)}\n`, 'utf8'),
]);
console.log(JSON.stringify({
  ok: true,
  selectionFile,
  priceFile,
  auditFile,
  changedRows: changedRows.length,
  exposureTop5: topRows.map(row => ({storeKey: row.storeKey, skc: row.skc, exposure: row.score})),
}, null, 2));
