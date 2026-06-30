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
  hasOrdinaryMarketingEvidence,
  isRecentNewListingLink,
  loadMarketingPricingPolicy,
  unwrapBiLinksData,
} from '../../lib/marketing_pricing_policy.mjs';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';

const ROOT = process.cwd();
const DEFAULT_LINKS_DATA = path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json');
const DEFAULT_POLICY = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
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
const outDir = path.resolve(ROOT, args.outDir || path.join('tmp', 'marketing-signup', 'limited-discount-fallback', `new-listing-7d-${reportDate}`));
const reportJsonPath = path.resolve(ROOT, args.reportJson || path.join('outputs', 'reports', `new-listing-7d-limited-discount-plan-${reportDate}.json`));
const reportMdPath = path.resolve(ROOT, args.reportMd || path.join('outputs', 'reports', `new-listing-7d-limited-discount-plan-${reportDate}.md`));

const policy = await loadMarketingPricingPolicy(policyPath);
const durationDays = positiveInt(policy?.newListingWithin7Days?.limitedDiscount?.durationDays, 7);
const endTime = args.endTime || `${addDays(reportDate, durationDays)} 23:59:59`;
const activityNamePrefix = args.activityNamePrefix || policy?.newListingWithin7Days?.limitedDiscount?.activityNamePrefix || '新上架7天高曝光兜底限时折扣';

const linksDoc = await readJson(linksDataPath);
const priceDoc = await readJson(priceOverridesPath);
const linksData = unwrapBiLinksData(linksDoc);
const storeLinks = Array.isArray(linksData.storeLinks) ? linksData.storeLinks : [];
const priceIndex = buildPriceIndex(priceDoc);

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
  if (!recent.applies) continue;

  const canonical = normalizeCanonicalFromLink(link);
  const priceEvidence = findPriceEvidence(priceIndex, canonical);
  const currentLimitedPrice = numberOrNull(
    link.marketing_limited_discount_price_sar
    ?? link.marketing_limited_discount_price
    ?? link.limitedDiscountPrice,
  );
  const hasCurrentLimitedDiscount = (
    link.marketing_limited_discount_is_current === true
    || link.marketing_limited_discount_is_current === 1
    || link.marketing_limited_discount_is_current === '1'
    || currentLimitedPrice !== null
  );
  const common = {
    storeKey,
    skc,
    canonical,
    rawGoodsSn: link.raw_goods_sn || link.rawGoodsSn || '',
    supplierNo: link.raw_goods_sn || link.rawGoodsSn || canonical,
    shelfAgeDays: recent.shelfAgeDays,
    shelfAgeSource: recent.shelfAgeSource,
    c7EpsUv: numberOrNull(link.c7_eps_uv ?? link.c7EpsUv),
    c30EpsUv: numberOrNull(link.c30_eps_uv ?? link.c30EpsUv),
    currentPrice: numberOrNull(link.current_price_sar ?? link.currentPriceSar ?? link.current_price),
    currentLimitedPrice,
    hasCurrentLimitedDiscount,
    performanceActivityNames: link.performance_activity_names || '',
    firstShelfTime: link.first_shelf_time || '',
    ordinaryMarketingEvidence: hasOrdinaryMarketingEvidence(link),
  };
  if (!priceEvidence) {
    blocked.push({
      ...common,
      reason: 'missing_price_evidence_for_canonical',
      note: '最新最终版 price-overrides 中找不到该标准货号的曝光前五目标价，不能自动写限时折扣。',
    });
    continue;
  }
  if (!Number.isFinite(priceEvidence.topTierPrice) || priceEvidence.topTierPrice <= 0) {
    blocked.push({
      ...common,
      reason: 'missing_top_tier_price',
      priceEvidence,
      note: '该标准货号有普通目标价，但没有可继承的曝光前五目标价，不能自动套“前五力度”。',
    });
    continue;
  }
  const action = hasCurrentLimitedDiscount ? 'replace_existing_limited_discount' : 'create_limited_discount';
  rows.push({
    ...common,
    action,
    needsLimitedDiscount: true,
    limitedDiscountPrice: priceEvidence.topTierPrice,
    finalTargetPrice: priceEvidence.topTierPrice,
    targetPrice: priceEvidence.topTierPrice,
    expectedFinalNoCoupon: priceEvidence.topTierPrice,
    expectedFinalAfterLimitedAnd15Coupon: '',
    couponFactor: 1,
    originalPlannedFinalPrice: priceEvidence.topTierPrice,
    sourceRule: 'new_listing_within_7d_same_as_global_exposure_top5',
    combo: '新上架7天限时折扣兜底；不依赖优惠券',
    note: hasCurrentLimitedDiscount
      ? `新上架${recent.shelfAgeDays}天且未报普通活动，已有旧限时折扣 ${formatPrice(currentLimitedPrice)} SAR；按新规则取消/结束旧活动后重报一周，目标价按曝光前五力度 ${formatPrice(priceEvidence.topTierPrice)} SAR。`
      : `新上架${recent.shelfAgeDays}天且未报普通活动，缺限时折扣；按曝光前五力度 ${formatPrice(priceEvidence.topTierPrice)} SAR 报一周兜底。`,
    priceEvidence,
    endTime,
    activityNamePrefix,
  });
}

