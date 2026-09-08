import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { normalizeGoodsSnDetailed } from '../../lib/product_sku_normalizer.mjs';
import {
  buildSharedStorageCostIndex,
  findSharedStorageCost,
  storageMethodForEvidence,
  storageEvidenceBlocksSharedFallback,
} from '../../lib/marketing_shared_storage_cost.mjs';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {
  applyLowEtFastSellerPricePullbackToRows,
  buildLowEtFastSellerPricingContext,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {
  buildManualLimitedDiscountIndex,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  buildLinkRowIndexFromBi,
  buildExposureTopLinkIndex,
  exposureTopRowsForCanonical,
  inferNewListingShelfAgeDays,
  isNewListingOrdinaryMarketingActivity,
  isRecentNewListingLink,
  loadMarketingPricingPolicy,
  marketingLinkKey as exposureLinkKey,
  marginTargetsForExposurePolicy,
  pctRatioText,
} from '../../lib/marketing_pricing_policy.mjs';

const ROOT = process.cwd();
const cli = parseArgs(process.argv.slice(2));
const DATE_TAG = cli.date || '2026-06-01';
const OUTPUT_VERSION = cli.version || 'v7';
const reportJson = path.resolve(ROOT, cli.report || path.join('outputs', 'reports', `marketing-stack-review-${DATE_TAG}.json`));
const cloudBiPath = path.resolve(ROOT, cli.bi || path.join('tmp', 'sku-approval-builder', `cloud-bi-portal-data-${DATE_TAG}.json`));
const cloudCostPath = path.resolve(ROOT, cli.cost || path.join('tmp', 'sku-approval-builder', `cloud-marketing-cost-map-${DATE_TAG}.json`));
const outDir = path.resolve(ROOT, cli.outputDir || path.join('outputs', 'reports'));

const activityDoc = JSON.parse(await fs.readFile(reportJson, 'utf8'));
const cloudBi = JSON.parse(await fs.readFile(cloudBiPath, 'utf8'));
const cloudCostDoc = JSON.parse(await fs.readFile(cloudCostPath, 'utf8'));
const sharedStorageCostIndex = buildSharedStorageCostIndex(cloudBi);
const pricingPolicyPath = path.resolve(ROOT, cli.pricingPolicy || path.join('config', 'marketing_pricing_policy.json'));
const pricingPolicy = await loadMarketingPricingPolicy(pricingPolicyPath);
const cloudBiStat = fssync.statSync(cloudBiPath);
const cloudCostStat = fssync.statSync(cloudCostPath);
const defaultExposureDataPath = path.resolve(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json');
const exposureDataPath = cli.exposureData
  ? path.resolve(ROOT, cli.exposureData)
  : (fssync.existsSync(defaultExposureDataPath) ? defaultExposureDataPath : '');
const exposureBi = exposureDataPath ? JSON.parse(await fs.readFile(exposureDataPath, 'utf8')) : cloudBi;
const exposureDataStat = exposureDataPath && fssync.existsSync(exposureDataPath)
  ? fssync.statSync(exposureDataPath)
  : cloudBiStat;
const signupPricingPolicy = withSignupCliOverrides(pricingPolicy, cli);
const requestedActivityIds = new Set(
  String(cli.activities || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite),
);
const rawActivityRows = (activityDoc.detailRows || []).filter(row => (
  requestedActivityIds.size === 0 || requestedActivityIds.has(Number(row['活动ID'] ?? row.activityId))
));
const hasNewListingOrdinaryActivity = rawActivityRows.some(row => isNewListingOrdinaryMarketingActivity(row, signupPricingPolicy));
const selectedActivityStoreKeys = uniq((activityDoc.selectedStores || [])
  .map(row => String(typeof row === 'string' ? row : (row?.storeKey || row?.store_key || '')).trim().toUpperCase())
  .filter(Boolean));
const activityStoreKeys = selectedActivityStoreKeys.length
  ? selectedActivityStoreKeys
  : uniq(rawActivityRows.map(row => String(row['店铺'] || row.storeKey || '').trim().toUpperCase()).filter(Boolean));
const defaultRawLinkHistoryDir = path.resolve(ROOT, 'outputs', 'shein_links');
const rawLinkHistoryDir = cli.rawLinkHistoryDir
  ? path.resolve(ROOT, cli.rawLinkHistoryDir)
  : (fssync.existsSync(defaultRawLinkHistoryDir) ? defaultRawLinkHistoryDir : '');
const rawLinkSnapshot = rawLinkHistoryDir
  ? collectLatestRawMarketingLinkRows({
      historyDir: rawLinkHistoryDir,
      reportDate: DATE_TAG,
      storeKeys: activityStoreKeys,
      includeOffShelf: true,
    })
  : {rows: [], sourceFiles: [], errors: [], storeCount: 0};
const rawLinkCoverage = rawLinkHistoryDir
  ? assessLatestRawMarketingLinkCoverage({...rawLinkSnapshot, storeKeys: activityStoreKeys})
  : {complete: false, expectedStoreCount: activityStoreKeys.length, sourceFileCount: 0, missingStoreKeys: activityStoreKeys, parseErrorCount: 0};
const {doc: exposureBiWithRawLinks, summary: rawLinkEvidenceOverlay} = mergeRawLinkEvidenceIntoBi(exposureBi, rawLinkSnapshot.rows);
const {doc: exposureBiForRanking, summary: exposureCanonicalBackfill} = enrichExposureBiWithPlanCanonicals(exposureBiWithRawLinks, rawActivityRows);
const exposureIndex = buildExposureTopLinkIndex(exposureBiForRanking, signupPricingPolicy);
const exposureGeneratedAt = String(exposureBi?.generatedAt || exposureBi?.data?.generatedAt || '').trim();
const exposureGeneratedDate = shanghaiDate(exposureGeneratedAt);
const exposureFreshness = {
  generatedAt: exposureGeneratedAt,
  generatedDate: exposureGeneratedDate,
  reportDate: DATE_TAG,
  staleForReportDate: !exposureGeneratedDate || exposureGeneratedDate < DATE_TAG,
  sourcePath: exposureDataPath ? path.relative(ROOT, exposureDataPath) : path.relative(ROOT, cloudBiPath),
};
if (hasNewListingOrdinaryActivity && rawLinkCoverage.complete !== true) {
  throw new Error(`New-listing ordinary plan requires complete raw link snapshots: ${JSON.stringify(rawLinkCoverage)}`);
}
if (hasNewListingOrdinaryActivity && exposureFreshness.staleForReportDate) {
  throw new Error(`New-listing ordinary plan requires a linksData snapshot generated on or after ${DATE_TAG}: ${JSON.stringify(exposureFreshness)}`);
}
if (signupPricingPolicy?.exposureTopLinks?.enabled !== false && exposureIndex.positiveMetricRowCount === 0) {
  throw new Error('Ordinary marketing plan requires positive exposure metrics; raw link rows without c7/c30 exposure cannot establish the global Top5');
}
const exposureLinkIndex = buildLinkRowIndexFromBi(exposureBiForRanking);
const targetFloorMargin = pctConfigToRatio(cli.targetFloorMarginPct ?? pricingPolicy.targetFloorMarginPct ?? 15);
const selectionMarginBasis = normalizeSelectionMarginBasis(cli.selectionMarginBasis || 'full_cost_including_storage');
const storageRequiredForSelection = selectionMarginBasis !== 'product_cost_excluding_storage';
const EXECUTION_TAG = cli.executionTag || executionTagFromVersion(OUTPUT_VERSION);
const baselinePriceOverridesPath = cli.baselinePriceOverrides
  ? path.resolve(ROOT, cli.baselinePriceOverrides)
  : '';
const baselinePriceOverridesDoc = baselinePriceOverridesPath
  ? JSON.parse(await fs.readFile(baselinePriceOverridesPath, 'utf8'))
  : null;
const baselinePolicy = baselinePriceOverridesPath
  ? await loadBaselinePricePolicy(baselinePriceOverridesPath, cli.baselineUserRemarks ? path.resolve(ROOT, cli.baselineUserRemarks) : '')
  : null;
const inventoryTrendPath = path.resolve(
  ROOT,
  cli.inventoryTrend || path.join('outputs', 'bi-portal', 'sections', 'inventoryTrend.json'),
);
const inventoryTrendDoc = fssync.existsSync(inventoryTrendPath)
  ? JSON.parse(await fs.readFile(inventoryTrendPath, 'utf8'))
  : null;
const manualLimitedRegistryPath = path.resolve(
  ROOT,
  cli.manualLimitedRegistry || path.join('config', 'marketing_manual_limited_discount_overrides.json'),
);
const manualLimitedRegistryDoc = fssync.existsSync(manualLimitedRegistryPath)
  ? JSON.parse(await fs.readFile(manualLimitedRegistryPath, 'utf8'))
  : {entries: []};
const manualLimitedDiscountIndex = buildManualLimitedDiscountIndex(
  manualLimitedRegistryDoc,
  new Date(),
);
const lowEtFastSellerContext = buildLowEtFastSellerPricingContext({
      inventoryTrendDoc,
      linksDataDoc: exposureBi,
      baselineDoc: baselinePriceOverridesDoc || {items:[]},
      costDoc: cloudCostDoc,
      marketingPolicy: pricingPolicy,
      reportDate: DATE_TAG,
    });

const TRUE_COSTS = cloudCostDoc.trueCostMap || {};
const COSTS = cloudCostDoc.costMap || {};
const profitProducts = cloudBi?.profit?.products || [];
const profitByKey = new Map();
for (const p of profitProducts) {
  const standard = p.standard_goods_sn;
  for (const key of [standard, compact(standard), modelCode(standard)].filter(Boolean)) {
    profitByKey.set(compact(key), p);
  }
}

const fixedPriceBase = [
  ['SK-999食品料理机', 110], ['SM-961厨师机', 227], ['PA4-6L便携式冰箱', 160],
  ['SM-505A电动缝纫机', 110], ['TXSM-505A电动缝纫机', 110], ['SK-03012台式榨汁机', 96],
  ['SK-03038制冰机', 330], ['SK-04031胶囊咖啡机', 233], ['SK-GT-3065蒸汽熨烫机', 90],
  ['SK-3378杆式吸尘器', 150], ['SK-10075电油炸锅', 150], ['SK-6863半自动意式咖啡机', 300],
  ['SK-6810半自动意式咖啡机', 165], ['CM-121E美式咖啡机', 135], ['SK-11041蒸汽熨烫机', 70],
  ['SK-223三明治机和早餐机', 85], ['KF-JN-02便携咖啡机', 96], ['SK-185台式榨汁机', 91],
];
const specialMarginBase = [
  ['FZ-666颈部按摩器', 0.15], ['SK-7025A绞肉机', 0.25], ['SK-7027绞肉机', 0.25], ['SK-7028绞肉机', 0.25],
];
const fixedRules = buildRuleMap(fixedPriceBase);
const marginRules = buildRuleMap(specialMarginBase);

const rawRows = rawActivityRows;
if (!rawRows.length) {
  throw new Error(`Marketing activity review has no detail rows: ${reportJson}`);
}
const rows = rawRows.map(normalizeReviewRow);

const bySku = new Map();
for (const r of rows) {
  const sku = r['标准货号'] || r['供方货号'] || r['SKC'] || '未识别货号';
  if (!bySku.has(sku)) bySku.set(sku, []);
  bySku.get(sku).push(r);
}

const approvalRows = [];
const executionRows = [];
for (const [sku, group] of bySku.entries()) {
  const stores = uniq(group.map(r => r['店铺'])).sort();
  const activities = uniq(group.map(r => r['活动ID'])).sort((a, b) => Number(a) - Number(b));
  const currentPrices = group.map(r => numValue(r['当前售价SAR'])).filter(isNum);
  const productCostValues = group.map(r => r._cloudCost.productUnitCostSar).filter(v => v !== null && v !== undefined && Number(v) > 0);
  const storageKnownValues = group.map(r => r._cloudCost.storageUnitCostSar).filter(v => v !== null && v !== undefined && Number(v) >= 0);
  const fullCostValues = group.map(r => r._cloudCost.fullUnitCostSar).filter(v => v !== null && v !== undefined && Number(v) > 0);
  const platformCaps = group.map(r => {
    const current = numValue(r['当前售价SAR']);
    const minDiscount = numValue(r['平台最低降幅%']) ?? 0;
    return isNum(current) ? floor2(current * (1 - minDiscount / 100)) : null;
  }).filter(isNum);
  const oldSuggested = group.map(r => numValue(r['本次建议普通活动价SAR'])).filter(isNum);
  const couponRows = group.filter(r => String(r['优惠券活动ID/名称'] || '').trim());
  const limitRows = group.filter(r => String(r['限时折扣名称'] || '').trim());
  const storageEvidenceStatuses = uniq(group.map(r => r._cloudCost.storageQuantityEvidenceStatus).filter(Boolean));
  const skuReviewReasons = uniq(group.map(r => r._approvalNormalized?.needsReview ? r._approvalNormalized.reviewReason : '').filter(Boolean));
  const skuNeedsReview = skuReviewReasons.length > 0;
  const missingCost = productCostValues.length === 0;
  const storageMissing = !missingCost && storageKnownValues.length === 0;
  const keyList = [sku, ...group.map(r => r['供方货号'])].filter(Boolean);
  const fixed = findRule(fixedRules, keyList);
  const specialMargin = findRule(marginRules, keyList);
  const baselineRule = findBaselineRule(baselinePolicy, keyList);
  const baselineIsFixedPrice = baselineRule?.type === 'fixed_sar';
  const baselineIsMargin = baselineRule?.type === 'margin_pct';
  const hasFixedPrice = baselineIsFixedPrice || (!baselineRule && fixed !== null);
  const baseTargetMargin = hasFixedPrice ? null : (baselineIsMargin ? baselineRule.otherMargin : (specialMargin ?? 0.30));
  const exposureTargets = baseTargetMargin === null ? null : marginTargetsForExposurePolicy(baseTargetMargin, signupPricingPolicy);
  const topExposureRows = fixed !== null && !baselineRule
    ? []
    : uniqBy(
        exposureTopRowsForCanonical(exposureIndex, sku),
        row => `${row.storeKey || ''}:${row.skc}`,
      );
  const hasExposureRanking = topExposureRows.length > 0;
  const exposureRankMetricText = hasExposureRanking ? (topExposureRows[0]?.rankMetricLabel || exposureMetricText(topExposureRows[0]?.rankMetricField)) : '';
  const groupSkcs = new Set(group.map(r => String(r['SKC'] || '').trim()).filter(Boolean));
  const topExposureSkcsInGroup = topExposureRows.filter(row => groupSkcs.has(row.skc));
  const topExposureLinkKeys = new Set(topExposureRows.map(row => exposureLinkKey(row.storeKey, row.skc)));
  const rowNewListingTopTreatmentInfo = row => {
    const storeKey = String(row['店铺'] || '').trim().toUpperCase();
    const skc = String(row['SKC'] || '').trim();
    const link = exposureLinkIndex.byLinkKey.get(exposureLinkKey(storeKey, skc)) || null;
    const newListing = isRecentNewListingLink(link, signupPricingPolicy, DATE_TAG);
    const shelfAge = inferNewListingShelfAgeDays(link, DATE_TAG);
    const activityMatched = isNewListingOrdinaryMarketingActivity(row, signupPricingPolicy);
    return {
      ...newListing,
      shelfAgeDays: newListing.shelfAgeDays ?? shelfAge.value,
      shelfAgeSource: newListing.shelfAgeSource || shelfAge.source,
      // An eligible row in a New Arrivals ordinary campaign is already the
      // platform's first-signup evidence. Do not lose the approved Top5
      // treatment merely because BI has not yet backfilled the link age.
      applies: Boolean(activityMatched),
      activityMatched,
      link,
      reason: activityMatched ? 'new_listing_ordinary_activity' : newListing.reason,
    };
  };
  const newListingTreatmentKey = row => `${exposureLinkKey(row['店铺'], row['SKC'])}:${Number(row['活动ID'] || 0)}`;
  const newListingTopTreatmentByActivityLink = new Map(
    group.map(row => [newListingTreatmentKey(row), rowNewListingTopTreatmentInfo(row)]),
  );
  const newListingTopTreatmentRows = uniqBy(
    group.filter(row => newListingTopTreatmentByActivityLink.get(newListingTreatmentKey(row))?.applies),
    row => exposureLinkKey(row['店铺'], row['SKC']),
  );
  const hasNewListingTopTreatment = newListingTopTreatmentRows.length > 0;
  const rowIsTopExposure = row => {
    const linkKey = exposureLinkKey(row['店铺'], row['SKC']);
    return topExposureLinkKeys.has(linkKey) || Boolean(newListingTopTreatmentByActivityLink.get(newListingTreatmentKey(row))?.applies);
  };
  const targetMargin = hasFixedPrice ? null : (baselineIsMargin ? baselineRule.otherMargin : (hasExposureRanking ? (exposureTargets?.otherMargin ?? baseTargetMargin) : baseTargetMargin));
  const topExposureMargin = hasFixedPrice
    ? null
    : (baselineIsMargin
        ? (baselineRule.topMargin ?? baselineRule.otherMargin)
        : (!(hasExposureRanking || hasNewListingTopTreatment) ? null : (exposureTargets?.topMargin ?? null)));
  const exposureRuleText = baselineIsFixedPrice
    ? `继承上期确认价：7天曝光前五 ${fmt(baselineRule.topPrice ?? baselineRule.otherPrice)} SAR / 其他 ${fmt(baselineRule.otherPrice)} SAR`
    : baselineIsMargin
      ? `继承上期确认利润率：7天曝光前五 ${pctRatioText(topExposureMargin)} / 其他 ${pctRatioText(targetMargin)}`
      : fixed !== null
    ? '固定价/逐行覆盖价优先，不自动套曝光利润率'
    : hasExposureRanking
      ? `${exposureRankMetricText}前五 ${pctRatioText(topExposureMargin)} / 其他 ${pctRatioText(targetMargin)}`
      : hasNewListingTopTreatment
        ? `新上架7天内新品活动按曝光前五力度 ${pctRatioText(topExposureMargin)} / 其他 ${pctRatioText(targetMargin)}`
      : '曝光数据缺失：保持基础利润率';
  const targetMode = hasFixedPrice
    ? (baselineIsFixedPrice ? '继承上期确认固定价' : '固定最终成交价')
    : `${specialMargin !== null ? `目标利润率 ${pct(specialMargin)}` : '默认目标利润率 30%'}；曝光规则：${exposureRuleText}`;
  const safeProductCost = productCostValues.length ? Math.max(...productCostValues) : null;
  const targetFinal = baselineIsFixedPrice
    ? baselineRule.otherPrice
    : (!baselineRule && fixed !== null)
      ? fixed
      : (safeProductCost !== null ? ceil2(safeProductCost / (1 - targetMargin)) : null);
  const topExposureTargetFinal = baselineIsFixedPrice
    ? (baselineRule.topPrice ?? baselineRule.otherPrice)
    : ((!baselineRule && fixed !== null) || topExposureMargin === null
        ? null
        : (safeProductCost !== null ? ceil2(safeProductCost / (1 - topExposureMargin)) : null));
  // 2026-06-14: coupons are not guaranteed to trigger. Keep historical
  // what-if prices only for user-visible traffic-coupon research, never as the
  // default guaranteed target price.
  const priceFor15Coupon = targetFinal !== null ? ceil2(targetFinal / 0.85) : null;
  const priceFor50Coupon = targetFinal !== null ? ceil2(targetFinal / 0.50) : null;
  const minPlatformCap = platformCaps.length ? Math.min(...platformCaps) : null;
  const rowTargetFinalFor = row => baselineIsFixedPrice
    ? (rowIsTopExposure(row) && topExposureTargetFinal !== null ? topExposureTargetFinal : targetFinal)
    : (!baselineRule && fixed !== null)
      ? fixed
      : (rowIsTopExposure(row) && topExposureTargetFinal !== null ? topExposureTargetFinal : targetFinal);
  const rowStrategyFor = row => {
    const rowStore = String(row['店铺'] || '').trim().toUpperCase();
    const hasStoreExplicitPrice = Boolean(baselineRule?.storePrices?.[rowStore] !== undefined || (baselineRule?.storeKey && baselineRule.storeKey === rowStore));
    const storeExplicitPrice = hasStoreExplicitPrice
      ? (baselineRule.storePrices?.[rowStore] ?? baselineRule.otherPrice)
      : null;
    const isExplicitPriceForRow = Boolean(hasStoreExplicitPrice || (!baselineRule?.storePrices && !baselineRule?.storeKey && baselineRule?.isUserExplicitPrice));
    const explicitPriceVal = hasStoreExplicitPrice ? storeExplicitPrice : (isExplicitPriceForRow ? (rowTargetFinalFor(row) ?? baselineRule?.otherPrice) : null);

    const rawRowIntendedFinal = isExplicitPriceForRow ? explicitPriceVal : rowTargetFinalFor(row);
    const current = numValue(row['当前售价SAR']);
    const minDiscount = numValue(row['平台最低降幅%']) ?? 0;
    const cap = isNum(current) ? floor2(current * (1 - minDiscount / 100)) : null;
    const rowPriceFor15Coupon = rawRowIntendedFinal !== null ? ceil2(rawRowIntendedFinal / 0.85) : null;
    const rowCanUse15Coupon = false;
    const couponFactor = 1;
    const uncappedActivityPrice = rawRowIntendedFinal;

    // When explicit user price is specified, preserve user price as initial target price without platform cap clamping;
    // cap conflicts indicate platform constraints instead of silently altering the price
    const initialTargetPrice = isExplicitPriceForRow
      ? uncappedActivityPrice
      : (uncappedActivityPrice === null
          ? null
          : (cap === null ? uncappedActivityPrice : Math.min(uncappedActivityPrice, cap)));

    const jittered = isExplicitPriceForRow
      ? {value: initialTargetPrice, adjusted: false, from: null}
      : jitterIntegerTargetPrice(initialTargetPrice, {
      key: `${row['店铺'] || ''}:${row['活动ID'] || ''}:${row['SKC'] || ''}`,
      platformCap: cap,
      cost: selectionMarginBasis === 'product_cost_excluding_storage'
        ? row._cloudCost.productUnitCostSar
        : row._cloudCost.fullUnitCostSar,
      minMargin: (baselineRule?.allowBelowFloor || baselineRule?.allowBelowFloorLinkKeys?.has(exposureLinkKey(row['店铺'], row['SKC']))) ? null : targetFloorMargin,
    });
    const targetPrice = jittered.value;
    const finalTargetPrice = targetPrice === null ? null : round2(targetPrice);
    const rowIntendedFinal = isExplicitPriceForRow
      ? rawRowIntendedFinal
      : (jittered.adjusted
          && initialTargetPrice !== null
          && rawRowIntendedFinal !== null
          && Math.abs(initialTargetPrice - rawRowIntendedFinal) < 0.001
            ? targetPrice
            : rawRowIntendedFinal);
    return {
      rowIntendedFinal,
      rowPriceFor15Coupon,
      rowCanUse15Coupon,
      couponFactor,
      uncappedActivityPrice,
      targetPrice,
      finalTargetPrice,
      platformCap: cap,
      minDiscount,
      platformConstrained: cap !== null && uncappedActivityPrice !== null && cap < uncappedActivityPrice - 0.001,
      priceJitteredFrom: jittered.adjusted ? jittered.from : null,
      isExplicitPriceForRow,
    };
  };
  const rowStrategies = group.map(rowStrategyFor);
  const inheritedRuleName = baselineIsFixedPrice
    ? 'baseline_user_confirmed_fixed_price_no_coupon'
    : baselineIsMargin
      ? 'baseline_user_confirmed_margin_no_coupon'
      : null;
  const safeNoCouponAll = rowStrategies.length
    && rowStrategies.every(s => s.rowIntendedFinal !== null && s.platformCap !== null && s.rowIntendedFinal <= s.platformCap);
  const safe15All = false;
  const recFinals = rowStrategies.map(s => s.finalTargetPrice).filter(isNum);
  const rowIntendedFinals = rowStrategies.map(s => s.rowIntendedFinal).filter(isNum);
  const activityBasePrices = rowStrategies.map(s => s.targetPrice).filter(isNum);
  const targetProductMargins = [];
  const targetFullMargins = [];
  const targetSafetyMargins = [];
  const cappedProductMargins = [];
  const cappedFullMargins = [];
  const cappedSafetyMargins = [];
  for (const [idx, r] of group.entries()) {
    const s = rowStrategies[idx];
    const p = s?.finalTargetPrice;
    const rowTargetFinal = s?.rowIntendedFinal;
    const productCost = r._cloudCost.productUnitCostSar;
    const fullCost = r._cloudCost.fullUnitCostSar;
    const safetyCost = selectionMarginBasis === 'product_cost_excluding_storage' ? productCost : fullCost;
    if (isNum(p) && isNum(productCost) && Number(productCost) > 0 && p > 0) cappedProductMargins.push((p - productCost) / p);
    if (isNum(p) && isNum(fullCost) && Number(fullCost) > 0 && p > 0) cappedFullMargins.push((p - fullCost) / p);
    if (isNum(p) && isNum(safetyCost) && Number(safetyCost) > 0 && p > 0) cappedSafetyMargins.push((p - safetyCost) / p);
    if (isNum(rowTargetFinal) && isNum(productCost) && Number(productCost) > 0 && rowTargetFinal > 0) targetProductMargins.push((rowTargetFinal - productCost) / rowTargetFinal);
    if (isNum(rowTargetFinal) && isNum(fullCost) && Number(fullCost) > 0 && rowTargetFinal > 0) targetFullMargins.push((rowTargetFinal - fullCost) / rowTargetFinal);
    if (isNum(rowTargetFinal) && isNum(safetyCost) && Number(safetyCost) > 0 && rowTargetFinal > 0) targetSafetyMargins.push((rowTargetFinal - safetyCost) / rowTargetFinal);
  }

  let couponStrategy = '不叠优惠券';
  if (!couponRows.length) couponStrategy = '无优惠券叠加';
  else couponStrategy = '不把15%券作为价格保障；仅高曝光/滞销/清货试验另出流量券方案';

  const actionParts = [];
  let status = '可按货号确认';
  if (skuNeedsReview) {
    status = '货号待归并，暂停';
    actionParts.push(`货号归并待复核：${skuReviewReasons.join(' / ')}`);
  } else if (missingCost) {
    status = '缺云端成本，需先确认';
    actionParts.push('缺云端成本：先不自动报，需你确认最终价');
  } else if (storageMissing && storageRequiredForSelection) {
    status = '缺仓储口径，需复核';
    actionParts.push('云端未给出仓储/件，不能按0安全通过');
  } else {
    const storageWarnings = storageEvidenceStatuses.filter(status => status !== 'fresh_quantity_crosscheck_passed');
    if (storageWarnings.length) actionParts.push(`仓储计费单价已保留，交叉核验提示：${storageWarnings.join(' / ')}`);
    if (storageMissing && !storageRequiredForSelection) {
      actionParts.push('仓储费缺失不作为本轮自动剔除条件；筛选红线按不含仓储成本利润率');
    }
    if (safeNoCouponAll) actionParts.push(`普通活动按目标价 ${fmt(targetFinal)} SAR 报`);
    else actionParts.push('普通活动需按店铺平台上限微调，低利润店筛掉/单独处理');
    if (fixed === null && (hasExposureRanking || hasNewListingTopTreatment)) {
      actionParts.push(`曝光前五链接目标利润率 ${pctRatioText(topExposureMargin)}，其他链接 ${pctRatioText(targetMargin)}；不得低于15%底价`);
    }
    if (couponRows.length) actionParts.push(couponStrategy);
    if (limitRows.length) actionParts.push('有旧限时折扣标签：未处理前不视为安全');
  }
  if (!missingCost && !(storageRequiredForSelection && storageMissing) && !safeNoCouponAll) status = '部分店需系统处理';
  if (!missingCost && !(storageRequiredForSelection && storageMissing) && limitRows.length) status = status === '可按货号确认' ? '限时折扣需注意' : `${status}+限时折扣`;
  const isExplicitPrice = Boolean(baselineRule?.isUserExplicitPrice || (baselineIsFixedPrice && baselineRule?.sourceRules?.includes('baseline_user_remark_fixed_price')));
  if (!missingCost && targetSafetyMargins.length && Math.min(...targetSafetyMargins) < targetFloorMargin) {
    if (!isExplicitPrice) {
      status = '利润低于红线/需确认';
    } else {
      actionParts.push("用户明确指定价低于红线(" + pctRatioText(Math.min(...targetSafetyMargins)) + ")，按指定价保留执行");
    }
  }

  const needConfirm = missingCost
    ? (skuNeedsReview ? '先确认这到底是什么货号' : '请填最终成交价或补云端成本')
    : skuNeedsReview
      ? '先确认这到底是什么货号'
      : storageMissing && storageRequiredForSelection
      ? '请确认仓储口径后再报'
      : isExplicitPrice
        ? `已明确指定价 ${fmt(targetFinal)} SAR，直接执行`
      : hasFixedPrice
        ? `确认固定最终价 ${fmt(targetFinal)} SAR 是否继续`
      : hasExposureRanking
          ? `确认默认/非曝光前五目标利润率 ${pct(targetMargin)} 或最终价 ${fmt(targetFinal)} SAR；曝光前五链接可按 ${pctRatioText(topExposureMargin)} / ${fmt(topExposureTargetFinal)} SAR`
          : `确认目标利润率 ${pct(targetMargin)} 或最终价 ${fmt(targetFinal)} SAR；曝光数据缺失，按基础利润率执行`;
  const compactCouponCombo = !couponRows.length
    ? '普通活动'
    : '普通活动，不叠券；15/30/50%券都禁止；可选流量券另行审批';
  const compactCombo = skuNeedsReview || missingCost || (storageRequiredForSelection && storageMissing)
    ? '暂不自动报，等你确认'
    : [
        compactCouponCombo,
        limitRows.length ? '限时折扣先处理' : '',
      ].filter(Boolean).join('；');
  const storeHandling = skuNeedsReview || missingCost || (storageRequiredForSelection && storageMissing)
    ? '不自动处理'
    : safeNoCouponAll
      ? '同货号按目标价执行'
      : '我按店铺平台上限微调；低利润店剔除/单独处理';

  for (const [rowIdx, r] of group.entries()) {
    const strategy = rowStrategies[rowIdx] || {};
    const storeKey = String(r['店铺'] || '').trim().toUpperCase();
    const activityId = Number(r['活动ID'] || 0);
    const skc = String(r['SKC'] || '').trim();
    const current = numValue(r['当前售价SAR']);
    const minDiscount = strategy.minDiscount ?? (numValue(r['平台最低降幅%']) ?? 0);
    const platformCap = strategy.platformCap ?? (isNum(current) ? floor2(current * (1 - minDiscount / 100)) : null);
    const uncappedActivityPrice = strategy.uncappedActivityPrice ?? null;
    const targetPrice = strategy.targetPrice ?? null;
    const finalTargetPrice = strategy.finalTargetPrice ?? null;
    const rowIntendedFinal = strategy.rowIntendedFinal ?? null;
    const rowCouponFactor = strategy.couponFactor ?? 1;
    const rowLinkKey = exposureLinkKey(storeKey, skc);
    const actualTopExposureLink = topExposureLinkKeys.has(rowLinkKey);
    const isTopExposureLink = rowIsTopExposure(r);
    const newListingTopTreatment = newListingTopTreatmentByActivityLink.get(newListingTreatmentKey(r)) || {};
    const productCost = r._cloudCost.productUnitCostSar;
    const fullCost = r._cloudCost.fullUnitCostSar;
    const marginAfterStorage = finalTargetPrice !== null && isNum(fullCost) && Number(fullCost) > 0 && finalTargetPrice > 0
      ? (finalTargetPrice - Number(fullCost)) / finalTargetPrice
      : null;
    const marginBeforeStorage = finalTargetPrice !== null && isNum(productCost) && Number(productCost) > 0 && finalTargetPrice > 0
      ? (finalTargetPrice - Number(productCost)) / finalTargetPrice
      : null;
    const marginForSelection = selectionMarginBasis === 'product_cost_excluding_storage'
      ? marginBeforeStorage
      : marginAfterStorage;
    const excludeReasons = [];
    if (!storeKey) excludeReasons.push('missing_store_key');
    if (!activityId) excludeReasons.push('missing_activity_id');
    if (!skc) excludeReasons.push('missing_skc');
    if (skuNeedsReview) excludeReasons.push('canonical_needs_review');
    const isExplicitPriceForRow = Boolean(strategy.isExplicitPriceForRow);
    if (missingCost && !isExplicitPriceForRow) excludeReasons.push('missing_cloud_product_cost');
    if (storageMissing && storageRequiredForSelection && !isExplicitPriceForRow) excludeReasons.push('missing_cloud_storage_unit_cost');
    if (rowIntendedFinal === null) excludeReasons.push('missing_target_final_price');
    if (targetPrice === null || finalTargetPrice === null) excludeReasons.push('missing_row_target_price');
    const baselineAllowsBelowFloor = Boolean(isExplicitPriceForRow || baselineRule?.allowBelowFloor || baselineRule?.allowBelowFloorLinkKeys?.has(exposureLinkKey(storeKey, skc)));
    if (!baselineAllowsBelowFloor && marginForSelection !== null && marginForSelection < targetFloorMargin - 1e-9) excludeReasons.push(`row_${selectionMarginBasis}_margin_below_floor`);
    if (marginForSelection === null && !missingCost && !isExplicitPriceForRow && !(storageRequiredForSelection && storageMissing)) excludeReasons.push(`missing_row_${selectionMarginBasis}_margin`);
    executionRows.push({
      selected: excludeReasons.length === 0,
      excludeReason: excludeReasons.join(';'),
      storeKey,
      activityId,
      skc,
      canonical: sku,
      supplierNo: r['供方货号'] || '',
      currentPrice: current,
      platformMinDiscountPct: minDiscount,
      platformAllowedMaxBasePrice: platformCap,
      targetPrice: round2(targetPrice),
      finalTargetPrice: round2(finalTargetPrice),
      intendedFinalTargetPrice: round2(rowIntendedFinal),
      couponFactor: rowCouponFactor,
      combo: skuNeedsReview || missingCost || (storageRequiredForSelection && storageMissing)
        ? '暂不自动报，等你确认'
        : [
            rowCouponFactor < 1 ? '可选流量15%券另行审批' : '普通活动',
            limitRows.length ? '限时折扣先处理' : '',
          ].filter(Boolean).join('；'),
      cost: roundOrNull(productCost, 4),
      storageUnitCostSar: roundOrNull(r._cloudCost.storageUnitCostSar, 4),
      storageMethod: r._cloudCost.storageMethod || '',
      storageQuantityEvidenceStatus: r._cloudCost.storageQuantityEvidenceStatus || '',
      storageAllocationQuantitySource: r._cloudCost.storageAllocationQuantitySource || '',
      storageQuantityDateGapDays: r._cloudCost.storageQuantityDateGapDays ?? null,
      storageQuantityRatioOperationalToBilled: r._cloudCost.storageQuantityRatioOperationalToBilled ?? null,
      storageQuantityRelativeDifference: r._cloudCost.storageQuantityRelativeDifference ?? null,
      storageOperationalInventorySnapshotDate: r._cloudCost.storageOperationalInventorySnapshotDate || '',
      storageSourceDateMin: r._cloudCost.storageSourceDateMin || '',
      storageSourceDateMax: r._cloudCost.storageSourceDateMax || '',
      fullCost: roundOrNull(fullCost, 4),
      marginBeforeStorage: roundOrNull(marginBeforeStorage, 4),
      marginAfterStorage: roundOrNull(marginAfterStorage, 4),
      marginForSelection: roundOrNull(marginForSelection, 4),
      selectionMarginBasis,
      marginFloorExempt: baselineAllowsBelowFloor,
      isTopExposureLink,
      newListingTopTreatment: Boolean(newListingTopTreatment.applies),
      newListingShelfAgeDays: newListingTopTreatment.shelfAgeDays ?? null,
      newListingShelfAgeSource: newListingTopTreatment.shelfAgeSource || '',
      platformNewLabel: newListingTopTreatment.platformNewLabel?.applies ? newListingTopTreatment.platformNewLabel.value : '',
      targetPriceScope: 'store_skc_link_state_window',
      rule: inheritedRuleName || 'cloud_sku_approval_execution_price',
      sourceStatus: status,
      platformAdjusted: Boolean(strategy.platformConstrained),
      note: [
        strategy.platformConstrained
          ? `平台最低降幅上限 ${fmt(platformCap)} SAR 低于策略价 ${fmt(uncappedActivityPrice)} SAR`
          : '',
        actualTopExposureLink ? `命中本标准货号${exposureRankMetricText || '曝光'}全局前五` : '',
        newListingTopTreatment.applies
          ? (newListingTopTreatment.shelfAgeDays === null || newListingTopTreatment.shelfAgeDays === undefined
              ? '首次报新品活动，按曝光前五力度'
              : `新上架${newListingTopTreatment.shelfAgeDays}天且首次报新品活动，按曝光前五力度`)
          : '',
        baselineRule ? `继承上期最终版策略：${baselineRule.summary}` : '',
        strategy.priceJitteredFrom !== null ? `整数报价 ${fmt(strategy.priceJitteredFrom)} SAR 已按店铺/SKC稳定微调为 ${fmt(targetPrice)} SAR` : '',
        baselineAllowsBelowFloor && marginForSelection !== null && marginForSelection < targetFloorMargin - 1e-9 ? `继承上期确认：低于${round2(targetFloorMargin * 100)}%红线也允许按平台/清货价报名` : '',
        rowCouponFactor < 1 ? `可选流量券仅作触券下探测算，不作为保底成交价` : '',
      ].filter(Boolean).join('；'),
    });
  }

  const cloudProfit = mostCommonObject(group.map(r => r._cloudCost.profitRow).filter(Boolean));
  const storageFeeTotals = group.map(r => r._cloudCost.storageFeeSar).filter(v => v !== null && v !== undefined && Number(v) >= 0);
  const storageQtyBases = group.map(r => r._cloudCost.quantityBasis).filter(v => v !== null && v !== undefined && Number(v) >= 0);
  const sourceLabels = uniq(group.map(r => r._cloudCost.source).filter(Boolean));
  approvalRows.push({
    '系统结论': status,
    '标准货号': sku,
    '代表供方货号': mostCommon(group.map(r => r['供方货号'])),
    '覆盖店铺数': stores.length,
    '覆盖店铺': stores.join(','),
    '活动ID': activities.join(','),
    '当前售价范围SAR': range(currentPrices),
    '商品成本SAR（不含仓储）': range(productCostValues),
    '仓储费SAR/件': range(storageKnownValues),
    '含仓储成本SAR': range(fullCostValues),
    '仓储口径': mostCommon(group.map(r => r._cloudCost.storageMethod).filter(Boolean)) || 'missing',
    '仓储证据状态': storageEvidenceStatuses.join(' / '),
    '云端仓储总费SAR': range(storageFeeTotals),
    '云端仓储数量基准': range(storageQtyBases),
    '云端历史不含仓储利润率': isNum(cloudProfit?.profit_margin_before_storage) ? pct(cloudProfit.profit_margin_before_storage) : '',
    '云端历史含仓储利润率': isNum(cloudProfit?.profit_margin_after_storage) ? pct(cloudProfit.profit_margin_after_storage) : '',
    '云端成本来源': sourceLabels.join(' / ') || 'missing',
    '货号复核原因': skuReviewReasons.join(' / '),
    '系统目标': targetMode,
    '建议最终成交价SAR': range(rowIntendedFinals),
    '曝光前五SKC': topExposureRows.map(row => `${row.storeKey || '-'}#${row.rank}.${row.skc}${row.score ? `(${row.score})` : ''}`).join('；'),
    '本表命中曝光前五SKC': topExposureSkcsInGroup.map(row => `${row.storeKey || '-'}#${row.rank}.${row.skc}`).join('；'),
    '新上架7天内按前五力度SKC': newListingTopTreatmentRows.map(r => `${r['店铺']}#${r['SKC']}`).join('；'),
    '曝光规则目标利润率': exposureRuleText,
    '曝光前五建议最终成交价SAR': fmt(topExposureTargetFinal),
    '其他链接建议最终成交价SAR': fmt(targetFinal),
    '建议普通活动价SAR': missingCost ? '' : range(activityBasePrices.length ? activityBasePrices : oldSuggested),
    '15%券触发下探参考价SAR': couponRows.length ? fmt(priceFor15Coupon) : '',
    '50%券研究下探参考价SAR': couponRows.length ? fmt(priceFor50Coupon) : '',
    '平台允许活动价上限范围SAR': range(platformCaps),
    '推荐活动组合': actionParts.join('；'),
    '组合后预计最终价SAR': missingCost ? '' : range(recFinals),
    '不含仓储利润率': missingCost ? '利润暂算不出' : (targetProductMargins.length ? pct(Math.min(...targetProductMargins)) : ''),
    '含仓储利润率': (missingCost || storageMissing) ? '利润暂算不出' : (targetFullMargins.length ? pct(Math.min(...targetFullMargins)) : ''),
    '平台压价后最低不含仓储利润率': missingCost ? '' : (cappedProductMargins.length ? pct(Math.min(...cappedProductMargins)) : ''),
    '平台压价后最低含仓储利润率': missingCost ? '' : (cappedFullMargins.length ? pct(Math.min(...cappedFullMargins)) : ''),
    '优惠券/可选流量券候选行数': couponRows.length,
    '限时折扣风险行数': limitRows.length,
    '你只需确认': needConfirm,
    '给你看-活动组合': compactCombo,
    '给你看-店铺差异处理': storeHandling,
    '你的确认最终价SAR': '',
    '你的确认利润率%': '',
    '备注/是否同意': '',
  });
}

const lowEtFastSellerOverlay = lowEtFastSellerContext
  ? applyLowEtFastSellerPricePullbackToRows({
      rows: executionRows,
      context: lowEtFastSellerContext,
      costDoc: cloudCostDoc,
      isManualSpecial: row => manualLimitedDiscountIndex.activeByKey.has(
        `${String(row.storeKey || '').trim().toUpperCase()}::${String(row.skc || '').trim()}`,
      ),
    })
  : null;
if (lowEtFastSellerOverlay) {
  for (let index = 0; index < executionRows.length; index += 1) {
    const current = executionRows[index];
    const decision = lowEtFastSellerOverlay.results[index];
    if (decision.applied) {
      const adjusted = decision.row;
      const finalTargetPrice = round2(adjusted.finalTargetPrice);
      const marginBeforeStorage = finalTargetPrice > 0 && Number(current.cost) > 0
        ? (finalTargetPrice - Number(current.cost)) / finalTargetPrice
        : null;
      const marginAfterStorage = finalTargetPrice > 0 && Number(current.fullCost) > 0
        ? (finalTargetPrice - Number(current.fullCost)) / finalTargetPrice
        : null;
      const marginForSelection = selectionMarginBasis === 'product_cost_excluding_storage'
        ? marginBeforeStorage
        : marginAfterStorage;
      const priceDerivedReasons = new Set([
        'missing_target_final_price',
        'missing_row_target_price',
        `missing_row_${selectionMarginBasis}_margin`,
        `row_${selectionMarginBasis}_margin_below_floor`,
      ]);
      const retainedExcludeReasons = String(current.excludeReason || '')
        .split(';')
        .map(reason => reason.trim())
        .filter(Boolean)
        .filter(reason => !priceDerivedReasons.has(reason));
      if (
        marginForSelection === null
        && !retainedExcludeReasons.includes('missing_cloud_product_cost')
        && !retainedExcludeReasons.includes('missing_cloud_storage_unit_cost')
      ) {
        retainedExcludeReasons.push(`missing_row_${selectionMarginBasis}_margin`);
      }
      if (
        decision.audit?.mode !== 'user_fixed_tier'
        && current.marginFloorExempt !== true
        && marginForSelection !== null
        && marginForSelection < targetFloorMargin - 1e-9
      ) {
        retainedExcludeReasons.push(`row_${selectionMarginBasis}_margin_below_floor`);
      }
      executionRows[index] = {
        ...current,
        ...adjusted,
        selected: retainedExcludeReasons.length === 0,
        excludeReason: retainedExcludeReasons.join(';'),
        preLowEtTargetPrice: current.targetPrice,
        targetPrice: finalTargetPrice,
        finalTargetPrice,
        intendedFinalTargetPrice: finalTargetPrice,
        marginBeforeStorage: roundOrNull(marginBeforeStorage, 4),
        marginAfterStorage: roundOrNull(marginAfterStorage, 4),
        marginForSelection: roundOrNull(marginForSelection, 4),
        lowEtFastSellerPricePullback: {
          ...adjusted.lowEtFastSellerPricePullback,
          selectionBlockedReasons: retainedExcludeReasons,
        },
        rule: decision.audit?.mode === 'user_fixed_tier' ? 'user_fixed_tier' : 'low_et_fast_seller_price_pullback',
        note: [
          current.note,
          decision.audit.mode === 'user_fixed_tier' ? '用户最新固定三档价；不受ET或默认利润率改写' : decision.audit.mode === 'top5_restore_latest_approved_canonical_ordinary_price'
            ? 'ET<=10且跨19店30天销量>30：Top5恢复该标准货号统一普通档已批准价'
            : 'ET<=10且跨19店30天销量>30：普通链接目标利润率提高5个百分点',
          decision.audit.platformClipped ? '已按平台允许报名价上限裁剪' : '',
        ].filter(Boolean).join('；'),
      };
      continue;
    }
    if (!decision.blocked && decision.audit) {
      executionRows[index] = {...current, lowEtFastSellerPricePullback: decision.audit};
    }
    if (decision.blocked) {
      const manualReview = decision.manualReview === true;
      executionRows[index] = {
        ...current,
        selected: false,
        excludeReason: manualReview
          ? 'active_manual_special_requires_user_review'
          : decision.reason,
        lowEtFastSellerPricePullback: {
          applied: false,
          blocked: true,
          manualReview,
          reason: decision.reason,
          evidenceHash: decision.evidence?.evidenceHash || '',
          contextEvidenceHash: lowEtFastSellerContext.evidenceHash,
        },
        note: [
          current.note,
          manualReview
            ? '有效人工特殊限时折扣仍在保护期，普通活动价格收回不自动覆盖，需单独审核'
            : `ET低库存畅销品定价证据阻断：${decision.reason}`,
        ].filter(Boolean).join('；'),
      };
    }
  }

  for (const approval of approvalRows) {
    const canonicalRows = executionRows.filter(row => row.canonical === approval['标准货号']);
    const appliedRows = canonicalRows.filter(row => (
      row.lowEtFastSellerPricePullback?.applied === true && row.selected === true
    ));
    const blockedRows = canonicalRows.filter(row => (
      row.lowEtFastSellerPricePullback?.blocked === true
      || (row.lowEtFastSellerPricePullback?.selectionBlockedReasons || []).length > 0
      || String(row.excludeReason || '').startsWith('active_manual_special_requires_user_review')
      || String(row.excludeReason || '').startsWith('top5_missing_canonical_ordinary_approved_price')
      || String(row.excludeReason || '').startsWith('missing_current_day_matched_et_inventory')
    ));
    if (!appliedRows.length && !blockedRows.length) continue;
    const selectedRows = canonicalRows.filter(row => row.selected);
    if (selectedRows.length) {
      approval['建议最终成交价SAR'] = range(selectedRows.map(row => row.finalTargetPrice));
      approval['建议普通活动价SAR'] = range(selectedRows.map(row => row.targetPrice));
      approval['组合后预计最终价SAR'] = range(selectedRows.map(row => row.finalTargetPrice));
      const selectedTopRows = selectedRows.filter(row => row.isTopExposureLink);
      const selectedOrdinaryRows = selectedRows.filter(row => !row.isTopExposureLink);
      approval['曝光前五建议最终成交价SAR'] = selectedTopRows.length
        ? range(selectedTopRows.map(row => row.finalTargetPrice))
        : (blockedRows.some(row => row.isTopExposureLink) ? '单独审核' : '');
      approval['其他链接建议最终成交价SAR'] = selectedOrdinaryRows.length
        ? range(selectedOrdinaryRows.map(row => row.finalTargetPrice))
        : '';
      approval['不含仓储利润率'] = pct(Math.min(...selectedRows.map(row => row.marginBeforeStorage).filter(isNum)));
      approval['含仓储利润率'] = pct(Math.min(...selectedRows.map(row => row.marginAfterStorage).filter(isNum)));
    }
    const manualReviewRows = blockedRows.filter(row => row.lowEtFastSellerPricePullback?.manualReview === true);
    const missingEtRows = blockedRows.filter(row => row.excludeReason === 'missing_current_day_matched_et_inventory');
    const missingTop5BaselineRows = blockedRows.filter(row => row.excludeReason === 'top5_missing_canonical_ordinary_approved_price');
    approval['系统结论'] = appliedRows.length && blockedRows.length
      ? `低库存已收回${appliedRows.length}行，另${blockedRows.length}行单列`
      : appliedRows.length
        ? '低库存畅销品已收回一档'
        : blockedRows.length > 0 && missingEtRows.length === blockedRows.length
          ? 'ET库存未匹配（不是低库存结论）'
          : '低库存规则缺证据';
    approval['曝光规则目标利润率'] = [
      approval['曝光规则目标利润率'],
      appliedRows.length ? `ET低库存畅销品收回 ${appliedRows.length} 行` : '',
      manualReviewRows.length ? `人工特殊价保护 ${manualReviewRows.length} 行` : '',
      missingTop5BaselineRows.length ? `Top5缺精确普通档基准 ${missingTop5BaselineRows.length} 行` : '',
      missingEtRows.length ? `ET当天库存未匹配 ${missingEtRows.length} 行（不判定为低库存）` : '',
    ].filter(Boolean).join('；');
    approval['给你看-店铺差异处理'] = appliedRows.length && blockedRows.length
      ? `${appliedRows.length}行按收回后价格；${manualReviewRows.length}行特殊价保持；${missingTop5BaselineRows.length}行补普通档基准`
      : blockedRows.length > 0 && missingEtRows.length === blockedRows.length
        ? '只是ET库存未匹配，不算低库存；先补库存证据'
        : blockedRows.length
          ? '缺证据行单独处理'
      : '按ET低库存畅销品收回后价格执行';
    approval['你只需确认'] = appliedRows.length && blockedRows.length
      ? `确认已收回的 ${appliedRows.length} 行；人工特殊价保持不动`
      : blockedRows.length > 0 && missingEtRows.length === blockedRows.length
        ? '无需确认价格；先补ET当天库存匹配'
        : blockedRows.length
          ? `确认收回价；另审核 ${blockedRows.length} 行证据缺口`
      : '确认本期按低库存畅销品价格收回一档';
  }
}

const rank = {'缺云端成本，需先确认': 0, '缺仓储口径，需复核': 1, 'ET库存未匹配（不是低库存结论）': 2, '低库存规则缺证据': 3, '利润低于红线/需确认': 4, '部分店需系统处理+限时折扣': 5, '部分店需系统处理': 6, '限时折扣需注意': 7, '低库存畅销品已收回一档': 8, '可按货号确认': 9};
approvalRows.sort((a, b) => (rank[a['系统结论']] ?? 9) - (rank[b['系统结论']] ?? 9) || String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));

const confirmHeaders = [
  '系统结论','标准货号','覆盖店铺数','建议活动组合',
  '商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR','建议最终成交价SAR',
  '曝光规则目标利润率','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR',
  '新上架7天内按前五力度SKC',
  '不含仓储利润率','含仓储利润率','仓储口径','仓储证据状态','店铺差异我怎么处理','需要你确认',
  '你的确认最终价SAR','你的确认利润率%','备注/是否同意'
];
const detailHeaders = [
  '系统结论','标准货号','代表供方货号','覆盖店铺数','覆盖店铺','活动ID','当前售价范围SAR',
  '商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR','仓储口径','仓储证据状态','云端仓储总费SAR','云端仓储数量基准',
  '云端历史不含仓储利润率','云端历史含仓储利润率','云端成本来源','货号复核原因','系统目标','建议最终成交价SAR',
  '曝光前五SKC','本表命中曝光前五SKC','新上架7天内按前五力度SKC','曝光规则目标利润率','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR','建议普通活动价SAR',
  '如果只叠15%券普通活动价需≥SAR','如果叠50%券普通活动价需≥SAR','平台允许活动价上限范围SAR','推荐活动组合',
  '组合后预计最终价SAR','不含仓储利润率','含仓储利润率','平台压价后最低不含仓储利润率','平台压价后最低含仓储利润率',
  '优惠券风险行数','限时折扣风险行数','你只需确认','备注/是否同意'
];
const confirmRows = approvalRows.map(r => ({
  '系统结论': r['系统结论'],
  '标准货号': r['标准货号'],
  '覆盖店铺数': r['覆盖店铺数'],
  '建议活动组合': r['给你看-活动组合'],
  '商品成本SAR（不含仓储）': r['商品成本SAR（不含仓储）'],
  '仓储费SAR/件': r['仓储费SAR/件'],
  '含仓储成本SAR': r['含仓储成本SAR'],
  '建议最终成交价SAR': r['建议最终成交价SAR'],
  '曝光规则目标利润率': r['曝光规则目标利润率'],
  '曝光前五建议最终成交价SAR': r['曝光前五建议最终成交价SAR'],
  '其他链接建议最终成交价SAR': r['其他链接建议最终成交价SAR'],
  '新上架7天内按前五力度SKC': r['新上架7天内按前五力度SKC'],
  '不含仓储利润率': r['不含仓储利润率'],
  '含仓储利润率': r['含仓储利润率'],
  '仓储口径': r['仓储口径'],
  '仓储证据状态': r['仓储证据状态'],
  '店铺差异我怎么处理': r['给你看-店铺差异处理'],
  '需要你确认': r['你只需确认'],
  '你的确认最终价SAR': '',
  '你的确认利润率%': '',
  '备注/是否同意': '',
}));

await fs.mkdir(outDir, {recursive: true});
const csvPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}.csv`);
await fs.writeFile(csvPath, '\uFEFF' + [confirmHeaders.join(','), ...confirmRows.map(r => confirmHeaders.map(h => csvEscape(r[h])).join(','))].join('\n'), 'utf8');

const sourceSummary = {
  createdAt: new Date().toISOString(),
  activityAuditSource: {
    path: path.relative(ROOT, reportJson),
    createdAt: activityDoc.createdAt || '',
    selectedStores: activityDoc.selectedStores?.length || 0,
    detailRows: rawRows.length,
    note: '活动清单来自本轮只读营销扫描报告；成本、仓储、利润口径由云端生产 BI 快照覆盖。',
  },
  cloudProductionSource: {
    host: 'shein-bi-tencent',
    appPath: '/opt/shein-bi/app',
    biPath: '/opt/shein-bi/app/outputs/bi-portal/data.json',
    biInputPath: path.relative(ROOT, cloudBiPath),
    biGeneratedAt: cloudBi.generatedAt || '',
    pulledBiBytes: cloudBiStat.size,
    pulledBiMtime: cloudBiStat.mtime.toISOString(),
    costPath: '/opt/shein-bi/app/tmp/mbrs/marketing-cost-map.json',
    costInputPath: path.relative(ROOT, cloudCostPath),
    costSource: cloudCostDoc.source || '',
    costBiSource: cloudCostDoc.biSource || '',
    trueCostCount: cloudCostDoc.trueCostCount || Object.keys(TRUE_COSTS).length,
    pulledCostMtime: cloudCostStat.mtime.toISOString(),
  },
  pricingPolicy: {
    path: path.relative(ROOT, pricingPolicyPath),
    updatedAt: pricingPolicy.updatedAt || '',
    exposureDataPath: exposureDataPath ? path.relative(ROOT, exposureDataPath) : path.relative(ROOT, cloudBiPath),
    exposureDataMtime: exposureDataStat.mtime.toISOString(),
    exposureTopLinksEnabled: signupPricingPolicy.exposureTopLinks?.enabled !== false,
    exposureTopN: signupPricingPolicy.exposureTopLinks?.topN || 5,
    exposureMetricFields: signupPricingPolicy.exposureTopLinks?.metricFields || [],
    exposureSourceRows: exposureIndex.rowCount,
    exposurePositiveMetricRows: exposureIndex.positiveMetricRowCount,
    exposureRankedRows: exposureIndex.rankedRowCount,
    exposureFreshness,
    exposureCanonicalBackfill,
    rawLinkHistoryDir: rawLinkHistoryDir ? path.relative(ROOT, rawLinkHistoryDir) : '',
    rawLinkCoverage,
    rawLinkEvidenceOverlay,
    selectionMarginBasis,
    selectionMarginRule: `${marginBasisText(selectionMarginBasis)} >= ${round2(targetFloorMargin * 100)}% 才进入自动 allowlist`,
    exposureMetricTierCounts: countMapValues(exposureIndex.metricLabelByGroup),
    rule: '同一标准货号在所有店铺、所有链接中取全局前五；先按正向7天曝光排名，只有当该标准货号全局没有任何正向7天曝光时，才降级按30天曝光/总曝光兜底。高曝光前五策略沿用原规则：前五链接可比其他链接低5个百分点，但不得低于15%底价；若基础目标已在15%底线，则前五保持15%，其他链接提高到20%。固定价和逐行覆盖价优先。',
    baselinePriceOverrides: baselinePolicy ? path.relative(ROOT, baselinePolicy.filePath) : '',
    baselineUserRemarks: cli.baselineUserRemarks ? path.relative(ROOT, path.resolve(ROOT, cli.baselineUserRemarks)) : '',
    baselineRuleCount: baselinePolicy?.summaries?.length || 0,
    lowEtFastSellerPricePullback: lowEtFastSellerOverlay ? {
      enabled: true,
      inventoryTrend: path.relative(ROOT, inventoryTrendPath),
      manualLimitedDiscountRegistry: path.relative(ROOT, manualLimitedRegistryPath),
      evidenceHash: lowEtFastSellerContext.evidenceHash,
      contextBlockerCount: lowEtFastSellerContext.blockers.length,
      appliedCount: lowEtFastSellerOverlay.appliedCount,
      blockedCount: lowEtFastSellerOverlay.blockedCount,
      manualReviewCount: lowEtFastSellerOverlay.manualReviewCount,
    } : {
      enabled: false,
      reason: 'missing_baseline_or_inventory_trend',
    },
  },
  output: {
    rows: confirmRows.length,
    csvPath: path.relative(ROOT, csvPath),
  },
};
const sourceSummaryPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}-source-summary.json`);
await fs.writeFile(sourceSummaryPath, JSON.stringify(sourceSummary, null, 2), 'utf8');

