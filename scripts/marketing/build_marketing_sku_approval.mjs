import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { normalizeGoodsSnDetailed } from '../../lib/product_sku_normalizer.mjs';
import {
  buildExposureTopLinkIndex,
  exposureTopRowsForCanonical,
  loadMarketingPricingPolicy,
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
const outDir = path.join(ROOT, 'outputs', 'reports');

const activityDoc = JSON.parse(await fs.readFile(reportJson, 'utf8'));
const cloudBi = JSON.parse(await fs.readFile(cloudBiPath, 'utf8'));
const cloudCostDoc = JSON.parse(await fs.readFile(cloudCostPath, 'utf8'));
const pricingPolicyPath = path.resolve(ROOT, cli.pricingPolicy || path.join('config', 'marketing_pricing_policy.json'));
const pricingPolicy = await loadMarketingPricingPolicy(pricingPolicyPath);
const exposureIndex = buildExposureTopLinkIndex(cloudBi, pricingPolicy);
const cloudBiStat = fssync.statSync(cloudBiPath);
const cloudCostStat = fssync.statSync(cloudCostPath);

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

const rawRows = activityDoc.detailRows || [];
const rows = rawRows.map(normalizeReviewRow);

const bySku = new Map();
for (const r of rows) {
  const sku = r['标准货号'] || r['供方货号'] || r['SKC'] || '未识别货号';
  if (!bySku.has(sku)) bySku.set(sku, []);
  bySku.get(sku).push(r);
}

const approvalRows = [];
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
  const skuReviewReasons = uniq(group.map(r => r._approvalNormalized?.needsReview ? r._approvalNormalized.reviewReason : '').filter(Boolean));
  const skuNeedsReview = skuReviewReasons.length > 0;
  const missingCost = productCostValues.length === 0;
  const storageMissing = !missingCost && storageKnownValues.length === 0;
  const keyList = [sku, ...group.map(r => r['供方货号'])].filter(Boolean);
  const fixed = findRule(fixedRules, keyList);
  const specialMargin = findRule(marginRules, keyList);
  const baseTargetMargin = fixed !== null ? null : (specialMargin ?? 0.30);
  const exposureTargets = baseTargetMargin === null ? null : marginTargetsForExposurePolicy(baseTargetMargin, pricingPolicy);
  const topExposureRows = fixed !== null ? [] : exposureTopRowsForCanonical(exposureIndex, sku);
  const hasExposureRanking = topExposureRows.length > 0;
  const groupSkcs = new Set(group.map(r => String(r['SKC'] || '').trim()).filter(Boolean));
  const topExposureSkcsInGroup = topExposureRows.filter(row => groupSkcs.has(row.skc));
  const targetMargin = fixed !== null ? null : (hasExposureRanking ? (exposureTargets?.otherMargin ?? baseTargetMargin) : baseTargetMargin);
  const topExposureMargin = fixed !== null || !hasExposureRanking ? null : (exposureTargets?.topMargin ?? null);
  const exposureRuleText = fixed !== null
    ? '固定价/逐行覆盖价优先，不自动套曝光利润率'
    : hasExposureRanking
      ? `前五 ${pctRatioText(topExposureMargin)} / 其他 ${pctRatioText(targetMargin)}`
      : '曝光数据缺失：保持基础利润率';
  const targetMode = fixed !== null
    ? '固定最终成交价'
    : `${specialMargin !== null ? `目标利润率 ${pct(specialMargin)}` : '默认目标利润率 30%'}；曝光规则：${exposureRuleText}`;
  const safeProductCost = productCostValues.length ? Math.max(...productCostValues) : null;
  const targetFinal = fixed !== null ? fixed : (safeProductCost !== null ? ceil2(safeProductCost / (1 - targetMargin)) : null);
  const topExposureTargetFinal = fixed !== null || topExposureMargin === null
    ? null
    : (safeProductCost !== null ? ceil2(safeProductCost / (1 - topExposureMargin)) : null);
  const priceFor15Coupon = targetFinal !== null ? ceil2(targetFinal / 0.85) : null;
  const priceFor50Coupon = targetFinal !== null ? ceil2(targetFinal / 0.50) : null;
  const minPlatformCap = platformCaps.length ? Math.min(...platformCaps) : null;
  const safeNoCouponAll = targetFinal !== null && minPlatformCap !== null && targetFinal <= minPlatformCap;
  const safe15All = priceFor15Coupon !== null && minPlatformCap !== null && priceFor15Coupon <= minPlatformCap;
  const activityPriceForStrategy = couponRows.length && safe15All ? priceFor15Coupon : targetFinal;
  const couponFactorForStrategy = couponRows.length && safe15All ? 0.85 : 1;
  const effectiveNoCouponPrices = group.map(r => {
    const current = numValue(r['当前售价SAR']);
    const minDiscount = numValue(r['平台最低降幅%']) ?? 0;
    const cap = isNum(current) ? floor2(current * (1 - minDiscount / 100)) : null;
    if (activityPriceForStrategy === null) return null;
    return cap === null ? activityPriceForStrategy : Math.min(activityPriceForStrategy, cap);
  }).filter(isNum);
  const recFinals = effectiveNoCouponPrices.map(p => round2(p * couponFactorForStrategy));
  const targetProductMargins = [];
  const targetFullMargins = [];
  const cappedProductMargins = [];
  const cappedFullMargins = [];
  for (const [idx, r] of group.entries()) {
    const p = recFinals[idx];
    const productCost = r._cloudCost.productUnitCostSar;
    const fullCost = r._cloudCost.fullUnitCostSar;
    if (isNum(p) && isNum(productCost) && Number(productCost) > 0 && p > 0) cappedProductMargins.push((p - productCost) / p);
    if (isNum(p) && isNum(fullCost) && Number(fullCost) > 0 && p > 0) cappedFullMargins.push((p - fullCost) / p);
    if (isNum(targetFinal) && isNum(productCost) && Number(productCost) > 0 && targetFinal > 0) targetProductMargins.push((targetFinal - productCost) / targetFinal);
    if (isNum(targetFinal) && isNum(fullCost) && Number(fullCost) > 0 && targetFinal > 0) targetFullMargins.push((targetFinal - fullCost) / targetFinal);
  }

  let couponStrategy = '不叠优惠券';
  if (!couponRows.length) couponStrategy = '无优惠券叠加';
  else if (safe15All) couponStrategy = '可只叠15%券，禁止30/50%券';
  else couponStrategy = '不要叠券；15/30/50%券都禁止';

  const actionParts = [];
  let status = '可按货号确认';
  if (skuNeedsReview) {
    status = '货号待归并，暂停';
    actionParts.push(`货号归并待复核：${skuReviewReasons.join(' / ')}`);
  } else if (missingCost) {
    status = '缺云端成本，需先确认';
    actionParts.push('缺云端成本：先不自动报，需你确认最终价');
  } else if (storageMissing) {
    status = '缺仓储口径，需复核';
    actionParts.push('云端未给出仓储/件，不能按0安全通过');
  } else {
    if (safeNoCouponAll) actionParts.push(`普通活动按目标价 ${fmt(targetFinal)} SAR 报`);
    else actionParts.push('普通活动需按店铺平台上限微调，低利润店筛掉/单独处理');
    if (fixed === null && hasExposureRanking) {
      actionParts.push(`曝光前五链接目标利润率 ${pctRatioText(topExposureMargin)}，其他链接 ${pctRatioText(targetMargin)}；不得低于15%底价`);
    }
    if (couponRows.length) actionParts.push(couponStrategy);
    if (limitRows.length) actionParts.push('有旧限时折扣标签：未处理前不视为安全');
  }
  if (!missingCost && !storageMissing && !safeNoCouponAll) status = '部分店需系统处理';
  if (!missingCost && !storageMissing && limitRows.length) status = status === '可按货号确认' ? '限时折扣需注意' : `${status}+限时折扣`;
  if (!missingCost && !storageMissing && targetFullMargins.length && Math.min(...targetFullMargins) < 0.15) status = '利润低于红线/需确认';

  const needConfirm = missingCost
    ? (skuNeedsReview ? '先确认这到底是什么货号' : '请填最终成交价或补云端成本')
    : skuNeedsReview
      ? '先确认这到底是什么货号'
      : storageMissing
      ? '请确认仓储口径后再报'
      : fixed !== null
        ? `确认固定最终价 ${fmt(targetFinal)} SAR 是否继续`
        : hasExposureRanking
          ? `确认默认/非曝光前五目标利润率 ${pct(targetMargin)} 或最终价 ${fmt(targetFinal)} SAR；曝光前五链接可按 ${pctRatioText(topExposureMargin)} / ${fmt(topExposureTargetFinal)} SAR`
          : `确认目标利润率 ${pct(targetMargin)} 或最终价 ${fmt(targetFinal)} SAR；曝光数据缺失，按基础利润率执行`;
  const compactCouponCombo = !couponRows.length
    ? '普通活动'
    : (safe15All ? '普通活动 + 仅15%券，禁止30/50%券' : '普通活动，不叠券；15/30/50%券都禁止');
  const compactCombo = skuNeedsReview || missingCost || storageMissing
    ? '暂不自动报，等你确认'
    : [
        compactCouponCombo,
        limitRows.length ? '限时折扣先处理' : '',
      ].filter(Boolean).join('；');
  const storeHandling = skuNeedsReview || missingCost || storageMissing
    ? '不自动处理'
    : safeNoCouponAll
      ? '同货号按目标价执行'
      : '我按店铺平台上限微调；低利润店剔除/单独处理';

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
    '云端仓储总费SAR': range(storageFeeTotals),
    '云端仓储数量基准': range(storageQtyBases),
    '云端历史不含仓储利润率': isNum(cloudProfit?.profit_margin_before_storage) ? pct(cloudProfit.profit_margin_before_storage) : '',
    '云端历史含仓储利润率': isNum(cloudProfit?.profit_margin_after_storage) ? pct(cloudProfit.profit_margin_after_storage) : '',
    '云端成本来源': sourceLabels.join(' / ') || 'missing',
    '货号复核原因': skuReviewReasons.join(' / '),
    '系统目标': targetMode,
    '建议最终成交价SAR': fmt(targetFinal),
    '曝光前五SKC': topExposureRows.map(row => `${row.rank}.${row.skc}${row.score ? `(${row.score})` : ''}`).join('；'),
    '本表命中曝光前五SKC': topExposureSkcsInGroup.map(row => `${row.rank}.${row.skc}`).join('；'),
    '曝光规则目标利润率': exposureRuleText,
    '曝光前五建议最终成交价SAR': fmt(topExposureTargetFinal),
    '其他链接建议最终成交价SAR': fmt(targetFinal),
    '建议普通活动价SAR': missingCost ? '' : range(effectiveNoCouponPrices.length ? effectiveNoCouponPrices : oldSuggested),
    '如果只叠15%券普通活动价需≥SAR': couponRows.length ? fmt(priceFor15Coupon) : '',
    '如果叠50%券普通活动价需≥SAR': couponRows.length ? fmt(priceFor50Coupon) : '',
    '平台允许活动价上限范围SAR': range(platformCaps),
    '推荐活动组合': actionParts.join('；'),
    '组合后预计最终价SAR': missingCost ? '' : range(recFinals),
    '不含仓储利润率': missingCost ? '' : (targetProductMargins.length ? pct(Math.min(...targetProductMargins)) : ''),
    '含仓储利润率': missingCost ? '' : (targetFullMargins.length ? pct(Math.min(...targetFullMargins)) : ''),
    '平台压价后最低不含仓储利润率': missingCost ? '' : (cappedProductMargins.length ? pct(Math.min(...cappedProductMargins)) : ''),
    '平台压价后最低含仓储利润率': missingCost ? '' : (cappedFullMargins.length ? pct(Math.min(...cappedFullMargins)) : ''),
    '优惠券风险行数': couponRows.length,
    '限时折扣风险行数': limitRows.length,
    '你只需确认': needConfirm,
    '给你看-活动组合': compactCombo,
    '给你看-店铺差异处理': storeHandling,
    '你的确认最终价SAR': '',
    '你的确认利润率%': '',
    '备注/是否同意': '',
  });
}

