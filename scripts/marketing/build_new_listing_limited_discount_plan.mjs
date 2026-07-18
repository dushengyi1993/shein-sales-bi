#!/usr/bin/env node
/**
 * Build the actionable limited-discount fallback plan for links listed within
 * the policy window and not yet covered by ordinary marketing.
 *
 * This script is read-only. It produces per-store rescue JSON files for
 * apply_hl_limited_discount_rescue.mjs; execution still goes through that
 * browser/dry-run/readback guarded script.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  buildExposureTopLinkIndex,
  buildLinkRowIndexFromBi,
  deriveTopTreatmentTargetFromCost,
  exposureRankInfo,
  hasOrdinaryMarketingEvidence,
  isRecentNewListingLink,
  loadMarketingPricingPolicy,
  unwrapBiLinksData,
} from '../../lib/marketing_pricing_policy.mjs';
import {
  collectRelistedLinkHistoryEvidence,
  marketingLinkKey,
} from '../../lib/marketing_relisted_link_history.mjs';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
  mergeMarketingLinkRows,
} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';
import {
  buildManualLimitedDiscountIndex,
  classifyManualLimitedDiscountLiveState,
  loadManualLimitedDiscountRegistry,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';

const ROOT = process.cwd();
const DEFAULT_LINKS_DATA = path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json');
const DEFAULT_POLICY = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
const DEFAULT_STORES_CONFIG = path.join(ROOT, 'config', 'stores.json');
const DEFAULT_COST_MAP = path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json');
const DEFAULT_PRICE_OVERRIDES = path.join(
  ROOT,
  'tmp',
  'marketing-signup',
  'price-overrides-2026-06-22-45579-45589-46479-no-coupon-baseline16-userremarks-sk999-14-19-jitter-gapfill-fy6810-lq2-all-safe.json',
);

const args = parseArgs(process.argv.slice(2));
const reportDate = args.date || formatLocalDate(new Date());
const linksDataPath = path.resolve(ROOT, args.linksData || DEFAULT_LINKS_DATA);
const priceOverridesPath = path.resolve(ROOT, args.priceOverrides || DEFAULT_PRICE_OVERRIDES);
const policyPath = path.resolve(ROOT, args.pricingPolicy || DEFAULT_POLICY);
const linkHistoryDir = path.resolve(ROOT, args.linkHistoryDir || path.join('outputs', 'shein_links'));
const outDir = path.resolve(ROOT, args.outDir || path.join('tmp', 'marketing-signup', 'limited-discount-fallback', `new-listing-7d-${reportDate}`));
const reportJsonPath = path.resolve(ROOT, args.reportJson || path.join('outputs', 'reports', `new-listing-7d-limited-discount-plan-${reportDate}.json`));
const reportMdPath = path.resolve(ROOT, args.reportMd || path.join('outputs', 'reports', `new-listing-7d-limited-discount-plan-${reportDate}.md`));
const sourceGuardPath = args.sourceGuard ? path.resolve(ROOT, args.sourceGuard) : '';

const policy = await loadMarketingPricingPolicy(policyPath);
const effectiveNow = args.now ? new Date(String(args.now).replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(args.now)) ? '' : '+08:00')) : new Date();
if (!Number.isFinite(effectiveNow.getTime())) throw new Error(`Invalid --now: ${args.now}`);
const manualLimitedDiscountRegistry = await loadManualLimitedDiscountRegistry();
const manualLimitedDiscountIndex = buildManualLimitedDiscountIndex(
  manualLimitedDiscountRegistry,
  effectiveNow,
);
const costMapPath = path.resolve(ROOT, args.costMap || policy?.topTreatmentCostFallback?.costMapPath || DEFAULT_COST_MAP);
const durationDays = positiveInt(
  policy?.newListingWithin7Days?.limitedDiscount?.durationDays ?? policy?.limitedDiscount?.defaultDurationDays,
  7,
);
const activityStock = positiveInt(policy?.limitedDiscount?.defaultActivityStock, 10);
const endTime = args.endTime || `${addDays(reportDate, durationDays)} 23:59:59`;
const activityNamePrefix = args.activityNamePrefix || policy?.newListingWithin7Days?.limitedDiscount?.activityNamePrefix || '新上架7天高曝光兜底限时折扣';
const relistedPolicy = policy?.relistedWithoutActiveMarketing || {};
const relistedActivityNamePrefix = relistedPolicy?.limitedDiscount?.activityNamePrefix || '重新上架无活动Top5兜底限时折扣';
const mandatoryOnShelfPolicy = policy?.mandatoryOnShelfLimitedDiscount || {};
const mandatoryOnShelfActivityNamePrefix = mandatoryOnShelfPolicy?.activityNamePrefix || '在售老链接漏限时折扣兜底';
const mandatoryOnShelfDurationDays = positiveInt(mandatoryOnShelfPolicy?.durationDays, 30);
const mandatoryOnShelfEndTime = args.mandatoryOnShelfEndTime || `${addDays(reportDate, mandatoryOnShelfDurationDays)} 23:59:59`;

const linksDoc = await readJson(linksDataPath);
const storesConfigPath = path.resolve(ROOT, args.storesConfig || DEFAULT_STORES_CONFIG);
const storesConfig = await readJson(storesConfigPath);
const priceDoc = await readJson(priceOverridesPath);
const costDoc = fsSync.existsSync(costMapPath) ? await readJson(costMapPath) : {};
const liveScanPath = args.currentMarketingLiveScan
  ? path.resolve(ROOT, args.currentMarketingLiveScan)
  : '';
const liveScanDoc = liveScanPath ? await readJson(liveScanPath) : null;
const sourceGuardDoc = sourceGuardPath ? await readJson(sourceGuardPath) : null;
const linksData = unwrapBiLinksData(linksDoc);
const linkRowIndex = buildLinkRowIndexFromBi(linksDoc);
const expectedRawStoreKeys = [...new Set((storesConfig.stores || [])
  .filter(store => store?.enabled !== false)
  .map(store => normStore(store?.storeKey || store?.key || store?.store))
  .filter(Boolean))].sort();
if (!expectedRawStoreKeys.length) throw new Error(`No enabled stores found in stores config: ${storesConfigPath}`);
const latestRawLinks = collectLatestRawMarketingLinkRows({
  historyDir: linkHistoryDir,
  reportDate,
  storeKeys: expectedRawStoreKeys,
});
const latestRawLinkCoverage = assessLatestRawMarketingLinkCoverage({
  sourceFiles: latestRawLinks.sourceFiles,
  errors: latestRawLinks.errors,
  storeKeys: expectedRawStoreKeys,
});
if (!latestRawLinkCoverage.complete) {
  throw new Error(
    `Latest raw link overlay incomplete: expectedStores=${latestRawLinkCoverage.expectedStoreCount} `
    + `sourceFiles=${latestRawLinkCoverage.sourceFileCount} missing=${latestRawLinkCoverage.missingStoreKeys.join(',') || '(none)'} `
    + `parseErrors=${latestRawLinkCoverage.parseErrorCount}; refuse to generate a false no-action plan.`,
  );
}
const mergedLinks = mergeMarketingLinkRows([...linkRowIndex.byLinkKey.values()], latestRawLinks.rows);
const storeLinks = mergedLinks.rows;
if (storeLinks.length === 0) {
  throw new Error('No normalized store+SKC rows found in links data; refuse to report a false no-action result.');
}
const primaryPriceIndex = buildPriceIndex(priceDoc, priceOverridesPath, {isSupplemental: false});
const supplementalPriceIndexes = args.noSupplementalPriceOverrides === 'true'
  ? []
  : await loadSupplementalNewListingPriceIndexes(priceOverridesPath, args.supplementalPriceOverridesDir);
const priceIndexes = [primaryPriceIndex, ...supplementalPriceIndexes];
const exposureIndex = buildExposureTopLinkIndex({storeLinks}, policy);
const liveLimitedEvidence = collectLiveLimitedDiscountEvidence(liveScanDoc, liveScanPath, {
  now: effectiveNow,
  requiredEndTime: endTime,
  expectedStoreKeys: expectedRawStoreKeys,
});
const currentLinkKeys = new Set(storeLinks.map(link => marketingLinkKey(
  link.store_key || link.storeKey || link.store,
  link.skc || link.SKC,
)).filter(key => !key.endsWith('::')));
const relistedHistory = collectRelistedLinkHistoryEvidence({
  historyDir: linkHistoryDir,
  reportDate,
  lookbackDays: relistedPolicy.historyLookbackDays || 60,
  currentKeys: currentLinkKeys,
  storeKeys: new Set(storeLinks.map(link => normStore(link.store_key || link.storeKey || link.store)).filter(Boolean)),
});
const targetPriceDriftStageKeys = new Set((sourceGuardDoc?.limitedDiscountTargetPriceDrift?.belowRows || [])
  .map(row => exactPriceKey(normStore(row?.storeKey || row?.store_key), String(row?.skc || '').trim()))
  .filter(key => !key.endsWith('::')));

const rows = [];
const blocked = [];
const ignored = [];
for (const link of storeLinks) {
  const storeKey = normStore(link.store_key || link.storeKey || link.store);
  const skc = String(link.skc || '').trim();
  if (!storeKey || !skc) {
    ignored.push({storeKey, skc, reason: 'missing_store_or_skc'});
    continue;
  }
  const recent = isRecentNewListingLink(link, policy, reportDate);
  const exactKey = exactPriceKey(storeKey, skc);
  const manualSpecialEntry = manualLimitedDiscountIndex.activeByKey.get(exactKey) || null;
  const relistedEvidence = relistedHistory.bySkc.get(exactKey) || null;
  const liveMarketingRows = liveLimitedEvidence.anyBySkc.get(exactKey) || [];
  const liveLimitedRows = liveLimitedEvidence.bySkc.get(exactKey) || [];
  const relistedApplies = relistedPolicy.enabled !== false
    && relistedEvidence
    && isOnShelfMarketingLink(link)
    && (relistedPolicy.requireLatestSourceHasNoActivity === false || relistedEvidence.latestHasActivity === false)
    && (relistedPolicy.requireNoBiMarketingSignal === false || !hasBiActiveMarketingSignal(link))
    && (relistedPolicy.requireCompleteLiveMarketingScan === false || liveLimitedEvidence.complete)
    && liveMarketingRows.length === 0;
  const mandatoryOnShelfApplies = mandatoryOnShelfPolicy.enabled !== false
    && isOnShelfMarketingLink(link)
    && (mandatoryOnShelfPolicy.requireCompleteLiveMarketingScan === false || liveLimitedEvidence.complete)
    && liveLimitedRows.length === 0;
  if (!recent.applies && !relistedApplies && !mandatoryOnShelfApplies) continue;
  if (targetPriceDriftStageKeys.has(exactKey)) {
    ignored.push({
      storeKey,
      skc,
      canonical: normalizeCanonicalFromLink(link),
      reason: 'handled_by_exact_target_price_drift_stage',
    });
    continue;
  }
  if (manualSpecialEntry && String(args.excludeManualSpecial || 'false') === 'true') {
    ignored.push({
      storeKey,
      skc,
      canonical: normalizeCanonicalFromLink(link),
      reason: 'manual_special_managed_by_dedicated_restore_stage',
      specialPrice: manualSpecialEntry.specialPrice,
      validTo: manualSpecialEntry.validTo,
    });
    continue;
  }
  const treatmentType = recent.applies
    ? 'new_listing_within_7d'
    : relistedApplies
      ? 'relisted_without_active_marketing'
      : 'existing_on_shelf_missing_limited_discount';

  const canonical = normalizeCanonicalFromLink(link);
  const exactPriceEvidence = findPriceEvidenceAcross(priceIndexes, canonical, storeKey, skc, {allowCanonicalFallback: false});
  const priceEvidence = exactPriceEvidence || findPriceEvidenceAcross(priceIndexes, canonical, storeKey, skc);
  const manualSpecialLiveState = manualSpecialEntry
    ? classifyManualLimitedDiscountLiveState(manualSpecialEntry, liveLimitedRows)
    : null;
  const liveCoveredByName = isLiveNewListingLimitedDiscountCovered(liveLimitedRows);
  const biLimitedExplicitlyInactive = (
    link.marketing_limited_discount_is_current === false
    || link.marketing_limited_discount_is_current === 0
    || link.marketing_limited_discount_is_current === '0'
  );
  const currentLimitedPrice = numberOrNull(
    (liveLimitedRows.length ? liveLimitedRows[0].price : null)
    ?? (biLimitedExplicitlyInactive
      ? null
      : link.marketing_limited_discount_price_sar
        ?? link.marketing_limited_discount_price
        ?? link.limitedDiscountPrice),
  );
  const hasCurrentLimitedDiscount = (
    liveLimitedRows.length > 0
    || link.marketing_limited_discount_is_current === true
    || link.marketing_limited_discount_is_current === 1
    || link.marketing_limited_discount_is_current === '1'
    || (!biLimitedExplicitlyInactive && currentLimitedPrice !== null)
  );
  const planTopTier = resolveTopTierPrice(priceEvidence);
  const costTopTier = deriveTopTreatmentTargetFromCost({canonical, costDoc, policy});
  const ordinaryTopTier = Number.isFinite(planTopTier.price) && planTopTier.price > 0 ? planTopTier : costTopTier;
  const currentExposureRank = exposureRankInfo(exposureIndex, canonical, skc, storeKey);
  const mandatoryTier = resolveMandatoryOnShelfTarget({
    priceEvidence,
    costTopTier,
    isTopExposureLink: currentExposureRank.isTopExposureLink,
  });
  const resolvedTopTier = manualSpecialEntry
    ? {price: manualSpecialEntry.specialPrice, source: 'manual_special_limited_discount_override'}
    : treatmentType === 'existing_on_shelf_missing_limited_discount'
      ? mandatoryTier
      : ordinaryTopTier;
  const eligibleLiveCoverage = treatmentType === 'existing_on_shelf_missing_limited_discount'
    ? hasCurrentLimitedDiscount
    : liveCoveredByName;
  const liveCoveredAtTarget = (manualSpecialEntry ? manualSpecialLiveState?.status === 'covered_exact' : eligibleLiveCoverage)
    && Number.isFinite(resolvedTopTier.price)
    && currentLimitedPrice !== null
    && (manualSpecialEntry
      ? Math.abs(round2(currentLimitedPrice) - round2(resolvedTopTier.price)) <= 0.01
      : round2(currentLimitedPrice) >= round2(resolvedTopTier.price) - 0.01);
  const liveCoveredNoTargetEvidence = eligibleLiveCoverage && (!Number.isFinite(resolvedTopTier.price) || resolvedTopTier.price <= 0);
  const common = {
    storeKey,
    skc,
    canonical,
    rawGoodsSn: link.raw_goods_sn || link.rawGoodsSn || '',
    supplierNo: link.raw_goods_sn || link.rawGoodsSn || canonical,
    treatmentType,
    shelfAgeDays: recent.shelfAgeDays ?? numberOrNull(link.shelf_age_days ?? link.shelf_days),
    shelfAgeSource: recent.shelfAgeSource || 'historical_relist_transition',
    platformNewLabel: recent.platformNewLabel || null,
    lastInactiveDate: relistedEvidence?.lastInactiveDate || '',
    lastInactiveStatus: relistedEvidence?.lastInactiveStatus || '',
    relistedAt: relistedEvidence?.relistedAt || '',
    relistedHistorySnapshotCount: relistedEvidence?.inactiveSnapshotCount || 0,
    relistedLatestSourceHasActivity: relistedEvidence?.latestHasActivity ?? null,
    c7EpsUv: numberOrNull(link.c7_eps_uv ?? link.c7EpsUv),
    c30EpsUv: numberOrNull(link.c30_eps_uv ?? link.c30EpsUv),
    currentPrice: numberOrNull(link.current_price_sar ?? link.currentPriceSar ?? link.current_price ?? link.original_supply_price_range_sar),
    currentLimitedPrice,
    hasCurrentLimitedDiscount,
    performanceActivityNames: link.performance_activity_names || '',
    firstShelfTime: link.first_shelf_time || '',
    ordinaryMarketingEvidence: hasOrdinaryMarketingEvidence(link),
    currentExposureRank: currentExposureRank.rank ?? null,
    currentExposureIsTop5: currentExposureRank.isTopExposureLink === true,
    manualSpecialLimitedDiscount: Boolean(manualSpecialEntry),
    manualSpecialLiveStatus: manualSpecialLiveState?.status || '',
    manualSpecialValidFrom: manualSpecialEntry?.validFrom || '',
    manualSpecialValidTo: manualSpecialEntry?.validTo || '',
    manualSpecialCurrentActivityId: manualSpecialEntry?.currentActivityId || null,
  };
  if (liveCoveredAtTarget || liveCoveredNoTargetEvidence) {
    ignored.push({
      ...common,
      reason: liveCoveredAtTarget
        ? 'live_new_listing_limited_discount_already_covered_at_target'
        : 'live_new_listing_limited_discount_already_covered_target_evidence_missing',
      liveLimitedDiscountSource: liveLimitedEvidence.path || '',
      liveLimitedDiscountNames: [...new Set(liveLimitedRows.map(row => row.name).filter(Boolean))],
      plannedLimitedDiscountPrice: resolvedTopTier.price,
      topTierPriceSource: resolvedTopTier.source,
    });
    continue;
  }
  if (!manualSpecialEntry && !priceEvidence && !costTopTier.available) {
    blocked.push({
      ...common,
      reason: 'missing_price_and_product_cost_evidence_for_canonical',
      costEvidence: costTopTier,
      note: '最新最终版 price-overrides 无该标准货号，且成本表也没有可用商品成本，才能阻断自动限时折扣。',
    });
    continue;
  }
  if (!Number.isFinite(resolvedTopTier.price) || resolvedTopTier.price <= 0) {
    blocked.push({
      ...common,
      reason: 'missing_top_tier_price',
      priceEvidence,
      note: '该标准货号有普通目标价，但没有可继承/推导的曝光前五目标价，不能自动套“前五力度”。',
    });
    continue;
  }
  const topTierPrice = resolvedTopTier.price;
  const action = manualSpecialEntry
    ? (manualSpecialLiveState?.status === 'covered_exact' ? 'keep_manual_special_limited_discount' : 'restore_manual_special_limited_discount')
    : hasCurrentLimitedDiscount ? 'replace_existing_limited_discount' : 'create_limited_discount';
  rows.push({
    ...common,
    action,
    needsLimitedDiscount: true,
    limitedDiscountPrice: topTierPrice,
    finalTargetPrice: topTierPrice,
    targetPrice: topTierPrice,
    expectedFinalNoCoupon: topTierPrice,
    expectedFinalAfterLimitedAnd15Coupon: '',
    couponFactor: 1,
    originalPlannedFinalPrice: topTierPrice,
    sourceRule: manualSpecialEntry
      ? 'manual_special_limited_discount_override'
      : treatmentType === 'relisted_without_active_marketing'
      ? 'relisted_without_active_marketing_same_as_global_exposure_top5'
      : treatmentType === 'existing_on_shelf_missing_limited_discount'
      ? 'existing_on_shelf_missing_limited_discount_current_exposure_tier'
      : 'new_listing_within_7d_same_as_global_exposure_top5',
    combo: treatmentType === 'relisted_without_active_marketing'
      ? '重新上架无生效营销活动限时折扣兜底；不依赖优惠券'
      : treatmentType === 'existing_on_shelf_missing_limited_discount'
      ? '在售老链接漏限时折扣兜底；不依赖优惠券'
      : '新上架7天限时折扣兜底；不依赖优惠券',
    note: manualSpecialEntry
      ? `用户批准人工特殊限时折扣保护：精确恢复 ${formatPrice(manualSpecialEntry.specialPrice)} SAR、活动库存 ${manualSpecialEntry.activityStock}，有效至 ${manualSpecialEntry.validTo}；不得用普通 Top5/基准价覆盖。`
      : treatmentType === 'relisted_without_active_marketing'
      ? `历史快照 ${relistedEvidence.lastInactiveDate} 为${relistedEvidence.lastInactiveStatus || '下架/售罄'}，${relistedEvidence.relistedAt} 恢复在售，当前商品源、BI和完整营销live scan均无生效活动；按曝光前五/新链接力度 ${formatPrice(topTierPrice)} SAR 报一周兜底。`
      : treatmentType === 'existing_on_shelf_missing_limited_discount'
      ? `完整营销live scan确认该在售老链接没有当前/未来限时折扣；按当前全局曝光${currentExposureRank.isTopExposureLink ? 'Top5' : '非Top5'}档位 ${formatPrice(topTierPrice)} SAR 报一周兜底。`
      : hasCurrentLimitedDiscount
        ? `新上架${recent.shelfAgeDays}天且未报普通活动，已有旧限时折扣 ${formatPrice(currentLimitedPrice)} SAR；按新规则取消/结束旧活动后重报一周，目标价按曝光前五力度 ${formatPrice(topTierPrice)} SAR。`
        : `新上架${recent.shelfAgeDays}天且未报普通活动，缺限时折扣；按曝光前五力度 ${formatPrice(topTierPrice)} SAR 报一周兜底。`,
    priceEvidence,
    costEvidence: costTopTier.available ? costTopTier : null,
    productUnitCostSar: costTopTier.productUnitCostSar ?? null,
    storageUnitCostSar: costTopTier.storageUnitCostSar ?? null,
    selectionCostBasis: costTopTier.selectionCostBasis || '',
    topTierPriceSource: resolvedTopTier.source,
    priceEvidenceSourcePath: priceEvidence?.priceOverridesSource || (costTopTier.available ? rel(costMapPath) : ''),
    supplementalPriceEvidence: priceEvidence?.supplementalPriceEvidence === true,
    targetPriceEvidenceScope: exactPriceEvidence
      ? 'exact_store_skc'
      : priceEvidence
        ? 'canonical_top_tier_fallback'
        : 'product_cost_top_treatment_fallback',
    endTime: manualSpecialEntry?.validTo
      || (treatmentType === 'existing_on_shelf_missing_limited_discount' ? mandatoryOnShelfEndTime : endTime),
    activityStock: manualSpecialEntry?.activityStock || activityStock,
    activityNamePrefix: manualSpecialEntry
      ? `${storeKey}人工特殊限时折扣保护恢复`
      : treatmentType === 'relisted_without_active_marketing'
        ? relistedActivityNamePrefix
        : treatmentType === 'existing_on_shelf_missing_limited_discount'
          ? mandatoryOnShelfActivityNamePrefix
          : activityNamePrefix,
  });
}

rows.sort(compareRows);
blocked.sort(compareRows);

await fs.mkdir(outDir, {recursive: true});
await fs.mkdir(path.dirname(reportJsonPath), {recursive: true});

const rescueFiles = [];
for (const [, storeRows] of groupBy(rows, row => `${row.storeKey}::${row.endTime}::${row.activityStock}::${row.activityNamePrefix}`).entries()) {
  const storeKey = storeRows[0].storeKey;
  const windowSuffix = String(storeRows[0].endTime || endTime).slice(0, 10).replaceAll('-', '');
  const treatmentTypes = [...new Set(storeRows.map(row => row.treatmentType).filter(Boolean))];
  const treatmentSuffix = treatmentTypes.length === 1
    ? treatmentTypes[0].replaceAll('_', '-')
    : 'mixed-treatments';
  const rescuePath = path.join(outDir, `limited-${storeKey}-${treatmentSuffix}-${reportDate}-${windowSuffix}-s${storeRows[0].activityStock}.json`);
  const storePrefixes = [...new Set(storeRows.map(row => row.activityNamePrefix).filter(Boolean))];
  const storeActivityNamePrefix = storePrefixes.length === 1
    ? storePrefixes[0]
    : '新上架及重新上架Top5兜底限时折扣';
  const rescue = {
    createdAt: new Date().toISOString(),
    storeKey,
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${reportDate}`,
    sourceLinksData: rel(linksDataPath),
    sourcePriceOverrides: rel(priceOverridesPath),
    sourceGuard: sourceGuardPath ? rel(sourceGuardPath) : '',
    pricingPolicy: rel(policyPath),
    endTime: storeRows[0].endTime,
    activityStock: storeRows[0].activityStock,
    activityNamePrefix: storeActivityNamePrefix,
    rows: storeRows.map(row => ({
      storeKey: row.storeKey,
      skc: row.skc,
      canonical: row.canonical,
      supplierNo: row.supplierNo,
      currentPrice: row.currentPrice,
      finalTargetPrice: row.finalTargetPrice,
      targetPrice: row.targetPrice,
      needsLimitedDiscount: true,
      limitedDiscountPrice: row.limitedDiscountPrice,
      expectedFinalAfterLimitedAnd15Coupon: '',
      originalPlannedFinalPrice: row.originalPlannedFinalPrice,
      expectedFinalNoCoupon: row.expectedFinalNoCoupon,
      couponFactor: 1,
      sourceRule: row.sourceRule,
      treatmentType: row.treatmentType,
      combo: row.combo,
      note: row.note,
      shelfAgeDays: row.shelfAgeDays,
      lastInactiveDate: row.lastInactiveDate,
      lastInactiveStatus: row.lastInactiveStatus,
      relistedAt: row.relistedAt,
      c7EpsUv: row.c7EpsUv,
      previousLimitedPrice: row.currentLimitedPrice,
      action: row.action,
      topTierPriceSource: row.topTierPriceSource,
      productUnitCostSar: row.productUnitCostSar,
      storageUnitCostSar: row.storageUnitCostSar,
      selectionCostBasis: row.selectionCostBasis,
      manualSpecialLimitedDiscount: row.manualSpecialLimitedDiscount,
      manualSpecialValidFrom: row.manualSpecialValidFrom,
      manualSpecialValidTo: row.manualSpecialValidTo,
      manualSpecialCurrentActivityId: row.manualSpecialCurrentActivityId,
      activityStock: row.activityStock,
    })),
  };
  await fs.writeFile(rescuePath, `${JSON.stringify(rescue, null, 2)}\n`, 'utf8');
  rescueFiles.push({
    storeKey,
    path: rel(rescuePath),
    count: storeRows.length,
    actions: countBy(storeRows, 'action'),
    treatments: countBy(storeRows, 'treatmentType'),
    activityNamePrefix: storeActivityNamePrefix,
  });
}

const summary = {
  createdAt: new Date().toISOString(),
  reportDate,
  sourceGuard: sourceGuardPath ? rel(sourceGuardPath) : '',
  sourceLinksData: rel(linksDataPath),
  sourceLinksGeneratedAt: linksDoc.generatedAt || linksData.generatedAt || '',
  sourcePriceOverrides: rel(priceOverridesPath),
  sourceCostMap: rel(costMapPath),
  sourceCurrentMarketingLiveScan: liveScanPath ? rel(liveScanPath) : '',
  sourceRelistedLinkHistory: rel(linkHistoryDir),
  latestRawLinkOverlay: {
    ...latestRawLinkCoverage,
    sourceFileCount: latestRawLinks.sourceFiles.length,
    sourceFiles: latestRawLinks.sourceFiles.map(file => ({...file, path: rel(file.path)})),
    parseErrorCount: latestRawLinks.errors.length,
    errors: latestRawLinks.errors.slice(0, 20),
    rawRowCount: mergedLinks.rawRowCount,
    addedRowCount: mergedLinks.addedRowCount,
    addedRows: mergedLinks.addedRows.slice(0, 60).map(row => ({
      storeKey: row.store_key,
      skc: row.skc,
      canonical: row.standard_goods_sn,
      linkDate: row.link_date,
      firstShelfTime: row.first_shelf_time,
      source: rel(row.raw_link_snapshot_source),
    })),
  },
  pricingPolicy: rel(policyPath),
  rule: {
    windowDays: Number(policy?.newListingWithin7Days?.windowDays || 7),
    pricingTreatment: policy?.newListingWithin7Days?.pricingTreatment || 'same_as_global_exposure_top5',
    durationDays,
    activityStock,
    endTime,
    activityNamePrefix,
    relistedActivityNamePrefix,
    mandatoryOnShelfActivityNamePrefix,
    mandatoryOnShelfDurationDays,
    mandatoryOnShelfEndTime,
    mandatoryOnShelfRequireCompleteLiveScan: mandatoryOnShelfPolicy.requireCompleteLiveMarketingScan !== false,
    liveLimitedEvidenceComplete: liveLimitedEvidence.complete,
    relistedHistoryLookbackDays: Number(relistedPolicy.historyLookbackDays || 60),
    relistedHistoryStatus: relistedHistory.status,
    relistedHistorySourceFileCount: relistedHistory.sourceFileCount,
    relistedHistoryParseErrorCount: relistedHistory.parseErrorCount,
  },
  totals: {
    storeLinks: storeLinks.length,
    actionable: rows.length,
    newListingWithin7Days: rows.filter(row => row.treatmentType === 'new_listing_within_7d').length,
    relistedWithoutActiveMarketing: rows.filter(row => row.treatmentType === 'relisted_without_active_marketing').length,
    existingOnShelfMissingLimitedDiscount: rows.filter(row => row.treatmentType === 'existing_on_shelf_missing_limited_discount').length,
    createLimitedDiscount: rows.filter(row => row.action === 'create_limited_discount').length,
    replaceExistingLimitedDiscount: rows.filter(row => row.action === 'replace_existing_limited_discount').length,
    blocked: blocked.length,
    ignored: ignored.length,
    liveCoveredIgnored: ignored.filter(row => String(row.reason || '').startsWith('live_new_listing_limited_discount_already_covered')).length,
  },
  byStore: countBy(rows, 'storeKey'),
  rescueFiles,
  supplementalPriceOverrides: supplementalPriceIndexes.map(index => ({
    path: rel(index.sourcePath),
    rowCount: index.rowCount,
    createdAt: index.createdAt || '',
    baselineForLimitedDiscountFallback: index.baselineForLimitedDiscountFallback === true,
  })),
  rows,
  blocked,
  ignored: ignored.slice(0, 30),
};

await fs.writeFile(reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
await fs.writeFile(reportMdPath, buildMarkdown(summary), 'utf8');
console.log(JSON.stringify({
  ok: true,
  reportJson: rel(reportJsonPath),
  reportMd: rel(reportMdPath),
  actionable: rows.length,
  blocked: blocked.length,
  rescueFiles,
}, null, 2));

async function loadSupplementalNewListingPriceIndexes(primaryPath, requestedDir = '') {
  const dir = requestedDir
    ? path.resolve(ROOT, requestedDir)
    : path.join(ROOT, 'tmp', 'marketing-signup');
  if (!fsSync.existsSync(dir)) return [];
  const primaryResolved = path.resolve(primaryPath || '');
  const candidates = [];
  for (const entry of fsSync.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isFile() || !/^price-overrides-.*\.json$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (path.resolve(full) === primaryResolved) continue;
    let doc = null;
    try {
      doc = JSON.parse(fsSync.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const items = Array.isArray(doc?.items) ? doc.items : [];
    if (items.length < 100) continue;
    if (doc?.scope?.repairOnly === true) continue;
    if (doc?.baselineForLimitedDiscountFallback !== true && doc?.baselineForNextOrdinaryActivity !== true) continue;
    const stat = fsSync.statSync(full);
    candidates.push({
      full,
      doc,
      score: Math.max(dateToMs(doc?.createdAt), stat.mtimeMs)
        + (doc?.baselineForLimitedDiscountFallback === true ? 10_000_000 : 0),
    });
  }
  candidates.sort((a, b) => b.score - a.score || String(a.full).localeCompare(String(b.full)));
  return candidates.slice(0, 6).map(candidate => buildPriceIndex(candidate.doc, candidate.full, {isSupplemental: true}));
}

function buildPriceIndex(priceDoc, sourcePath = '', {isSupplemental = false} = {}) {
  const items = Array.isArray(priceDoc?.items) ? priceDoc.items : [];
  const byCanonical = new Map();
  const byExact = new Map();
  for (const item of items) {
    const canonical = normalizeCanonicalFromValue(item.canonical || item.standardGoodsSn || item.standard_goods_sn || item.supplierNo || '');
    const storeKey = normStore(item.storeKey || item.store || item['店铺']);
    const skc = String(item.skc || item.SKC || item['SKC'] || '').trim();
    if (!canonical) continue;
    const key = canonicalKey(canonical);
    if (!byCanonical.has(key)) byCanonical.set(key, {canonical, items: []});
    byCanonical.get(key).items.push(item);
    if (storeKey && skc) byExact.set(exactPriceKey(storeKey, skc), item);
  }
  const evidence = new Map();
  for (const [key, group] of byCanonical.entries()) {
    const topRows = group.items.filter(item => item.isTopExposureLink || item.newListingTopTreatment);
    const topPrices = topRows.map(item => numberOrNull(item.finalTargetPrice ?? item.targetPrice)).filter(Number.isFinite);
    const otherPrices = group.items.filter(item => !(item.isTopExposureLink || item.newListingTopTreatment))
      .map(item => numberOrNull(item.finalTargetPrice ?? item.targetPrice))
      .filter(Number.isFinite);
    const allPrices = group.items.map(item => numberOrNull(item.finalTargetPrice ?? item.targetPrice)).filter(Number.isFinite);
    evidence.set(key, {
      canonical: group.canonical,
      rowCount: group.items.length,
      topRowCount: topRows.length,
      topTierPrice: representativePrice(topPrices),
      otherTierPrice: representativePrice(otherPrices),
      allPriceMin: allPrices.length ? round2(Math.min(...allPrices)) : null,
      topTierSamples: topRows.slice(0, 8).map(item => ({
        storeKey: item.storeKey,
        skc: item.skc,
        finalTargetPrice: item.finalTargetPrice,
        note: item.note || '',
      })),
    });
  }
  return {
    byCanonical: evidence,
    byExact,
    sourcePath: sourcePath || '',
    rowCount: items.length,
    createdAt: priceDoc?.createdAt || '',
    baselineForLimitedDiscountFallback: priceDoc?.baselineForLimitedDiscountFallback === true,
    isSupplemental,
  };
}

function findPriceEvidenceAcross(indexes, canonical, storeKey = '', skc = '', options = {}) {
  for (const index of indexes || []) {
    const evidence = findPriceEvidence(index, canonical, storeKey, skc, options);
    if (!evidence) continue;
    return {
      ...evidence,
      priceOverridesSource: index.sourcePath ? rel(index.sourcePath) : '',
      supplementalPriceEvidence: index.isSupplemental === true,
    };
  }
  return null;
}

function findPriceEvidence(index, canonical, storeKey = '', skc = '', {allowCanonicalFallback = true} = {}) {
  const exact = index.byExact?.get(exactPriceKey(storeKey, skc));
  if (exact) {
    const finalTargetPrice = numberOrNull(exact.finalTargetPrice ?? exact.targetPrice);
    if (Number.isFinite(finalTargetPrice) && finalTargetPrice > 0) {
      return {
        canonical: normalizeCanonicalFromValue(exact.canonical || exact.standardGoodsSn || exact.standard_goods_sn || canonical),
        rowCount: 1,
        topRowCount: exact.isTopExposureLink || exact.newListingTopTreatment ? 1 : 0,
        topTierPrice: round2(finalTargetPrice),
        otherTierPrice: null,
        allPriceMin: round2(finalTargetPrice),
        sourceScope: 'exact_store_skc',
        topTierSamples: [{
          storeKey: exact.storeKey,
          skc: exact.skc,
          finalTargetPrice,
          note: exact.note || '',
        }],
      };
    }
  }
  if (!allowCanonicalFallback) return null;
  return index.byCanonical?.get(canonicalKey(canonical)) || null;
}


function resolveTopTierPrice(priceEvidence) {
  if (!priceEvidence) return {price: null, source: 'missing_price_evidence'};
  const explicit = numberOrNull(priceEvidence.topTierPrice);
  if (Number.isFinite(explicit) && explicit > 0) {
    return {price: round2(explicit), source: priceEvidence.topRowCount ? 'explicit_top_tier_price' : 'exact_store_skc_target_price'};
  }
  const allMin = numberOrNull(priceEvidence.allPriceMin);
  const other = numberOrNull(priceEvidence.otherTierPrice);
  if (Number.isFinite(allMin) && allMin > 0 && (!Number.isFinite(other) || allMin <= other + 0.01)) {
    return {price: round2(allMin), source: 'derived_from_lowest_approved_same_canonical_target_price'};
  }
  return {price: null, source: 'missing_top_tier_price'};
}

function resolveMandatoryOnShelfTarget({priceEvidence, costTopTier, isTopExposureLink = false} = {}) {
  if (priceEvidence?.sourceScope === 'exact_store_skc') {
    const exact = numberOrNull(priceEvidence.topTierPrice ?? priceEvidence.allPriceMin);
    if (Number.isFinite(exact) && exact > 0) return {price: round2(exact), source: 'exact_store_skc_target_price'};
  }
  const tierPrice = numberOrNull(
    isTopExposureLink
      ? (priceEvidence?.topTierPrice ?? priceEvidence?.allPriceMin ?? priceEvidence?.otherTierPrice)
      : (priceEvidence?.otherTierPrice ?? priceEvidence?.topTierPrice ?? priceEvidence?.allPriceMin),
  );
  if (Number.isFinite(tierPrice) && tierPrice > 0) {
    return {
      price: round2(tierPrice),
      source: isTopExposureLink ? 'canonical_current_top5_tier_price' : 'canonical_current_non_top5_tier_price',
    };
  }
  if (costTopTier?.available) {
    if (isTopExposureLink) return {price: costTopTier.price, source: costTopTier.source};
    const cost = numberOrNull(costTopTier.productUnitCostSar);
    const baseMargin = numberOrNull(costTopTier.baseMargin);
    if (Number.isFinite(cost) && cost > 0 && Number.isFinite(baseMargin) && baseMargin > 0 && baseMargin < 1) {
      return {price: ceil2(cost / (1 - baseMargin)), source: 'derived_from_product_cost_non_top5_base_margin'};
    }
  }
  return {price: null, source: 'missing_current_exposure_tier_price'};
}

function collectLiveLimitedDiscountEvidence(liveDoc, livePath = '', {
  now = new Date(),
  requiredEndTime = '',
  expectedStoreKeys = [],
} = {}) {
  const rows = Array.isArray(liveDoc?.rows) ? liveDoc.rows : [];
  const bySkc = new Map();
  const anyBySkc = new Map();
  const observedStoreKeys = new Set([...(liveDoc?.stores || []), ...(liveDoc?.storeStatus || []), ...(liveDoc?.storeStatuses || [])]
    .map(store => normStore(store?.storeKey || store?.store_key || store?.store || store))
    .filter(Boolean));
  const expected = [...new Set((expectedStoreKeys || []).map(normStore).filter(Boolean))];
  const complete = Boolean(
    liveDoc
    && liveDoc.ok !== false
    && liveDoc.partial !== true
    && (!expected.length || expected.every(storeKey => observedStoreKeys.has(storeKey))),
  );
  if (!liveDoc || liveDoc.ok === false) return {path: livePath ? rel(livePath) : '', bySkc, anyBySkc, complete};
  for (const row of rows) {
    const storeKey = normStore(row.store_key || row.storeKey || row.store);
    const skc = String(row.skc || row.SKC || '').trim();
    if (!storeKey || !skc) continue;
    const key = exactPriceKey(storeKey, skc);
    const limitedPrice = numberOrNull(
      row.marketing_limited_discount_price_sar
      ?? row.marketing_limited_discount_price
      ?? row.limitedDiscountPrice
      ?? row.limited_discount_price_sar
    );
    const isLimitedEvidence = (
      row.marketing_limited_discount_is_current === true
      || row.marketing_limited_discount_is_current === 1
      || row.marketing_limited_discount_is_current === '1'
      || /limited/i.test(String(row.marketing_price_evidence_type || row.evidenceType || ''))
      || limitedPrice !== null
    );
    const isCurrentEvidence = isCurrentMarketingEvidenceRow(row);
    const liveLimitedName = row.marketing_limited_discount_name || row.limitedDiscountName || row.activityName || '';
    const startText = row.marketing_limited_discount_start || row.limitedDiscountStart || '';
    const endText = row.marketing_limited_discount_end || row.limitedDiscountEnd || '';
    const startMs = dateToMs(startText);
    const endMs = dateToMs(endText);
    const requiredEndMs = dateToMs(requiredEndTime);
    const futureWindowIsValid = startMs > 0
      && endMs > 0
      && startMs >= now.getTime() - 5 * 60 * 1000
      && startMs <= now.getTime() + 24 * 60 * 60 * 1000
      && (!requiredEndMs || endMs >= requiredEndMs);
    const isFutureFallbackCovered = !isCurrentEvidence
      && isLimitedEvidence
      && futureWindowIsValid
      && isLiveNewListingLimitedDiscountCovered([{name: liveLimitedName}]);
    // A future ordinary campaign must not suppress the current fallback, but a
    // future limited discount is the fallback we just scheduled and must stop
    // the next guard run from creating a duplicate during its start delay.
    if (!isCurrentEvidence && !isFutureFallbackCovered) continue;
    if (!anyBySkc.has(key)) anyBySkc.set(key, []);
    anyBySkc.get(key).push(row);
    if (!isLimitedEvidence) continue;
    if (!bySkc.has(key)) bySkc.set(key, []);
    bySkc.get(key).push({
      price: limitedPrice,
      name: liveLimitedName,
      start: startText,
      end: endText,
    });
  }
  return {path: livePath ? rel(livePath) : '', bySkc, anyBySkc, complete};
}

function isLiveNewListingLimitedDiscountCovered(rows) {
  return (rows || []).some(row => /新上架.*限时折扣|重新上架.*限时折扣|高曝光兜底限时折扣|Top5兜底限时折扣|漏限时折扣兜底|历史销冠.*兜底|new\s*listing|relisted/i.test(String(row.name || '')));
}

function isOnShelfMarketingLink(link) {
  if (link?.is_on_shelf === true || link?.isOnShelf === true) return true;
  if (link?.is_on_shelf === false || link?.isOnShelf === false) return false;
  return /已上架|在售|ON_SHELF/i.test(String(link?.shelf_status_name || link?.shelfStatusName || link?.visible_shelf_statuses || ''))
    && !/下架|售罄|SOLD_OUT|OUT_SHELF/i.test(String(link?.shelf_status_name || link?.shelfStatusName || ''));
}

function hasBiActiveMarketingSignal(link) {
  const statusText = String(link?.activity_label || link?.activity_status || '').trim();
  const futureOnly = /即将开始|待生效|未开始|future/i.test(statusText)
    && !/营销中|活动中|生效中|current|active/i.test(statusText);
  if (!futureOnly && hasOrdinaryMarketingEvidence(link)) return true;
  if (
    link?.marketing_limited_discount_is_current === true
    || link?.marketing_limited_discount_is_current === 1
    || link?.marketing_limited_discount_is_current === '1'
    || (
      link?.marketing_limited_discount_is_current !== false
      && link?.marketing_limited_discount_is_current !== 0
      && link?.marketing_limited_discount_is_current !== '0'
      && numberOrNull(link?.marketing_limited_discount_price_sar ?? link?.marketing_limited_discount_price ?? link?.limitedDiscountPrice) !== null
    )
  ) return true;
  const text = [
    link?.activity_label,
    link?.performance_activity_names,
    link?.marketing_activity_names,
    link?.activity_names,
  ].filter(Boolean).join(' ');
  if (futureOnly) return false;
  return /营销中|活动中|生效中|普通活动|营销活动|限时折扣|优惠券|coupon|campaign|limited\s*discount/i.test(text);
}

function isCurrentMarketingEvidenceRow(row) {
  const evidenceType = String(row?.marketing_price_evidence_type || row?.evidenceType || '').trim();
  if (/^future_/i.test(evidenceType)) return false;
  if (/^current_/i.test(evidenceType)) return true;
  if (row?.marketing_limited_discount_is_current === false || row?.marketing_limited_discount_is_current === 0 || row?.marketing_limited_discount_is_current === '0') return false;
  return true;
}

function normalizeCanonicalFromLink(link) {
  const direct = link?.standard_goods_sn || link?.standardGoodsSn || '';
  const raw = link?.raw_goods_sn || link?.rawGoodsSn || link?.supplierNo || link?.sku_supplier_no || '';
  return normalizeCanonicalFromValue(direct || raw, {
    goodsTitle: link?.product_display_name || link?.product_name_cn || link?.goods_title || '',
  });
}

function normalizeCanonicalFromValue(value, context = {}) {
  const normalized = normalizeGoodsSnDetailed(value, context);
  return normalized.canonical || String(value || '').trim();
}

function representativePrice(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor((nums.length - 1) / 2);
  return round2(nums[mid]);
}

function buildMarkdown(summary) {
  const lines = [];
  lines.push(`# 在售链接限时折扣兜底计划 ${summary.reportDate}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 需要处理：${summary.totals.actionable} 个链接；新上架7天 ${summary.totals.newListingWithin7Days} 个，重新上架且无生效营销活动 ${summary.totals.relistedWithoutActiveMarketing} 个，其他在售老链接漏限时折扣 ${summary.totals.existingOnShelfMissingLimitedDiscount || 0} 个；其中新建限时折扣 ${summary.totals.createLimitedDiscount} 个，已有旧限时折扣需取消/结束后重报 ${summary.totals.replaceExistingLimitedDiscount} 个。`);
  lines.push(`- 阻断：${summary.totals.blocked} 个；主要是缺最新最终版曝光前五目标价或货号归并证据。`);
  lines.push(`- 限时折扣窗口：到 \`${summary.rule.endTime}\`；新链接活动名前缀：\`${summary.rule.activityNamePrefix}\`；重新上架活动名前缀：\`${summary.rule.relistedActivityNamePrefix}\`。`);
  lines.push('');
  lines.push('## 按店铺');
  for (const file of summary.rescueFiles) {
    const actions = Object.entries(file.actions || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`- ${file.storeKey}: ${file.count} 个（${actions}），rescue：\`${file.path}\``);
  }
  if (!summary.rescueFiles.length) lines.push('- 无可执行店铺。');
  lines.push('');
  lines.push('## 明细');
  for (const row of summary.rows.slice(0, 80)) {
    const treatment = row.treatmentType === 'relisted_without_active_marketing'
      ? `重新上架（${row.lastInactiveDate} ${row.lastInactiveStatus || '下架/售罄'} → ${row.relistedAt} 在售）`
      : row.treatmentType === 'existing_on_shelf_missing_limited_discount'
        ? `在售老链接（当前曝光${row.currentExposureIsTop5 ? 'Top5' : '非Top5'}档）`
      : `新上架 ${row.shelfAgeDays} 天`;
    lines.push(`- ${row.storeKey} / \`${row.skc}\` / ${row.canonical}: ${row.action === 'create_limited_discount' ? '新建' : '取消旧折扣后重报'}，${treatment}，目标 ${formatPrice(row.limitedDiscountPrice)} SAR，7天曝光 ${row.c7EpsUv ?? 0}。`);
  }
  if (summary.blocked.length) {
    lines.push('');
    lines.push('## 阻断');
    for (const row of summary.blocked.slice(0, 30)) {
      lines.push(`- ${row.storeKey} / \`${row.skc}\` / ${row.canonical}: ${row.reason}；${row.note || ''}`);
    }
  }
  lines.push('');
  lines.push('## 文件');
  lines.push(`- JSON：\`${rel(reportJsonPath)}\``);
  lines.push(`- 本报告：\`${rel(reportMdPath)}\``);
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[key] = value;
  }
  return out;
}

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row?.[field] || '(empty)');
    out[key] = (out[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function compareRows(a, b) {
  const av = Number(a.c7EpsUv || 0);
  const bv = Number(b.c7EpsUv || 0);
  if (bv !== av) return bv - av;
  return String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc));
}

function canonicalKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]_:：/\\-]/g, '')
    .toUpperCase();
}

function exactPriceKey(storeKey, skc) {
  return `${normStore(storeKey)}::${String(skc || '').trim()}`;
}

function normStore(value) {
  return String(value || '').trim().toUpperCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + Number(days || 0));
  return formatLocalDate(date);
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}

function ceil2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.ceil((n - Number.EPSILON) * 100) / 100 : null;
}

function dateToMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(' ', 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : 0;
}

function formatPrice(value) {
  const n = round2(value);
  return n === null ? '' : String(n);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