const workbook = Workbook.create();
const activitySummaryHeaders = [
  '活动ID','活动名称','报名截止','活动时间','候选行数','方案行数','覆盖店铺数','标准货号数','新上架Top5待遇行数',
  '方案价格区间SAR','商品成本覆盖','仓储费展示','方案状态','备注/修改意见',
];
const activitySummaryRows = uniq(rawRows.map(r => Number(r['活动ID'] || 0)).filter(Boolean))
  .sort((a, b) => a - b)
  .map(activityId => {
    const sourceRows = rawRows.filter(r => Number(r['活动ID']) === activityId);
    const plannedRows = executionRows.filter(r => r.selected && Number(r.activityId) === activityId);
    const first = sourceRows[0] || {};
    const costCovered = plannedRows.filter(r => r.cost !== null && r.cost !== undefined && r.cost !== '' && Number.isFinite(Number(r.cost)) && Number(r.cost) > 0).length;
    const storageCovered = plannedRows.filter(r => r.storageUnitCostSar !== null && r.storageUnitCostSar !== undefined && r.storageUnitCostSar !== '' && Number.isFinite(Number(r.storageUnitCostSar)) && Number(r.storageUnitCostSar) >= 0).length;
    return [
      activityId,
      first['活动名称'] || '',
      first['报名截止'] || '',
      [first['普通活动开始'], first['普通活动结束']].filter(Boolean).join(' 至 '),
      sourceRows.length,
      plannedRows.length,
      uniq(plannedRows.map(r => r.storeKey)).length,
      uniq(plannedRows.map(r => r.canonical)).length,
      plannedRows.filter(r => r.newListingTopTreatment).length,
      range(plannedRows.map(r => r.targetPrice)),
      `${costCovered}/${plannedRows.length}`,
      storageCovered === plannedRows.length ? `${storageCovered}/${plannedRows.length}` : `缺 ${plannedRows.length - storageCovered}/${plannedRows.length}`,
      plannedRows.length === sourceRows.length ? '全量进入待确认方案' : `剔除 ${sourceRows.length - plannedRows.length} 行`,
      selectionMarginBasis === 'full_cost_including_storage'
        ? `未提交；普通活动须等你确认。本轮普通活动按含仓储成本利润率不低于 ${round2(targetFloorMargin * 100)}% 筛选；自动限时折扣兜底另按不含仓储商品成本边界。`
        : `未提交；普通活动须等你确认。本轮筛选按不含仓储商品成本利润率不低于 ${round2(targetFloorMargin * 100)}%；仓储费与含仓储利润率仍完整展示。`,
    ];
  });