const rank = {'缺云端成本，需先确认': 0, '缺仓储口径，需复核': 1, '利润低于红线/需确认': 2, '部分店需系统处理+限时折扣': 3, '部分店需系统处理': 4, '限时折扣需注意': 5, '可按货号确认': 6};
approvalRows.sort((a, b) => (rank[a['系统结论']] ?? 9) - (rank[b['系统结论']] ?? 9) || String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));

const confirmHeaders = [
  '系统结论','标准货号','覆盖店铺数','建议活动组合',
  '商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR','建议最终成交价SAR',
  '曝光规则目标利润率','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR',
  '不含仓储利润率','含仓储利润率','仓储口径','店铺差异我怎么处理','需要你确认',
  '你的确认最终价SAR','你的确认利润率%','备注/是否同意'
];
const detailHeaders = [
  '系统结论','标准货号','代表供方货号','覆盖店铺数','覆盖店铺','活动ID','当前售价范围SAR',
  '商品成本SAR（不含仓储）','仓储费SAR/件','含仓储成本SAR','仓储口径','云端仓储总费SAR','云端仓储数量基准',
  '云端历史不含仓储利润率','云端历史含仓储利润率','云端成本来源','货号复核原因','系统目标','建议最终成交价SAR',
  '曝光前五SKC','本表命中曝光前五SKC','曝光规则目标利润率','曝光前五建议最终成交价SAR','其他链接建议最终成交价SAR','建议普通活动价SAR',
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
  '不含仓储利润率': r['不含仓储利润率'],
  '含仓储利润率': r['含仓储利润率'],
  '仓储口径': r['仓储口径'],
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
    biGeneratedAt: cloudBi.generatedAt || '',
    pulledBiBytes: cloudBiStat.size,
    pulledBiMtime: cloudBiStat.mtime.toISOString(),
    costPath: '/opt/shein-bi/app/tmp/mbrs/marketing-cost-map.json',
    costSource: cloudCostDoc.source || '',
    costBiSource: cloudCostDoc.biSource || '',
    trueCostCount: cloudCostDoc.trueCostCount || Object.keys(TRUE_COSTS).length,
    pulledCostMtime: cloudCostStat.mtime.toISOString(),
  },
  pricingPolicy: {
    path: path.relative(ROOT, pricingPolicyPath),
    updatedAt: pricingPolicy.updatedAt || '',
    exposureTopLinksEnabled: pricingPolicy.exposureTopLinks?.enabled !== false,
    exposureTopN: pricingPolicy.exposureTopLinks?.topN || 5,
    exposureMetricFields: pricingPolicy.exposureTopLinks?.metricFields || [],
    exposureSourceRows: exposureIndex.rowCount,
    rule: '同货号曝光前五链接可比其他链接低5个百分点，但不得低于15%底价；若基础目标已在15%底线，则前五保持15%，其他链接提高到20%。固定价和逐行覆盖价优先。',
  },
  output: {
    rows: confirmRows.length,
    csvPath: path.relative(ROOT, csvPath),
  },
};
const sourceSummaryPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}-source-summary.json`);
await fs.writeFile(sourceSummaryPath, JSON.stringify(sourceSummary, null, 2), 'utf8');

const workbook = Workbook.create();
const sheet = workbook.worksheets.add('给你确认');
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
statusRange.conditionalFormats.add('containsText', {text: '部分店', format: {fill: '#FFF2CC', font: {bold: true, color: '#7F6000'}}});
statusRange.conditionalFormats.add('containsText', {text: '限时折扣', format: {fill: '#E2F0D9', font: {bold: true, color: '#375623'}}});

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
  ['项目', '值'],
  ['云端主机', sourceSummary.cloudProductionSource.host],
  ['云端应用目录', sourceSummary.cloudProductionSource.appPath],
  ['云端 BI 快照', sourceSummary.cloudProductionSource.biPath],
  ['BI generatedAt', 'cloud generatedAt: ' + sourceSummary.cloudProductionSource.biGeneratedAt],
  ['云端成本映射', sourceSummary.cloudProductionSource.costPath],
  ['成本源文件', sourceSummary.cloudProductionSource.costSource],
  ['成本映射所用 BI', sourceSummary.cloudProductionSource.costBiSource],
  ['营销定价策略', sourceSummary.pricingPolicy.path],
  ['曝光前五规则', sourceSummary.pricingPolicy.rule],
  ['云端 trueCostCount', sourceSummary.cloudProductionSource.trueCostCount],
  ['活动扫描明细行数', rawRows.length],
  ['活动扫描店铺数', activityDoc.selectedStores?.length || 0],
  ['说明', `${OUTPUT_VERSION} 成本、仓储费/件、含仓储成本、利润率均用云端生产 BI/成本映射重算；仓储费/件采用当前仍在仓库存的移动平均累计仓储成本：每日仓储费加入库存成本余额，库存数量减少时剔除已出库产品携带的历史仓储成本。`],
];
sourceSheet.getRange('B:B').format.numberFormat = '@';
sourceSheet.getRangeByIndexes(0, 0, sourceRows.length, 2).values = sourceRows;
sourceSheet.getRange('B:B').format.numberFormat = '@';
sourceSheet.getRange('A1:B1').format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}};
sourceSheet.getRange('A:A').format.columnWidthPx = 180;
sourceSheet.getRange('B:B').format.columnWidthPx = 760;
sourceSheet.getRangeByIndexes(1, 0, sourceRows.length - 1, 2).format = {wrapText: true};

const notes = workbook.worksheets.add('说明');
notes.showGridLines = false;
notes.getRange('A1:D1').values = [['这张表怎么用', '', '', '']];
notes.mergeCells('A1:D1');
notes.getRange('A1:D1').format = {fill: '#1F4E78', font: {bold: true, color: '#FFFFFF'}};
notes.getRange('A3:D9').values = [
  ['1', '先看', '给你确认', '每个标准货号一行，已补商品成本、仓储费/件、含仓储成本。'],
  ['2', '利润率口径', '不含仓储 / 含仓储', '不含仓储利润率只扣商品成本；含仓储利润率扣商品成本+云端仓储费/件。仓储费>0 时含仓储利润率应更低。'],
  ['3', '云端来源', '云端来源', '成本和仓储来自 shein-bi-tencent 的生产 BI 快照和云端成本映射。'],
  ['4', '你确认什么', '建议最终成交价SAR', '接受就写同意；要改就填“你的确认最终价SAR”或“你的确认利润率%”。'],
  ['5', '店铺差异', '系统处理', '各店当前价、平台最低降幅差异由系统按范围处理；低利润或不达标店会筛掉/单独处理。'],
  ['6', '优惠券/限时折扣', '风险提示', '表里直接提示是否可叠15%券；50%券原则上禁止。限时折扣仍先按风险处理。'],
  ['7', '本次修正', 'v4-v6 问题', 'v4 暴露出别名同步和销量分摊问题；v5/v6 仍没有剔除已出库产品携带的历史仓储成本；v7 改为当前在仓库存移动平均累计仓储口径，并把禁止券档写清楚。'],
];
notes.getRange('A10:D10').values = [
  ['8', '曝光前五', '价格差异', '同一货号按 BI 曝光量取前五 SKC：前五链接可比其他链接低5个百分点，但不能低于15%底价；若基础目标已是15%，前五保持15%，其他链接提高到20%。固定价和逐行覆盖价优先。'],
];
notes.getRange('A3:D9').format = {wrapText: true};
notes.getRange('A10:D10').format = {wrapText: true};
notes.getRange('A:A').format.columnWidthPx = 50;
notes.getRange('B:B').format.columnWidthPx = 130;
notes.getRange('C:C').format.columnWidthPx = 180;
notes.getRange('D:D').format.columnWidthPx = 520;

const preview = await workbook.render({sheetName: '给你确认', range: 'A1:P24', scale: 1, format: 'png'});
const previewPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}-preview.png`);
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const inspect = await workbook.inspect({kind: 'table', range: '给你确认!A1:P12', include: 'values', tableMaxRows: 12, tableMaxCols: 16});
console.log(inspect.ndjson);
const errors = await workbook.inspect({kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: {useRegex: true, maxResults: 50}, summary: 'formula errors'});
console.log(errors.ndjson);
const xlsx = await SpreadsheetFile.exportXlsx(workbook);
const xlsxPath = path.join(outDir, `marketing-sku-approval-${DATE_TAG}-${OUTPUT_VERSION}.xlsx`);
await xlsx.save(xlsxPath);
sourceSummary.output.xlsxPath = path.relative(ROOT, xlsxPath);
sourceSummary.output.previewPath = path.relative(ROOT, previewPath);
sourceSummary.output.columns = confirmHeaders.length;
await fs.writeFile(sourceSummaryPath, JSON.stringify(sourceSummary, null, 2), 'utf8');
console.log(JSON.stringify({xlsxPath, csvPath, previewPath, sourceSummaryPath, rows: approvalRows.length, columns: confirmHeaders.length}, null, 2));

