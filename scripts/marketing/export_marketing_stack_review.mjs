#!/usr/bin/env node
/**
 * Read-only export for marketing stack safety review.
 *
 * Scope:
 * - Launch/connect store Chrome profiles in small batches.
 * - Read marketing activity list, ordinary activity goods, coupon rules/usage.
 * - Merge local cost map and latest BI link activity labels, especially
 *   existing "限时折扣" labels.
 * - Write review CSV/JSON/MD artifacts for human approval.
 *
 * Non-goals:
 * - No signup, no submit, no coupon import, no budget edit, no discount cancel.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';
import {normalizeInventoryProjection} from '../../lib/inventory_projection_contract.mjs';
import {buildSharedStorageCostIndex, findSharedStorageCost} from '../../lib/marketing_shared_storage_cost.mjs';
import {
  addBiPortalSourceArgs,
  normalizeBiPortalSourceArgs,
  selectBiPortalSource,
  summarizeBiPortalSourceForReport,
} from '../../lib/bi_portal_source.mjs';
import {summarizeStoreAuditCoverage} from '../../lib/marketing_stack_review_coverage.mjs';
import {loadSheinBrowserSession, sheinSessionPostJson} from '../../lib/shein_session_http.mjs';
import {
  couponPlanStoreView,
  findCouponPlanRow,
  loadCouponTargetEligibilityPlan,
  summarizeCouponTargetEligibilityPlan,
} from '../../lib/marketing_coupon_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const encodeRedirect = url => Buffer.from(url, 'utf8').toString('base64');
const MBR_LOGIN_URL = `https://sso.geiwohuo.com/#/login/GMPSSO/${encodeRedirect(LIST_URL)}`;
const COUPON_DETAIL_URL = activityId => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/${activityId}`;
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const TMP_ROOT = path.join(ROOT, 'tmp', 'mbrs');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const COUPON_LEVEL_RULES = await readJsonIfExists(path.join(ROOT, 'config', 'marketing_coupon_level_rules.json'), {activities: {}});
const COST_DOC = await readJsonIfExists(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), {costMap: {}, trueCostMap: {}});
const COSTS = COST_DOC.costMap || {};
const TRUE_COSTS = COST_DOC.trueCostMap || {};

const READ_ONLY_ENDPOINTS = [
  '/mrs-api-prefix/mbrs/activity/get_activity_list',
  '/mrs-api-prefix/mbrs/activity/get_activity_detail',
  '/mrs-api-prefix/mbrs/activity/fetch_seller_act_info',
  '/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2',
  '/mrs-api-prefix/mbrs/coupon/query_coupon_activity_usage_List',
  '/mrs-api-prefix/mbrs/activity/multi-level/goods/query',
];

const fixedPriceBase = [
  ['SK-999食品料理机', 110],
  ['SM-961厨师机', 227],
  ['PA4-6L便携式冰箱', 160],
  ['SM-505A电动缝纫机', 110],
  ['TXSM-505A电动缝纫机', 110],
  ['SK-03012台式榨汁机', 96],
  ['SK-03038制冰机', 330],
  ['SK-04031胶囊咖啡机', 233],
  ['SK-GT-3065蒸汽熨烫机', 90],
  ['SK-3378杆式吸尘器', 150],
  ['SK-10075电油炸锅', 150],
  ['SK-6863半自动意式咖啡机', 300],
  ['SK-6810半自动意式咖啡机', 165],
  ['CM-121E美式咖啡机', 135],
  ['SK-11041蒸汽熨烫机', 70],
  ['SK-223三明治机和早餐机', 85],
  ['KF-JN-02便携咖啡机', 96],
  ['SK-185台式榨汁机', 91],
];

const specialMarginBase = [
  ['FZ-666颈部按摩器', 0.15],
  ['SK-7025A绞肉机', 0.25],
  ['SK-7027绞肉机', 0.25],
  ['SK-7028绞肉机', 0.25],
];

const fixedPriceRules = new Map();
for (const [label, value] of fixedPriceBase) registerRuleKeys(fixedPriceRules, label, value);

const specialMarginRules = new Map();
for (const [label, value] of specialMarginBase) registerRuleKeys(specialMarginRules, label, value);

const args = normalizeBiPortalSourceArgs(parseArgs(process.argv.slice(2)), ROOT);
const now = new Date();
const BI_SOURCE_SELECTION = await selectBiPortalSource({
  root: ROOT,
  biPortalData: args.biPortalData,
  cloudBiSsh: args.cloudBiSsh,
  cloudBiRoot: args.cloudBiRoot,
  cloudBiSshTimeoutMs: args.cloudBiSshTimeoutMs,
  cloudBiMaxBytes: args.cloudBiMaxBytes,
  now,
  maxAgeHours: args.biMaxAgeHours,
});
if (!BI_SOURCE_SELECTION.selected.data) {
  throw new Error(`BI Portal data unavailable: ${BI_SOURCE_SELECTION.selected.source.status} ${BI_SOURCE_SELECTION.selected.source.error || ''}`.trim());
}
const BI = BI_SOURCE_SELECTION.selected.data;
const BI_SOURCE_SUMMARY = summarizeBiPortalSourceForReport(BI_SOURCE_SELECTION);
const COUPON_TARGET_PLAN = args.couponTargetPlan ? await loadCouponTargetEligibilityPlan({
  root: ROOT,
  planPath: args.couponTargetPlan,
  priceOverridesPaths: args.couponPriceOverrides,
  targetDiscountPct: 15,
}) : null;
const dateTag = formatDate(now);
const timestampTag = formatTimestamp(now);
const runDir = path.join(TMP_ROOT, `marketing-stack-review-${timestampTag}`);
const selectedStores = STORES.filter(s => s.enabled)
  .filter(s => !args.stores.length || args.stores.includes(String(s.storeKey).toUpperCase()));
const enabledStores = STORES.filter(s => s.enabled);

if (!selectedStores.length) {
  throw new Error(`No enabled stores selected. --stores=${args.stores.join(',') || '(empty)'}`);
}

const linkIndex = buildLinkActivityIndex(BI);
const depletionIndex = buildDepletionIndex(BI);
const sharedStorageCostIndex = buildSharedStorageCostIndex(BI);
const batches = chunk(selectedStores, args.batchSize);
const audit = {
  createdAt: now.toISOString(),
  mode: 'read-only',
  args: {...args, stores: selectedStores.map(s => s.storeKey)},
  readOnlyEndpoints: READ_ONLY_ENDPOINTS,
  source: {
    ...BI_SOURCE_SUMMARY,
    costSource: COST_DOC.source || '',
    costBiSource: COST_DOC.biSource || '',
  },
  batches: [],
  stores: [],
};

async function main() {
await fs.mkdir(OUT_DIR, {recursive: true});
await fs.mkdir(runDir, {recursive: true});

console.log(`只读叠加审核导出：${selectedStores.map(s => s.storeKey).join(', ')}`);
console.log(`批次：${batches.map(b => b.map(s => s.storeKey).join('/')).join(' | ')}`);
console.log(`安全边界：仅调用只读接口，不报名、不提交、不取消限时折扣。`);

const detailRows = [];
const couponRows = [];

const DETAIL_HEADERS = [
  '店铺','分组','活动类型','活动ID','活动名称','报名截止','普通活动开始','普通活动结束','时间窗口是否重叠',
  'SKC','SKU','供方货号','标准货号','商品标题/中文名',
  '原始价SAR','当前售价SAR','价格字段来源','平台最低降幅%',
  '商品完整成本SAR','仓储费摊销SAR/件','含仓储费成本SAR','仓储口径',
  '本次建议普通活动价SAR','本次建议普通活动折扣%','普通营销活动价/折扣',
  '优惠券活动ID/名称','优惠券券档/风险折扣','优惠券券后价SAR',
  '限时折扣名称','限时折扣价SAR',
  '最低价来源','最低促销基准价SAR','叠加后最终成交价SAR','商品利润率','含仓储费利润率','风险提示','修改意见/备注',
];

const SUMMARY_HEADERS = [
  '标准货号','代表供方货号','适用店铺数','适用店铺','涉及活动数','活动ID','明细行数',
  '当前售价SAR范围','商品完整成本SAR范围','含仓储费成本SAR范围','建议普通活动价SAR范围','叠加后最终成交价SAR范围',
  '最低含仓储费利润率','限时折扣风险行数','优惠券叠加风险行数','高风险提示','修改意见/备注',
];

const COUPON_HEADERS = [
  '店铺','分组','优惠券活动ID','优惠券活动名称','报名截止','活动开始','活动结束','后台券档','商家承担%','平台承担%',
  '风险测算最高券折扣%','站点','当前站点预算SAR','已用预算SAR','优惠券状态','可报名数量','已报名数量',
  '15%券档levelRuleId','15%券档可报集合数','15%券档已报/处理中集合数','15%券档剩余未入已报集合数','15%券档状态分布',
  '15%券档允许配套计划数','15%券档允许计划active数','15%券档禁止/未知计划数','15%券档禁止/未知仍active数',
  '15%券档active但不在允许计划数','15%券档active是否符合允许计划','15%券档禁止/未知active样例',
  '规则来源','备注/风险',
];

const LIMIT_HEADERS = ['店铺','SKC','标准货号','限时折扣名称','限时折扣价SAR','来源','数据日期','风险提示','修改意见/备注'];

for (const [batchIndex, batch] of batches.entries()) {
  const batchAudit = {
    batchIndex: batchIndex + 1,
    stores: batch.map(s => s.storeKey),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    mode: args.sessionHttp ? 'session_http' : 'browser',
    closeAfterBatch: false,
  };
  audit.batches.push(batchAudit);
  console.log(`\n[BATCH ${batchIndex + 1}/${batches.length}] ${batch.map(s => s.storeKey).join(', ')}`);
  const scanStoreSafely = store => scanStore(store).catch(err => ({
    store: store.storeKey,
    ok: false,
    error: err.message,
    stack: err.stack,
    activities: [],
    couponSummaries: [],
    rows: [],
  }));
  const storeResults = args.sessionHttp
    ? await Promise.all(batch.map(scanStoreSafely))
    : await scanStoresSequentially(batch, scanStoreSafely);
  for (const [storeIndex, store] of batch.entries()) {
    const storeResult = storeResults[storeIndex];
    audit.stores.push(stripRowsForAudit(storeResult));
    detailRows.push(...(storeResult.rows || []));
    couponRows.push(...(storeResult.couponSummaries || []));
    await fs.writeFile(path.join(runDir, `store-${store.storeKey}.json`), JSON.stringify(storeResult, null, 2), 'utf8');
  }
  batchAudit.finishedAt = new Date().toISOString();
  console.log(args.sessionHttp
    ? `[BATCH ${batchIndex + 1}] session HTTP 并发扫描完成，未启动或关闭浏览器。`
    : `[BATCH ${batchIndex + 1}] 浏览器扫描完成；每个 profile 已在对应店铺扫描结束时独立收尾。`);
}

const limitRows = buildLimitDiscountRows(linkIndex);
const summaryRows = summarizeBySku(detailRows);
const storeStatuses = audit.stores.map(s => summarizeStoreAuditCoverage(s, s.store));

const outputNaming = resolveStackReviewOutputNaming(dateTag, selectedStores, enabledStores);
const base = outputNaming.basePath;
const files = {
  detailCsv: `${base}-detail.csv`,
  bySkuCsv: `${base}-by-sku.csv`,
  couponCsv: `${base}-coupon.csv`,
  limitDiscountCsv: `${base}-limit-discount-risk.csv`,
  md: `${base}.md`,
  json: `${base}.json`,
  audit: path.join(runDir, `marketing-stack-review-audit-${timestampTag}.json`),
};

await writeCsv(files.detailCsv, detailRows, DETAIL_HEADERS);
await writeCsv(files.bySkuCsv, summaryRows, SUMMARY_HEADERS);
await writeCsv(files.couponCsv, couponRows, COUPON_HEADERS);
await writeCsv(files.limitDiscountCsv, limitRows, LIMIT_HEADERS);
await fs.writeFile(files.json, JSON.stringify({
  createdAt: now.toISOString(),
  activityScanCreatedAt: now.toISOString(),
  activityScanFinishedAt: new Date().toISOString(),
  source: audit.source,
  biSourceDiagnostics: BI_SOURCE_SELECTION.diagnostics.map(d => ({type: d.type, source: d.source})),
  selectedStores: selectedStores.map(s => ({storeKey: s.storeKey, groupKey: s.groupKey, shopName: s.shopName})),
  coverage: {
    enabledStoreCount: outputNaming.enabledStoreCount,
    selectedStoreCount: outputNaming.selectedStoreCount,
    completeEnabledStoreCoverage: outputNaming.completeEnabledStoreCoverage,
    outputName: outputNaming.outputName,
  },
  storeStatuses,
  missingStores: storeStatuses.filter(s => !s.ok).map(s => s.storeKey),
  notes: [
    '本文件为只读审核输出；未报名、未提交、未取消或调价限时折扣。',
    outputNaming.completeEnabledStoreCoverage
      ? '本次覆盖全部启用店铺，可作为当天默认全量营销栈报告。'
      : '本次仅覆盖部分启用店铺，输出文件名自动追加 stores 后缀，不覆盖当天默认全量营销栈报告；每日 guard 不应把它当全量 no-action 依据。',
    '限时折扣价格若未从当前接口读到，会作为风险字段保留，不按安全通过。',
    '多档优惠券活动会额外读取 15% 券档规则页商品集合；活动列表 apply/allow 仅保留作参考，不作为 15% 档最终报名验证口径。',
    '15% 优惠券只允许从 price-overrides 里明确标记为高曝光支持、滞销高库存引流或清货试验的可选流量券策略派生；历史 couponFactor≈0.85 / 仅15%券价格保障口径默认阻断。',
  ],
  couponTargetPlan: COUPON_TARGET_PLAN ? {
    path: COUPON_TARGET_PLAN.path,
    planSources: COUPON_TARGET_PLAN.planSources,
    priceOverrideSources: COUPON_TARGET_PLAN.priceOverrideSources,
    stores: summarizeCouponTargetEligibilityPlan(COUPON_TARGET_PLAN),
  } : null,
  summaryRows,
  detailRows,
  couponRows,
  limitRows,
}, null, 2), 'utf8');
await fs.writeFile(files.audit, JSON.stringify(audit, null, 2), 'utf8');
await fs.writeFile(files.md, renderMarkdown(summaryRows, detailRows, couponRows, limitRows, files), 'utf8');

console.log(`\nDETAIL_ROWS ${detailRows.length}`);
console.log(`SUMMARY_ROWS ${summaryRows.length}`);
console.log(`COUPON_ROWS ${couponRows.length}`);
console.log(`LIMIT_DISCOUNT_RISK_ROWS ${limitRows.length}`);
console.log(`DETAIL_CSV ${files.detailCsv}`);
console.log(`BY_SKU_CSV ${files.bySkuCsv}`);
console.log(`COUPON_CSV ${files.couponCsv}`);
console.log(`LIMIT_DISCOUNT_CSV ${files.limitDiscountCsv}`);
console.log(`MD ${files.md}`);
console.log(`JSON ${files.json}`);
console.log(`AUDIT ${files.audit}`);
}

function parseArgs(argv) {
  const out = {
    stores: [],
    batchSize: 3,
    hours: 48,
    allOpen: true,
    visible: true,
    headless: false,
    noClose: false,
    noLaunch: false,
    includeCouponGoods: false,
    couponWorstRatePct: null,
    couponTargetPlan: null,
    couponPriceOverrides: [],
    sessionHttp: false,
    biPortalData: '',
    cloudBiSsh: '',
    cloudBiRoot: '',
    cloudBiSshTimeoutMs: null,
    cloudBiMaxBytes: null,
    biMaxAgeHours: 72,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const biArgIndex = addBiPortalSourceArgs(out, argv, i);
    if (biArgIndex !== i) {
      i = biArgIndex;
      continue;
    }
    if (a === '--stores') out.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--batch-size') out.batchSize = Number(argv[++i] || 3);
    else if (a === '--hours') {
      out.hours = Number(argv[++i] || 48);
      out.allOpen = false;
    }
    else if (a === '--all-open') out.allOpen = true;
    else if (a === '--headless') {
      out.headless = true;
      out.visible = false;
    }
    else if (a === '--visible') {
      out.visible = true;
      out.headless = false;
    }
    else if (a === '--no-close') out.noClose = true;
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--include-coupon-goods') out.includeCouponGoods = true;
    else if (a === '--coupon-worst-rate-pct') out.couponWorstRatePct = Number(argv[++i]);
    else if (a === '--coupon-target-plan') out.couponTargetPlan = argv[++i];
    else if (a === '--coupon-price-overrides' || a === '--price-overrides') out.couponPriceOverrides.push(...String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--session-http') out.sessionHttp = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(out.batchSize) || out.batchSize < 1) out.batchSize = 1;
  out.batchSize = Math.min(3, Math.floor(out.batchSize));
  if (!Number.isFinite(out.hours) || out.hours <= 0) out.hours = 48;
  if (out.couponWorstRatePct !== null && !Number.isFinite(out.couponWorstRatePct)) out.couponWorstRatePct = null;
  return out;
}

function resolveStackReviewOutputNaming(dateTag, selectedStores, enabledStores) {
  const selectedKeys = selectedStores.map(s => cleanStoreKey(s.storeKey)).filter(Boolean).sort();
  const enabledKeys = enabledStores.map(s => cleanStoreKey(s.storeKey)).filter(Boolean).sort();
  const completeEnabledStoreCoverage = selectedKeys.length === enabledKeys.length
    && selectedKeys.every((key, idx) => key === enabledKeys[idx]);
  const outputName = completeEnabledStoreCoverage
    ? `marketing-stack-review-${dateTag}`
    : `marketing-stack-review-${dateTag}-stores-${safeOutputStoreSuffix(selectedKeys)}`;
  return {
    outputName,
    basePath: path.join(OUT_DIR, outputName),
    selectedStoreCount: selectedKeys.length,
    enabledStoreCount: enabledKeys.length,
    completeEnabledStoreCoverage,
  };
}

function cleanStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function safeOutputStoreSuffix(storeKeys) {
  const suffix = storeKeys.map(key => key.replace(/[^A-Z0-9_-]/g, '')).filter(Boolean).join('-');
  return suffix || 'partial';
}

async function scanStore(store) {
  if (args.sessionHttp) return await scanStoreViaSession(store);
  const startedAt = new Date().toISOString();
  console.log(`\n[${store.storeKey}] 只读扫描开始`);
  let cdp = null;
  let listPage = null;
  const result = {
    store: store.storeKey,
    groupKey: store.groupKey,
    shopName: store.shopName || '',
    ok: false,
    startedAt,
    finishedAt: '',
    activities: [],
    couponSummaries: [],
    rows: [],
  };
  try {
    if (!args.noLaunch) {
      closeExistingStoreChrome(store);
      await sleep(1200);
      launchStore(store);
      await sleep(3500);
    }
    cdp = await connectStore(store);
    listPage = await newPage(cdp, LIST_URL);
    result.loginRecovery = await recoverLoginIfNeeded(cdp, listPage.sessionId);
    result.pageInfo = await evalJs(cdp, listPage.sessionId, `
      return {
        href: location.href,
        title: document.title || '',
        bodyTextSample: String(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)
      };
    `).catch(err => ({error: err.message}));
    let activities = await fetchActivities(cdp, listPage.sessionId);
    if (activityDiagnosticsNeedLogin(fetchActivities.lastDiagnostics)) {
      result.loginRecoveryAfter20302 = await recoverMbrsLoginAndRetry(cdp, listPage.sessionId);
      activities = await fetchActivities(cdp, listPage.sessionId);
    }
    result.activityFetchDiagnostics = fetchActivities.lastDiagnostics || [];
    if (activityDiagnosticsFailed(result.activityFetchDiagnostics)) {
      result.reason = `营销活动列表读取失败：${formatActivityDiagnostics(result.activityFetchDiagnostics)}`;
      console.log(`[${store.storeKey}] activity list failed: ${result.reason}`);
      return result;
    }
    const scoped = activities.filter(withinScope);
    const ordinary = scoped.filter(a => !isCouponActivity(a));
    const coupons = scoped.filter(isCouponActivity);
    result.activities = scoped.map(a => ({
      activityId: a.activityId,
      name: a.name,
      type: isCouponActivity(a) ? 'coupon' : 'ordinary',
      signEnd: a.signEnd,
      eventStart: a.eventStart,
      eventEnd: a.eventEnd,
      allowGoodsNum: a.allowGoodsNum,
      applyGoodsNum: a.applyGoodsNum,
    }));
    result.activityListCount = activities.length;
    console.log(`[${store.storeKey}] activity list=${activities.length}, open activities=${scoped.length}, ordinary=${ordinary.length}, coupon=${coupons.length}`);

    const couponSummaries = [];
    for (const coupon of coupons) {
      const summary = await fetchCouponSummary(cdp, listPage.sessionId, store, coupon);
      couponSummaries.push(summary);
      result.couponSummaries.push(summary);
    }
    const couponContext = buildCouponContext(couponSummaries);

    for (const activity of ordinary) {
      const page = await newPage(cdp, LIST_URL.replace('/list', `/sign-up/config/${activity.activityId}`));
      try {
        await waitFor(cdp, page.sessionId, `document.body && (document.body.innerText.includes('可报名商品') || document.body.innerText.includes('提报的活动价格') || document.body.innerText.includes('活动'))`, 30_000);
        const detail = await fetchActivityDetail(cdp, page.sessionId, activity.activityId).catch(err => ({ok: false, error: err.message, info: null}));
        const collected = await collectOrdinaryGoodsRows(cdp, page.sessionId, activity);
        result.activities.find(a => a.activityId === activity.activityId).collected = {
          ok: collected.ok,
          totalGoods: collected.totalGoods,
          rows: collected.rows.length,
          reason: collected.reason || '',
        };
        console.log(`[${store.storeKey}] ${activity.activityId} ${collected.ok ? 'OK' : 'WARN'} rows=${collected.rows.length}/${collected.totalGoods || ''} ${collected.reason || ''}`);
        for (const row of collected.rows) {
          result.rows.push(buildDetailRow(store, activity, detail.info || null, row, couponContext));
        }
      } finally {
        await cdp.call('Target.closeTarget', {targetId: page.targetId}).catch(() => {});
      }
    }
    result.ok = true;
    return result;
  } finally {
    if (listPage?.targetId) await cdp?.call('Target.closeTarget', {targetId: listPage.targetId}).catch(() => {});
    cdp?.close();
    if (!args.noClose) closeExistingStoreChrome(store);
    result.finishedAt = new Date().toISOString();
  }
}

async function scanStoreViaSession(store) {
  const startedAt = new Date().toISOString();
  console.log(`\n[${store.storeKey}] session 直连只读扫描开始`);
  const session = await loadBrowserSession(store.storeKey);
  const result = {
    store: store.storeKey,
    groupKey: store.groupKey,
    shopName: store.shopName || '',
    ok: false,
    startedAt,
    finishedAt: '',
    pageInfo: {source: `state/shein_browser_sessions/${store.storeKey}.local.json`, exportedAt: session.exportedAt || ''},
    activities: [],
    couponSummaries: [],
    rows: [],
  };
  try {
    const activityResult = await fetchActivitiesHttp(session);
    const activities = activityResult.activities;
    result.activityFetchDiagnostics = activityResult.diagnostics;
    const scoped = activities.filter(withinScope);
    const ordinary = scoped.filter(a => !isCouponActivity(a));
    const coupons = scoped.filter(isCouponActivity);
    result.activityListCount = activities.length;
    result.activities = scoped.map(a => ({
      activityId: a.activityId,
      name: a.name,
      type: isCouponActivity(a) ? 'coupon' : 'ordinary',
      signEnd: a.signEnd,
      eventStart: a.eventStart,
      eventEnd: a.eventEnd,
      allowGoodsNum: a.allowGoodsNum,
      applyGoodsNum: a.applyGoodsNum,
    }));
    console.log(`[${store.storeKey}] activity list=${activities.length}, open activities=${scoped.length}, ordinary=${ordinary.length}, coupon=${coupons.length}`);
    const couponSummaries = [];
    for (const coupon of coupons) {
      const summary = await fetchCouponSummaryHttp(session, store, coupon);
      couponSummaries.push(summary);
      result.couponSummaries.push(summary);
    }
    const couponContext = buildCouponContext(couponSummaries);
    for (const activity of ordinary) {
      const detail = await fetchActivityDetailHttp(session, activity.activityId).catch(err => ({ok: false, error: err.message, info: null}));
      const collected = await collectOrdinaryGoodsRowsHttp(session, activity);
      result.activities.find(a => a.activityId === activity.activityId).collected = {
        ok: collected.ok,
        totalGoods: collected.totalGoods,
        rows: collected.rows.length,
        reason: collected.reason || '',
      };
      console.log(`[${store.storeKey}] ${activity.activityId} ${collected.ok ? 'OK' : 'WARN'} rows=${collected.rows.length}/${collected.totalGoods || ''} ${collected.reason || ''}`);
      for (const row of collected.rows) {
        result.rows.push(buildDetailRow(store, activity, detail.info || null, row, couponContext));
      }
    }
    result.ok = true;
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
  }
}

async function loadBrowserSession(storeKey) {
  return loadSheinBrowserSession(ROOT, storeKey);
}

async function sessionFetchJson(session, url, body, extraHeaders = {}) {
  return sheinSessionPostJson(session, url, body, {headers: extraHeaders});
}

async function fetchActivitiesHttp(session) {
  const pages = [];
  for (let page = 1; page <= 30; page += 1) {
    const json = await sessionFetchJson(session, `/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=${page}&page_size=100`, {});
    if (!(json?.code === '0' || json?.code === 0)) {
      throw new Error(`get_activity_list page ${page} returned code=${json?.code ?? ''} msg=${json?.msg ?? ''}`);
    }
    const list = json?.info?.activity_detail_list || [];
    pages.push({page, code: json?.code, msg: json?.msg, list});
    if (list.length < 100) break;
  }
  const diagnostics = (pages || []).map(p => ({
    page: p.page,
    code: p.code,
    msg: p.msg,
    listLength: p.list?.length || 0,
    firstActivityId: p.list?.[0]?.activity_id || null,
    firstActivityName: p.list?.[0]?.activity_name || '',
  }));
  const seen = new Set();
  const list = [];
  for (const page of pages || []) {
    for (const a of page.list || []) {
      const id = Number(a.activity_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push(normalizeActivity(a));
    }
  }
  return {activities: list, diagnostics};
}

async function scanStoresSequentially(stores, scanStoreSafely) {
  const results = [];
  for (const store of stores) results.push(await scanStoreSafely(store));
  return results;
}

function normalizeActivity(a) {
  return {
    activityId: Number(a.activity_id),
    name: a.activity_name || '',
    backendCate: a.backend_cate,
    label: a.text_tag_content || '',
    signStart: a.activity_start_zone_time || '',
    signEnd: a.activity_end_zone_time || '',
    eventStart: a.start_zone_time || '',
    eventEnd: a.end_zone_time || '',
    allowGoodsNum: Number(a.allow_goods_num || 0),
    applyGoodsNum: Number(a.apply_goods_num || 0),
    raw: a,
  };
}

async function fetchActivityDetailHttp(session, activityId) {
  const json = await sessionFetchJson(session, '/mrs-api-prefix/mbrs/activity/get_activity_detail', {activity_id: activityId});
  return {ok: json?.code === '0' || json?.code === 0, code: json?.code, msg: json?.msg, info: json?.info || null};
}

async function fetchCouponSummaryHttp(session, store, activity) {
  const [detailJson, usageJson, sellerJson, coupon15Rule] = await Promise.all([
    sessionFetchJson(session, '/mrs-api-prefix/mbrs/activity/get_activity_detail', {activity_id: activity.activityId}),
    sessionFetchJson(session, '/mrs-api-prefix/mbrs/coupon/query_coupon_activity_usage_List?page_num=1&page_size=20', {activity_ids: [activity.activityId], query_status: 0}),
    sessionFetchJson(session, '/mrs-api-prefix/mbrs/activity/fetch_seller_act_info', {partake_act_id: activity.activityId}),
    fetchCoupon15PctRuleStatsHttp(session, store, activity.activityId).catch(err => ({
      ok: false,
      levelRuleId: configuredCouponLevelRuleId(store.storeKey, activity.activityId),
      levelRuleIdSource: 'config',
      error: err.message,
    })),
  ]);
  return couponSummaryFromApi(
    store,
    activity,
    detailJson?.info || {},
    usageJson?.info?.coupon_activity_usage_detail_list?.[0] || {},
    sellerJson?.info || {},
    coupon15Rule,
  );
}

async function fetchCoupon15PctRuleStatsHttp(session, store, activityId) {
  const levelRuleId = configuredCouponLevelRuleId(store.storeKey, activityId);
  if (!levelRuleId) {
    return {
      ok: false,
      levelRuleId: 0,
      levelRuleIdSource: 'config',
      reason: `configured 15% coupon levelRuleId missing for ${store.storeKey}/${activityId}`,
    };
  }
  const route = `/mbrs/marketing/coupon/rule/signup/${activityId}/${levelRuleId}`;
  const headers = {
    'origin-url': `https://sso.geiwohuo.com/#${route}`,
    'x-bbl-route': route,
    'x-req-zone-id': 'Asia/Shanghai',
    'x-lt-language': 'CN',
    LAN: 'CN',
  };
  const queryAll = async pageModule => {
    const all = [];
    let declaredTotal = 0;
    let lastMessage = '';
    for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
      const json = await sessionFetchJson(
        session,
        `/mrs-api-prefix/mbrs/activity/multi-level/goods/query?page_num=${pageNum}&page_size=200`,
        {
          activity_id: Number(activityId),
          level_rule_id: levelRuleId,
          page: 'COUPON',
          page_module: pageModule,
          product_code_list: [],
          supplier_no_list: [],
        },
        headers,
      );
      const code = String(json?.code ?? '');
      lastMessage = String(json?.msg || '');
      const list = Array.isArray(json?.info?.partake_goods_list) ? json.info.partake_goods_list : [];
      if (code !== '0') {
        return {ok: false, code, msg: lastMessage, total: declaredTotal, list: all};
      }
      declaredTotal = Number(json?.info?.total ?? list.length ?? 0);
      all.push(...list.map(item => ({
        skc: String(item?.skc || '').trim(),
        supplierNo: item?.supplier_no || '',
        status: String(item?.status ?? ''),
        enrollTime: item?.enroll_time || null,
      })));
      if (!list.length || all.length >= declaredTotal) break;
    }
    const bySkc = new Map();
    for (const item of all) {
      if (item.skc && !bySkc.has(item.skc)) bySkc.set(item.skc, item);
    }
    return {ok: true, code: '0', msg: lastMessage, total: declaredTotal, list: [...bySkc.values()]};
  };
  const [available, enrolled] = await Promise.all([
    queryAll('MULTI_LEVEL_RULE_GOODS'),
    queryAll('MULTI_LEVEL_RULE_ENROLLED_GOODS'),
  ]);
  if (!available.ok || !enrolled.ok) {
    return {
      ok: false,
      levelRuleId,
      levelRuleIdSource: 'config',
      availableCode: available.code,
      availableMsg: available.msg,
      enrolledCode: enrolled.code,
      enrolledMsg: enrolled.msg,
    };
  }
  const enrolledSet = new Set(enrolled.list.map(item => item.skc));
  const remaining = available.list.map(item => item.skc).filter(skc => skc && !enrolledSet.has(skc));
  const activeEnrolled = enrolled.list.filter(item => ['0', '1'].includes(String(item.status ?? '')));
  const statusCounts = {};
  for (const item of enrolled.list) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
  return {
    ok: true,
    levelRuleId,
    levelRuleIdSource: 'config',
    availableTotal: available.total,
    availableCount: available.list.length,
    enrolledTotal: enrolled.total,
    enrolledCount: enrolled.list.length,
    remainingCount: remaining.length,
    remainingSample: remaining.slice(0, 20),
    availableSkcs: available.list.map(item => item.skc).filter(Boolean),
    enrolledSkcs: enrolled.list.map(item => item.skc).filter(Boolean),
    enrolledActiveSkcs: activeEnrolled.map(item => item.skc).filter(Boolean),
    enrolledActiveRows: activeEnrolled,
    statusSummary: Object.keys(statusCounts).sort().map(key => `${key}:${statusCounts[key]}`).join(';'),
  };
}

function couponSummaryFromApi(store, activity, detail = {}, usage = {}, seller = {}, coupon15Rule = null) {
  const rates = Array.isArray(detail.coupon_discount_rate_list) ? detail.coupon_discount_rate_list : [];
  const maxCouponRatePct = args.couponWorstRatePct ?? maxCouponRate(rates);
  const sellerSharePct = Number(detail.seller_subsidy_rate ?? 100);
  const merchantWorstRatePct = round2(maxCouponRatePct * (Number.isFinite(sellerSharePct) ? sellerSharePct : 100) / 100);
  const site = (usage.coupon_site_usage_info_list || []).find(x => x.site === 'shein-sa') || (usage.coupon_site_usage_info_list || [])[0] || {};
  const has15Rule = coupon15Rule?.ok === true;
  const targetView = COUPON_TARGET_PLAN ? couponPlanStoreView(COUPON_TARGET_PLAN, store.storeKey) : null;
  const targetSet = targetView?.allowedSet || null;
  const activeRows = (coupon15Rule?.enrolledActiveRows || (coupon15Rule?.enrolledActiveSkcs || []).map(skc => ({skc})))
    .filter(row => row?.skc);
  const enrolledActiveSkcs = new Set(activeRows.map(x => String(x.skc).trim()).filter(Boolean));
  const targetActiveCount = targetSet && has15Rule ? [...targetSet].filter(skc => enrolledActiveSkcs.has(skc)).length : '';
  const activeBlockedRows = [];
  const nonTargetEnrolledRows = [];
  if (targetView && has15Rule) {
    for (const row of activeRows) {
      const skc = String(row.skc || '').trim();
      const planRow = findCouponPlanRow(COUPON_TARGET_PLAN, store.storeKey, skc);
      if (!planRow) {
        nonTargetEnrolledRows.push({...row, category: 'not_in_allowed_plan', reason: 'active_coupon_not_in_allowed15_plan'});
      } else if (!planRow.allowed15) {
        activeBlockedRows.push({...row, category: planRow.category, reason: planRow.reason, combo: planRow.combo, couponFactor: planRow.couponFactor});
      }
    }
  }
  const targetAligned = targetSet && has15Rule
    ? targetActiveCount === targetSet.size && activeBlockedRows.length === 0 && nonTargetEnrolledRows.length === 0
    : '';
  const ruleSource = has15Rule
    ? `get_activity_detail + query_coupon_activity_usage_List + fetch_seller_act_info + multi-level/goods/query(15%)${coupon15Rule.levelRuleIdSource === 'config-fallback' ? ' + configured levelRuleId fallback' : ''}`
    : 'get_activity_detail + query_coupon_activity_usage_List + fetch_seller_act_info';
  const ruleNote = has15Rule
    ? targetView
      ? `15%券档按规则页 active 已报集合验证；允许15%券计划=${targetSet.size}，允许计划active=${targetActiveCount}，禁止/未知计划active=${activeBlockedRows.length}，active但不在允许计划=${nonTargetEnrolledRows.length}。${targetAligned ? 'active集合与允许15%券计划一致；可报未入已报集合视为未配套/不应报名。' : '需处理 active 与允许15%券计划不一致；禁止/未知 active 是硬风险，不能被 extra=0 掩盖。'}`
      : `15%券档按规则页已报/处理中集合验证；活动列表 apply/allow 对多档券可能不是最终报名口径。可报未入已报集合数=${coupon15Rule.remainingCount}，未加载允许15%券配套计划，不能据此判断是否应报。`
    : '只读读取券规则与预算；商品级适用范围未在本阶段提交或修改，明细按可能叠加风险提示。';
  const activeBlockedSample = activeBlockedRows
    .slice(0, 10)
    .map(row => `${row.skc}${row.supplierNo ? '/' + row.supplierNo : ''}:${row.category}:${row.reason}`)
    .join('；');
  return {
    '店铺': store.storeKey,
    '分组': store.groupKey,
    '优惠券活动ID': activity.activityId,
    '优惠券活动名称': activity.name || detail.activity_name || '',
    '报名截止': activity.signEnd,
    '活动开始': activity.eventStart,
    '活动结束': activity.eventEnd,
    '后台券档': rates.map(r => `${r.min ?? ''}-${r.max ?? ''}%`).join(' / '),
    '商家承担%': num(detail.seller_subsidy_rate),
    '平台承担%': num(detail.platform_subsidy_rate),
    '风险测算最高券折扣%': num(merchantWorstRatePct),
    '站点': site.site || '',
    '当前站点预算SAR': num(site.coupon_usage_upper_limit),
    '已用预算SAR': num(site.coupon_used_amount),
    '优惠券状态': usage.coupon_limit_setting_status ?? '',
    '可报名数量': activity.allowGoodsNum,
    '已报名数量': activity.applyGoodsNum,
    '15%券档levelRuleId': has15Rule ? coupon15Rule.levelRuleId : '',
    '15%券档可报集合数': has15Rule ? coupon15Rule.availableCount : '',
    '15%券档已报/处理中集合数': has15Rule ? coupon15Rule.enrolledCount : '',
    '15%券档剩余未入已报集合数': has15Rule ? coupon15Rule.remainingCount : '',
    '15%券档状态分布': has15Rule ? coupon15Rule.statusSummary : '',
    '15%券档允许配套计划数': targetSet ? targetSet.size : '',
    '15%券档允许计划active数': targetSet && has15Rule ? targetActiveCount : '',
    '15%券档禁止/未知计划数': targetView ? targetView.blockedCount : '',
    '15%券档禁止/未知仍active数': targetView && has15Rule ? activeBlockedRows.length : '',
    '15%券档active但不在允许计划数': targetView && has15Rule ? nonTargetEnrolledRows.length : '',
    '15%券档active是否符合允许计划': targetSet && has15Rule ? (targetAligned ? '是' : '否') : '',
    '15%券档禁止/未知active样例': activeBlockedSample,
    '规则来源': ruleSource,
    '备注/风险': ruleNote,
    _raw: {activity, detail, usage, seller, coupon15Rule, targetView: targetView ? {allCount: targetView.allCount, allowedCount: targetView.allowedCount, blockedCount: targetView.blockedCount, categoryCounts: targetView.categoryCounts} : null, activeBlockedRows, nonTargetEnrolledRows},
  };
}

async function collectOrdinaryGoodsRowsHttp(session, activity) {
  const body = {
    activity_id: activity.activityId,
    is_partake: 0,
    main_site: 'shein',
    pricing_currency_code: 'SAR',
    skc_query: {grade_tree_list: []},
  };
  const json = await sessionFetchJson(
    session,
    '/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2?page_num=1&page_size=500',
    body,
    {
      'Origin-Url': `https://sso.geiwohuo.com/#/mbrs/marketing/sign-up/config/${activity.activityId}`,
      'x-bbl-route': `/mbrs/marketing/sign-up/config/${activity.activityId}`,
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    },
  );
  if (!(json?.code === '0' || json?.code === 0)) {
    return {
      ok: false,
      totalGoods: 0,
      source: 'session-http query_supplier_goods_list_v2',
      reason: `接口返回 code=${json?.code ?? ''} msg=${json?.msg ?? ''}`,
      rows: [],
    };
  }
  const list = json?.info?.partake_goods_list || [];
  const totalRaw = json?.info?.total;
  const totalGoodsKnown = totalRaw !== undefined && totalRaw !== null && totalRaw !== '';
  const totalGoods = totalGoodsKnown ? Number(totalRaw) : list.length;
  const ok = list.length > 0
    ? (!totalGoodsKnown || list.length >= totalGoods)
    : (totalGoodsKnown && totalGoods === 0);
  return {
    ok,
    totalGoods,
    totalGoodsKnown,
    source: 'session-http query_supplier_goods_list_v2',
    reason: ok ? '' : (totalGoodsKnown && totalGoods && list.length < totalGoods ? `接口只返回 ${list.length}/${totalGoods} 行` : '接口未返回商品且缺明确 total=0 证据'),
    rows: list.map((g, i) => normalizeGoodsRow(g, i)),
  };
}

function normalizeGoodsRow(g = {}, i = 0) {
  const minDiscount = Number(g.final_min_sell_price_rate || g.min_sell_price_rate || g.min_special_sell_price_rate || g.lowest_sale_price_thirty_day_rate || 0);
  const current = Number(g.current_cost || g.current_cost_display?.value || g.shop_price || g.special_price || g.current_shop_price || 0);
  return {
    idx: i + 1,
    skc: g.skc || '',
    supplierNo: g.supplier_no || '',
    sku: '',
    goodsName: [g.goods_name || '', g.supplier_no || '', g.grade_tree || ''].filter(Boolean).join('\n').slice(0, 500),
    currentPrice: current,
    originalPrice: Number(g.shop_price || g.market_price || g.current_shop_price || 0),
    minDiscount: minDiscount || 10,
    priceSource: [
      g.current_cost ? 'current_cost' : '',
      g.current_cost_display?.value ? 'current_cost_display.value' : '',
      g.shop_price ? 'shop_price' : '',
      g.special_price ? 'special_price' : '',
      g.current_shop_price ? 'current_shop_price' : '',
    ].filter(Boolean).join('/'),
    apiRaw: {
      gradeTree: g.grade_tree || '',
      currentCostStr: g.current_cost_str || '',
      finalMinSellPriceRate: g.final_min_sell_price_rate ?? null,
      minSellPriceRate: g.min_sell_price_rate ?? null,
      minSpecialSellPriceRate: g.min_special_sell_price_rate ?? null,
      lowestSalePriceThirtyDayRate: g.lowest_sale_price_thirty_day_rate ?? null,
    },
  };
}

async function fetchActivities(cdp, sessionId) {
  await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('营销活动')`, 45_000);
  const pages = await evalJs(cdp, sessionId, `
    const pages = [];
    const post = async (page) => {
      const r = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=' + page + '&page_size=100', {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: '{}',
      });
      return await r.json();
    };
    for (let page = 1; page <= 30; page += 1) {
      const json = await post(page);
      const list = json?.info?.activity_detail_list || [];
      pages.push({page, code: json?.code, msg: json?.msg, list});
      if (list.length < 100) break;
    }
    return pages;
  `);
  const seen = new Set();
  const list = [];
  for (const page of pages || []) {
    for (const a of page.list || []) {
      const id = Number(a.activity_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({
        activityId: id,
        name: a.activity_name || '',
        backendCate: a.backend_cate,
        label: a.text_tag_content || '',
        signStart: a.activity_start_zone_time || '',
        signEnd: a.activity_end_zone_time || '',
        eventStart: a.start_zone_time || '',
        eventEnd: a.end_zone_time || '',
        allowGoodsNum: Number(a.allow_goods_num || 0),
        applyGoodsNum: Number(a.apply_goods_num || 0),
        raw: a,
      });
    }
  }
  fetchActivities.lastDiagnostics = (pages || []).map(p => ({
    page: p.page,
    code: p.code,
    msg: p.msg,
    listLength: p.list?.length || 0,
    firstActivityId: p.list?.[0]?.activity_id || null,
    firstActivityName: p.list?.[0]?.activity_name || '',
  }));
  return list;
}

function activityDiagnosticsNeedLogin(diagnostics = []) {
  return (diagnostics || []).some(d => String(d?.code || '').trim() === '20302');
}

function activityDiagnosticsFailed(diagnostics = []) {
  return (diagnostics || []).some(d => {
    const code = String(d?.code || '').trim();
    return code && !(code === '0' || code.toUpperCase() === 'OK');
  });
}

function formatActivityDiagnostics(diagnostics = []) {
  return (diagnostics || [])
    .filter(d => {
      const code = String(d?.code || '').trim();
      return code && !(code === '0' || code.toUpperCase() === 'OK');
    })
    .map(d => [d.page ? `page=${d.page}` : '', d.code, d.msg].filter(Boolean).join(' '))
    .join('；') || 'unknown';
}

async function readPageLoginState(cdp, sessionId) {
  return await evalJs(cdp, sessionId, `
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      title: document.title || '',
      isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      tail: text.slice(-1000),
    };
  `).catch(err => ({href: '', title: '', isLogin: false, error: err.message, tail: ''}));
}

async function clickLoginOnce(cdp, sessionId) {
  const target = await evalJs(cdp, sessionId, `
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20)
      || buttons.find(x => !x.disabled && x.text === '登录')
      || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!btn) return {found: false, href: location.href, buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20), tail: (document.body?.innerText || '').slice(-800)};
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found: true, href: location.href, text: btn.text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  `);
  if (!target.found) return {clicked: false, ...target};
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y, button: 'none'}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1}, sessionId);
  return {clicked: true, ...target};
}

async function recoverLoginIfNeeded(cdp, sessionId) {
  const before = await readPageLoginState(cdp, sessionId);
  if (!before.isLogin) return {needed: false, before, after: before};
  const attempts = [];
  let after = before;
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const clicked = await clickLoginOnce(cdp, sessionId);
    attempts.push({attemptNo, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2000 : 5000);
    after = await readPageLoginState(cdp, sessionId);
    if (!after.isLogin) break;
    if (attemptNo === 2) {
      await evalJs(cdp, sessionId, `location.reload(); return {href: location.href};`);
      await sleep(2500);
      after = await readPageLoginState(cdp, sessionId);
      if (!after.isLogin) break;
    }
  }
  return {needed: true, before, attempts, after};
}

async function recoverMbrsLoginAndRetry(cdp, sessionId) {
  const before = await readPageLoginState(cdp, sessionId);
  await evalJs(cdp, sessionId, `location.href = __arg.url; return {href: location.href};`, {url: MBR_LOGIN_URL});
  await sleep(3500);
  const loginRecovery = await recoverLoginIfNeeded(cdp, sessionId);
  await evalJs(cdp, sessionId, `location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
  await sleep(3500);
  const after = await readPageLoginState(cdp, sessionId);
  return {needed: true, before, loginRecovery, after};
}

async function fetchActivityDetail(cdp, sessionId, activityId) {
  return await evalJs(cdp, sessionId, `
    const res = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_detail', {
      method: 'POST',
      credentials: 'include',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({activity_id: __arg.activityId}),
    });
    const json = await res.json();
    return {ok: json?.code === '0' || json?.code === 0, code: json?.code, msg: json?.msg, info: json?.info || null};
  `, {activityId});
}

async function fetchCouponSummary(cdp, sessionId, store, activity) {
  let couponPage = null;
  let activeSessionId = sessionId;
  try {
    couponPage = await newPage(cdp, COUPON_DETAIL_URL(activity.activityId));
    activeSessionId = couponPage.sessionId;
    await waitFor(cdp, activeSessionId, `
      document.body && (
        document.body.innerText.includes('优惠券') ||
        document.body.innerText.includes('继续报名') ||
        document.body.innerText.includes('活动详情')
      )
    `, 25_000);
  } catch {
    activeSessionId = sessionId;
  }
  try {
  const data = await evalJs(cdp, activeSessionId, `
    const post = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body || {}),
      });
      return await res.json();
    };
    const activityId = __arg.activityId;
    const detail = await post('/mrs-api-prefix/mbrs/activity/get_activity_detail', {activity_id: activityId});
    const usage = await post('/mrs-api-prefix/mbrs/coupon/query_coupon_activity_usage_List?page_num=1&page_size=20', {activity_ids: [activityId], query_status: 0});
    const seller = await post('/mrs-api-prefix/mbrs/activity/fetch_seller_act_info', {partake_act_id: activityId});
    return {detail, usage, seller};
  `, {activityId: activity.activityId});
  const coupon15Rule = await fetchCoupon15PctRuleStats(cdp, activeSessionId, store, activity.activityId).catch(err => ({
    ok: false,
    error: err.message,
  }));
  return couponSummaryFromApi(
    store,
    activity,
    data.detail?.info || {},
    data.usage?.info?.coupon_activity_usage_detail_list?.[0] || {},
    data.seller?.info || {},
    coupon15Rule,
  );
  } finally {
    if (couponPage?.targetId) await cdp.call('Target.closeTarget', {targetId: couponPage.targetId}).catch(() => {});
  }
}

function configuredCouponLevelRuleId(storeKey, activityId) {
  const activityRules = COUPON_LEVEL_RULES?.activities?.[String(activityId)] || {};
  const storeRules = activityRules?.stores?.[String(storeKey || '').toUpperCase()] || {};
  const id = Number(storeRules.levelRuleId || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

async function fetchCoupon15PctRuleStats(cdp, sessionId, store, activityId) {
  const fallbackLevelRuleId = configuredCouponLevelRuleId(store.storeKey, activityId);
  return await evalJs(cdp, sessionId, `
    const activityId = Number(__arg.activityId);
    const fallbackLevelRuleId = Number(__arg.fallbackLevelRuleId || 0);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const waitFor = async (predicate, timeoutMs = 35_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await sleep(500);
      }
      return false;
    };
    const headers = () => ({
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    });
    const post = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify(body || {}),
      });
      return await res.json();
    };
    const detailUrl = 'https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/' + activityId;
    if (!location.href.includes('/mbrs/marketing/coupon/detail/' + activityId) &&
        !location.href.includes('/mbrs/marketing/coupon/rule/signup/' + activityId + '/')) {
      location.href = detailUrl;
      await waitFor(() => {
        const text = document.body?.innerText || '';
        return location.href.includes('/mbrs/marketing/coupon/detail/' + activityId) &&
          (text.includes('继续报名') || text.includes('优惠券') || text.includes('活动详情'));
      });
    }
    if (!location.href.includes('/mbrs/marketing/coupon/rule/signup/' + activityId + '/')) {
      const buttons = [...document.querySelectorAll('button,[role=button]')]
        .filter(visible)
        .map(el => {
          let node = el;
          let ctx = '';
          for (let i = 0; i < 6 && node; i += 1) {
            ctx = textOf(node);
            if (ctx.length > 20 && ctx.length < 2500) break;
            node = node.parentElement;
          }
          return {el, text: textOf(el), ctx};
        })
        .filter(x => x.text === '继续报名' || x.text === '报名' || x.text === '去报名');
      if (!buttons.length) {
        return {ok: false, reason: 'continue signup button not found', href: location.href, text: (document.body?.innerText || '').slice(0, 1200)};
      }
      const preferred = buttons.find(x => x.ctx.includes('15') || x.ctx.includes('1%-15') || x.ctx.includes('1%-15%')) || buttons[0];
      preferred.el.scrollIntoView({block: 'center', inline: 'center'});
      preferred.el.click();
      await waitFor(() => location.href.includes('/mbrs/marketing/coupon/rule/signup/' + activityId + '/'), 25_000);
    }
    let m = String(location.href || '').match(new RegExp('/coupon/rule/signup/' + activityId + '/(\\\\d+)'));
    let levelRuleId = Number(m?.[1] || 0);
    let levelRuleIdSource = 'route';
    let routeFallback = null;
    if (!levelRuleId && fallbackLevelRuleId) {
      routeFallback = {
        reason: 'detail button did not reach rule signup route; using configured per-store levelRuleId',
        fromHref: location.href,
        fallbackLevelRuleId,
      };
      location.href = 'https://sso.geiwohuo.com/#/mbrs/marketing/coupon/rule/signup/' + activityId + '/' + fallbackLevelRuleId + '?from=detail';
      await waitFor(() => location.href.includes('/mbrs/marketing/coupon/rule/signup/' + activityId + '/' + fallbackLevelRuleId), 8_000);
      m = String(location.href || '').match(new RegExp('/coupon/rule/signup/' + activityId + '/(\\\\d+)'));
      levelRuleId = Number(m?.[1] || fallbackLevelRuleId || 0);
      levelRuleIdSource = 'config-fallback';
      routeFallback.toHref = location.href;
    }
    if (!levelRuleId) {
      return {ok: false, reason: '15% rule signup route not reached', href: location.href};
    }
    const queryPage = async (pageModule, pageNum) => {
      const json = await post('/mrs-api-prefix/mbrs/activity/multi-level/goods/query?page_num=' + pageNum + '&page_size=200', {
        activity_id: activityId,
        level_rule_id: levelRuleId,
        page: 'COUPON',
        page_module: pageModule,
        product_code_list: [],
        supplier_no_list: [],
      });
      const list = json?.info?.partake_goods_list || [];
      return {
        code: json?.code,
        msg: json?.msg,
        total: Number(json?.info?.total ?? list.length ?? 0),
        list: list.map(x => ({
          skc: x.skc || '',
          supplierNo: x.supplier_no || '',
          status: String(x.status ?? ''),
          enrollTime: x.enroll_time || null,
        })),
      };
    };
    const queryAll = async pageModule => {
      const all = [];
      let total = 0;
      let last = null;
      for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
        last = await queryPage(pageModule, pageNum);
        if (last.code !== '0' && last.code !== 0) return {...last, list: all};
        total = last.total;
        all.push(...last.list);
        if (!last.list.length || all.length >= total) break;
      }
      const seen = new Set();
      const deduped = [];
      for (const item of all) {
        if (!item.skc || seen.has(item.skc)) continue;
        seen.add(item.skc);
        deduped.push(item);
      }
      return {code: '0', msg: last?.msg || 'OK', total, list: deduped};
    };
    const available = await queryAll('MULTI_LEVEL_RULE_GOODS');
    const enrolled = await queryAll('MULTI_LEVEL_RULE_ENROLLED_GOODS');
    if ((available.code !== '0' && available.code !== 0) || (enrolled.code !== '0' && enrolled.code !== 0)) {
      return {ok: false, levelRuleId, availableCode: available.code, availableMsg: available.msg, enrolledCode: enrolled.code, enrolledMsg: enrolled.msg};
    }
    const enrolledSet = new Set(enrolled.list.map(x => x.skc));
    const remaining = available.list.map(x => x.skc).filter(skc => skc && !enrolledSet.has(skc));
    const activeEnrolled = enrolled.list.filter(x => ['0', '1'].includes(String(x.status ?? '')));
    const statusCounts = {};
    for (const item of enrolled.list) statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    const statusSummary = Object.keys(statusCounts).sort().map(k => k + ':' + statusCounts[k]).join(';');
    return {
      ok: true,
      levelRuleId,
      levelRuleIdSource,
      routeFallback,
      availableTotal: available.total,
      availableCount: available.list.length,
      enrolledTotal: enrolled.total,
      enrolledCount: enrolled.list.length,
      remainingCount: remaining.length,
      remainingSample: remaining.slice(0, 20),
      availableSkcs: available.list.map(x => x.skc).filter(Boolean),
      enrolledSkcs: enrolled.list.map(x => x.skc).filter(Boolean),
      enrolledActiveSkcs: activeEnrolled.map(x => x.skc).filter(Boolean),
      enrolledActiveRows: activeEnrolled,
      statusSummary,
    };
  `, {activityId, fallbackLevelRuleId});
}

async function collectOrdinaryGoodsRows(cdp, sessionId, activity) {
  const apiRows = await evalJs(cdp, sessionId, `
    const activityId = Number((location.hash.match(/config\\/(\\d+)/) || [])[1] || __arg.activityId || 0);
    const body = {
      activity_id: activityId,
      is_partake: 0,
      main_site: 'shein',
      pricing_currency_code: 'SAR',
      skc_query: {grade_tree_list: []}
    };
    const r = await fetch('/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2?page_num=1&page_size=500', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'Origin-Url': location.href,
        'x-bbl-route': location.hash.replace(/^#/, ''),
        'x-req-zone-id': 'Asia/Shanghai',
        'x-lt-language': 'CN',
        'LAN': 'CN'
      },
      body: JSON.stringify(body)
    });
    const json = await r.json();
    const list = json?.info?.partake_goods_list || [];
    const totalRaw = json?.info?.total;
    const totalGoodsKnown = totalRaw !== undefined && totalRaw !== null && totalRaw !== '';
    const totalGoods = totalGoodsKnown ? Number(totalRaw) : list.length;
    return {
      code: json?.code,
      msg: json?.msg,
      totalGoods,
      totalGoodsKnown,
      rows: list.map((g, i) => {
        const minDiscount = Number(g.final_min_sell_price_rate || g.min_sell_price_rate || g.min_special_sell_price_rate || g.lowest_sale_price_thirty_day_rate || 0);
        const current = Number(g.current_cost || g.current_cost_display?.value || g.shop_price || g.special_price || g.current_shop_price || 0);
        return {
          idx: i + 1,
          skc: g.skc || '',
          supplierNo: g.supplier_no || '',
          sku: '',
          goodsName: [g.goods_name || '', g.supplier_no || '', g.grade_tree || ''].filter(Boolean).join('\\n').slice(0, 500),
          currentPrice: current,
          originalPrice: Number(g.shop_price || g.market_price || g.current_shop_price || 0),
          minDiscount: minDiscount || 10,
          priceSource: [
            g.current_cost ? 'current_cost' : '',
            g.current_cost_display?.value ? 'current_cost_display.value' : '',
            g.shop_price ? 'shop_price' : '',
            g.special_price ? 'special_price' : '',
          ].filter(Boolean).join('/'),
          apiRaw: {
            gradeTree: g.grade_tree || '',
            currentCostStr: g.current_cost_str || '',
            finalMinSellPriceRate: g.final_min_sell_price_rate ?? null,
            minSellPriceRate: g.min_sell_price_rate ?? null,
            minSpecialSellPriceRate: g.min_special_sell_price_rate ?? null,
            lowestSalePriceThirtyDayRate: g.lowest_sale_price_thirty_day_rate ?? null,
          }
        };
      })
    };
  `, {activityId: activity.activityId}).catch(err => ({code: 'ERR', msg: err.message, rows: [], totalGoods: null, totalGoodsKnown: false}));
  const codeOk = apiRows.code === '0' || apiRows.code === 0;
  const rows = apiRows.rows || [];
  const totalGoodsKnown = apiRows.totalGoodsKnown === true;
  const totalGoods = totalGoodsKnown ? Number(apiRows.totalGoods) : (rows.length || null);
  const ok = codeOk
    ? (rows.length > 0 ? (!totalGoodsKnown || rows.length >= totalGoods) : (totalGoodsKnown && totalGoods === 0))
    : false;
  return {
    ok,
    rows,
    totalGoods,
    totalGoodsKnown,
    source: 'query_supplier_goods_list_v2',
    reason: ok ? '' : (codeOk
      ? (totalGoodsKnown && totalGoods && rows.length < totalGoods ? `接口只返回 ${rows.length}/${totalGoods} 行` : (apiRows.msg || '接口未返回商品且缺明确 total=0 证据'))
      : `接口返回 code=${apiRows.code ?? ''} msg=${apiRows.msg || ''}`),
  };
}

function buildDetailRow(store, activity, activityDetail, row, couponContext) {
  const normalized = normalizeGoodsSnDetailed(row.supplierNo, {goodsTitle: row.goodsName || ''});
  const canonical = normalized.canonical || row.supplierNo || '';
  const keysRaw = [row.supplierNo, canonical, modelCode(row.supplierNo), modelCode(canonical), normalized.rawGoodsSn].filter(Boolean);
  const cost = lookupCostInfo(keysRaw);
  const depletion = lookupDepletion(store.storeKey, canonical, row.supplierNo);
  const pricing = choosePricing(store.storeKey, activity.activityId, row, canonical, cost, depletion);
  const link = lookupLinkActivity(store.storeKey, row.skc, canonical, row.supplierNo);
  const linkNames = splitActivityNames(link?.activityNames || '');
  const limitNames = linkNames.filter(x => /限时折扣/.test(x));
  const ordinaryNames = linkNames.filter(x => !/限时折扣|coupon|优惠券/i.test(x));
  const overlappingCoupons = couponContext.coupons.filter(c => overlaps(activity.eventStart, activity.eventEnd, c['活动开始'], c['活动结束']));
  const couponRatePct = overlappingCoupons.length ? Math.max(...overlappingCoupons.map(c => Number(c['风险测算最高券折扣%'] || 0)).filter(Number.isFinite), 0) : 0;
  const couponNames = overlappingCoupons.map(c => `${c['优惠券活动ID']}-${c['优惠券活动名称']}`).join('；');
  const ordinaryBaseCandidates = [
    {source: '当前售价', price: numValue(row.currentPrice)},
    {source: '本次建议普通活动价', price: numValue(pricing.suggestedMarketingPrice)},
  ].filter(x => Number.isFinite(x.price) && x.price > 0);
  const lowest = ordinaryBaseCandidates.sort((a, b) => a.price - b.price)[0] || {source: '', price: null};
  const finalPrice = Number.isFinite(lowest.price) ? round2(lowest.price * (1 - couponRatePct / 100)) : null;
  const goodsMargin = margin(finalPrice, cost.productCostSar);
  const fullMargin = margin(finalPrice, cost.fullCostSar);
  const risk = [];
  if (ordinaryNames.length) risk.push(`既有普通活动标签：${ordinaryNames.slice(0, 4).join(' / ')}`);
  if (limitNames.length) risk.push(`存在限时折扣标签但未读到价格：${limitNames.slice(0, 4).join(' / ')}`);
  if (overlappingCoupons.length) risk.push(`可能叠加优惠券，按最高商家承担 ${couponRatePct}% 测算`);
  if (cost.productCostSar === null) risk.push('商品成本缺失');
  if (cost.storageUnitCostSar === null) risk.push('仓储费缺失/估算缺失，不能按0安全通过');
  if (fullMargin !== null && fullMargin < 0.15) risk.push(`含仓储费利润率低于15%红线：${pct(fullMargin)}`);
  else if (fullMargin !== null && fullMargin < 0.20) risk.push(`含仓储费利润率低于20%默认线：${pct(fullMargin)}`);
  if (pricing.platformAdjusted) risk.push('平台最低折扣压低建议价');
  if (normalized.needsReview) risk.push(`货号归并待复核：${normalized.reviewReason}`);
  if (!Number.isFinite(row.currentPrice) || row.currentPrice <= 0) risk.push('当前售价缺失');
  const oldActivityOverlap = ordinaryNames.length || limitNames.length || overlappingCoupons.length;
  return {
    '店铺': store.storeKey,
    '分组': store.groupKey,
    '活动类型': '普通营销活动',
    '活动ID': activity.activityId,
    '活动名称': activity.name,
    '报名截止': activity.signEnd,
    '普通活动开始': activity.eventStart,
    '普通活动结束': activity.eventEnd,
    '时间窗口是否重叠': oldActivityOverlap ? '是' : '否',
    'SKC': row.skc,
    'SKU': row.sku || '',
    '供方货号': row.supplierNo,
    '标准货号': canonical,
    '商品标题/中文名': row.goodsName || activityDetail?.activity_name || '',
    '原始价SAR': num(row.originalPrice),
    '当前售价SAR': num(row.currentPrice),
    '价格字段来源': row.priceSource || 'query_supplier_goods_list_v2',
    '平台最低降幅%': num(row.minDiscount),
    '商品完整成本SAR': num(cost.productCostSar),
    '仓储费摊销SAR/件': num(cost.storageUnitCostSar),
    '含仓储费成本SAR': num(cost.fullCostSar),
    '仓储口径': cost.storageMethod || (cost.storageUnitCostSar === null ? 'missing' : ''),
    '本次建议普通活动价SAR': num(pricing.suggestedMarketingPrice),
    '本次建议普通活动折扣%': num(pricing.suggestedMarketingDiscountPct),
    '普通营销活动价/折扣': [
      pricing.suggestedMarketingPrice ? `本次建议 ${num(pricing.suggestedMarketingPrice)} SAR / ${num(pricing.suggestedMarketingDiscountPct)}%` : '',
      ordinaryNames.length ? `既有标签 ${ordinaryNames.join(' / ')}` : '',
    ].filter(Boolean).join('；'),
    '优惠券活动ID/名称': couponNames,
    '优惠券券档/风险折扣': overlappingCoupons.length ? `最高商家承担 ${num(couponRatePct)}%；用户审核后再决定是否用15%档` : '',
    '优惠券券后价SAR': num(finalPrice),
    '限时折扣名称': limitNames.join(' / '),
    '限时折扣价SAR': '',
    '最低价来源': [lowest.source, limitNames.length ? '限时折扣价未读到，需专项复核' : ''].filter(Boolean).join('；'),
    '最低促销基准价SAR': num(lowest.price),
    '叠加后最终成交价SAR': num(finalPrice),
    '商品利润率': pct(goodsMargin),
    '含仓储费利润率': pct(fullMargin),
    '风险提示': risk.join('；'),
    '修改意见/备注': '',
    _raw: {activity, activityDetail, row, pricing, cost, link, couponIds: overlappingCoupons.map(c => c['优惠券活动ID'])},
  };
}

function choosePricing(storeKey, activityId, row, canonical, cost, depletion) {
  const seed = `${storeKey}:${activityId}:${row.skc}:${canonical}`;
  const keys = [canonical, row.supplierNo, modelCode(canonical), modelCode(row.supplierNo)].map(compact).filter(Boolean);
  const fixed = keys.map(k => fixedPriceRules.get(k)).find(v => v !== undefined);
  let rule = '默认30%利润率';
  let targetFinalPrice = null;
  let targetMargin = 0.30;
  if (fixed !== undefined) {
    rule = '用户明确固定价（目标最终成交价）';
    targetMargin = null;
    targetFinalPrice = round2(Number(fixed) + randomBetween(seed, -2, 1));
  } else {
    const specialMargin = keys.map(k => specialMarginRules.get(k)).find(v => v !== undefined);
    if (specialMargin !== undefined) {
      targetMargin = specialMargin <= 0.15 ? 0.15 : randomBetween(seed, specialMargin - 0.02, specialMargin + 0.01);
      rule = `用户指定利润率 ${Math.round(specialMargin * 100)}%`;
    } else if (Number(depletion?.onHand || 0) > 0 && Number(depletion?.daysOnHand || 0) > 180) {
      targetMargin = 0.15;
      rule = '在仓去化>6个月：15%利润率';
    } else if (Number(depletion?.onHand || 0) > 0 && Number(depletion?.daysOnHand || 0) > 90) {
      targetMargin = randomBetween(seed, 0.23, 0.27);
      rule = '在仓去化>3个月：23%-27%利润率';
    }
    if (cost.fullCostSar !== null && targetMargin !== null) targetFinalPrice = round2(cost.fullCostSar / (1 - targetMargin));
  }
  const current = numValue(row.currentPrice);
  const minDiscountPct = numValue(row.minDiscount) || 0;
  const platformMax = current ? floor2(current * (1 - minDiscountPct / 100)) : null;
  let suggestedMarketingPrice = targetFinalPrice;
  let platformAdjusted = false;
  if (suggestedMarketingPrice !== null && platformMax !== null && suggestedMarketingPrice > platformMax) {
    suggestedMarketingPrice = platformMax;
    platformAdjusted = true;
  }
  const suggestedMarketingDiscountPct = current && suggestedMarketingPrice
    ? round2(Math.max(minDiscountPct, (1 - suggestedMarketingPrice / current) * 100))
    : null;
  return {
    rule,
    targetMargin,
    targetFinalPrice,
    suggestedMarketingPrice,
    suggestedMarketingDiscountPct,
    platformMax,
    platformAdjusted,
  };
}

function buildCouponContext(coupons) {
  return {coupons};
}

function withinScope(a) {
  if (a.allowGoodsNum <= 0 && !isCouponActivity(a)) return false;
  if (!isCouponActivity(a) && a.applyGoodsNum >= a.allowGoodsNum) return false;
  const end = parseTime(a.signEnd);
  if (!end || end.getTime() < now.getTime()) return false;
  if (args.allOpen) return true;
  return end.getTime() <= now.getTime() + args.hours * 3600_000;
}

function isCouponActivity(a) {
  const text = [a.name, a.label, a.backendCate, a.raw?.multi_level_coupon_activity ? 'coupon' : ''].filter(Boolean).join(' ');
  return /coupon|优惠券/i.test(text);
}

function buildLinkActivityIndex(bi) {
  const byStoreSkc = new Map();
  const byStoreStandard = new Map();
  const rows = [...(bi.storeLinks || []), ...(bi.links || [])];
  for (const r of rows) {
    const store = r.store_key || r.storeKey;
    const skc = r.skc;
    const standard = r.standard_goods_sn || r.standardGoodsSn;
    const activityNames = r.performance_activity_names || r.activity_names || r.activityNames || '';
    const activityTag = r.performance_activity_tag || r.activity_label || r.activityTag || '';
    if (!store || (!skc && !standard)) continue;
    const doc = {
      store,
      skc,
      standard,
      activityNames,
      activityTag,
      linkDate: r.link_date || r.date || '',
      isOnShelf: r.is_on_shelf ?? r.isOnShelf ?? null,
    };
    if (store && skc) byStoreSkc.set(`${store}__${skc}`, mergeLinkDoc(byStoreSkc.get(`${store}__${skc}`), doc));
    if (store && standard) {
      const k = `${store}__${compact(standard)}`;
      byStoreStandard.set(k, mergeLinkDoc(byStoreStandard.get(k), doc));
    }
  }
  return {byStoreSkc, byStoreStandard, rows};
}

function mergeLinkDoc(prev, next) {
  if (!prev) return next;
  const names = [...splitActivityNames(prev.activityNames), ...splitActivityNames(next.activityNames)];
  return {
    ...prev,
    ...next,
    activityNames: [...new Set(names)].join(' / '),
    activityTag: [...new Set([prev.activityTag, next.activityTag].filter(Boolean).join(',').split(','))].join(','),
  };
}

function buildDepletionIndex(bi) {
  const byStandard = new Map();
  for (const p of bi.inventoryDepletion?.products || []) {
    const standard = p.standard_goods_sn || p.standardGoodsSn;
    if (!standard) continue;
    const projection = normalizeInventoryProjection(p);
    byStandard.set(compact(standard), {
      onHand: projection.fresh_matched ? projection.current_sellable_quantity : null,
      daysOnHand: projection.fresh_matched ? numValue(p.days_of_supply_on_hand) : null,
      weightedDailySales: Number(p.weighted_daily_gross_sales || 0),
      unitCostSar: numValue(p.unit_cost_sar),
      inventoryMatchStatus: projection.inventory_match_status,
    });
  }
  return byStandard;
}

function lookupLinkActivity(storeKey, skc, canonical, supplierNo) {
  if (skc && linkIndex.byStoreSkc.has(`${storeKey}__${skc}`)) return linkIndex.byStoreSkc.get(`${storeKey}__${skc}`);
  for (const k of [canonical, supplierNo].map(compact).filter(Boolean)) {
    const doc = linkIndex.byStoreStandard.get(`${storeKey}__${k}`);
    if (doc) return doc;
  }
  return null;
}

function lookupDepletion(storeKey, canonical, supplierNo) {
  for (const k of [canonical, supplierNo].map(compact).filter(Boolean)) {
    const dep = depletionIndex.get(k);
    if (dep) return dep;
  }
  return null;
}

function lookupCostInfo(keys) {
  const trueCost = lookupTrueCost(keys);
  const fallbackCost = lookupCost(keys);
  const sharedStorageCost = findSharedStorageCost(sharedStorageCostIndex, keys);
  const productCostSar = numValue(trueCost?.unitCostSar)
    ?? numValue(trueCost?.productUnitCostSar)
    ?? fallbackCost;
  const storageUnitCostSar = numValue(trueCost?.storageUnitCostSar)
    ?? numValue(trueCost?.storageUnitCostSar30d)
    ?? numValue(sharedStorageCost?.storageUnitCostSar);
  const explicitFullCostSar = numValue(trueCost?.trueUnitCostSar);
  const fullCostSar = explicitFullCostSar !== null ? explicitFullCostSar
    : (productCostSar !== null && storageUnitCostSar !== null ? round2(productCostSar + storageUnitCostSar) : productCostSar);
  const mappedStorageMethod = /^(?:missing|unknown)$/i.test(String(trueCost?.storageMethod || '').trim()) ? '' : trueCost?.storageMethod;
  return {
    productCostSar,
    storageUnitCostSar,
    fullCostSar,
    storageMethod: mappedStorageMethod || sharedStorageCost?.storageMethod || '',
    raw: trueCost ? {...trueCost, sharedStorageCostFallback: sharedStorageCost || null} : sharedStorageCost,
  };
}

function lookupCost(keys) {
  for (const key of keys) {
    if (COSTS[key] !== undefined) return Number(COSTS[key]);
    const c = compact(key);
    if (COSTS[c] !== undefined) return Number(COSTS[c]);
  }
  return null;
}

function lookupTrueCost(keys) {
  for (const key of keys) {
    if (TRUE_COSTS[key]) return TRUE_COSTS[key];
    const c = compact(key);
    if (TRUE_COSTS[c]) return TRUE_COSTS[c];
  }
  return null;
}

function buildLimitDiscountRows(index) {
  const rows = [];
  const seen = new Set();
  for (const doc of index.byStoreSkc.values()) {
    const names = splitActivityNames(doc.activityNames).filter(x => /限时折扣/.test(x));
    if (!names.length) continue;
    const key = `${doc.store}__${doc.skc}__${names.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      '店铺': doc.store,
      'SKC': doc.skc || '',
      '标准货号': doc.standard || '',
      '限时折扣名称': names.join(' / '),
      '限时折扣价SAR': '',
      '来源': `${BI_SOURCE_SUMMARY.biDataPath || 'outputs/bi-portal/data.json'} performance_activity_names`,
      '数据日期': doc.linkDate || BI.dates?.linkDate || '',
      '风险提示': '只读审核已发现限时折扣标签，但当前脚本未读取到限时折扣价；报名/用券前必须人工复核或专项扫描。',
      '修改意见/备注': '',
    });
  }
  return rows.sort((a, b) => String(a['店铺']).localeCompare(String(b['店铺'])) || String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));
}

function summarizeBySku(rows) {
  const bySku = new Map();
  for (const r of rows) {
    const key = r['标准货号'] || r['供方货号'] || r.SKC;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(r);
  }
  const out = [];
  for (const [sku, group] of bySku) {
    const stores = uniq(group.map(r => r['店铺'])).sort();
    const activities = uniq(group.map(r => r['活动ID'])).sort((a, b) => Number(a) - Number(b));
    const risks = uniq(group.flatMap(r => String(r['风险提示'] || '').split('；').filter(Boolean)));
    const margins = group.map(r => parsePct(r['含仓储费利润率'])).filter(v => v !== null);
    out.push({
      '标准货号': sku,
      '代表供方货号': mostCommon(group.map(r => r['供方货号'])),
      '适用店铺数': stores.length,
      '适用店铺': stores.join(','),
      '涉及活动数': activities.length,
      '活动ID': activities.join(','),
      '明细行数': group.length,
      '当前售价SAR范围': range(group.map(r => r['当前售价SAR']), 2),
      '商品完整成本SAR范围': range(group.map(r => r['商品完整成本SAR']), 2),
      '含仓储费成本SAR范围': range(group.map(r => r['含仓储费成本SAR']), 2),
      '建议普通活动价SAR范围': range(group.map(r => r['本次建议普通活动价SAR']), 2),
      '叠加后最终成交价SAR范围': range(group.map(r => r['叠加后最终成交价SAR']), 2),
      '最低含仓储费利润率': margins.length ? pct(Math.min(...margins)) : '',
      '限时折扣风险行数': group.filter(r => r['限时折扣名称']).length,
      '优惠券叠加风险行数': group.filter(r => r['优惠券活动ID/名称']).length,
      '高风险提示': risks.slice(0, 8).join('；') + (risks.length > 8 ? '；...' : ''),
      '修改意见/备注': '',
    });
  }
  return out.sort((a, b) => String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));
}

function renderMarkdown(summaryRows, detailRows, couponRows, limitRows, files) {
  const outputNaming = resolveStackReviewOutputNaming(dateTag, selectedStores, enabledStores);
  const risky = detailRows.filter(r => r['风险提示']).length;
  const lowMargin = detailRows.filter(r => {
    const m = parsePct(r['含仓储费利润率']);
    return m !== null && m < 0.20;
  }).length;
  const missingCost = detailRows.filter(r => /成本缺失|仓储费缺失/.test(r['风险提示'] || '')).length;
  const couponForbiddenActive = couponRows.reduce((sum, r) => sum + (numValue(r['15%券档禁止/未知仍active数']) || 0), 0);
  const couponExtraActive = couponRows.reduce((sum, r) => sum + (numValue(r['15%券档active但不在允许计划数']) || 0), 0);
  const topRiskRows = detailRows
    .filter(r => r['风险提示'])
    .slice(0, 80);
  const previewHeaders = ['店铺','活动ID','标准货号','当前售价SAR','本次建议普通活动价SAR','优惠券券档/风险折扣','叠加后最终成交价SAR','含仓储费利润率','风险提示','修改意见/备注'];
  return [
    `# 营销活动叠加安全审核（${dateTag}）`,
    '',
    '- 状态：只读扫描输出；未报名、未提交、未取消或调价限时折扣。',
    `- 覆盖模式：${outputNaming.completeEnabledStoreCoverage ? '全部启用店铺' : `部分店铺（不会覆盖当天全量报告，输出名 ${outputNaming.outputName}）`}`,
    `- 覆盖店铺：${selectedStores.map(s => s.storeKey).join(', ')}`,
    `- 明细行：${detailRows.length}`,
    `- 标准货号行：${summaryRows.length}`,
    `- 优惠券规则行：${couponRows.length}`,
    `- 限时折扣风险标签行：${limitRows.length}`,
    `- 15%券禁止/未知仍 active 数：${couponForbiddenActive}`,
    `- 15%券 active 但不在允许计划数：${couponExtraActive}`,
    `- 有风险提示明细行：${risky}`,
    `- 含仓储费利润率低于 20% 行：${lowMargin}`,
    `- 缺成本/仓储费口径行：${missingCost}`,
    `- BI 数据时间：${BI.generatedAt || ''}`,
    `- BI 数据来源：${BI_SOURCE_SUMMARY.biDataPath || ''}（transport=${BI_SOURCE_SUMMARY.biDataTransport || ''}, fallback=${BI_SOURCE_SUMMARY.biFallbackUsed ? 'yes' : 'no'}, status=${BI_SOURCE_SUMMARY.biStatus || ''}）`,
    `- 链接活动标签日期：${BI.dates?.linkDate || ''}`,
    `- 成本来源：${COST_DOC.source || ''}`,
    `- 优惠券配套计划：${COUPON_TARGET_PLAN ? path.relative(ROOT, COUPON_TARGET_PLAN.path) : '未加载；仅展示券档可报/已报集合，不判断是否应报'}`,
    `- 优惠券配套口径：${COUPON_TARGET_PLAN ? '仅 price-overrides 中明确标记为高曝光支持、滞销高库存引流或清货试验的可选流量券 SKC 允许进入 15%券计划；历史 couponFactor≈0.85 / 仅15%券价格保障口径全部 fail closed。' : '未加载。'}`,
    '',
    '## 文件',
    '',
    `- 明细审核表：\`${path.relative(ROOT, files.detailCsv)}\``,
    `- 按标准货号汇总：\`${path.relative(ROOT, files.bySkuCsv)}\``,
    `- 优惠券规则：\`${path.relative(ROOT, files.couponCsv)}\``,
    `- 限时折扣风险表：\`${path.relative(ROOT, files.limitDiscountCsv)}\``,
    `- JSON 全量：\`${path.relative(ROOT, files.json)}\``,
    '',
    '## 审核口径',
    '',
    '- 最低促销基准价先按当前可读到的 `当前售价` 与 `本次建议普通活动价` 取低值。',
    '- 若 BI 链路已发现同 SKC 存在 `限时折扣`，但本阶段未读到限时折扣价格，明细会标为高风险，不按安全通过。',
    '- 若同窗口存在优惠券活动，按券规则中可读到的最高商家承担折扣做风险测算；用户可在备注栏指定不用券或只用 15% 档。',
    '- 多档优惠券活动报名验证优先看 `15%券档active是否符合允许计划`、`15%券档允许配套计划数`、`15%券档禁止/未知仍active数`、`15%券档active但不在允许计划数`；禁止/未知 active 是硬风险，不能被“extra=0”或旧普通计划口径掩盖。',
    '- `15%券档剩余未入已报集合数` 是“平台可报但未报”的集合，不等于本期应报目标。',
    '- 安全判断默认看 `含仓储费利润率`；仓储费缺失会标记风险，不能当 0 处理。',
    '',
    '## 风险明细预览',
    '',
    `| ${previewHeaders.join(' | ')} |`,
    `| ${previewHeaders.map(() => '---').join(' | ')} |`,
    ...topRiskRows.map(r => `| ${previewHeaders.map(h => mdCell(r[h])).join(' | ')} |`),
    topRiskRows.length < risky ? `\n> 仅预览前 ${topRiskRows.length} 行风险；完整内容见 CSV/JSON。` : '',
    '',
  ].join('\n');
}

async function readJsonIfExists(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') {
    spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'cleanup_shein_store_browsers.mjs'),
      '--store',
      store.storeKey,
      '--kill-after-sec',
      '5',
    ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
    return;
  }
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchStore(store) {
  const mode = args.headless ? '--headless' : (args.visible ? '--visible' : '--background');
  const params = [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    mode,
    '--url',
    LIST_URL,
  ];
  const r = spawnSync(process.execPath, params, {cwd: ROOT, encoding: 'utf8', timeout: 25_000});
  if (r.status !== 0) throw new Error(`launch browser failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(6000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

async function waitForCdpPort(store, {timeoutMs = 25_000, intervalMs = 800} = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      return await httpJson(`http://127.0.0.1:${store.port}/json/version`);
    } catch (err) {
      lastError = err;
      await sleep(intervalMs);
    }
  }
  throw new Error(`CDP port not ready for ${store.storeKey} on ${store.port}: ${lastError?.message || 'timeout'}`);
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  call(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45_000);
    });
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStore(store) {
  const version = await waitForCdpPort(store);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.call('Target.setDiscoverTargets', {discover: true});
  return cdp;
}

async function newPage(cdp, url) {
  const {targetId} = await cdp.call('Target.createTarget', {url, newWindow: false});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('Runtime.enable', {}, sessionId);
  return {targetId, sessionId};
}

async function evalJs(cdp, sessionId, body, arg = undefined) {
  const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
  const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
  const res = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(text);
  }
  return res.result?.value;
}

async function waitFor(cdp, sessionId, predicateBody, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJs(cdp, sessionId, `return Boolean(${predicateBody});`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function compact(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\-]/g, '').toUpperCase();
}

function modelCode(s) {
  return String(s || '').match(/^[A-Z]{1,5}-?\d+[A-Z]?(?:-\d+)?/i)?.[0] || '';
}

function registerRuleKeys(map, label, value) {
  const normalized = normalizeGoodsSnDetailed(label, {goodsTitle: label});
  const keys = [label, normalized.canonical, modelCode(label), modelCode(normalized.canonical)]
    .map(compact)
    .filter(Boolean);
  for (const key of keys) map.set(key, value);
}

function stableRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function randomBetween(seed, min, max) {
  return min + stableRandom(seed) * (max - min);
}

function round2(n) {
  if (!Number.isFinite(Number(n))) return null;
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function floor2(n) {
  if (!Number.isFinite(Number(n))) return null;
  return Math.floor((Number(n) + 1e-9) * 100) / 100;
}

function numValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%', '').replace(',', '').trim());
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  const n = numValue(v);
  return n === null ? '' : round2(n);
}

function pct(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : `${round2(Number(v) * 100)}%`;
}

function parsePct(s) {
  const n = numValue(s);
  return n === null ? null : n / 100;
}

function margin(price, cost) {
  const p = numValue(price);
  const c = numValue(cost);
  if (!p || c === null) return null;
  return (p - c) / p;
}

function parseTime(s) {
  if (!s || s === '长期有效') return null;
  const raw = String(s).trim();
  const normalized = raw.replace(/\//g, '-').replace(' ', 'T');
  const d = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? new Date(normalized) : new Date(normalized + '+08:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  const as = parseTime(aStart) || new Date(0);
  const ae = parseTime(aEnd) || new Date('2999-12-31T00:00:00+08:00');
  const bs = parseTime(bStart) || new Date(0);
  const be = parseTime(bEnd) || new Date('2999-12-31T00:00:00+08:00');
  return as.getTime() <= be.getTime() && bs.getTime() <= ae.getTime();
}

function maxCouponRate(rates) {
  const nums = [];
  for (const r of rates || []) {
    for (const key of ['max', 'coupon_discount_rate', 'discount_rate', 'rate']) {
      const n = numValue(r?.[key]);
      if (n !== null) nums.push(n);
    }
  }
  return nums.length ? Math.max(...nums) : 0;
}

function splitActivityNames(text) {
  return String(text || '').split(/\s*\/\s*|\s*；\s*|\s*;\s*/).map(s => s.trim()).filter(Boolean);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTimestamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function writeCsv(file, rows, headers) {
  const text = [
    headers.join(','),
    ...rows.map(r => headers.map(h => csvEscape(r[h])).join(',')),
  ].join('\n');
  await fs.writeFile(file, '\uFEFF' + text, 'utf8');
}

function range(values, digits = 2) {
  const nums = values.map(numValue).filter(v => v !== null);
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const fmt = v => Number(v).toFixed(digits).replace(/\.?0+$/, '');
  return min === max ? fmt(min) : `${fmt(min)}-${fmt(max)}`;
}

function uniq(values) {
  return [...new Set(values.filter(v => v !== null && v !== undefined && String(v) !== ''))];
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, '<br>').slice(0, 500);
}

function stripRowsForAudit(result) {
  return {
    store: result.store,
    groupKey: result.groupKey,
    ok: result.ok,
    error: result.error || '',
    reason: result.reason || '',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    pageInfo: result.pageInfo || null,
    loginRecovery: result.loginRecovery || null,
    loginRecoveryAfter20302: result.loginRecoveryAfter20302 || null,
    activityFetchDiagnostics: result.activityFetchDiagnostics || [],
    activities: result.activities,
    couponSummaries: (result.couponSummaries || []).map(c => {
      const copy = {...c};
      delete copy._raw;
      return copy;
    }),
    activityListCount: result.activityListCount || 0,
    rowCount: result.rows?.length || 0,
  };
}

await main();