const activitySummarySheet = workbook.worksheets.add('活动汇总');
activitySummarySheet.showGridLines = false;
activitySummarySheet.getRangeByIndexes(0, 0, activitySummaryRows.length + 1, activitySummaryHeaders.length).values = [activitySummaryHeaders, ...activitySummaryRows];
activitySummarySheet.freezePanes.freezeRows(1);
activitySummarySheet.getRangeByIndexes(0, 0, 1, activitySummaryHeaders.length).format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
activitySummarySheet.getRangeByIndexes(1, 0, activitySummaryRows.length, activitySummaryHeaders.length).format = {wrapText: true};
for (let c = 0; c < activitySummaryHeaders.length; c++) {
  const header = activitySummaryHeaders[c];
  let width = 120;
  if (header === '活动名称') width = 300;
  if (['报名截止','活动时间'].includes(header)) width = header === '活动时间' ? 280 : 170;
  if (['方案状态','备注/修改意见'].includes(header)) width = header === '备注/修改意见' ? 420 : 180;
  if (header === '方案价格区间SAR') width = 160;
  activitySummarySheet.getRangeByIndexes(0, c, activitySummaryRows.length + 1, 1).format.columnWidthPx = width;
}
activitySummarySheet.tables.add(`A1:${colName(activitySummaryHeaders.length)}${activitySummaryRows.length + 1}`, true, `ActivitySummary${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium2';
const sheet = workbook.worksheets.add('按货号汇总');
sheet.showGridLines = false;
sheet.getRangeByIndexes(0, 0, confirmRows.length + 1, confirmHeaders.length).values = [confirmHeaders, ...confirmRows.map(r => confirmHeaders.map(h => r[h] ?? ''))];
sheet.freezePanes.freezeRows(1);
sheet.freezePanes.freezeColumns(2);
sheet.getRangeByIndexes(0, 0, 1, confirmHeaders.length).format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
sheet.getRangeByIndexes(1, 0, confirmRows.length, confirmHeaders.length).format = {wrapText: true};
for (let c = 0; c < confirmHeaders.length; c++) {
  const h = confirmHeaders[c];
  let width = 126;
  if (h === '标准货号') width = 210;
  if (['建议活动组合','店铺差异我怎么处理','需要你确认','备注/是否同意','仓储口径'].includes(h)) width = 230;
  if (['商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR','建议最终成交价SAR','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR','不含仓储利润率','含仓储利润率','你的确认最终价SAR','你的确认利润率%'].includes(h)) width = 150;
  if (h === '曝光规则目标利润率') width = 230;
  if (h === '系统结论') width = 155;
  sheet.getRangeByIndexes(0, c, confirmRows.length + 1, 1).format.columnWidthPx = width;
}
sheet.getRangeByIndexes(1, 2, confirmRows.length, 1).format.numberFormat = '0';
const table = sheet.tables.add(`A1:${colName(confirmHeaders.length)}${confirmRows.length + 1}`, true, `BossConfirmCloud${safeTableSuffix(OUTPUT_VERSION)}`);
table.style = 'TableStyleMedium2';
table.showFilterButton = true;
const statusCol = confirmHeaders.indexOf('系统结论');
const statusRange = sheet.getRangeByIndexes(1, statusCol, confirmRows.length, 1);
statusRange.conditionalFormats.add('containsText', {text: '缺云端成本', format: {fill: '#FCE4D6', font: {bold: true, color: '#9C0006'}}});
statusRange.conditionalFormats.add('containsText', {text: '缺仓储', format: {fill: '#FCE4D6', font: {bold: true, color: '#9C0006'}}});
statusRange.conditionalFormats.add('containsText', {text: '利润低于', format: {fill: '#FFC7CE', font: {bold: true, color: '#9C0006'}}});
statusRange.conditionalFormats.add('containsText', {text: 'ET库存未匹配', format: {fill: '#F4CCCC', font: {bold: true, color: '#9C0006'}}});
statusRange.conditionalFormats.add('containsText', {text: '低库存已收回', format: {fill: '#FFF2CC', font: {bold: true, color: '#7F6000'}}});
statusRange.conditionalFormats.add('containsText', {text: '低库存畅销品已收回一档', format: {fill: '#D9EAD3', font: {bold: true, color: '#274E13'}}});
statusRange.conditionalFormats.add('containsText', {text: '部分店', format: {fill: '#FFF2CC', font: {bold: true, color: '#7F6000'}}});
statusRange.conditionalFormats.add('containsText', {text: '限时折扣', format: {fill: '#E2F0D9', font: {bold: true, color: '#375623'}}});

const sourceRowByKey = new Map(rows.map(r => [
  `${String(r['店铺'] || '').trim().toUpperCase()}::${Number(r['活动ID'] || 0)}::${String(r['SKC'] || '').trim()}`,
  r,
]));
const signupHeaders = [
  '活动ID','活动名称','报名截止','店铺','标准货号','中文品名','SKC','供方货号','当前售价SAR','平台最低降幅%',
  '平台可报上限SAR','建议报名价SAR','普通目标成交价SAR','商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR',
  '不含仓储利润率','含仓储利润率','曝光待遇','新上架7天待遇','方案状态','风险/处理说明','备注/修改意见',
];
const signupRows = executionRows.map(r => {
  const sourceRow = sourceRowByKey.get(`${r.storeKey}::${r.activityId}::${r.skc}`) || {};
  const exposureTreatment = r.isTopExposureLink ? '最新7日全店曝光Top5力度' : '普通力度';
  const storageText = r.storageUnitCostSar === null || r.storageUnitCostSar === undefined ? '仓储展示缺失' : '';
  const storageWarningText = r.storageQuantityEvidenceStatus && r.storageQuantityEvidenceStatus !== 'fresh_quantity_crosscheck_passed'
    ? `数量差异提示:${r.storageQuantityEvidenceStatus}`
    : '';
  return [
    r.activityId, sourceRow['活动名称'] || '', sourceRow['报名截止'] || '', r.storeKey, r.canonical,
    String(r.canonical || '').replace(/^[A-Z0-9-]+/i, '') || r.canonical, r.skc, r.supplierNo, r.currentPrice,
    r.platformMinDiscountPct, r.platformAllowedMaxBasePrice, r.targetPrice, r.finalTargetPrice, r.cost,
    r.storageUnitCostSar, r.fullCost, r.marginBeforeStorage, r.marginAfterStorage, exposureTreatment,
    r.newListingTopTreatment ? `是（上架${r.newListingShelfAgeDays ?? ''}天，按Top5力度）` : '否',
    r.selected ? '待用户确认，未提交' : '剔除/阻塞',
    [r.excludeReason, storageText, storageWarningText, r.note].filter(Boolean).join('；'), '',
  ];
});
const signupSheet = workbook.worksheets.add('报名明细');
signupSheet.showGridLines = false;
signupSheet.getRangeByIndexes(0, 0, signupRows.length + 1, signupHeaders.length).values = [signupHeaders, ...signupRows];
signupSheet.freezePanes.freezeRows(1);
signupSheet.freezePanes.freezeColumns(4);
signupSheet.getRangeByIndexes(0, 0, 1, signupHeaders.length).format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
signupSheet.getRangeByIndexes(1, 0, signupRows.length, signupHeaders.length).format = {wrapText: true};
for (let c = 0; c < signupHeaders.length; c++) {
  const h = signupHeaders[c];
  let width = 120;
  if (['活动名称','风险/处理说明'].includes(h)) width = 300;
  if (['标准货号','中文品名','SKC','供方货号'].includes(h)) width = 190;
  if (['曝光待遇','新上架7天待遇','方案状态','备注/修改意见'].includes(h)) width = 190;
  signupSheet.getRangeByIndexes(0, c, signupRows.length + 1, 1).format.columnWidthPx = width;
}
for (const h of ['当前售价SAR','平台可报上限SAR','建议报名价SAR','普通目标成交价SAR','商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR']) {
  const c = signupHeaders.indexOf(h);
  signupSheet.getRangeByIndexes(1, c, signupRows.length, 1).format.numberFormat = '0.00';
}
for (const h of ['不含仓储利润率','含仓储利润率']) {
  const c = signupHeaders.indexOf(h);
  signupSheet.getRangeByIndexes(1, c, signupRows.length, 1).format.numberFormat = '0.0%';
}
signupSheet.tables.add(`A1:${colName(signupHeaders.length)}${signupRows.length + 1}`, true, `SignupDetail${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium2';

const differenceHeaders = ['标准货号','店铺','活动ID','SKC','当前售价SAR','建议报名价SAR','普通目标成交价SAR','曝光待遇','差异原因','备注/修改意见'];
const priceSetsByCanonical = new Map();
for (const r of executionRows) {
  if (!priceSetsByCanonical.has(r.canonical)) priceSetsByCanonical.set(r.canonical, new Set());
  priceSetsByCanonical.get(r.canonical).add(String(r.targetPrice ?? ''));
}
const differenceRows = executionRows.map(r => [
  r.canonical, r.storeKey, r.activityId, r.skc, r.currentPrice, r.targetPrice, r.finalTargetPrice,
  r.isTopExposureLink ? 'Top5力度' : '普通力度',
  r.platformAdjusted
    ? `平台最低降幅将策略价压到 ${fmt(r.platformAllowedMaxBasePrice)} SAR`
    : (priceSetsByCanonical.get(r.canonical)?.size > 1 ? '同货号因Top5身份/店铺平台上限产生差异' : '同货号各店同价'),
  '',
]);
const differenceSheet = workbook.worksheets.add('店铺差异明细');
differenceSheet.showGridLines = false;
differenceSheet.getRangeByIndexes(0, 0, differenceRows.length + 1, differenceHeaders.length).values = [differenceHeaders, ...differenceRows];
differenceSheet.freezePanes.freezeRows(1);
differenceSheet.freezePanes.freezeColumns(2);
differenceSheet.getRangeByIndexes(0, 0, 1, differenceHeaders.length).format = {fill: '#4F6D7A', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
differenceSheet.getRangeByIndexes(1, 0, differenceRows.length, differenceHeaders.length).format = {wrapText: true};
for (let c = 0; c < differenceHeaders.length; c++) differenceSheet.getRangeByIndexes(0, c, differenceRows.length + 1, 1).format.columnWidthPx = ['标准货号','差异原因','备注/修改意见'].includes(differenceHeaders[c]) ? 250 : 135;
differenceSheet.tables.add(`A1:${colName(differenceHeaders.length)}${differenceRows.length + 1}`, true, `StoreDifference${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium4';

const blockedHeaders = ['店铺','活动ID','标准货号','SKC','建议报名价SAR','商品成本SAR','仓储费SAR/件','阻塞原因','处理建议','备注/修改意见'];
const excludedRowsForSheet = executionRows.filter(r => !r.selected);
const blockedRows = excludedRowsForSheet.length ? excludedRowsForSheet.map(r => [
  r.storeKey, r.activityId, r.canonical, r.skc, r.targetPrice, r.cost, r.storageUnitCostSar, humanLowEtReason(r.excludeReason),
  '先补齐对应证据或调整价格，再单独补报；不影响其他安全行。', '',
]) : [['','','','','','','','无阻塞项',`本轮 ${executionRows.filter(r => r.selected).length} 行均进入待确认方案。`,'']];
const blockedSheet = workbook.worksheets.add('剔除项与阻塞项');
blockedSheet.showGridLines = false;
blockedSheet.getRangeByIndexes(0, 0, blockedRows.length + 1, blockedHeaders.length).values = [blockedHeaders, ...blockedRows];
blockedSheet.freezePanes.freezeRows(1);
blockedSheet.getRangeByIndexes(0, 0, 1, blockedHeaders.length).format = {fill: '#9C0006', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
blockedSheet.getRangeByIndexes(1, 0, blockedRows.length, blockedHeaders.length).format = {wrapText: true};
for (let c = 0; c < blockedHeaders.length; c++) blockedSheet.getRangeByIndexes(0, c, blockedRows.length + 1, 1).format.columnWidthPx = /原因|建议|备注/.test(blockedHeaders[c]) ? 300 : 150;
blockedSheet.tables.add(`A1:${colName(blockedHeaders.length)}${blockedRows.length + 1}`, true, `BlockedItems${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium3';

const riskHeaders = ['店铺','活动ID','标准货号','SKC','风险类型','建议报名价SAR','不含仓储利润率','含仓储利润率','处理结论','备注/修改意见'];
const riskSourceRows = executionRows.filter(r =>
  r.platformAdjusted
  || r.storageUnitCostSar === null
  || r.storageUnitCostSar === undefined
  || (r.storageQuantityEvidenceStatus && r.storageQuantityEvidenceStatus !== 'fresh_quantity_crosscheck_passed')
  || (isNum(r.marginAfterStorage) && r.marginAfterStorage < targetFloorMargin));
const riskRows = riskSourceRows.length ? riskSourceRows.map(r => [
  r.storeKey, r.activityId, r.canonical, r.skc,
  [r.platformAdjusted ? '平台最低降幅压价' : '', r.storageUnitCostSar === null || r.storageUnitCostSar === undefined ? '仓储展示缺失' : '', r.storageQuantityEvidenceStatus && r.storageQuantityEvidenceStatus !== 'fresh_quantity_crosscheck_passed' ? `数量差异提示:${r.storageQuantityEvidenceStatus}` : '', isNum(r.marginAfterStorage) && r.marginAfterStorage < targetFloorMargin ? '含仓储利润率低于15%' : ''].filter(Boolean).join('；'),
  r.targetPrice, r.marginBeforeStorage, r.marginAfterStorage,
  r.selected ? '商品成本边界通过，可进入普通活动待确认；仓储风险单列展示。' : '已阻塞，不进入报名。', r.storageAllocationQuantitySource || '',
]) : [['','','','','无风险项','','','','','']];
const riskSheet = workbook.worksheets.add('低价补救与风险项');
riskSheet.showGridLines = false;
riskSheet.getRangeByIndexes(0, 0, riskRows.length + 1, riskHeaders.length).values = [riskHeaders, ...riskRows];
riskSheet.freezePanes.freezeRows(1);
riskSheet.getRangeByIndexes(0, 0, 1, riskHeaders.length).format = {fill: '#BF9000', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
riskSheet.getRangeByIndexes(1, 0, riskRows.length, riskHeaders.length).format = {wrapText: true};
for (const h of ['不含仓储利润率','含仓储利润率']) {
  const c = riskHeaders.indexOf(h);
  riskSheet.getRangeByIndexes(1, c, riskRows.length, 1).format.numberFormat = '0.0%';
}
for (let c = 0; c < riskHeaders.length; c++) riskSheet.getRangeByIndexes(0, c, riskRows.length + 1, 1).format.columnWidthPx = /风险|结论|备注/.test(riskHeaders[c]) ? 290 : 150;
riskSheet.tables.add(`A1:${colName(riskHeaders.length)}${riskRows.length + 1}`, true, `RiskItems${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium5';

const lowEtHeaders = [
  '店铺','活动ID','标准货号','SKC','ET当日可售','跨19店30天销量','Top5身份','原方案价SAR','收回后价格SAR',
  '处理状态','原因','备注/修改意见',
];
const lowEtRows = lowEtFastSellerOverlay
  ? executionRows
      .filter(row => row.lowEtFastSellerPricePullback)
      .map(row => {
        const audit = row.lowEtFastSellerPricePullback || {};
        const evidence = lowEtFastSellerContext.byCanonical.get(compact(row.canonical)) || {};
        const manualReview = audit.manualReview === true;
        return [
          row.storeKey, row.activityId, row.canonical, row.skc,
          audit.etOperationalSaleable ?? evidence.etOperationalSaleable ?? '',
          audit.validSales30d ?? evidence.validSales30d ?? '',
          audit.isTop5 === true ? '是' : (audit.isTop5 === false ? '否' : ''),
          audit.applied === true ? row.preLowEtTargetPrice : row.targetPrice,
          audit.applied === true ? row.targetPrice : '',
          audit.applied === true && row.selected === true
            ? '低库存畅销品：已收回一档'
            : audit.applied === true
              ? '收回价已计算，但其他安全门禁阻断'
            : (manualReview
                ? '人工特殊价保护：保持原价，不自动覆盖'
                : row.excludeReason === 'missing_current_day_matched_et_inventory'
                  ? 'ET库存未匹配：不能判定为低库存'
                  : '低库存规则缺价格证据：暂不报名'),
          humanLowEtReason(audit.mode || audit.reason || row.excludeReason),
          '',
        ];
      })
  : [];
const lowEtDisplayRows = lowEtRows.length
  ? lowEtRows
  : [['','','','','','','','','','本轮无命中项','','']];
const lowEtSheet = workbook.worksheets.add('ET低库存价格收回');
lowEtSheet.showGridLines = false;
lowEtSheet.getRangeByIndexes(0, 0, lowEtDisplayRows.length + 1, lowEtHeaders.length).values = [lowEtHeaders, ...lowEtDisplayRows];
lowEtSheet.freezePanes.freezeRows(1);
lowEtSheet.freezePanes.freezeColumns(4);
lowEtSheet.getRangeByIndexes(0, 0, 1, lowEtHeaders.length).format = {fill: '#7030A0', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
lowEtSheet.getRangeByIndexes(1, 0, lowEtDisplayRows.length, lowEtHeaders.length).format = {wrapText: true};
for (let c = 0; c < lowEtHeaders.length; c++) {
  const header = lowEtHeaders[c];
  lowEtSheet.getRangeByIndexes(0, c, lowEtDisplayRows.length + 1, 1).format.columnWidthPx =
    /标准货号|状态|原因|备注/.test(header) ? 260 : 140;
}
lowEtSheet.tables.add(`A1:${colName(lowEtHeaders.length)}${lowEtDisplayRows.length + 1}`, true, `LowEtPullback${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium4';

const couponSheet = workbook.worksheets.add('15%券流量试验计划');
couponSheet.showGridLines = false;
const couponActivityScope = uniq(executionRows.map(row => row.activityId))
  .sort((a, b) => Number(a) - Number(b))
  .join(' / ');
const couponPlanRows = [
  ['状态','适用活动','本轮动作','定价边界','说明','备注/修改意见'],
  ['无已批准目标',couponActivityScope,'不提交优惠券，也不把券当保底层','普通活动目标价不依赖优惠券触发','后续若单独批准15%小流量试验，再按指定店铺/SKC另建计划；30%/50%券禁止。',''],
];
couponSheet.getRangeByIndexes(0, 0, couponPlanRows.length, couponPlanRows[0].length).values = couponPlanRows;
couponSheet.getRange('A1:F1').format = {fill: '#595959', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
couponSheet.getRange('A2:F2').format = {wrapText: true};
couponSheet.getRange('A:F').format.columnWidthPx = 220;
couponSheet.tables.add('A1:F2', true, `CouponPlan${safeTableSuffix(OUTPUT_VERSION)}`).style = 'TableStyleMedium9';

const detailSheet = workbook.worksheets.add('系统依据');
detailSheet.showGridLines = false;
detailSheet.getRangeByIndexes(0, 0, approvalRows.length + 1, detailHeaders.length).values = [detailHeaders, ...approvalRows.map(r => detailHeaders.map(h => r[h] ?? ''))];
detailSheet.freezePanes.freezeRows(1);
detailSheet.freezePanes.freezeColumns(2);
detailSheet.getRangeByIndexes(0, 0, 1, detailHeaders.length).format = {fill: '#595959', font: {bold: true, color: '#FFFFFF'}, wrapText: true};
detailSheet.getRangeByIndexes(1, 0, approvalRows.length, detailHeaders.length).format = {wrapText: true};
for (let c = 0; c < detailHeaders.length; c++) {
  const h = detailHeaders[c];
  let width = 125;
  if (['标准货号','代表供方货号','系统目标','当前售价范围SAR','建议最终成交价SAR','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR','建议普通活动价SAR'].includes(h)) width = 155;
  if (['覆盖店铺','推荐活动组合','你只需确认','备注/是否同意','仓储口径','云端成本来源','货号复核原因','曝光前五SKC','本表命中曝光前五SKC','曝光规则目标利润率'].includes(h)) width = 260;
  if (/利润率|仓储|成本/.test(h)) width = 155;
  if (h === '系统结论') width = 150;
  if (/如果|平台允许/.test(h)) width = 175;
  detailSheet.getRangeByIndexes(0, c, approvalRows.length + 1, 1).format.columnWidthPx = width;
}
const detailTable = detailSheet.tables.add(`A1:${colName(detailHeaders.length)}${approvalRows.length + 1}`, true, `SystemBasisCloud${safeTableSuffix(OUTPUT_VERSION)}`);
detailTable.style = 'TableStyleMedium9';
detailTable.showFilterButton = true;

const sourceSheet = workbook.worksheets.add('云端来源');
sourceSheet.showGridLines = false;
const sourceRows = [
  ['项目', '值', '备注/修改意见'],
  ['云端主机', sourceSummary.cloudProductionSource.host, ''],
  ['云端应用目录', sourceSummary.cloudProductionSource.appPath, ''],
  ['云端 BI 原始路径', sourceSummary.cloudProductionSource.biPath, ''],
  ['本轮 BI 输入副本', sourceSummary.cloudProductionSource.biInputPath, ''],
  ['BI generatedAt', 'cloud generatedAt: ' + sourceSummary.cloudProductionSource.biGeneratedAt, ''],
  ['云端成本映射原始路径', sourceSummary.cloudProductionSource.costPath, ''],
  ['本轮成本输入副本', sourceSummary.cloudProductionSource.costInputPath, ''],
  ['成本源文件', sourceSummary.cloudProductionSource.costSource, ''],
  ['成本映射所用 BI', sourceSummary.cloudProductionSource.costBiSource, ''],
  ['营销定价策略', sourceSummary.pricingPolicy.path, ''],
  ['曝光数据源', sourceSummary.pricingPolicy.exposureDataPath, ''],
  ['曝光数据 mtime', 'cloud mtime: ' + sourceSummary.pricingPolicy.exposureDataMtime, ''],
  ['曝光字段', (sourceSummary.pricingPolicy.exposureMetricFields || []).join(', '), ''],
  ['曝光排名层级分布', Object.entries(sourceSummary.pricingPolicy.exposureMetricTierCounts || {}).map(([k, v]) => `${k}=${v}`).join('；'), ''],
  ['曝光货号回填', `用本次活动明细的 店铺+SKC 回填云端链接快照空货号：${sourceSummary.pricingPolicy.exposureCanonicalBackfill?.filledRows || 0} 行；未回填空货号：${sourceSummary.pricingPolicy.exposureCanonicalBackfill?.remainingBlankRows || 0} 行`, ''],
  ['曝光前五规则', sourceSummary.pricingPolicy.rule, ''],
  ['自动剔除利润率口径', sourceSummary.pricingPolicy.selectionMarginRule, ''],
  ['云端 trueCostCount', sourceSummary.cloudProductionSource.trueCostCount, ''],
  ['活动扫描明细行数', rawRows.length, ''],
  ['活动扫描店铺数', activityDoc.selectedStores?.length || 0, ''],
  ['说明', `${OUTPUT_VERSION} 成本、仓储费/件、含仓储成本、利润率均用云端生产 BI/成本映射重算；仓储费/件继续展示为当前仍在仓库存的移动平均累计仓储成本，但本轮自动剔除红线使用 ${marginBasisText(selectionMarginBasis)}，不是含仓储利润率。`, ''],
];
sourceSheet.getRange('B:B').format.numberFormat = '@';
sourceSheet.getRangeByIndexes(0, 0, sourceRows.length, 3).values = sourceRows;
sourceSheet.getRange('B:B').format.numberFormat = '@';
sourceSheet.getRange('A1:C1').format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}};
sourceSheet.getRange('A:A').format.columnWidthPx = 180;
sourceSheet.getRange('B:B').format.columnWidthPx = 760;
sourceSheet.getRange('C:C').format.columnWidthPx = 220;
sourceSheet.getRangeByIndexes(1, 0, sourceRows.length - 1, 3).format = {wrapText: true};

const notes = workbook.worksheets.add('说明');
notes.showGridLines = false;
notes.getRange('A1:D1').values = [['这张表怎么用', '', '', '']];
notes.mergeCells('A1:D1');
notes.getRange('A1:D1').format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}};
notes.getRange('A3:D9').values = [
  ['1', '先看', '按货号汇总', '每个标准货号一行，已补商品成本、仓储费/件、含仓储成本。'],
  ['2', '利润率口径', '不含仓储 / 含仓储', `不含仓储利润率只扣商品成本；含仓储利润率扣商品成本+云端仓储费/件。本轮自动剔除红线按 ${marginBasisText(selectionMarginBasis)} >= ${round2(targetFloorMargin * 100)}%。`],
  ['3', '云端来源', '云端来源', '成本和仓储来自 shein-bi-tencent 的生产 BI 快照和云端成本映射。'],
  ['4', '你确认什么', '建议最终成交价SAR', '接受就写同意；要改就填“你的确认最终价SAR”或“你的确认利润率%”。'],
  ['5', '店铺差异', '系统处理', '各店当前价、平台最低降幅差异由系统按范围处理；低利润或不达标店会筛掉/单独处理。'],
  ['6', '优惠券/限时折扣', '风险提示', '表里直接提示是否可叠15%券；50%券原则上禁止。限时折扣仍先按风险处理。'],
  ['7', '本次修正', 'v4-v6 问题', 'v4 暴露出别名同步和销量分摊问题；v5/v6 仍没有剔除已出库产品携带的历史仓储成本；v7 改为当前在仓库存移动平均累计仓储口径，并把禁止券档写清楚。'],
];
notes.getRange('A10:D10').values = [
  ['8', '曝光前五', '价格差异', '同一标准货号在所有店铺、所有链接中按本次云端7天曝光取全局前五 SKC：前五链接可比其他链接低5个百分点，但不能低于15%底价；若基础目标已是15%，前五保持15%，其他链接提高到20%。固定价和逐行覆盖价优先。'],
];
notes.getRange('A3:D9').format = {wrapText: true};
notes.getRange('A10:D10').format = {wrapText: true};
notes.getRange('A:A').format.columnWidthPx = 50;
notes.getRange('B:B').format.columnWidthPx = 130;
notes.getRange('C:C').format.columnWidthPx = 180;
notes.getRange('D:D').format.columnWidthPx = 520;

const preview = await workbook.render({sheetName: '按货号汇总', range: 'A1:P24', scale: 1, format: 'png'});
const previewPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}-preview.png`);
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const inspect = await workbook.inspect({kind: 'table', range: '按货号汇总!A1:P12', include: 'values', tableMaxRows: 12, tableMaxCols: 16});
console.log(inspect.ndjson);
const errors = await workbook.inspect({kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: {useRegex: true, maxResults: 50}, summary: 'formula errors'});
console.log(errors.ndjson);
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
const xlsxPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}.xlsx`);
await xlsx.save(xlsxPath);
const executionArtifacts = await writeExecutionArtifacts(executionRows, {
  dateTag: DATE_TAG,
  outputVersion: OUTPUT_VERSION,
  executionTag: EXECUTION_TAG,
  sourceWorkbook: xlsxPath,
  sourceReport: reportJson,
  cloudBiPath,
  cloudCostPath,
  exposureDataPath,
  executionOutputDir: cli.executionOutputDir,
  reportsOutputDir: cli.outputDir,
});
sourceSummary.output.xlsxPath = path.relative(ROOT, xlsxPath);
sourceSummary.output.previewPath = path.relative(ROOT, previewPath);
sourceSummary.output.columns = confirmHeaders.length;
sourceSummary.executionArtifacts = executionArtifacts.summary;
await fs.writeFile(sourceSummaryPath, JSON.stringify(sourceSummary, null, 2), 'utf8');
console.log(JSON.stringify({xlsxPath, csvPath, previewPath, sourceSummaryPath, rows: approvalRows.length, columns: confirmHeaders.length, executionArtifacts: executionArtifacts.summary}, null, 2));

function normalizeReviewRow(row) {
  const rawSupplier = row._raw?.row?.supplierNo || row['供方货号'] || row['标准货号'] || '';
  const goodsTitle = row._raw?.row?.goodsName || row['商品标题/中文名'] || '';
  const normalized = normalizeGoodsSnDetailed(rawSupplier, {goodsTitle});
  const canonical = normalized.canonical || row['标准货号'] || rawSupplier;
  const cloudCostFromMap = lookupCloudCostInfo([canonical, rawSupplier, row['供方货号'], row['标准货号'], modelCode(canonical), modelCode(rawSupplier)]);
  const activityRowCost = costInfoFromActivityRow(row);
  // Inventory is shared across stores, so product and storage cost both belong to
  // the canonical SKU. A link-level activity response may omit storage fields and
  // must not turn the same shared stock into different per-store costs.
  const cloudCost = (cloudCostFromMap?.productUnitCostSar !== null && cloudCostFromMap?.productUnitCostSar !== undefined)
    ? cloudCostFromMap
    : (activityRowCost || {
        productUnitCostSar: null,
        storageUnitCostSar: null,
        fullUnitCostSar: null,
        storageMethod: 'missing',
        source: 'missing',
      });
  return {
    ...row,
    '供方货号': rawSupplier || row['供方货号'] || '',
    '标准货号': canonical,
    '商品完整成本SAR': fmt(cloudCost?.productUnitCostSar),
    '仓储费摊销SAR/件': (cloudCost?.storageUnitCostSar === null || cloudCost?.storageUnitCostSar === undefined) ? '' : fmt(cloudCost.storageUnitCostSar),
    '含仓储费成本SAR': fmt(cloudCost?.fullUnitCostSar),
    _approvalNormalized: {
      input: rawSupplier,
      canonical,
      source: normalized.source || '',
      matchedAlias: normalized.matchedAlias || '',
      needsReview: Boolean(normalized.needsReview),
      reviewReason: normalized.reviewReason || '',
    },
    _cloudCost: cloudCost,
  };
}

function lookupCloudCostInfo(keys) {
  const candidates = uniq(keys.filter(Boolean).flatMap(k => [k, compact(k), modelCode(k)]).filter(Boolean));
  let trueCost = null;
  for (const key of candidates) {
    trueCost = TRUE_COSTS[key] || TRUE_COSTS[compact(key)];
    if (trueCost) break;
  }
  let profitRow = null;
  for (const key of candidates) {
    profitRow = profitByKey.get(compact(key));
    if (profitRow) break;
  }
  let costMapValue = null;
  for (const key of candidates) {
    const direct = positiveOrNull(COSTS[key]);
    const compacted = positiveOrNull(COSTS[compact(key)]);
    costMapValue = direct ?? compacted;
    if (costMapValue !== null) break;
  }
  const productUnitCostSar = positiveOrNull(trueCost?.unitCostSar)
    ?? positiveOrNull(trueCost?.productUnitCostSar)
    ?? positiveOrNull(profitRow?.unit_cost_sar)
    ?? costMapValue;
  const storageFeeSar = numValue(trueCost?.storageFeeSar) ?? numValue(profitRow?.storage_fee_sar);
  const quantityBasis = numValue(trueCost?.quantityBasis) ?? null;
  const storageEvidenceBlocked = storageEvidenceBlocksSharedFallback(trueCost);
  const sharedStorageCost = storageEvidenceBlocked ? null : findSharedStorageCost(sharedStorageCostIndex, keys);
  let storageUnitCostSar = numValue(trueCost?.storageUnitCostSar);
  if (storageUnitCostSar === null) storageUnitCostSar = numValue(trueCost?.storageUnitCostSar30d);
  if (storageUnitCostSar === null) storageUnitCostSar = numValue(sharedStorageCost?.storageUnitCostSar);
  const fullUnitCostSar = positiveOrNull(trueCost?.trueUnitCostSar)
    ?? (productUnitCostSar !== null && storageUnitCostSar !== null ? Number(productUnitCostSar) + Number(storageUnitCostSar) : null);
  const mappedStorageMethod = /^(?:missing|unknown)$/i.test(String(trueCost?.storageMethod || '').trim()) ? '' : trueCost?.storageMethod;
  const storageQuantityEvidenceStatus = trueCost?.storageQuantityEvidenceStatus || '';
  const storageMethodRaw = storageMethodForEvidence({
    storageUnitCostSar,
    storageQuantityEvidenceStatus,
    baseMethod: mappedStorageMethod || (storageEvidenceBlocked ? '' : (profitRow?.storage_fee_method || sharedStorageCost?.storageMethod || '')),
  });
  const storageMethod = trueCost?.storageUnitBasis ? `${storageMethodRaw} / ${trueCost.storageUnitBasis}` : storageMethodRaw;
  const source = sharedStorageCost && !mappedStorageMethod
    ? sharedStorageCost.source
    : (trueCost?.source || (profitRow ? 'outputs/bi-portal/data.json' : (costMapValue !== null ? 'cloud costMap' : '')));
  return {
    productUnitCostSar: roundOrNull(productUnitCostSar, 4),
    storageUnitCostSar: roundOrNull(storageUnitCostSar, 4),
    fullUnitCostSar: roundOrNull(fullUnitCostSar, 4),
    storageFeeSar: roundOrNull(storageFeeSar ?? sharedStorageCost?.storageFeeSar, 4),
    quantityBasis: roundOrNull(quantityBasis ?? sharedStorageCost?.storageCurrentQuantity, 4),
    storageRecent30FeeSar: roundOrNull(trueCost?.storageRecent30FeeSar, 4),
    storageRecent30Days: roundOrNull(trueCost?.storageRecent30Days, 4),
    storageUnitBasis: trueCost?.storageUnitBasis || '',
    storageQuantityEvidenceStatus,
    storageAllocationQuantitySource: trueCost?.storageAllocationQuantitySource || '',
    storageQuantityDateGapDays: roundOrNull(trueCost?.storageQuantityDateGapDays, 4),
    storageQuantityRatioOperationalToBilled: roundOrNull(trueCost?.storageQuantityRatioOperationalToBilled, 4),
    storageQuantityRelativeDifference: roundOrNull(trueCost?.storageQuantityRelativeDifference, 4),
    storageOperationalInventorySnapshotDate: trueCost?.storageOperationalInventorySnapshotDate || '',
    storageSourceDateMin: trueCost?.storageSourceDateMin || '',
    storageSourceDateMax: trueCost?.storageSourceDateMax || '',
    storageMethod,
    source,
    profitRow,
  };
}


function costInfoFromActivityRow(row) {
  const rawCost = row?._raw?.cost || row?._raw?.row?.cost || {};
  const productUnitCostSar = positiveOrNull(rawCost.productCostSar)
    ?? positiveOrNull(rawCost.unitCostSar)
    ?? positiveOrNull(row?.['商品完整成本SAR']);
  const storageUnitCostSar = numValue(rawCost.storageUnitCostSar);
  const fullUnitCostSar = positiveOrNull(rawCost.fullCostSar)
    ?? positiveOrNull(rawCost.trueUnitCostSar)
    ?? (productUnitCostSar !== null && storageUnitCostSar !== null ? Number(productUnitCostSar) + Number(storageUnitCostSar) : productUnitCostSar);
  if (productUnitCostSar === null) return null;
  const storageQuantityEvidenceStatus = rawCost.storageQuantityEvidenceStatus || '';
  return {
    productUnitCostSar: roundOrNull(productUnitCostSar, 4),
    storageUnitCostSar: roundOrNull(storageUnitCostSar, 4),
    fullUnitCostSar: roundOrNull(fullUnitCostSar, 4),
    storageFeeSar: roundOrNull(rawCost.storageFeeSar, 4),
    quantityBasis: roundOrNull(rawCost.quantityBasis, 4),
    storageRecent30FeeSar: roundOrNull(rawCost.storageRecent30FeeSar, 4),
    storageRecent30Days: roundOrNull(rawCost.storageRecent30Days, 4),
    storageUnitBasis: rawCost.storageUnitBasis || '',
    storageQuantityEvidenceStatus,
    storageAllocationQuantitySource: rawCost.storageAllocationQuantitySource || '',
    storageQuantityDateGapDays: roundOrNull(rawCost.storageQuantityDateGapDays, 4),
    storageQuantityRatioOperationalToBilled: roundOrNull(rawCost.storageQuantityRatioOperationalToBilled, 4),
    storageQuantityRelativeDifference: roundOrNull(rawCost.storageQuantityRelativeDifference, 4),
    storageOperationalInventorySnapshotDate: rawCost.storageOperationalInventorySnapshotDate || '',
    storageSourceDateMin: rawCost.storageSourceDateMin || '',
    storageSourceDateMax: rawCost.storageSourceDateMax || '',
    storageMethod: storageMethodForEvidence({
      storageUnitCostSar,
      storageQuantityEvidenceStatus,
      baseMethod: rawCost.storageMethod || 'activity_review_row_cost',
    }),
    source: rawCost.source ? `activity_review_row:${rawCost.source}` : 'activity_review_row_cost',
    profitRow: null,
  };
}

function buildRuleMap(entries) {
  const map = new Map();
  for (const [label, value] of entries) {
    for (const key of [label, normalizeGoodsSnDetailed(label, {goodsTitle: label}).canonical, modelCode(label), compact(label)]) {
      if (key) map.set(compact(key), value);
    }
  }
  return map;
}
function findRule(map, keys) {
  for (const key of keys) {
    const candidates = [key, modelCode(key), compact(key)].map(compact).filter(Boolean);
    for (const k of candidates) if (map.has(k)) return map.get(k);
  }
  return null;
}
function compact(s) { return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\-]/g, '').toUpperCase(); }
function modelCode(s) { return String(s || '').match(/^[A-Z]{1,5}-?\d+[A-Z]?(?:-\d+)?/i)?.[0] || ''; }
function numValue(v) { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; const n = Number(String(v).replace('%','').replace(',','').trim()); return Number.isFinite(n) ? n : null; }
function positiveOrNull(v) { const n = numValue(v); return n !== null && n > 0 ? n : null; }
function isNum(v) { return Number.isFinite(Number(v)); }
function round2(n) { if (n === null || n === undefined || n === '') return null; return Number.isFinite(Number(n)) ? Math.round((Number(n) + Number.EPSILON) * 100) / 100 : null; }
function roundOrNull(n, digits = 2) { if (n === null || n === undefined || n === '') return null; const x = Number(n); if (!Number.isFinite(x)) return null; const m = 10 ** digits; return Math.round((x + Number.EPSILON) * m) / m; }
function floor2(n) { if (n === null || n === undefined || n === '') return null; return Number.isFinite(Number(n)) ? Math.floor((Number(n) + 1e-9) * 100) / 100 : null; }
function ceil2(n) { if (n === null || n === undefined || n === '') return null; return Number.isFinite(Number(n)) ? Math.ceil((Number(n) - 1e-9) * 100) / 100 : null; }
function jitterIntegerTargetPrice(value, {key = '', platformCap = null, cost = null, minMargin = null} = {}) {
  const base = round2(value);
  if (!isNum(base) || Math.abs(base - Math.round(base)) > 1e-9) return {value: base, adjusted: false, from: null};
  const offsets = [0.13, -0.17, 0.27, -0.29, 0.39, -0.41];
  const start = stableHash(key) % offsets.length;
  const floorPrice = isNum(cost) && isNum(minMargin) && Number(minMargin) < 1
    ? Number(cost) / (1 - Number(minMargin))
    : null;
  for (let i = 0; i < offsets.length; i++) {
    const candidate = round2(base + offsets[(start + i) % offsets.length]);
    if (isNum(platformCap) && candidate > Number(platformCap) + 1e-9) continue;
    if (isNum(floorPrice) && candidate < floorPrice - 1e-9) continue;
    return {value: candidate, adjusted: true, from: base};
  }
  return {value: base, adjusted: false, from: null};
}
function stableHash(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}
function fmt(v) { const n = round2(v); return n === null ? '' : n; }
function pct(v) { return isNum(v) ? `${round2(Number(v) * 100)}%` : ''; }
function range(values) { const nums = values.filter(v => v !== null && v !== undefined && isNum(v)).map(Number); if (!nums.length) return ''; const min = round2(Math.min(...nums)); const max = round2(Math.max(...nums)); return min === max ? String(min) : `${min}-${max}`; }
function uniq(values) { return [...new Set(values.filter(v => v !== null && v !== undefined && String(v) !== ''))]; }
function uniqBy(values, keyFn) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
function mostCommon(values) { const counts = new Map(); for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; }
function mostCommonObject(values) { const counts = new Map(); for (const v of values.filter(Boolean)) { const k = JSON.stringify(v); counts.set(k, (counts.get(k) || 0) + 1); } const top = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]; return top ? JSON.parse(top) : null; }
function csvEscape(v) { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s; }
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function safeTableSuffix(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'V'; }
function withSignupCliOverrides(policy, args) {
  const out = {
    ...policy,
    exposureTopLinks: {...(policy?.exposureTopLinks || {})},
  };
  const metricFields = parseList(args.exposureMetricFields);
  if (metricFields.length) out.exposureTopLinks.metricFields = metricFields;
  return out;
}
function enrichExposureBiWithPlanCanonicals(bi, activityRows) {
  const canonicalByLink = new Map();
  for (const row of activityRows || []) {
    const storeKey = String(row?.['店铺'] || row?.storeKey || '').trim().toUpperCase();
    const skc = String(row?.['SKC'] || row?.skc || '').trim();
    const canonical = String(row?.['标准货号'] || row?.['供方货号'] || row?.canonical || '').trim();
    if (!storeKey || !skc || !canonical) continue;
    canonicalByLink.set(exposureLinkKey(storeKey, skc), canonical);
  }
  const summary = {
    activityLinkMappings: canonicalByLink.size,
    scannedRows: 0,
    blankCanonicalRows: 0,
    filledRows: 0,
    remainingBlankRows: 0,
  };
  const enrichRow = row => {
    summary.scannedRows += 1;
    const direct = String(row?.standard_goods_sn || row?.standardGoodsSn || '').trim();
    const raw = String(row?.raw_goods_sn || row?.rawGoodsSn || row?.supplierNo || row?.sku_supplier_no || '').trim();
    if (direct || raw) return row;
    summary.blankCanonicalRows += 1;
    const storeKey = String(row?.store_key || row?.storeKey || row?.store || '').trim().toUpperCase();
    const skc = String(row?.skc || '').trim();
    const canonical = canonicalByLink.get(exposureLinkKey(storeKey, skc));
    if (!canonical) {
      summary.remainingBlankRows += 1;
      return row;
    }
    summary.filledRows += 1;
    return {
      ...row,
      standard_goods_sn: canonical,
      standardGoodsSn: canonical,
      exposureCanonicalBackfilledFromPlan: true,
    };
  };
  return {
    doc: {
      ...(bi || {}),
      storeLinks: Array.isArray(bi?.storeLinks) ? bi.storeLinks.map(enrichRow) : bi?.storeLinks,
      links: Array.isArray(bi?.links) ? bi.links.map(enrichRow) : bi?.links,
    },
    summary,
  };
}
function mergeRawLinkEvidenceIntoBi(bi, rawRows) {
  const data = bi?.data && typeof bi.data === 'object' ? bi.data : bi;
  const rawByKey = new Map();
  for (const row of rawRows || []) {
    const key = exposureLinkKey(row?.store_key || row?.storeKey, row?.skc);
    if (key) rawByKey.set(key, row);
  }
  const seen = new Set();
  let enrichedExistingRows = 0;
  const enrichRow = row => {
    const key = exposureLinkKey(row?.store_key || row?.storeKey || row?.store, row?.skc);
    if (!key) return row;
    seen.add(key);
    const raw = rawByKey.get(key);
    if (!raw) return row;
    const merged = {...row};
    let changed = false;
    for (const field of [
      'standard_goods_sn',
      'raw_goods_sn',
      'first_shelf_time',
      'created_time',
      'link_date',
      'is_on_shelf',
      'shelf_status_name',
    ]) {
      if ((merged[field] === null || merged[field] === undefined || merged[field] === '') && raw[field] !== null && raw[field] !== undefined && raw[field] !== '') {
        merged[field] = raw[field];
        changed = true;
      }
    }
    if (changed) {
      merged.rawLinkEvidenceBackfilled = true;
      enrichedExistingRows += 1;
    }
    return merged;
  };
  const storeLinks = Array.isArray(data?.storeLinks) ? data.storeLinks.map(enrichRow) : [];
  const links = Array.isArray(data?.links) ? data.links.map(enrichRow) : [];
  const appendedRows = [];
  for (const [key, row] of rawByKey.entries()) {
    if (seen.has(key)) continue;
    appendedRows.push({...row, rawLinkEvidenceAppended: true});
    seen.add(key);
  }
  const mergedData = {
    ...(data || {}),
    storeLinks: [...storeLinks, ...appendedRows],
    links,
  };
  return {
    doc: bi?.data && typeof bi.data === 'object' ? {...bi, data: mergedData} : mergedData,
    summary: {
      rawRows: rawByKey.size,
      enrichedExistingRows,
      appendedRows: appendedRows.length,
      preservedBiMetrics: true,
    },
  };
}
function shanghaiDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    const match = text.match(/^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : '';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function parseList(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}
function normalizeSelectionMarginBasis(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v || v === 'full' || v === 'full_cost' || v === 'full_cost_including_storage' || v === 'including_storage') {
    return 'full_cost_including_storage';
  }
  if (v === 'product' || v === 'product_cost' || v === 'product_cost_excluding_storage' || v === 'excluding_storage' || v === 'no_storage') {
    return 'product_cost_excluding_storage';
  }
  throw new Error(`Unsupported --selection-margin-basis: ${value}`);
}
function marginBasisText(value) {
  return value === 'product_cost_excluding_storage' ? '不含仓储成本利润率' : '含仓储成本利润率';
}
function exposureMetricText(field) {
  const text = String(field || '');
  if (/^c7/i.test(text)) return '7天曝光';
  if (/^c30/i.test(text)) return '30天曝光兜底';
  if (/eps/i.test(text)) return '总曝光兜底';
  if (/goods/i.test(text)) return '商品曝光兜底';
  return text || '曝光';
}
function countMapValues(map) {
  const out = {};
  if (!map || typeof map.values !== 'function') return out;
  for (const value of map.values()) {
    const key = String(value || '未知');
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'zh-Hans-CN')));
}
async function loadBaselinePricePolicy(filePath, userRemarksPath = '') {
  const doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const authoritativeBaseline = doc?.baselineForNextOrdinaryActivity === true;
  const userRemarkRules = userRemarksPath ? await loadUserRemarkRules(userRemarksPath) : new Map();
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const byCanonical = new Map();
  for (const row of items) {
    const canonical = String(row?.canonical || '').trim();
    if (!canonical) continue;
    const key = compact(canonical);
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(row);
  }
  const rules = new Map();
  const summaries = [];
  for (const [key, rowsForCanonical] of byCanonical.entries()) {
    const canonical = mostCommon(rowsForCanonical.map(r => r.canonical)) || rowsForCanonical[0]?.canonical || key;
    const inferred = inferBaselineRule(
      canonical,
      rowsForCanonical,
      userRemarkRules.get(compact(canonical)) || null,
      authoritativeBaseline,
    );
    if (!inferred) continue;
    for (const alias of [canonical, modelCode(canonical), compact(canonical)].filter(Boolean)) {
      rules.set(compact(alias), inferred);
    }
    summaries.push({
      canonical,
      type: inferred.type,
      topPrice: inferred.topPrice ?? null,
      otherPrice: inferred.otherPrice ?? null,
      topMargin: inferred.topMargin ?? null,
      otherMargin: inferred.otherMargin ?? null,
      allowBelowFloor: inferred.allowBelowFloor,
      rowCount: rowsForCanonical.length,
      sourceRules: inferred.sourceRules,
    });
  }
  return {
    filePath,
    sourceWorkbook: doc?.sourceWorkbook || '',
    authoritativeBaseline,
    rules,
    summaries,
  };
}

