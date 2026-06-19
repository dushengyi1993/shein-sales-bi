#!/usr/bin/env node
/**
 * Export a compact, non-secret marketing price lead snapshot for BI 主系统.
 *
 * The source artifacts under tmp/mbrs and tmp/marketing-signup are operational
 * outputs and are intentionally not committed. BI only needs a bounded
 * store+SKC price-evidence snapshot, so this script extracts that lifecycle
 * evidence into outputs/bi-portal/marketing-price-leads.json.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = {
    sourceRoot: ROOT,
    out: path.join(ROOT, 'outputs', 'bi-portal', 'marketing-price-leads.json'),
    maxOverrideFiles: 80,
    keepExistingOnEmpty: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source-root') args.sourceRoot = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--max-override-files') args.maxOverrideFiles = Number(argv[++i] || args.maxOverrideFiles);
    else if (a === '--allow-empty-overwrite') args.keepExistingOnEmpty = false;
  }
  return args;
}

function sanitizeText(value) {
  return String(value ?? '').replace(/\uFFFD+/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, '').trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function keyFor(storeKey, skc) {
  const store = sanitizeText(storeKey).toUpperCase();
  const id = sanitizeText(skc);
  return store && id ? `${store}__${id}` : '';
}

function evidenceTypeLooksCurrent(type, kind) {
  const text = String(type || '');
  if (kind === 'ordinary') return /current_ordinary_marketing_live_scan|active_ordinary|active_activity|current_activity|current_marketing/i.test(text);
  if (kind === 'limited') return /current_limited_discount_live_scan|active_limited_discount_live_scan|active_limited|current_discount/i.test(text);
  return false;
}

function normalizeLeadCurrentFlags(lead) {
  const next = {...lead};
  const type = next.marketing_price_evidence_type;
  if (next.marketing_suggested_ordinary_price_sar != null && evidenceTypeLooksCurrent(type, 'ordinary')) {
    next.marketing_ordinary_price_is_current = true;
  }
  if (next.marketing_limited_discount_price_sar != null && evidenceTypeLooksCurrent(type, 'limited')) {
    next.marketing_limited_discount_is_current = true;
  }
  return next;
}

function compactLead(lead) {
  const normalized = normalizeLeadCurrentFlags(lead);
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => {
    if (value == null) return false;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    return String(value).trim() !== '';
  }));
}

function mergeLead(map, lead) {
  const key = keyFor(lead.store_key, lead.skc);
  if (!key) return;
  const previous = map.get(key);
  const next = compactLead(lead);
  if (!previous) {
    map.set(key, {
      ...next,
      marketing_price_evidence_count: 1,
    });
    return;
  }
  const prevRank = Number(previous.marketing_price_source_rank || 0);
  const nextRank = Number(next.marketing_price_source_rank || 0);
  const prevAt = String(previous.marketing_price_source_at || '');
  const nextAt = String(next.marketing_price_source_at || '');
  const useNextPrimary = nextRank > prevRank || (nextRank === prevRank && nextAt >= prevAt);
  map.set(key, {
    ...(useNextPrimary ? previous : next),
    ...(useNextPrimary ? next : previous),
    marketing_price_evidence_count: Number(previous.marketing_price_evidence_count || 1) + 1,
  });
}

async function latestStackReviewDir(root) {
  const base = path.join(root, 'tmp', 'mbrs');
  let entries = [];
  try {
    entries = await fs.readdir(base, {withFileTypes: true});
  } catch {
    return null;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^marketing-stack-review-/i.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    const stat = await statOrNull(dir);
    if (stat) dirs.push({dir, stat});
  }
  dirs.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.dir.localeCompare(a.dir));
  return dirs[0] || null;
}

async function collectStackReview(root, map, sources) {
  const latest = await latestStackReviewDir(root);
  if (!latest) return;
  const names = (await fs.readdir(latest.dir)).filter(name => /^store-[A-Z0-9]+\.json$/i.test(name));
  let count = 0;
  for (const name of names) {
    const file = path.join(latest.dir, name);
    const doc = await readJsonOrNull(file);
    const rows = Array.isArray(doc?.rows) ? doc.rows : [];
    count += rows.length;
    for (const row of rows) {
      mergeLead(map, {
        store_key: row['店铺'] || doc?.store,
        skc: row['SKC'],
        standard_goods_sn: row['标准货号'] || row['供方货号'] || '',
        marketing_current_price_sar: numberOrNull(row['当前售价SAR']),
        marketing_current_price_source: row['价格字段来源'] || '',
        marketing_suggested_ordinary_price_sar: numberOrNull(row['本次建议普通活动价SAR']),
        marketing_suggested_ordinary_discount_pct: numberOrNull(row['本次建议普通活动折扣%']),
        marketing_ordinary_summary: row['普通营销活动价/折扣'] || '',
        marketing_limited_discount_name: row['限时折扣名称'] || '',
        marketing_limited_discount_price_sar: numberOrNull(row['限时折扣价SAR']),
        marketing_lowest_base_price_sar: numberOrNull(row['最低促销基准价SAR']),
        marketing_final_stack_price_sar: numberOrNull(row['叠加后最终成交价SAR']),
        marketing_coupon_summary: row['优惠券活动ID/名称'] || row['优惠券券档/风险折扣'] || '',
        marketing_activity_id: row['活动ID'] || '',
        marketing_activity_name: row['活动名称'] || '',
        marketing_signup_deadline: row['报名截止'] || '',
        marketing_activity_start: row['普通活动开始'] || '',
        marketing_activity_end: row['普通活动结束'] || '',
        marketing_price_note: row['风险提示'] || row['修改意见/备注'] || '',
        marketing_price_source_file: rel(root, file),
        marketing_price_source_at: doc?.finishedAt || doc?.createdAt || latest.stat.mtime.toISOString(),
        marketing_price_evidence_type: 'marketing_stack_review',
        marketing_price_source_rank: 20,
      });
    }
  }
  sources.push({
    type: 'marketing_stack_review',
    dir: rel(root, latest.dir),
    files: names.length,
    rows: count,
    updatedAt: latest.stat.mtime.toISOString(),
  });
}

async function listRecursive(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listRecursive(full, predicate, out);
    else if (!predicate || predicate(full, entry.name)) {
      const stat = await statOrNull(full);
      if (stat) out.push({file: full, stat});
    }
  }
  return out;
}


function parseDateMs(value) {
  const s = sanitizeText(value);
  if (!s) return NaN;
  const ms = Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : '+08:00'));
  return Number.isFinite(ms) ? ms : NaN;
}

function isActiveWindow(start, end, nowMs = Date.now()) {
  const s = parseDateMs(start);
  const e = parseDateMs(end);
  if (Number.isFinite(s) && nowMs < s) return false;
  if (Number.isFinite(e) && nowMs > e) return false;
  return Number.isFinite(s) || Number.isFinite(e);
}

async function collectLiveCouponLimitedScans(root, map, sources) {
  const base = path.join(root, 'tmp', 'marketing-signup', 'coupon-low-price-overlap');
  const files = await listRecursive(base, (file, name) => /^coupon-low-price-overlap-.*\.json$/i.test(name));
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let scannedFiles = 0;
  let rows = 0;
  const nowMs = Date.now();
  for (const item of files.slice(0, 12)) {
    const doc = await readJsonOrNull(item.file);
    const riskRows = Array.isArray(doc?.riskRows) ? doc.riskRows : (Array.isArray(doc?.rows) ? doc.rows : []);
    if (!riskRows.length) continue;
    scannedFiles += 1;
    rows += riskRows.length;
    for (const row of riskRows) {
      const activeLimited = isActiveWindow(row.limitedDiscountStart, row.limitedDiscountEnd, nowMs);
      const limitedPrice = numberOrNull(row.limitedDiscountPrice);
      const couponFactor = numberOrNull(row.couponFactor || row.planCouponFactor);
      mergeLead(map, {
        store_key: row.storeKey || row.store_key,
        skc: row.skc,
        standard_goods_sn: row.canonical || row.standard_goods_sn || row.supplierNo || '',
        marketing_limited_discount_price_sar: activeLimited ? limitedPrice : null,
        marketing_limited_discount_name: row.limitedDiscountName || '',
        marketing_limited_discount_start: row.limitedDiscountStart || '',
        marketing_limited_discount_end: row.limitedDiscountEnd || '',
        marketing_coupon_factor: row.hasActiveCoupon ? couponFactor : null,
        marketing_coupon_summary: row.hasActiveCoupon ? `${Math.round((1 - (couponFactor || 1)) * 100)}%券` : '',
        marketing_price_note: row.riskReason || row.priceDecision || '',
        marketing_price_source_file: rel(root, item.file),
        marketing_price_source_at: doc?.createdAt || item.stat.mtime.toISOString(),
        marketing_price_evidence_type: activeLimited ? 'active_limited_discount_live_scan' : 'limited_discount_live_scan_not_current',
        marketing_price_source_rank: activeLimited ? 60 : 18,
      });
    }
  }
  if (scannedFiles) {
    sources.push({
      type: 'live_coupon_limited_scan',
      files: scannedFiles,
      rows,
      updatedAt: files[0].stat.mtime.toISOString(),
      newestFile: rel(root, files[0].file),
      note: 'read-only scan artifacts only; active windows can feed BI discount price, future/expired rows remain hints',
    });
  }
}


function isCurrentWindow(start, end, nowMs = Date.now()) {
  const s = parseDateMs(start);
  const e = parseDateMs(end);
  if (Number.isFinite(s) && nowMs < s) return false;
  if (Number.isFinite(e) && nowMs > e) return false;
  return Number.isFinite(s) || Number.isFinite(e);
}

function normalizeLivePriceRows(doc) {
  const rows = [];
  const pushRows = value => {
    if (Array.isArray(value)) rows.push(...value);
  };
  pushRows(doc?.rows);
  pushRows(doc?.priceRows);
  pushRows(doc?.livePriceRows);
  pushRows(doc?.ordinaryRows);
  pushRows(doc?.limitedRows);
  for (const store of doc?.stores || []) {
    pushRows(store?.rows);
    pushRows(store?.livePriceRows);
    pushRows(store?.ordinaryRows);
    pushRows(store?.limitedRows);
    for (const risk of store?.risks || []) rows.push({...risk, storeKey: risk.storeKey || store.storeKey || store.store});
  }
  return rows;
}

function liveRowStore(row, doc) {
  return row.store_key || row.storeKey || row.store || doc?.store || doc?.storeKey || '';
}
function liveRowSkc(row) {
  return row.skc || row.SKC || row.skcName || row.skc_name || '';
}
function liveRowStandard(row) {
  return row.standard_goods_sn || row.standardGoodsSn || row.canonical || row.supplierNo || row.supplier_no || row.sku_supplier_no || '';
}
function liveRowCouponSummary(row) {
  const factor = numberOrNull(row.marketing_coupon_factor ?? row.couponFactor ?? row.planCouponFactor);
  if ((row.hasActiveCoupon === true || row.activeCoupon === true || row.couponActive === true || row.authorizedCurrentPlan === true) && factor && factor > 0 && factor < 1) {
    return `${Math.round((1 - factor) * 100)}%券`;
  }
  return row.marketing_coupon_summary || row.couponSummary || row.couponName || row.couponActivityName || '';
}

async function collectCurrentLivePriceEvidence(root, map, sources) {
  const bases = [
    path.join(root, 'tmp', 'marketing-signup'),
    path.join(root, 'tmp', 'mbrs'),
    path.join(root, 'outputs', 'bi-portal'),
  ];
  const files = [];
  for (const base of bases) {
    files.push(...await listRecursive(base, (file, name) => /(?:current|active|live).*(?:price|ordinary|limited|coupon).*\.json$/i.test(name) || /(?:ordinary|limited).*live.*\.json$/i.test(name), []));
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const nowMs = Date.now();
  let scannedFiles = 0;
  let inputRows = 0;
  let activeRows = 0;
  for (const item of files.slice(0, 120)) {
    const doc = await readJsonOrNull(item.file);
    const rows = normalizeLivePriceRows(doc);
    if (!rows.length) continue;
    scannedFiles += 1;
    inputRows += rows.length;
    for (const row of rows) {
      const store = liveRowStore(row, doc);
      const skc = liveRowSkc(row);
      if (!store || !skc) continue;
      const ordinaryStart = row.marketing_activity_start || row.ordinaryMarketingStart || row.ordinaryActivityStart || row.activityStart || row.startTime || row.start_time || '';
      const ordinaryEnd = row.marketing_activity_end || row.ordinaryMarketingEnd || row.ordinaryActivityEnd || row.activityEnd || row.endTime || row.end_time || '';
      const limitedStart = row.marketing_limited_discount_start || row.limitedDiscountStart || row.limitedStartTime || row.startTime || row.start_time || '';
      const limitedEnd = row.marketing_limited_discount_end || row.limitedDiscountEnd || row.limitedEndTime || row.endTime || row.end_time || '';
      const ordinaryPrice = numberOrNull(row.marketing_suggested_ordinary_price_sar ?? row.ordinaryMarketingPrice ?? row.ordinaryActivityPrice ?? row.activityPrice ?? row.product_act_price ?? row.attend_price);
      const limitedPrice = numberOrNull(row.marketing_limited_discount_price_sar ?? row.limitedDiscountPrice ?? row.limitedPrice ?? row.product_act_price);
      const ordinaryActive = ordinaryPrice !== null && isCurrentWindow(ordinaryStart, ordinaryEnd, nowMs);
      const limitedActive = limitedPrice !== null && isCurrentWindow(limitedStart, limitedEnd, nowMs);
      if (!ordinaryActive && !limitedActive) continue;
      activeRows += 1;
      const base = {
        store_key: store,
        skc,
        standard_goods_sn: liveRowStandard(row),
        marketing_coupon_summary: liveRowCouponSummary(row),
        marketing_coupon_factor: numberOrNull(row.marketing_coupon_factor ?? row.couponFactor ?? row.planCouponFactor),
        marketing_price_note: row.marketing_price_note || row.riskReason || row.reason || row.note || '',
        marketing_price_source_file: rel(root, item.file),
        marketing_price_source_at: doc?.generatedAt || doc?.createdAt || doc?.finishedAt || item.stat.mtime.toISOString(),
      };
      if (ordinaryActive) {
        mergeLead(map, {
          ...base,
          marketing_suggested_ordinary_price_sar: ordinaryPrice,
          marketing_ordinary_price_is_current: true,
          marketing_activity_id: row.marketing_activity_id || row.ordinaryMarketingActivityId || row.activityId || row.activity_id || '',
          marketing_activity_name: row.marketing_activity_name || row.ordinaryMarketingActivityName || row.activityName || row.act_name || '',
          marketing_activity_start: ordinaryStart,
          marketing_activity_end: ordinaryEnd,
          marketing_price_evidence_type: 'current_ordinary_marketing_live_scan',
          marketing_price_source_rank: 80,
        });
      }
      if (limitedActive) {
        mergeLead(map, {
          ...base,
          marketing_limited_discount_price_sar: limitedPrice,
          marketing_limited_discount_is_current: true,
          marketing_limited_discount_name: row.marketing_limited_discount_name || row.limitedDiscountName || row.activityName || row.act_name || '',
          marketing_limited_discount_start: limitedStart,
          marketing_limited_discount_end: limitedEnd,
          marketing_price_evidence_type: 'current_limited_discount_live_scan',
          marketing_price_source_rank: 82,
        });
      }
    }
  }
  if (scannedFiles) {
    sources.push({
      type: 'current_live_price_evidence',
      files: scannedFiles,
      rows: inputRows,
      activeRows,
      updatedAt: files[0].stat.mtime.toISOString(),
      newestFile: rel(root, files[0].file),
      note: 'read-only current live activity/limited-discount evidence; only active windows feed BI discount price',
    });
  }
}

async function collectPriceOverrides(root, map, sources, maxFiles) {
  const base = path.join(root, 'tmp', 'marketing-signup');
  const files = await listRecursive(base, (file, name) => /^price-overrides.*\.json$/i.test(name));
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let count = 0;
  for (const item of files.slice(0, maxFiles)) {
    const doc = await readJsonOrNull(item.file);
    const rows = Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc?.rows) ? doc.rows : []);
    count += rows.length;
    for (const row of rows) {
      mergeLead(map, {
        store_key: row.storeKey || row.store_key,
        skc: row.skc || row.SKC,
        standard_goods_sn: row.canonical || row.goodsSn || row.standard_goods_sn || '',
        marketing_current_price_sar: numberOrNull(row.currentPrice || row.current_price_sar),
        marketing_suggested_ordinary_price_sar: numberOrNull(row.ordinaryMarketingPrice || row.ordinaryActivityPrice || row.targetPrice || row.finalTargetPrice),
        marketing_final_target_price_sar: numberOrNull(row.finalTargetPrice || row.targetPrice),
        marketing_coupon_factor: numberOrNull(row.couponFactor),
        marketing_limited_discount_price_sar: numberOrNull(row.limitedDiscountPrice),
        marketing_activity_id: row.activityId || '',
        marketing_price_note: [row.combo, row.note, row.rule].filter(Boolean).join('；'),
        marketing_price_source_file: rel(root, item.file),
        marketing_price_source_at: doc?.createdAt || item.stat.mtime.toISOString(),
        marketing_price_evidence_type: 'price_overrides_plan',
        marketing_price_source_rank: 25,
      });
    }
  }
  if (files.length) {
    sources.push({
      type: 'price_overrides',
      files: Math.min(files.length, maxFiles),
      rows: count,
      updatedAt: files[0].stat.mtime.toISOString(),
      newestFile: rel(root, files[0].file),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const map = new Map();
  const sources = [];
  await collectStackReview(args.sourceRoot, map, sources);
  await collectLiveCouponLimitedScans(args.sourceRoot, map, sources);
  await collectCurrentLivePriceEvidence(args.sourceRoot, map, sources);
  await collectPriceOverrides(args.sourceRoot, map, sources, args.maxOverrideFiles);
  const rows = [...map.values()].sort((a, b) => String(a.store_key).localeCompare(String(b.store_key)) || String(a.skc).localeCompare(String(b.skc)));
  if (!rows.length && args.keepExistingOnEmpty) {
    const existing = await statOrNull(args.out);
    if (existing?.size > 0) {
      console.log(JSON.stringify({ok: true, skipped: true, reason: 'no marketing price evidence sources found; kept existing snapshot', out: args.out, existingBytes: existing.size}, null, 2));
      return;
    }
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceRoot: path.basename(args.sourceRoot),
    caveat: '来自最近一次活动扫描/报名价格栈产物；用于 BI 商品列表辅助判断，不等同于实时链接售价或最终成交价。',
    sources,
    rowCount: rows.length,
    rows,
  };
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({ok: true, out: args.out, rowCount: rows.length, sources}, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