rows.sort(compareRows);
blocked.sort(compareRows);

await fs.mkdir(outDir, {recursive: true});
await fs.mkdir(path.dirname(reportJsonPath), {recursive: true});

const rescueFiles = [];
for (const [storeKey, storeRows] of groupBy(rows, row => row.storeKey).entries()) {
  const rescuePath = path.join(outDir, `new-listing-7d-limited-${storeKey}-${reportDate}.json`);
  const rescue = {
    createdAt: new Date().toISOString(),
    storeKey,
    purpose: `new_listing_within_7d_limited_discount_fallback_${reportDate}`,
    sourceLinksData: rel(linksDataPath),
    sourcePriceOverrides: rel(priceOverridesPath),
    pricingPolicy: rel(policyPath),
    endTime,
    activityNamePrefix,
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
      combo: row.combo,
      note: row.note,
      shelfAgeDays: row.shelfAgeDays,
      c7EpsUv: row.c7EpsUv,
      previousLimitedPrice: row.currentLimitedPrice,
      action: row.action,
    })),
  };
  await fs.writeFile(rescuePath, `${JSON.stringify(rescue, null, 2)}\n`, 'utf8');
  rescueFiles.push({storeKey, path: rel(rescuePath), count: storeRows.length, actions: countBy(storeRows, 'action')});
}

const summary = {
  createdAt: new Date().toISOString(),
  reportDate,
  sourceLinksData: rel(linksDataPath),
  sourceLinksGeneratedAt: linksDoc.generatedAt || linksData.generatedAt || '',
  sourcePriceOverrides: rel(priceOverridesPath),
  pricingPolicy: rel(policyPath),
  rule: {
    windowDays: Number(policy?.newListingWithin7Days?.windowDays || 7),
    pricingTreatment: policy?.newListingWithin7Days?.pricingTreatment || 'same_as_global_exposure_top5',
    durationDays,
    endTime,
    activityNamePrefix,
  },
  totals: {
    storeLinks: storeLinks.length,
    actionable: rows.length,
    createLimitedDiscount: rows.filter(row => row.action === 'create_limited_discount').length,
    replaceExistingLimitedDiscount: rows.filter(row => row.action === 'replace_existing_limited_discount').length,
    blocked: blocked.length,
    ignored: ignored.length,
  },
  byStore: countBy(rows, 'storeKey'),
  rescueFiles,
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

function buildPriceIndex(priceDoc) {
  const items = Array.isArray(priceDoc?.items) ? priceDoc.items : [];
  const byCanonical = new Map();
  for (const item of items) {
    const canonical = normalizeCanonicalFromValue(item.canonical || item.standardGoodsSn || item.standard_goods_sn || item.supplierNo || '');
    if (!canonical) continue;
    const key = canonicalKey(canonical);
    if (!byCanonical.has(key)) byCanonical.set(key, {canonical, items: []});
    byCanonical.get(key).items.push(item);
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
  return evidence;
}

function findPriceEvidence(index, canonical) {
  const key = canonicalKey(canonical);
  return index.get(key) || null;
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
  lines.push(`# 新上架 7 天限时折扣兜底计划 ${summary.reportDate}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 需要处理：${summary.totals.actionable} 个链接；其中新建限时折扣 ${summary.totals.createLimitedDiscount} 个，已有旧限时折扣需取消/结束后重报 ${summary.totals.replaceExistingLimitedDiscount} 个。`);
  lines.push(`- 阻断：${summary.totals.blocked} 个；主要是缺最新最终版曝光前五目标价或货号归并证据。`);
  lines.push(`- 限时折扣窗口：到 \`${summary.rule.endTime}\`；活动名前缀：\`${summary.rule.activityNamePrefix}\`。`);
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
    lines.push(`- ${row.storeKey} / \`${row.skc}\` / ${row.canonical}: ${row.action === 'create_limited_discount' ? '新建' : '取消旧折扣后重报'}，目标 ${formatPrice(row.limitedDiscountPrice)} SAR，上架 ${row.shelfAgeDays} 天，7天曝光 ${row.c7EpsUv ?? 0}。`);
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

function formatPrice(value) {
  const n = round2(value);
  return n === null ? '' : String(n);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