async function loadUserRemarkRules(filePath) {
  const doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const rows = Array.isArray(doc?.remarkRules)
    ? doc.remarkRules
    : (Array.isArray(doc?.rows) ? doc.rows.map(r => parseRemarkRule(r.canonical, r.remark)).filter(Boolean) : []);
  const out = new Map();
  for (const row of rows) {
    const parsed = row?.type && row?.canonical ? row : parseRemarkRule(row?.canonical, row?.remark);
    if (!parsed?.canonical || !parsed?.type) continue;
    out.set(compact(parsed.canonical), parsed);
  }
  return out;
}
const KNOWN_STORE_KEYS = new Set([
  'DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL',
  'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ',
  'JSH', 'TZZ', 'XC',
]);

function parseRemarkRule(canonical, remark) {
  const text = String(remark || '').trim();
  const name = String(canonical || '').trim();
  if (!name || !text) return null;

  // Detect storeKey in canonical or remark (e.g. "FY 37 SAR", "FY: 37", "FY店 37 SAR", or canonical is "FY")
  const storeMatch = text.match(/\b(DL|DX|FY|LQ|NM|HL|JY|ZL|TS|MZ|CX|YJ|XL|QY|QH|TZ|JSH|TZZ|XC)\b/i)
    || (KNOWN_STORE_KEYS.has(name.toUpperCase()) ? [name, name] : null);
  const explicitStoreKey = storeMatch ? storeMatch[1].toUpperCase() : null;

  // 1. Two-tier fixed: 前五 35 SAR / 其他 37 SAR
  const fixedTier = text.match(/(?:前五|Top5?)\s*([0-9]+(?:\.[0-9]+)?)\s*SAR?\s*[\/／,，;；]\s*(?:其他|其余|Other)\s*([0-9]+(?:\.[0-9]+)?)\s*SAR?/i);
  if (fixedTier) return {canonical: name, remark: text, type: 'fixedPrice', top: Number(fixedTier[1]), other: Number(fixedTier[2]), storeKey: explicitStoreKey, isUserExplicit: true};

  // 2. Two-tier margin: 前五 25% / 其他 30%
  const marginTier = text.match(/(?:前五|Top5?)\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*[\/／,，;；]\s*(?:其他|其余|Other)\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (marginTier) return {canonical: name, remark: text, type: 'margin', top: Number(marginTier[1]) / 100, other: Number(marginTier[2]) / 100, storeKey: explicitStoreKey, isUserExplicit: true};

  // 3. Single fixed price: "FY 37 SAR", "37 SAR", "37", "固定价 37 SAR", "报 37"
  const singleFixed = text.match(/(?:(?:[A-Za-z0-9_-]+)\s+)?(?:固定价|目标价|最终价|确认最终价|执行价|一口价|按|报)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:SAR|沙特里亚尔|元)?/i);
  if (singleFixed) {
    const val = Number(singleFixed[1]);
    return {canonical: name, remark: text, type: 'fixedPrice', top: val, other: val, storeKey: explicitStoreKey, isSingleFixed: true, isUserExplicit: true};
  }

  // 4. Single margin: 25%, 利润率25%
  const singleMargin = text.match(/^(?:利润率|目标利润率|确认利润率|按)?\s*([0-9]+(?:\.[0-9]+)?)\s*%$/i);
  if (singleMargin) {
    const val = Number(singleMargin[1]) / 100;
    return {canonical: name, remark: text, type: 'margin', top: val, other: val, storeKey: explicitStoreKey, isUserExplicit: true};
  }

  return null;
}

