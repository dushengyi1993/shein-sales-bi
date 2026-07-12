/**
 * Audit actual order goods-line prices against the marketing price plan.
 *
 * Invariant:
 * - Actual sales/order income evidence comes only from browser order goods rows:
 *   goodsRows[].currencyPrice.
 * - Non-browser sources and precomputed daily aggregates are not used as truth
 *   sources here.
 *
 * This script is read-only. It writes only local audit JSON/CSV files.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isValidSalesGoodsRow, salesExclusionReason} from '../../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_PLAN = path.join(ROOT, 'tmp', 'marketing-signup', 'price-overrides-2026-06-03-ALL-ready.json');
const DEFAULT_SALES_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'order-price-audit');
const DEFAULT_LINKS_DATA = path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json');

function parseArgs(argv) {
  const out = {
    plan: DEFAULT_PLAN,
    salesDirs: [DEFAULT_SALES_DIR],
    stores: [],
    start: '',
    end: '',
    date: '',
    outDir: DEFAULT_OUT_DIR,
    toleranceSar: 0.01,
    priceGrain: 'auto',
    includeMatches: false,
    linksData: '',
    planStartTime: '',
    planEndTime: '',
    requirePlanWindow: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--plan' || a === '--price-plan') out.plan = path.resolve(argv[++i]);
    else if (a === '--sales-dir') out.salesDirs = splitList(argv[++i]).map(p => path.resolve(p));
    else if (a === '--add-sales-dir') out.salesDirs.push(...splitList(argv[++i]).map(p => path.resolve(p)));
    else if (a === '--stores') out.stores.push(...splitList(argv[++i]).map(s => s.toUpperCase()));
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--out-dir') out.outDir = path.resolve(argv[++i]);
    else if (a === '--tolerance-sar') out.toleranceSar = Number(argv[++i]);
    else if (a === '--price-grain') out.priceGrain = String(argv[++i] || '').toLowerCase();
    else if (a === '--plan-start-time') out.planStartTime = argv[++i];
    else if (a === '--plan-end-time') out.planEndTime = argv[++i];
    else if (a === '--require-plan-window') out.requirePlanWindow = true;
    else if (a === '--include-matches') out.includeMatches = true;
    else if (a === '--links-data') out.linksData = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/marketing/audit_order_prices_against_plan.mjs --date 2026-06-05 --stores YJ
  node scripts/marketing/audit_order_prices_against_plan.mjs --sales-dir tmp/yj-13015-sales-refetch-20260605 --date 2026-06-05 --stores YJ

Options:
  --price-grain auto|unit|line  Default auto. auto compares quantity=1 rows only; quantity>1 rows are grain_unknown.
  --plan-start-time TIME        Optional activity effective start, e.g. "2026-06-12 16:00:00".
  --plan-end-time TIME          Optional activity effective end.
  --require-plan-window         Refuse to run without both plan start/end times.
  --tolerance-sar N             Default 0.01 SAR.
  --include-matches             Include match rows in output, not only actionable rows.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (out.date) {
    out.start = out.date;
    out.end = out.date;
  }
  if (out.start && !out.end) out.end = out.start;
  if (out.end && !out.start) out.start = out.end;
  if (!['auto', 'unit', 'line'].includes(out.priceGrain)) {
    throw new Error('--price-grain must be auto, unit, or line');
  }
  if (out.requirePlanWindow && (!out.planStartTime || !out.planEndTime)) {
    throw new Error('--require-plan-window needs both --plan-start-time and --plan-end-time');
  }
  if (!Number.isFinite(out.toleranceSar) || out.toleranceSar < 0) out.toleranceSar = 0.01;
  out.stores = [...new Set(out.stores)];
  out.salesDirs = [...new Set(out.salesDirs)];
  return out;
}

function splitList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function ymdFromFile(file) {
  const name = path.basename(file, '.json');
  return /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : '';
}

function inDateRange(date, args) {
  if (!date) return !args.start && !args.end;
  if (args.start && date < args.start) return false;
  if (args.end && date > args.end) return false;
  return true;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writeCsv(file, rows) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const columns = [
    'status',
    'storeKey',
    'date',
    'orderNo',
    'orderTime',
    'goodsSn',
    'skc',
    'quantity',
    'currencyPrice',
    'actualUnitPrice',
    'finalTargetPrice',
    'deltaSar',
    'deltaPct',
    'planWindowStatus',
    'activityId',
    'planStartTime',
    'planEndTime',
    'planSelectionReason',
    'canonical',
    'combo',
    'sourceFile',
    'reason',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => csvCell(row[col])).join(','));
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

async function listJsonFiles(dir) {
  const out = [];
  if (!fssync.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fs.readdir(current, {withFileTypes: true});
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
  }
  return out.sort();
}

function planKey(storeKey, skc) {
  return `${String(storeKey || '').toUpperCase()}|${String(skc || '').trim()}`;
}

function itemPlanStartTime(item) {
  return item.planStartTime || item.activityStartTime || item.eventStart || item.startTime || '';
}

function itemPlanEndTime(item) {
  return item.planEndTime || item.activityEndTime || item.eventEnd || item.endTime || '';
}

function unwrapBiLinksData(doc) {
  if (!doc || typeof doc !== 'object') return {};
  return doc.data && typeof doc.data === 'object' ? doc.data : doc;
}

function linkTargetItemsFromLinksData(doc) {
  const data = unwrapBiLinksData(doc);
  const rows = [
    ...(Array.isArray(data.storeLinks) ? data.storeLinks : []),
    ...(Array.isArray(data.links) ? data.links : []),
  ];
  return rows.map(row => ({
    storeKey: row.store_key || row.storeKey || row.store,
    skc: row.skc || row.SKC,
    activityId: row.marketing_activity_id || '',
    canonical: row.standard_goods_sn || row.standardGoodsSn || row.canonical || row.raw_goods_sn || '',
    targetPrice: row.marketing_suggested_ordinary_price_sar ?? row.targetPrice ?? row.marketing_final_target_price_sar,
    finalTargetPrice: row.marketing_final_target_price_sar ?? row.marketing_final_target_price ?? row.finalTargetPrice,
    couponFactor: row.marketing_coupon_factor ?? row.couponFactor ?? '',
    combo: row.marketing_ordinary_summary || row.marketing_coupon_summary || '',
    source: 'linksData_exact_store_skc_current_target',
    planStartTime: '',
    planEndTime: '',
    sourcePriority: 0,
  })).filter(row => row.storeKey && row.skc && Number.isFinite(Number(row.finalTargetPrice)) && Number(row.finalTargetPrice) > 0);
}

function loadPlanItems(plan, linkTargetItems = []) {
  const byKey = new Map();
  const byBaseKey = new Map();
  const duplicateConflicts = new Map();
  const linkTargetByBaseKey = new Map(linkTargetItems.map(item => [planKey(item.storeKey, item.skc), item]));
  for (const sourceItem of (plan.items || [])) {
    const baseKeyForOverlay = planKey(sourceItem.storeKey, sourceItem.skc);
    const sourcePlanStartTime = itemPlanStartTime(sourceItem);
    const sourcePlanEndTime = itemPlanEndTime(sourceItem);
    const hasApprovedPlanWindow = Number.isFinite(parseTimeMs(sourcePlanStartTime))
      && Number.isFinite(parseTimeMs(sourcePlanEndTime));
    const linkTarget = hasApprovedPlanWindow
      ? null
      : (linkTargetByBaseKey.get(baseKeyForOverlay) || null);
    const item = linkTarget
      ? {
          ...sourceItem,
          ...linkTarget,
          activityId: sourceItem.activityId ?? linkTarget.activityId ?? '',
          planStartTime: sourcePlanStartTime,
          planEndTime: sourcePlanEndTime,
          source: 'price_overrides_plan_with_linksData_exact_store_skc_target',
        }
      : sourceItem;
    const storeKey = String(item.storeKey || '').toUpperCase();
    const skc = String(item.skc || '').trim();
    const target = Number(item.finalTargetPrice ?? item.targetPrice);
    if (!storeKey || !skc || !Number.isFinite(target) || target <= 0) continue;
    const baseKey = planKey(storeKey, skc);
    const planStartTime = itemPlanStartTime(item);
    const planEndTime = itemPlanEndTime(item);
    const key = `${baseKey}|${planStartTime}|${planEndTime}|${String(item.activityId ?? '')}`;
    const normalized = {
      storeKey,
      skc,
      activityId: item.activityId ?? '',
      canonical: item.canonical || '',
      targetPrice: Number(item.targetPrice ?? target),
      finalTargetPrice: target,
      couponFactor: item.couponFactor ?? '',
      combo: item.combo || '',
      source: item.source || '',
      sourcePriority: Number(item.sourcePriority ?? 50),
      planStartTime,
      planEndTime,
      planStartMs: parseTimeMs(planStartTime),
      planEndMs: parseTimeMs(planEndTime),
    };
    if (byKey.has(key)) {
      const prev = byKey.get(key);
      if (round2(prev.finalTargetPrice) !== round2(normalized.finalTargetPrice)) {
        if (!duplicateConflicts.has(key)) duplicateConflicts.set(key, [prev]);
        duplicateConflicts.get(key).push(normalized);
      }
    } else {
      byKey.set(key, normalized);
      if (!byBaseKey.has(baseKey)) byBaseKey.set(baseKey, []);
      byBaseKey.get(baseKey).push(normalized);
    }
  }
  for (const item of linkTargetItems) {
    const baseKey = planKey(item.storeKey, item.skc);
    if (byBaseKey.has(baseKey)) continue;
    const storeKey = String(item.storeKey || '').toUpperCase();
    const skc = String(item.skc || '').trim();
    const target = Number(item.finalTargetPrice ?? item.targetPrice);
    if (!storeKey || !skc || !Number.isFinite(target) || target <= 0) continue;
    const planStartTime = itemPlanStartTime(item);
    const planEndTime = itemPlanEndTime(item);
    const key = `${baseKey}|${planStartTime}|${planEndTime}|${String(item.activityId ?? '')}`;
    const normalized = {
      storeKey,
      skc,
      activityId: item.activityId ?? '',
      canonical: item.canonical || '',
      targetPrice: Number(item.targetPrice ?? target),
      finalTargetPrice: target,
      couponFactor: item.couponFactor ?? '',
      combo: item.combo || '',
      source: item.source || '',
      sourcePriority: Number(item.sourcePriority ?? 50),
      planStartTime,
      planEndTime,
      planStartMs: parseTimeMs(planStartTime),
      planEndMs: parseTimeMs(planEndTime),
    };
    byKey.set(key, normalized);
    byBaseKey.set(baseKey, [normalized]);
  }
  for (const rows of byBaseKey.values()) {
    rows.sort((a, b) => Number(a.sourcePriority ?? 50) - Number(b.sourcePriority ?? 50));
  }
  return {byKey, byBaseKey, duplicateConflicts};
}

function inferStoreFromPath(file) {
  const parts = file.split(/[\\/]/);
  const idx = parts.findIndex(p => p === 'shein_fetch' || p.includes('sales-refetch'));
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].toUpperCase();
  const parent = path.basename(path.dirname(file));
  return /^[A-Za-z0-9]{1,6}$/.test(parent) ? parent.toUpperCase() : '';
}

function rowTime(row) {
  return row.allocateTimeFull || row.allocateTime || row.orderCreateTime || row.orderCustomerTime || '';
}

function parseTimeMs(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

function planWindowStatus(orderTime, context) {
  const startMs = parseTimeMs(context.planStartTime);
  const endMs = parseTimeMs(context.planEndTime);
  if (startMs === null && endMs === null) return 'not_configured';
  const orderMs = parseTimeMs(orderTime);
  if (orderMs === null) return 'order_time_unparseable';
  if (startMs !== null && orderMs < startMs) return 'before_plan_window';
  if (endMs !== null && orderMs > endMs) return 'after_plan_window';
  return 'inside_plan_window';
}

function planItemWindowStatus(orderTime, plan) {
  if (plan.planStartMs === null && plan.planEndMs === null) return 'not_configured';
  const orderMs = parseTimeMs(orderTime);
  if (orderMs === null) return 'order_time_unparseable';
  if (plan.planStartMs !== null && orderMs < plan.planStartMs) return 'before_plan_window';
  if (plan.planEndMs !== null && orderMs > plan.planEndMs) return 'after_plan_window';
  return 'inside_plan_window';
}

function selectPlanForOrder(candidates, orderTime, context) {
  if (!candidates?.length) return {status: 'missing_plan', plan: null};
  const withWindows = candidates.filter(plan => plan.planStartMs !== null || plan.planEndMs !== null);
  if (!withWindows.length) {
    const legacyStatus = planWindowStatus(orderTime, context);
    if (legacyStatus !== 'not_configured' && legacyStatus !== 'inside_plan_window') {
      return {status: 'outside_plan_window', plan: candidates[0], reason: legacyStatus};
    }
    if (candidates.length > 1) {
      const targets = new Set(candidates.map(plan => round2(plan.finalTargetPrice)));
      if (targets.size > 1) return {status: 'ambiguous_plan', plan: null, reason: 'multiple windowless plan items have different finalTargetPrice'};
    }
    return {status: 'selected', plan: candidates[0], reason: legacyStatus};
  }
  const orderMs = parseTimeMs(orderTime);
  if (orderMs === null) {
    return {status: 'missing_order_time_for_plan_window', plan: withWindows[0], reason: 'order_time_unparseable'};
  }
    const active = withWindows.filter(plan => planItemWindowStatus(orderTime, plan) === 'inside_plan_window');
    if (!active.length) return {status: 'outside_plan_window', plan: withWindows[0], reason: 'no_plan_item_active_for_order_time'};
  active.sort((a, b) => {
    const priorityDiff = Number(a.sourcePriority ?? 50) - Number(b.sourcePriority ?? 50);
    if (priorityDiff) return priorityDiff;
    const targetDiff = Number(a.finalTargetPrice) - Number(b.finalTargetPrice);
    if (targetDiff) return targetDiff;
    return String(a.activityId || '').localeCompare(String(b.activityId || ''));
  });
  return {
    status: 'selected',
    plan: active[0],
    reason: active.length > 1 ? 'multiple_active_plan_items_use_lowest_finalTargetPrice' : 'active_plan_item_window',
    activeCandidateCount: active.length,
  };
}

function classifyRow(row, context) {
  const quantity = Number(row.number ?? row.quantity ?? 0);
  const currencyPrice = Number(row.currencyPrice);
  const base = {
    storeKey: context.storeKey,
    date: context.date,
    sourceFile: context.sourceFile,
    orderNo: row.orderNo || row.billno || row.orderId || '',
    orderTime: rowTime(row),
    goodsSn: row.goodsSn || row.skuSn || row.skuCode || '',
    skc: row.skcName || row.skc || '',
    quantity,
    currencyPrice: Number.isFinite(currencyPrice) ? currencyPrice : null,
    actualUnitPrice: null,
    finalTargetPrice: null,
    deltaSar: null,
    deltaPct: null,
    planWindowStatus: 'not_configured',
    canonical: '',
    combo: '',
    reason: '',
  };

  if (!Number.isFinite(currencyPrice) || currencyPrice <= 0) {
    return {...base, status: 'missing_currencyPrice', reason: 'goods row has no positive currencyPrice'};
  }
  if (!isValidSalesGoodsRow(row)) {
    return {...base, status: 'excluded_sale_row', reason: salesExclusionReason(row) || 'not a valid positive sales row'};
  }
  if (!base.skc) {
    return {...base, status: 'missing_skc', reason: 'goods row has no skcName/skc'};
  }

  const baseKey = planKey(context.storeKey, base.skc);
  const candidates = context.planByBaseKey.get(baseKey) || [];
  if (!candidates.length) {
    return {...base, status: 'missing_plan', reason: 'no plan item for store+skc'};
  }
  const selected = selectPlanForOrder(candidates, base.orderTime, context);
  if (selected.status !== 'selected') {
    return {...base, status: selected.status, reason: selected.reason || selected.status};
  }
  const plan = selected.plan;

  base.finalTargetPrice = round2(plan.finalTargetPrice);
  base.canonical = plan.canonical;
  base.combo = plan.combo;
  base.planWindowStatus = planItemWindowStatus(base.orderTime, plan);
  base.activityId = plan.activityId;
  base.planStartTime = plan.planStartTime || context.planStartTime || '';
  base.planEndTime = plan.planEndTime || context.planEndTime || '';
  base.planSelectionReason = selected.reason || '';

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return {...base, status: 'missing_quantity', reason: 'goods row has no positive quantity'};
  }
  if (context.priceGrain === 'auto' && quantity !== 1) {
    return {...base, status: 'grain_unknown', reason: 'quantity > 1 and price grain is not explicitly set'};
  }
  const actualUnitPrice = context.priceGrain === 'line' ? currencyPrice / quantity : currencyPrice;
  base.actualUnitPrice = round2(actualUnitPrice);
  base.deltaSar = round2(actualUnitPrice - plan.finalTargetPrice);
  base.deltaPct = plan.finalTargetPrice ? round4(base.deltaSar / plan.finalTargetPrice) : null;
  if (base.planWindowStatus !== 'not_configured' && base.planWindowStatus !== 'inside_plan_window') {
    return {...base, status: 'outside_plan_window', reason: base.planWindowStatus};
  }
  if (base.deltaSar < -context.toleranceSar) return {...base, status: 'below_target'};
  if (base.deltaSar > context.toleranceSar) return {...base, status: 'above_target'};
  return {...base, status: 'match'};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = await readJson(args.plan);
  const linksDataPath = args.linksData || (fssync.existsSync(DEFAULT_LINKS_DATA) ? DEFAULT_LINKS_DATA : '');
  const linksData = linksDataPath ? await readJson(linksDataPath).catch(() => null) : null;
  const linkTargetItems = linkTargetItemsFromLinksData(linksData);
  const {byKey: planByKey, byBaseKey: planByBaseKey, duplicateConflicts} = loadPlanItems(plan, linkTargetItems);
  const allRows = [];
  const files = [];
  for (const dir of args.salesDirs) {
    files.push(...await listJsonFiles(dir));
  }
  const seenFiles = new Set();
  for (const file of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const date = ymdFromFile(file);
    if (!inDateRange(date, args)) continue;
    let data;
    try {
      data = await readJson(file);
    } catch {
      continue;
    }
    if (!Array.isArray(data.goodsRows)) continue;
    const storeKey = String(data.storeKey || inferStoreFromPath(file)).toUpperCase();
    if (args.stores.length && !args.stores.includes(storeKey)) continue;
    const context = {
      storeKey,
      date: date || data.start || data.date || '',
      sourceFile: path.relative(ROOT, file).replace(/\\/g, '/'),
      planByKey,
      planByBaseKey,
      toleranceSar: args.toleranceSar,
      priceGrain: args.priceGrain,
      planStartTime: args.planStartTime,
      planEndTime: args.planEndTime,
    };
    for (const row of data.goodsRows) {
      const audit = classifyRow(row, context);
      if (args.includeMatches || audit.status !== 'match') allRows.push(audit);
    }
  }

  const actionable = allRows.filter(row => row.status !== 'match' && row.status !== 'excluded_sale_row');
  const summary = {
    createdAt: new Date().toISOString(),
    plan: path.relative(ROOT, args.plan).replace(/\\/g, '/'),
    salesDirs: args.salesDirs.map(dir => path.relative(ROOT, dir).replace(/\\/g, '/')),
    stores: args.stores,
    start: args.start || null,
    end: args.end || null,
    toleranceSar: args.toleranceSar,
    priceGrain: args.priceGrain,
    planStartTime: args.planStartTime || null,
    planEndTime: args.planEndTime || null,
    warnings: args.planStartTime || args.planEndTime ? [] : ['plan window is not configured; deviations are raw comparisons, not proof that a plan was active'],
    duplicatePlanConflictCount: duplicateConflicts.size,
    linksData: linksDataPath ? path.relative(ROOT, linksDataPath).replace(/\\/g, '/') : null,
    linkTargetRows: linkTargetItems.length,
    filesScanned: seenFiles.size,
    rowsReturned: allRows.length,
    actionableRows: actionable.length,
    statusCounts: countBy(allRows, row => row.status),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = args.stores.length ? args.stores.join('-') : 'ALL';
  const jsonPath = path.join(args.outDir, `order-price-audit-${suffix}-${stamp}.json`);
  const csvPath = path.join(args.outDir, `order-price-audit-${suffix}-${stamp}.csv`);
  await writeJson(jsonPath, {summary, rows: allRows});
  await writeCsv(csvPath, allRows);
  console.log(JSON.stringify({
    ok: true,
    summary,
    json: path.relative(ROOT, jsonPath).replace(/\\/g, '/'),
    csv: path.relative(ROOT, csvPath).replace(/\\/g, '/'),
    sample: actionable.slice(0, 20),
  }, null, 2));
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

await main();