function normalizeReviewRow(row) {
  const rawSupplier = row._raw?.row?.supplierNo || row['供方货号'] || row['标准货号'] || '';
  const goodsTitle = row._raw?.row?.goodsName || row['商品标题/中文名'] || '';
  const normalized = normalizeGoodsSnDetailed(rawSupplier, {goodsTitle});
  const canonical = normalized.canonical || row['标准货号'] || rawSupplier;
  const cloudCost = lookupCloudCostInfo([canonical, rawSupplier, row['供方货号'], row['标准货号'], modelCode(canonical), modelCode(rawSupplier)]);
  return {
    ...row,
    '供方货号': rawSupplier || row['供方货号'] || '',
    '标准货号': canonical,
    '商品完整成本SAR': fmt(cloudCost.productUnitCostSar),
    '仓储费摊销SAR/件': cloudCost.storageUnitCostSar === null ? '' : fmt(cloudCost.storageUnitCostSar),
    '含仓储费成本SAR': fmt(cloudCost.fullUnitCostSar),
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
  let storageUnitCostSar = numValue(trueCost?.storageUnitCostSar);
  if (storageUnitCostSar === null) storageUnitCostSar = numValue(trueCost?.storageUnitCostSar30d);
  const fullUnitCostSar = positiveOrNull(trueCost?.trueUnitCostSar)
    ?? (productUnitCostSar !== null && storageUnitCostSar !== null ? Number(productUnitCostSar) + Number(storageUnitCostSar) : null);
  const storageMethodRaw = String(trueCost?.storageMethod || profitRow?.storage_fee_method || '').trim() || (storageUnitCostSar === 0 ? 'cloud_zero_storage_fee' : 'missing');
  const storageMethod = trueCost?.storageUnitBasis ? `${storageMethodRaw} / ${trueCost.storageUnitBasis}` : storageMethodRaw;
  const source = trueCost?.source || (profitRow ? 'outputs/bi-portal/data.json' : (costMapValue !== null ? 'cloud costMap' : ''));
  return {
    productUnitCostSar: roundOrNull(productUnitCostSar, 4),
    storageUnitCostSar: roundOrNull(storageUnitCostSar, 4),
    fullUnitCostSar: roundOrNull(fullUnitCostSar, 4),
    storageFeeSar: roundOrNull(storageFeeSar, 4),
    quantityBasis: roundOrNull(quantityBasis, 4),
    storageRecent30FeeSar: roundOrNull(trueCost?.storageRecent30FeeSar, 4),
    storageRecent30Days: roundOrNull(trueCost?.storageRecent30Days, 4),
    storageUnitBasis: trueCost?.storageUnitBasis || '',
    storageMethod,
    source,
    profitRow,
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
function fmt(v) { const n = round2(v); return n === null ? '' : n; }
function pct(v) { return isNum(v) ? `${round2(Number(v) * 100)}%` : ''; }
function range(values) { const nums = values.filter(v => v !== null && v !== undefined && isNum(v)).map(Number); if (!nums.length) return ''; const min = round2(Math.min(...nums)); const max = round2(Math.max(...nums)); return min === max ? String(min) : `${min}-${max}`; }
function uniq(values) { return [...new Set(values.filter(v => v !== null && v !== undefined && String(v) !== ''))]; }
function mostCommon(values) { const counts = new Map(); for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1); return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''; }
function mostCommonObject(values) { const counts = new Map(); for (const v of values.filter(Boolean)) { const k = JSON.stringify(v); counts.set(k, (counts.get(k) || 0) + 1); } const top = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]; return top ? JSON.parse(top) : null; }
function csvEscape(v) { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s; }
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function safeTableSuffix(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '') || 'V'; }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inlineValue !== undefined ? inlineValue : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[key] = value;
  }
  return out;
}