function inferBaselineRule(canonical, rowsForCanonical, userRemarkRule = null, authoritativeBaseline = false) {
  const meaningful = rowsForCanonical.filter(r => isNum(r?.targetPrice) && isNum(r?.finalTargetPrice));
  if (!meaningful.length) return null;
  const sourceRules = uniq(meaningful.map(r => r.rule).filter(Boolean));
  const hasUserRule = meaningful.some(r =>
    /user|fixed|jitter|approved|gapfill/i.test(String(r.rule || '')) || /用户备注|固定价|小数微调|用户明确同意/i.test(String(r.note || '')),
  );
  if (!hasUserRule && !authoritativeBaseline) return null;
  const topRows = meaningful.filter(r => r.isTopExposureLink);
  const otherRows = meaningful.filter(r => !r.isTopExposureLink);
  const topMargins = robustUniqueNumbers(topRows.map(r => r.marginBeforeStorage), 4);
  const otherMargins = robustUniqueNumbers(otherRows.map(r => r.marginBeforeStorage), 4);
  const topPrices = robustUniqueNumbers(topRows.map(r => r.intendedFinalTargetPrice ?? r.finalTargetPrice), 2);
  const otherPrices = robustUniqueNumbers(otherRows.map(r => r.intendedFinalTargetPrice ?? r.finalTargetPrice), 2);
  const allPrices = robustUniqueNumbers(meaningful.map(r => r.intendedFinalTargetPrice ?? r.finalTargetPrice), 2);
  const userRemarkBelowFloor = userRemarkRule?.type === 'margin'
    ? [userRemarkRule.top, userRemarkRule.other].some(v => isNum(v) && v < targetFloorMargin - 1e-9)
    : false;
  const baselineSelectedBelowFloor = meaningful.some(r =>
    (isNum(r.marginForSelection) && r.marginForSelection < targetFloorMargin - 1e-9) ||
    (isNum(r.marginBeforeStorage) && r.marginBeforeStorage < targetFloorMargin - 1e-9)
  );
  const isUserExplicitPrice = Boolean(userRemarkRule?.isUserExplicit || userRemarkRule?.type === 'fixedPrice');
  const explicitStoreKey = userRemarkRule?.storeKey || null;
  // If user explicitly specified price for a store, do NOT grant global allowBelowFloor;
  // global allowBelowFloor is reserved only for explicit all-canonical user approval or all-canonical below floor remarks.
  const allowBelowFloor = (isUserExplicitPrice && !explicitStoreKey) || userRemarkBelowFloor || (!explicitStoreKey && baselineSelectedBelowFloor) || meaningful.some(r =>
    /user_approved_platform_margin_below_15/i.test(String(r.rule || '')) ||
    /低于15%|低于 15%|低于.*红线.*允许|用户明确同意/i.test(String(r.note || '')),
  );
  const allowBelowFloorLinkKeys = new Set(
    isUserExplicitPrice
      ? (explicitStoreKey
          ? meaningful.filter(r => String(r.storeKey || '').toUpperCase() === explicitStoreKey).map(r => exposureLinkKey(r.storeKey, r.skc))
          : meaningful.map(r => exposureLinkKey(r.storeKey, r.skc)))
      : meaningful
          .filter(r => /user_approved_platform_margin_below_15/i.test(String(r.rule || '')) || /用户明确同意/i.test(String(r.note || '')))
          .map(r => exposureLinkKey(r.storeKey, r.skc))
  );
  const notes = uniq(meaningful.map(r => r.note).filter(Boolean)).slice(0, 3);
  const summaryParts = [];
  if (userRemarkRule?.remark) summaryParts.push(`用户备注：${userRemarkRule.remark}`);
  if (notes.length && !summaryParts.length) summaryParts.push(notes[0].replace(/；固定价按用户要求做小数微调：.*$/, ''));

  if (userRemarkRule?.type === 'fixedPrice') {
    return {
      type: 'fixed_sar',
      canonical,
      topPrice: userRemarkRule.top,
      otherPrice: userRemarkRule.other,
      storeKey: explicitStoreKey,
      storePrices: explicitStoreKey ? { [explicitStoreKey]: userRemarkRule.other } : null,
      allowBelowFloor,
      allowBelowFloorLinkKeys,
      isUserExplicitPrice: true,
      sourceRules: ['baseline_user_remark_fixed_price'],
      summary: summaryParts[0] || (explicitStoreKey
        ? `用户备注${explicitStoreKey}固定价：${fmt(userRemarkRule.other)} SAR`
        : `用户备注固定价：前五 ${fmt(userRemarkRule.top)} / 其他 ${fmt(userRemarkRule.other)} SAR`),
    };
  }
  if (userRemarkRule?.type === 'margin') {
    return {
      type: 'margin_pct',
      canonical,
      topMargin: userRemarkRule.top,
      otherMargin: userRemarkRule.other,
      allowBelowFloor,
      allowBelowFloorLinkKeys,
      sourceRules: ['baseline_user_remark_margin'],
      summary: summaryParts[0] || `用户备注利润率：前五 ${pctRatioText(userRemarkRule.top)} / 其他 ${pctRatioText(userRemarkRule.other)}`,
    };
  }

  const fixedLike = meaningful.some(r => /fixed|jitter/i.test(String(r.rule || '')) || /固定价|SAR/i.test(String(r.note || '')));
  if (fixedLike && allPrices.length <= 24) {
    const topPrice = topPrices.length ? representativeLow(topPrices) : null;
    const otherPrice = otherPrices.length ? representativeMedian(otherPrices) : (allPrices.length ? representativeMedian(allPrices) : null);
    if (otherPrice !== null) {
      return {
        type: 'fixed_sar',
        canonical,
        topPrice,
        otherPrice,
        allowBelowFloor,
        allowBelowFloorLinkKeys,
        sourceRules,
        summary: summaryParts[0] || `固定价继承：前五 ${fmt(topPrice ?? otherPrice)} / 其他 ${fmt(otherPrice)} SAR`,
      };
    }
  }
  if (topMargins.length || otherMargins.length) {
    const topMargin = topMargins.length ? representativeLow(topMargins) : null;
    const otherMargin = otherMargins.length ? representativeHigh(otherMargins) : (topMargin ?? representativeHigh(robustUniqueNumbers(meaningful.map(r => r.marginBeforeStorage), 4)));
    if (isNum(otherMargin)) {
      return {
        type: 'margin_pct',
        canonical,
        topMargin: topMargin ?? otherMargin,
        otherMargin,
        allowBelowFloor,
        allowBelowFloorLinkKeys,
        sourceRules,
        summary: summaryParts[0] || `利润率继承：前五 ${pctRatioText(topMargin ?? otherMargin)} / 其他 ${pctRatioText(otherMargin)}`,
      };
    }
  }
  return null;
}
function findBaselineRule(policy, keys) {
  if (!policy?.rules) return null;
  for (const key of keys) {
    const candidates = [key, modelCode(key), compact(key)].map(compact).filter(Boolean);
    for (const candidate of candidates) {
      if (policy.rules.has(candidate)) return policy.rules.get(candidate);
    }
  }
  return null;
}
function robustUniqueNumbers(values, digits = 2) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const rounded = roundOrNull(value, digits);
    if (rounded === null) continue;
    const key = String(rounded);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rounded);
  }
  return out.sort((a, b) => a - b);
}
function representativeLow(values) {
  const nums = values.filter(isNum).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[0];
}
function representativeHigh(values) {
  const nums = values.filter(isNum).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[nums.length - 1];
}
function representativeMedian(values) {
  const nums = values.filter(isNum).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[Math.floor(nums.length / 2)];
}
function pctConfigToRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}
function executionTagFromVersion(version) {
  const v = String(version || '').trim();
  const m = v.match(/(?:^|-)t(\d+)$/i);
  if (m) return `t${m[1]}`;
  return v || 'plan';
}
async function writeExecutionArtifacts(rows, opts) {
  const signupDir = path.resolve(ROOT, opts.executionOutputDir || path.join('tmp', 'marketing-signup'));
  await fs.mkdir(signupDir, {recursive: true});
  const reportsDir = path.resolve(ROOT, opts.reportsOutputDir || path.join('outputs', 'reports'));
  await fs.mkdir(reportsDir, {recursive: true});
  const selected = rows.filter(r => r.selected);
  const excluded = rows.filter(r => !r.selected);
  const byReason = {};
  for (const r of excluded) {
    const reason = r.excludeReason || 'unknown';
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  const makeScope = (name, scopeRows, scopeExcluded, note) => {
    const stores = uniq(scopeRows.map(r => r.storeKey)).sort();
    const activityIds = uniq(scopeRows.map(r => r.activityId)).sort((a, b) => Number(a) - Number(b));
    const selectedItems = scopeRows.map(r => ({
      storeKey: r.storeKey,
      activityId: r.activityId,
      skc: r.skc,
      canonical: r.canonical,
      selected: true,
      rule: r.rule,
      isTopExposureLink: r.isTopExposureLink,
      newListingTopTreatment: r.newListingTopTreatment,
      newListingShelfAgeDays: r.newListingShelfAgeDays,
      newListingShelfAgeSource: r.newListingShelfAgeSource,
      platformNewLabel: r.platformNewLabel,
      preLowEtTargetPrice: r.preLowEtTargetPrice ?? null,
      lowEtFastSellerPricePullback: r.lowEtFastSellerPricePullback || null,
    }));
    const priceItems = scopeRows.map(r => ({
      storeKey: r.storeKey,
      activityId: r.activityId,
      skc: r.skc,
      canonical: r.canonical,
      targetPrice: r.targetPrice,
      finalTargetPrice: r.finalTargetPrice,
      intendedFinalTargetPrice: r.intendedFinalTargetPrice,
      cost: r.cost,
      fullCost: r.fullCost,
      storageUnitCostSar: r.storageUnitCostSar,
      marginBeforeStorage: r.marginBeforeStorage,
      marginAfterStorage: r.marginAfterStorage,
      marginForSelection: r.marginForSelection,
      selectionMarginBasis: r.selectionMarginBasis,
      isTopExposureLink: r.isTopExposureLink,
      newListingTopTreatment: r.newListingTopTreatment,
      newListingShelfAgeDays: r.newListingShelfAgeDays,
      newListingShelfAgeSource: r.newListingShelfAgeSource,
      platformNewLabel: r.platformNewLabel,
      preLowEtTargetPrice: r.preLowEtTargetPrice ?? null,
      lowEtFastSellerPricePullback: r.lowEtFastSellerPricePullback || null,
      couponFactor: r.couponFactor,
      minMarginFloor: targetFloorMargin,
      rule: r.rule,
      combo: r.combo,
      note: r.note,
      source: path.relative(ROOT, opts.sourceWorkbook),
      confirmMatch: 'row_level_cloud_execution',
    }));
    const relWorkbook = path.relative(ROOT, opts.sourceWorkbook).replaceAll('\\', '/');
    const relReport = path.relative(ROOT, opts.sourceReport).replaceAll('\\', '/');
    return {
      selection: {
        createdAt: new Date().toISOString(),
        sourceWorkbook: relWorkbook,
        sourceReport: relReport,
        activityIds,
        stores,
        selectionPolicy: {
          rule: 'auto_safe_after_cloud_cost_review_with_configured_row_margin_floor',
          note,
          targetFloorMarginPct: round2(targetFloorMargin * 100),
          selectionMarginBasis,
          selectionMarginBasisText: marginBasisText(selectionMarginBasis),
        },
        totals: {
          reviewRows: rows.length,
          selectedRows: scopeRows.length,
          excludedRows: scopeExcluded.length,
          selectionItems: selectedItems.length,
        },
        scope: {
          storeKeys: stores,
          phase: `${opts.dateTag}-${opts.executionTag}-plan`,
          submit: false,
        },
        mode: 'allowlist',
        items: selectedItems,
        excluded: scopeExcluded.map(excludedExecutionRow),
      },
      overrides: {
        createdAt: new Date().toISOString(),
        sourceWorkbook: relWorkbook,
        parser: 'build_marketing_sku_approval_execution_artifacts',
        sourceFiles: {
          activityReport: relReport,
          cloudBi: path.relative(ROOT, opts.cloudBiPath).replaceAll('\\', '/'),
          cloudCost: path.relative(ROOT, opts.cloudCostPath).replaceAll('\\', '/'),
          exposureData: opts.exposureDataPath ? path.relative(ROOT, opts.exposureDataPath).replaceAll('\\', '/') : '',
        },
        activityIds,
        stores,
        selectionPolicy: {
          rule: 'row_level_cloud_execution_price',
          targetPriceMeaning: 'ordinary marketing signup fill price; coupons are not used as a guaranteed price layer',
          finalTargetPriceMeaning: 'guaranteed target customer transaction price from ordinary activity / limited discount without assuming coupon trigger',
          targetFloorMarginPct: round2(targetFloorMargin * 100),
          selectionMarginBasis,
          selectionMarginBasisText: marginBasisText(selectionMarginBasis),
        },
        totals: {
          reviewRows: rows.length,
          selectedRows: scopeRows.length,
          excludedRows: scopeExcluded.length,
          priceOverrideItems: priceItems.length,
        },
        scope: {
          storeKeys: stores,
          phase: `${opts.dateTag}-${opts.executionTag}-plan`,
        },
        items: priceItems,
        excluded: scopeExcluded.map(excludedExecutionRow),
      },
    };
  };
  const mainRows = selected.filter(r => r.storeKey !== 'JSH');
  const jshRows = selected.filter(r => r.storeKey === 'JSH');
  const mainExcluded = excluded.filter(r => r.storeKey !== 'JSH');
  const jshExcluded = excluded.filter(r => r.storeKey === 'JSH');
  const scopes = {
    allSafe: makeScope('all-safe', selected, excluded, '全店安全清单：逐行剔除低利润/缺成本/缺仓储/待归并货号，并输出配套价格覆盖。'),
    mainNoJsh: makeScope('main-no-jsh', mainRows, mainExcluded, '主执行清单：不含 JSH；逐行剔除低利润/缺成本/缺仓储/待归并货号，并输出配套价格覆盖。'),
    jsh: makeScope('jsh', jshRows, jshExcluded, 'JSH 单列清单：逐行剔除低利润/缺成本/缺仓储/待归并货号，并输出配套价格覆盖。'),
  };
  const fileSpecs = {
    allSafe: 'all-safe',
    mainNoJsh: 'main-no-jsh',
    jsh: 'jsh',
  };
  const paths = {};
  for (const [key, suffix] of Object.entries(fileSpecs)) {
    const selectionPath = path.join(signupDir, `selection-plan-${opts.dateTag}-${opts.executionTag}-${suffix}.json`);
    const overridesPath = path.join(signupDir, `price-overrides-${opts.dateTag}-${opts.executionTag}-${suffix}.json`);
    await fs.writeFile(selectionPath, JSON.stringify(scopes[key].selection, null, 2), 'utf8');
    await fs.writeFile(overridesPath, JSON.stringify(scopes[key].overrides, null, 2), 'utf8');
    paths[key] = {
      selectionPlan: path.relative(ROOT, selectionPath).replaceAll('\\', '/'),
      priceOverrides: path.relative(ROOT, overridesPath).replaceAll('\\', '/'),
    };
  }
  const countBy = (items, key) => {
    const out = {};
    for (const item of items) {
      const value = String(item[key] ?? '');
      out[value] = (out[value] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const summary = {
    createdAt: new Date().toISOString(),
    sourceWorkbook: path.relative(ROOT, opts.sourceWorkbook).replaceAll('\\', '/'),
    sourceReport: path.relative(ROOT, opts.sourceReport).replaceAll('\\', '/'),
    totalReviewRows: rows.length,
    selectedAllSafeRows: selected.length,
    selectedMainNoJshRows: mainRows.length,
    selectedJshRows: jshRows.length,
    excludedRows: excluded.length,
    excludedByReason: byReason,
    byActivityAllSafe: countBy(selected, 'activityId'),
    byActivityMainNoJsh: countBy(mainRows, 'activityId'),
    byStoreMainNoJsh: countBy(mainRows, 'storeKey'),
    byStoreJsh: countBy(jshRows, 'storeKey'),
    paths,
    targetFloorMarginPct: round2(targetFloorMargin * 100),
    selectionMarginBasis,
    selectionMarginBasisText: marginBasisText(selectionMarginBasis),
  };
  const jsonPath = path.join(reportsDir, `marketing-signup-execution-plan-${opts.dateTag}-${opts.executionTag}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
  const mdPath = path.join(reportsDir, `marketing-signup-execution-plan-${opts.dateTag}-${opts.executionTag}.md`);
  const topExcluded = excluded.slice(0, 30);
  const md = [
    `# 今日普通活动执行方案 ${opts.dateTag}`,
    '',
    '## 结论',
    `- 活动：${Object.keys(summary.byActivityAllSafe).map(x => `\`${x}\``).join(' / ') || '无'}。`,
    `- 安全候选：${selected.length} 行；主执行（不含 JSH）：${mainRows.length} 行；JSH 单列：${jshRows.length} 行；剔除：${excluded.length} 行。`,
    `- 执行价已逐行写入 \`price-overrides\`：\`targetPrice\` 是普通活动填报价，\`finalTargetPrice\` 是不依赖优惠券触发的保底目标成交价。`,
    `- 逐行安全线：${marginBasisText(selectionMarginBasis)} 必须 >= ${round2(targetFloorMargin * 100)}%，否则不进 allowlist。`,
    '',
    '## 主执行分布（不含 JSH）',
    ...Object.entries(summary.byStoreMainNoJsh).map(([store, count]) => `- ${store}: ${count} 行`),
    '',
    '## 活动分布（全安全清单）',
    ...Object.entries(summary.byActivityAllSafe).map(([activity, count]) => `- 活动 ${activity}: ${count} 行`),
    '',
    '## 剔除原因',
    ...Object.entries(summary.excludedByReason).map(([reason, count]) => `- ${humanLowEtReason(reason)}：${count} 行`),
    '',
    '## 剔除样例（前 30）',
    ...topExcluded.map(r => `- ${r.storeKey} / ${r.activityId} / \`${r.skc}\` / ${r.canonical}: ${humanLowEtReason(r.excludeReason)}；预计最终价 ${fmt(r.finalTargetPrice)} SAR，筛选利润 ${pct(r.marginForSelection)}（不含仓储 ${pct(r.marginBeforeStorage)} / 含仓储 ${pct(r.marginAfterStorage)}）`),
    '',
    '## 文件',
    `- 主执行 allowlist：\`${paths.mainNoJsh.selectionPlan}\``,
    `- 主执行价格覆盖：\`${paths.mainNoJsh.priceOverrides}\``,
    `- JSH allowlist：\`${paths.jsh.selectionPlan}\``,
    `- JSH 价格覆盖：\`${paths.jsh.priceOverrides}\``,
    `- 全店 allowlist：\`${paths.allSafe.selectionPlan}\``,
    `- 全店价格覆盖：\`${paths.allSafe.priceOverrides}\``,
    `- JSON：\`${path.relative(ROOT, jsonPath).replaceAll('\\', '/')}\``,
    '',
  ].join('\n');
  await fs.writeFile(mdPath, md, 'utf8');
  summary.executionPlanJson = path.relative(ROOT, jsonPath).replaceAll('\\', '/');
  summary.executionPlanMd = path.relative(ROOT, mdPath).replaceAll('\\', '/');
  return {summary};
}
function excludedExecutionRow(row) {
  return {
    storeKey: row.storeKey,
    activityId: row.activityId,
    skc: row.skc,
    canonical: row.canonical,
    targetPrice: row.targetPrice,
    finalTargetPrice: row.finalTargetPrice,
    couponFactor: row.couponFactor,
    marginBeforeStorage: row.marginBeforeStorage,
    marginAfterStorage: row.marginAfterStorage,
    marginForSelection: row.marginForSelection,
    selectionMarginBasis: row.selectionMarginBasis,
    isTopExposureLink: row.isTopExposureLink,
    preLowEtTargetPrice: row.preLowEtTargetPrice ?? null,
    lowEtFastSellerPricePullback: row.lowEtFastSellerPricePullback || null,
    excludeReason: row.excludeReason,
    note: row.note,
  };
}
function humanLowEtReason(reason) {
  const text = String(reason || '').trim();
  const labels = {
    ordinary_link_target_margin_plus_5_points: '普通链接：目标利润率提高5个百分点',
    top5_restore_latest_approved_canonical_ordinary_price: 'Top5链接：恢复该标准货号统一普通档已批准价',
    active_manual_special_requires_user_review: '有效人工特殊折扣仍在保护期，保持原价，不自动覆盖',
    top5_missing_canonical_ordinary_approved_price: '低库存Top5缺该标准货号统一普通档已批准价',
    missing_current_day_matched_et_inventory: 'ET当天库存未匹配，不能判定为低库存',
    missing_complete_canonical_valid_sales_30d: '缺同货号跨19店完整30天销量证据',
  };
  return labels[text] || text;
}
function parseArgs(argv) {
  const allowedKeys = new Set([
    'baselinePriceOverrides',
    'baselineUserRemarks',
    'activities',
    'bi',
    'cost',
    'date',
    'executionOutputDir',
    'executionTag',
    'exposureData',
    'inventoryTrend',
    'manualLimitedRegistry',
    'outputDir',
    'pricingPolicy',
    'rawLinkHistoryDir',
    'report',
    'selectionMarginBasis',
    'targetFloorMarginPct',
    'version',
  ]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (!allowedKeys.has(key)) throw new Error(`Unknown argument: --${rawKey}`);
    const value = inlineValue !== undefined
      ? inlineValue
      : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '');
    if (value === '') throw new Error(`Missing value for --${rawKey}`);
    out[key] = value;
  }
  return out;
}
