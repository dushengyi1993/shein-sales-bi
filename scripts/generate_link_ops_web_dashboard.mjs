#!/usr/bin/env node
/**
 * Generate a local SHEIN operations cockpit.
 *
 * The page is intentionally independent from Feishu Base Dashboard. It reads:
 * - normalized link management JSON under outputs/shein_links
 * - daily sales JSON under outputs/shein_fetch
 *
 * Output:
 * - outputs/link-dashboard/index.html
 * - outputs/link-dashboard/link-ops-dashboard-YYYY-MM-DD.html
 * - outputs/link-dashboard/link-ops-dashboard-YYYY-MM-DD.json
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isValidSalesGoodsRow, salesAmountSar, salesQuantity, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const LINK_DIR = path.join(ROOT, 'outputs', 'shein_links');
const SALES_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const OUT_DIR = path.join(ROOT, 'outputs', 'link-dashboard');

const STORE_ORDER = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ'];
const HIGH = '高';
const MID = '中';
const LOW = '低';

function pad2(n) { return String(n).padStart(2, '0'); }
function bjNow(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600_000);
}
function bjDate(offsetDays = 0) {
  const bj = bjNow();
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}
function bjDateTime(date = new Date()) {
  const bj = bjNow(date);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())} ${pad2(bj.getHours())}:${pad2(bj.getMinutes())}:${pad2(bj.getSeconds())}`;
}
function monthOf(date) {
  return String(date || '').slice(0, 7);
}
function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function daysBetween(start, end) {
  const rows = [];
  for (let d = start; d <= end; d = addDays(d, 1)) rows.push(d);
  return rows;
}
function parseArgs(argv) {
  const args = {
    date: bjDate(-1),
    salesDate: bjDate(0),
    group: 'ALL',
    stores: null,
    focusLimit: 60,
    poolLimit: 700,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--sales-date') args.salesDate = argv[++i];
    else if (a === '--group') args.group = String(argv[++i] || 'ALL').toUpperCase();
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--store') args.stores = [String(argv[++i] || '').trim().toUpperCase()].filter(Boolean);
    else if (a === '--focus-limit') args.focusLimit = Math.max(1, Number(argv[++i] || 60));
    else if (a === '--pool-limit') args.poolLimit = Math.max(50, Number(argv[++i] || 700));
    // Backward compatibility with the first web action-list version.
    else if (a === '--max-actions-per-store') i += 1;
  }
  return args;
}
async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function readJsonIfExists(file) {
  try { return await readJson(file); }
  catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
function fileExists(file) {
  return fssync.existsSync(file);
}
function metric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function pct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', {maximumFractionDigits: 2});
}
function ratioChange(current, previous) {
  const c = metric(current, 0);
  const p = metric(previous, 0);
  if (!p && !c) return 0;
  if (!p && c) return 1;
  return (c - p) / p;
}
function shortTitle(value, limit = 54) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
function uniqueKey(...parts) {
  return parts.map(x => String(x ?? '').replace(/\s+/g, ' ').trim()).join('__');
}
function selectedStores(storesCfg, args) {
  const enabled = (storesCfg.stores || []).filter(s => s.enabled !== false).map(s => s.storeKey);
  if (args.stores?.length) return args.stores;
  if (args.group === 'ALL') return enabled;
  return storesCfg.groups?.[args.group] || enabled.filter(s => STORE_ORDER.includes(s));
}
function storeSort(a, b) {
  const ia = STORE_ORDER.indexOf(a);
  const ib = STORE_ORDER.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || String(a).localeCompare(String(b));
}

async function loadLinkObjects(args, storeKeys) {
  const objects = [];
  const missing = [];
  for (const storeKey of storeKeys) {
    const file = path.join(LINK_DIR, storeKey, `${args.date}.json`);
    const obj = await readJsonIfExists(file);
    if (!obj) {
      missing.push({storeKey, file});
      continue;
    }
    objects.push({storeKey, file, obj});
  }
  return {objects, missing};
}
async function loadSalesDay(storeKey, date) {
  const file = path.join(SALES_DIR, storeKey, `${date}.json`);
  const summaryFile = path.join(SALES_DIR, storeKey, `${date}_summary.json`);
  return {
    storeKey,
    date,
    detail: await readJsonIfExists(file),
    summary: await readJsonIfExists(summaryFile),
  };
}
async function loadSalesHistory(storeKeys, endDate, spanDays = 30) {
  const start = addDays(endDate, -(spanDays - 1));
  const dates = daysBetween(start, endDate);
  const byStoreDate = new Map();
  const rows = [];
  for (const storeKey of storeKeys) {
    for (const date of dates) {
      const day = await loadSalesDay(storeKey, date);
      byStoreDate.set(uniqueKey(storeKey, date), day);
      if (day.summary || day.detail) rows.push(day);
    }
  }
  return {start, end: endDate, dates, rows, byStoreDate};
}
async function readMonthlyReport(salesDate) {
  const month = monthOf(salesDate);
  const file = path.join(REPORT_DIR, `monthly-sales-${month}.json`);
  return await readJsonIfExists(file);
}

function buildLinkIndexes(objects, selectedStoreKeys) {
  const links = [];
  const performances = [];
  const inventories = [];
  const coverages = [];
  const suggestions = [];
  const perfByStoreSkc = new Map();
  const linkByStoreSkc = new Map();
  const invByStoreSkc = new Map();
  const coverageByStoreStandard = new Map();
  const storeStats = new Map();
  const standardStats = new Map();
  const standardStoreLinks = new Map();

  const ensureStore = storeKey => {
    if (!storeStats.has(storeKey)) {
      storeStats.set(storeKey, {
        storeKey,
        linkCount: 0,
        onShelf: 0,
        waitShelf: 0,
        soldOut: 0,
        outShelf: 0,
        hardDead: 0,
        performanceRows: 0,
        c7Sale: 0,
        c30Sale: 0,
        c30Exposure: 0,
      });
    }
    return storeStats.get(storeKey);
  };
  const ensureStandard = standardGoodsSn => {
    const key = standardGoodsSn || '未识别货号';
    if (!standardStats.has(key)) {
      standardStats.set(key, {
        standardGoodsSn: key,
        stores: new Set(),
        onShelfStores: new Set(),
        waitStores: new Set(),
        soldOutStores: new Set(),
        outStores: new Set(),
        linkCount: 0,
        onShelfCount: 0,
        waitShelfCount: 0,
        soldOutCount: 0,
        outShelfCount: 0,
        hardDeadCount: 0,
        c7Sale: 0,
        c30Sale: 0,
        c7Exposure: 0,
        c30Exposure: 0,
        c7Visitors: 0,
        c30Visitors: 0,
        sampleImage: '',
        sampleSkc: '',
        sampleTitle: '',
      });
    }
    return standardStats.get(key);
  };

  for (const {obj} of objects) {
    const storeKey = obj.store?.storeKey || '';
    ensureStore(storeKey);
    for (const row of obj.linkRows || []) {
      links.push(row);
      linkByStoreSkc.set(uniqueKey(row.storeKey || storeKey, row.skc), row);
      const st = ensureStore(row.storeKey || storeKey);
      const ss = ensureStandard(row.standardGoodsSn);
      st.linkCount += 1;
      ss.linkCount += 1;
      ss.stores.add(row.storeKey || storeKey);
      if (row.imageUrl && !ss.sampleImage) ss.sampleImage = row.imageUrl;
      if (row.skc && !ss.sampleSkc) ss.sampleSkc = row.skc;
      if ((row.productNameCn || row.productNameEn || row.saleName) && !ss.sampleTitle) {
        ss.sampleTitle = row.productNameCn || row.productNameEn || row.saleName;
      }
      const standardStoreKey = uniqueKey(row.standardGoodsSn, row.storeKey || storeKey);
      const bucket = standardStoreLinks.get(standardStoreKey) || [];
      bucket.push(row);
      standardStoreLinks.set(standardStoreKey, bucket);

      if (row.isOnShelf || row.shelfStatusName === '已上架') {
        st.onShelf += 1; ss.onShelfCount += 1; ss.onShelfStores.add(row.storeKey || storeKey);
      } else if (row.isWaitShelf || row.shelfStatusName === '待上架') {
        st.waitShelf += 1; ss.waitShelfCount += 1; ss.waitStores.add(row.storeKey || storeKey);
      } else if (row.isSoldOut || row.shelfStatusName === '已售罄') {
        st.soldOut += 1; ss.soldOutCount += 1; ss.soldOutStores.add(row.storeKey || storeKey);
      } else if (row.isOutShelf || row.shelfStatusName === '已下架') {
        st.outShelf += 1; ss.outShelfCount += 1; ss.outStores.add(row.storeKey || storeKey);
      }
      if (row.isHardDead) {
        st.hardDead += 1;
        ss.hardDeadCount += 1;
      }
    }
    for (const row of obj.performanceRows || []) {
      performances.push(row);
      perfByStoreSkc.set(uniqueKey(row.storeKey || storeKey, row.skc), row);
      const st = ensureStore(row.storeKey || storeKey);
      const ss = ensureStandard(row.standardGoodsSn);
      st.performanceRows += 1;
      st.c7Sale += metric(row.c7SaleCnt);
      st.c30Sale += metric(row.c30SaleCnt);
      st.c30Exposure += metric(row.c30EpsUv);
      ss.c7Sale += metric(row.c7SaleCnt);
      ss.c30Sale += metric(row.c30SaleCnt);
      ss.c7Exposure += metric(row.c7EpsUv);
      ss.c30Exposure += metric(row.c30EpsUv);
      ss.c7Visitors += metric(row.c7GoodsUv);
      ss.c30Visitors += metric(row.c30GoodsUv);
      if (row.imageUrl && !ss.sampleImage) ss.sampleImage = row.imageUrl;
      if (row.skc && !ss.sampleSkc) ss.sampleSkc = row.skc;
      if (row.goodsName && !ss.sampleTitle) ss.sampleTitle = row.goodsName;
    }
    for (const row of obj.inventoryRows || []) {
      inventories.push(row);
      invByStoreSkc.set(uniqueKey(row.storeKey || storeKey, row.skc), row);
    }
    for (const row of obj.coverageRows || []) {
      coverages.push(row);
      coverageByStoreStandard.set(uniqueKey(row.storeKey || storeKey, row.standardGoodsSn), row);
      const ss = ensureStandard(row.standardGoodsSn);
      ss.stores.add(row.storeKey || storeKey);
      if (row.hasOnShelfLink) ss.onShelfStores.add(row.storeKey || storeKey);
    }
    for (const row of obj.suggestionRows || []) {
      suggestions.push(row);
    }
  }

  const fullSelected = new Set(selectedStoreKeys);
  const suppressedStandards = new Set();
  for (const [standardGoodsSn, ss] of standardStats.entries()) {
    const appearedInAllStores = fullSelected.size > 0 && [...fullSelected].every(key => ss.stores.has(key));
    if (appearedInAllStores && ss.onShelfStores.size === 0) suppressedStandards.add(standardGoodsSn);
  }

  return {
    links,
    performances,
    inventories,
    coverages,
    suggestions,
    perfByStoreSkc,
    linkByStoreSkc,
    invByStoreSkc,
    coverageByStoreStandard,
    storeStats,
    standardStats,
    standardStoreLinks,
    suppressedStandards,
  };
}

function aggregateSales(history, storesCfg) {
  const storeMeta = new Map((storesCfg.stores || []).map(s => [s.storeKey, s]));
  const byDate = new Map();
  const byStore = new Map();
  const byProduct = new Map();
  const bySkc = new Map();
  const byStoreSkc = new Map();
  const latestFetchTimes = [];

  const ensureStore = storeKey => {
    if (!byStore.has(storeKey)) {
      const meta = storeMeta.get(storeKey) || {};
      byStore.set(storeKey, {
        storeKey,
        groupKey: meta.groupKey || meta.group || '',
        shopName: meta.shopName || '',
        todaySar: 0,
        todayRmb: 0,
        todayOrders: 0,
        todayQty: 0,
        yesterdaySar: 0,
        last7Sar: 0,
        prev7Sar: 0,
        last30Sar: 0,
        last7Qty: 0,
        last30Qty: 0,
      });
    }
    return byStore.get(storeKey);
  };
  const ensureDate = date => {
    if (!byDate.has(date)) byDate.set(date, {date, sar: 0, rmb: 0, orders: 0, qty: 0, DSY: 0, LGM: 0});
    return byDate.get(date);
  };
  const ensureProduct = goodsSn => {
    const key = goodsSn || '未识别货号';
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        goodsSn: key,
        goodsTitle: '',
        todayQty: 0,
        todaySar: 0,
        last7Qty: 0,
        last7Sar: 0,
        last30Qty: 0,
        last30Sar: 0,
        stores: new Set(),
      });
    }
    return byProduct.get(key);
  };
  const ensureSkc = skc => {
    const key = skc || '无SKC';
    if (!bySkc.has(key)) {
      bySkc.set(key, {skc: key, goodsSn: '', todayQty: 0, last7Qty: 0, last30Qty: 0, last30Sar: 0, stores: new Set()});
    }
    return bySkc.get(key);
  };
  const ensureStoreSkc = (storeKey, skc) => {
    const key = uniqueKey(storeKey, skc || '');
    if (!byStoreSkc.has(key)) {
      byStoreSkc.set(key, {
        storeKey,
        skc: skc || '',
        goodsSn: '',
        todayQty: 0,
        yesterdayQty: 0,
        prev7Qty: 0,
        prev7Sar: 0,
        last7Qty: 0,
        last30Qty: 0,
      });
    }
    return byStoreSkc.get(key);
  };

  const end = history.end;
  const last7Start = addDays(end, -6);
  const prev7Start = addDays(end, -13);
  const prev7End = addDays(end, -7);
  const yesterday = addDays(end, -1);

  for (const day of history.rows) {
    const storeKey = day.storeKey;
    const date = day.date;
    const meta = storeMeta.get(storeKey) || {};
    const groupKey = day.detail?.groupKey || meta.groupKey || meta.group || '';
    const sum = day.summary?.days?.[0] || day.detail?.summary || {};
    const goodsSales = Array.isArray(day.detail?.goodsRows) ? summarizeSalesGoodsRows(day.detail.goodsRows) : null;
    const sar = metric(goodsSales?.salesSar ?? sum.salesSar);
    const rmb = metric(sar * 1.8);
    const orders = metric(goodsSales?.positiveAmountOrderCount ?? sum.orderRefCount ?? sum.apiCount ?? sum.detailedOrderCount);
    const qty = metric(goodsSales?.quantityPositiveAmount ?? sum.quantityPositiveAmount ?? sum.quantityAll);
    const st = ensureStore(storeKey);
    latestFetchTimes.push(day.detail?.fetchTime || day.summary?.generatedAt || '');
    if (date === end) {
      st.todaySar += sar;
      st.todayRmb += rmb;
      st.todayOrders += orders;
      st.todayQty += qty;
    }
    if (date === yesterday) st.yesterdaySar += sar;
    if (date >= last7Start && date <= end) {
      st.last7Sar += sar;
      st.last7Qty += qty;
    }
    if (date >= prev7Start && date <= prev7End) st.prev7Sar += sar;
    st.last30Sar += sar;
    st.last30Qty += qty;

    const dr = ensureDate(date);
    dr.sar += sar;
    dr.rmb += rmb;
    dr.orders += orders;
    dr.qty += qty;
    if (groupKey === 'DSY') dr.DSY += sar;
    if (groupKey === 'LGM') dr.LGM += sar;

    const goodsRows = day.detail?.goodsRows || [];
    for (const row of goodsRows) {
      if (!isValidSalesGoodsRow(row)) continue;
      const goodsSn = row.goodsSn || '未识别货号';
      const lineSar = metric(salesAmountSar(row));
      const lineQty = metric(salesQuantity(row));
      const p = ensureProduct(goodsSn);
      if (row.goodsTitle && !p.goodsTitle) p.goodsTitle = row.goodsTitle;
      p.stores.add(storeKey);
      if (date === end) {
        p.todayQty += lineQty;
        p.todaySar += lineSar;
      }
      if (date >= last7Start && date <= end) {
        p.last7Qty += lineQty;
        p.last7Sar += lineSar;
      }
      p.last30Qty += lineQty;
      p.last30Sar += lineSar;

      const skc = row.skcName || row.skc || '';
      if (skc) {
        const sk = ensureSkc(skc);
        sk.goodsSn = goodsSn;
        sk.stores.add(storeKey);
        if (date === end) sk.todayQty += lineQty;
        if (date >= last7Start && date <= end) sk.last7Qty += lineQty;
        sk.last30Qty += lineQty;
        sk.last30Sar += lineSar;

        const storeSkc = ensureStoreSkc(storeKey, skc);
        storeSkc.goodsSn = goodsSn;
        if (date === end) storeSkc.todayQty += lineQty;
        if (date === yesterday) storeSkc.yesterdayQty += lineQty;
        if (date >= addDays(end, -7) && date <= yesterday) {
          storeSkc.prev7Qty += lineQty;
          storeSkc.prev7Sar += lineSar;
        }
        if (date >= last7Start && date <= end) storeSkc.last7Qty += lineQty;
        storeSkc.last30Qty += lineQty;
      }
    }
  }

  const totals = [...byStore.values()].reduce((acc, row) => {
    acc.todaySar += row.todaySar;
    acc.todayRmb += row.todayRmb;
    acc.todayOrders += row.todayOrders;
    acc.todayQty += row.todayQty;
    acc.yesterdaySar += row.yesterdaySar;
    acc.last7Sar += row.last7Sar;
    acc.prev7Sar += row.prev7Sar;
    acc.last30Sar += row.last30Sar;
    acc.last30Qty += row.last30Qty;
    return acc;
  }, {todaySar: 0, todayRmb: 0, todayOrders: 0, todayQty: 0, yesterdaySar: 0, last7Sar: 0, prev7Sar: 0, last30Sar: 0, last30Qty: 0});

  const trend = history.dates.map(date => byDate.get(date) || {date, sar: 0, rmb: 0, orders: 0, qty: 0, DSY: 0, LGM: 0});
  const storeRows = [...byStore.values()].sort((a, b) => b.todaySar - a.todaySar || storeSort(a.storeKey, b.storeKey));
  const productRows = [...byProduct.values()].map(row => ({
    ...row,
    stores: [...row.stores].sort(storeSort),
  })).sort((a, b) => b.last30Qty - a.last30Qty || b.last30Sar - a.last30Sar || a.goodsSn.localeCompare(b.goodsSn, 'zh-Hans-CN'));
  const skcRows = [...bySkc.values()].map(row => ({
    ...row,
    stores: [...row.stores].sort(storeSort),
  })).sort((a, b) => b.last30Qty - a.last30Qty || b.last30Sar - a.last30Sar || a.skc.localeCompare(b.skc));

  return {
    totals,
    todayChangeRate: ratioChange(totals.todaySar, totals.yesterdaySar),
    last7ChangeRate: ratioChange(totals.last7Sar, totals.prev7Sar),
    trend,
    storeRows,
    productRows,
    skcRows,
    storeSkcRows: [...byStoreSkc.values()].sort((a, b) => b.prev7Qty - a.prev7Qty || storeSort(a.storeKey, b.storeKey)),
    byStoreSkc,
    latestFetchTime: latestFetchTimes.filter(Boolean).sort().at(-1) || '',
  };
}

function salesLookupByGoods(salesAgg) {
  return new Map(salesAgg.productRows.map(row => [row.goodsSn, row]));
}
function priorityWeight(priority) {
  if (priority === HIGH) return 1;
  if (priority === MID) return 2;
  return 3;
}
function actionSort(a, b) {
  return priorityWeight(a.priority) - priorityWeight(b.priority)
    || b.score - a.score
    || storeSort(a.store, b.store)
    || String(a.standardGoodsSn || '').localeCompare(String(b.standardGoodsSn || ''), 'zh-Hans-CN')
    || String(a.skc || '').localeCompare(String(b.skc || ''));
}
function addAction(map, action) {
  const key = action.id || uniqueKey(action.type, action.store, action.standardGoodsSn, action.skc, action.title);
  const old = map.get(key);
  if (!old || action.score > old.score) map.set(key, {...action, id: key});
}
function linkAgeDays(linkRow, inventoryRow) {
  const fromInv = metric(inventoryRow?.shelfDays, NaN);
  if (Number.isFinite(fromInv) && fromInv > 0) return fromInv;
  const raw = linkRow?.firstShelfTime || linkRow?.publishTime || linkRow?.createTime || '';
  if (!raw) return 0;
  const d = new Date(String(raw).replace(' ', 'T') + '+08:00');
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
function buildOperations(linkIdx, salesAgg, selectedStoreKeys, args) {
  const productSales = salesLookupByGoods(salesAgg);
  const actions = new Map();

  // 1) Coverage opportunities: only when this goods already has at least one store on shelf.
  for (const row of linkIdx.coverages) {
    const standardGoodsSn = row.standardGoodsSn || '';
    if (!standardGoodsSn || linkIdx.suppressedStandards.has(standardGoodsSn)) continue;
    if (row.hasOnShelfLink) continue;
    const ss = linkIdx.standardStats.get(standardGoodsSn);
    if (!ss || ss.onShelfStores.size === 0) continue;
    const sales = productSales.get(standardGoodsSn) || {};
    const c30Sale = metric(ss.c30Sale) + metric(sales.last30Qty);
    const c7Sale = metric(ss.c7Sale) + metric(sales.last7Qty);
    const onShelfStores = [...ss.onShelfStores].sort(storeSort);
    const score = c30Sale * 20 + c7Sale * 25 + onShelfStores.length * 8 + metric(sales.last30Sar) / 10 + metric(ss.c30Exposure) / 1000;
    if (score < 18 && onShelfStores.length < 4) continue;
    addAction(actions, {
      type: '补链接',
      category: '补链接',
      priority: score >= 180 ? HIGH : score >= 60 ? MID : LOW,
      score,
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn,
      skc: row.bestSkc || '',
      imageUrl: ss.sampleImage || '',
      title: `${row.storeKey} 缺上架链接：${standardGoodsSn}`,
      reason: `该货号已有 ${onShelfStores.length} 个店铺在卖，但 ${row.storeKey} 当前没有已上架链接。`,
      evidence: `链接近30天销量 ${metric(ss.c30Sale)}；订单近30天销量 ${metric(sales.last30Qty)}；已上架店铺：${onShelfStores.join('、') || '—'}`,
      nextStep: '如果这个店也准备卖，补 1 条可上架链接；如果暂不卖，可在网页里忽略该货号。',
      metrics: {c7Sale, c30Sale, c30Exposure: metric(ss.c30Exposure), sales30Sar: metric(sales.last30Sar), onShelfStores: onShelfStores.length},
      source: 'coverage',
    });
  }

  // 2) Wait-shelf blockers from product list.
  for (const row of linkIdx.links) {
    if (!row.waitShelfBlocked && !row.waitShelfRequiresCertificate && !row.waitShelfBlockReason) continue;
    if (row.isHardDead) continue;
    const ss = linkIdx.standardStats.get(row.standardGoodsSn || '') || {};
    const sales = productSales.get(row.standardGoodsSn || '') || {};
    const score = 400 + metric(ss.c30Sale) * 15 + metric(sales.last30Qty) * 20;
    addAction(actions, {
      type: '待上架卡点',
      category: row.waitShelfRequiresCertificate ? '补证书/资料' : '待上架卡点',
      priority: HIGH,
      score,
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn: row.standardGoodsSn || '',
      skc: row.skc || '',
      imageUrl: row.imageUrl || ss.sampleImage || '',
      title: `${row.storeKey} 待上架卡住：${row.skc || row.standardGoodsSn}`,
      reason: row.waitShelfBlockReason || '后台显示待上架存在阻塞，需要补资料后才能上架。',
      evidence: `状态：${row.shelfStatusName || row.shelfStatus || '待上架'}；要求：${row.shelfRequireList || '—'}`,
      nextStep: '优先补证书、资质或审核资料；补完后再推动上架。',
      metrics: {c30Sale: metric(ss.c30Sale), sales30Qty: metric(sales.last30Qty)},
      source: 'product_list',
    });
  }

  // 3) Optimization and decline diagnosis from performance data.
  for (const row of linkIdx.performances) {
    const link = linkIdx.linkByStoreSkc.get(uniqueKey(row.storeKey, row.skc)) || {};
    if (link.isHardDead || link.isOutShelf) continue;
    const sales = productSales.get(row.standardGoodsSn || '') || {};
    const base = metric(row.c30SaleCnt) * 18 + metric(row.c7SaleCnt) * 25 + metric(sales.last30Qty) * 10;
    const common = {
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn: row.standardGoodsSn || '',
      skc: row.skc || '',
      imageUrl: row.imageUrl || link.imageUrl || '',
      metrics: {
        c7Sale: metric(row.c7SaleCnt),
        prev7Sale: metric(row.prev7SaleCnt),
        c30Sale: metric(row.c30SaleCnt),
        c7Exposure: metric(row.c7EpsUv),
        prev7Exposure: metric(row.prev7EpsUv),
        c30Exposure: metric(row.c30EpsUv),
        c7Visitors: metric(row.c7GoodsUv),
        c30Visitors: metric(row.c30GoodsUv),
        clickRate: metric(row.c7ClickRate),
        payRate: metric(row.c7PayRate),
        quality: row.totalQualityLevel || '',
      },
    };
    if (metric(row.c30SaleCnt) === 0 && metric(row.c30EpsUv) >= 1000) {
      addAction(actions, {
        ...common,
        type: '优化候选',
        category: '有流量无销量',
        priority: metric(row.c30EpsUv) >= 3000 ? HIGH : MID,
        score: metric(row.c30EpsUv) / 3 + metric(row.c30GoodsUv) * 5 + base,
        title: `${row.storeKey} 有流量但30天0销量：${row.skc}`,
        reason: '不是没有机会，而是流量没有转成订单，适合先优化主图/价格/评价/活动承接。',
        evidence: `30天曝光 ${metric(row.c30EpsUv)}，商详访客 ${metric(row.c30GoodsUv)}，销量 0，支付率 ${pct(row.c30PayRate)}`,
        nextStep: '先改链接承接，不建议直接下架；若优化后仍无销量，再进入淘汰。',
        source: 'performance',
      });
    }
    if (metric(row.c7EpsUv) >= 500 && metric(row.c7ClickRate, 1) < 0.015) {
      addAction(actions, {
        ...common,
        type: '优化候选',
        category: '高曝光低点击',
        priority: metric(row.c7EpsUv) >= 1500 ? HIGH : MID,
        score: metric(row.c7EpsUv) / 2 + base,
        title: `${row.storeKey} 高曝光低点击：${row.skc}`,
        reason: '平台给了曝光，但客户不愿点，优先检查首图、标题、价格带和活动标签。',
        evidence: `7天曝光 ${metric(row.c7EpsUv)}，点击率 ${pct(row.c7ClickRate)}，7天销量 ${metric(row.c7SaleCnt)}`,
        nextStep: '优先换主图/标题卖点；同类价格偏高时先调价或挂活动。',
        source: 'performance',
      });
    }
    if (metric(row.c7GoodsUv) >= 80 && metric(row.c7PayRate, 1) < 0.01) {
      addAction(actions, {
        ...common,
        type: '优化候选',
        category: '高访客低支付',
        priority: metric(row.c7GoodsUv) >= 200 ? HIGH : MID,
        score: metric(row.c7GoodsUv) * 8 + base,
        title: `${row.storeKey} 商详承接弱：${row.skc}`,
        reason: '已经有人进入商详，但支付转化低，问题更可能在价格、评价、质量等级、详情承诺或活动承接。',
        evidence: `7天商详访客 ${metric(row.c7GoodsUv)}，支付率 ${pct(row.c7PayRate)}，质量等级 ${row.totalQualityLevel || '—'}`,
        nextStep: '复核价格和评价；如果是低质评/高退货，谨慎继续投流。',
        source: 'performance',
      });
    }
    if (metric(row.prev7SaleCnt) >= 5 && metric(row.c7SaleCnt) <= metric(row.prev7SaleCnt) * 0.5) {
      addAction(actions, {
        ...common,
        type: '修复下滑',
        category: '销量下滑',
        priority: HIGH,
        score: (metric(row.prev7SaleCnt) - metric(row.c7SaleCnt)) * 80 + base,
        title: `${row.storeKey} 销量下滑：${row.skc}`,
        reason: '前7天有销量基础，近7天下滑明显，优先查活动结束、排名变化、断码/库存展示和竞品价格。',
        evidence: `前7天销量 ${metric(row.prev7SaleCnt)} → 近7天 ${metric(row.c7SaleCnt)}`,
        nextStep: '先找下滑原因，不急着下架；如果是活动结束导致，考虑重新进活动。',
        source: 'performance',
      });
    }
    if (metric(row.prev7EpsUv) >= 1000 && metric(row.c7EpsUv) <= metric(row.prev7EpsUv) * 0.5) {
      addAction(actions, {
        ...common,
        type: '修复下滑',
        category: '曝光下滑',
        priority: MID,
        score: (metric(row.prev7EpsUv) - metric(row.c7EpsUv)) / 12 + base,
        title: `${row.storeKey} 曝光下滑：${row.skc}`,
        reason: '链接原本有曝光，现在明显掉量，先排查排名、活动、标签、标题关键词和库存展示。',
        evidence: `前7天曝光 ${metric(row.prev7EpsUv)} → 近7天 ${metric(row.c7EpsUv)}`,
        nextStep: '如果转化仍好，优先抢回曝光；如果转化也弱，先优化承接。',
        source: 'performance',
      });
    }
  }

  // 3b) Sales anomaly that may be inventory/display-stock related.
  // Do not call it "out of stock" before the dedicated inventory menu is connected.
  for (const row of linkIdx.performances) {
    const link = linkIdx.linkByStoreSkc.get(uniqueKey(row.storeKey, row.skc)) || {};
    if (!row.skc || link.isHardDead || link.isOutShelf || link.isSoldOut) continue;
    const skcSales = salesAgg.byStoreSkc.get(uniqueKey(row.storeKey, row.skc));
    if (!skcSales) continue;
    const recentBaseline = Math.max(metric(skcSales.prev7Qty), metric(row.c7SaleCnt));
    const todayQty = metric(skcSales.todayQty);
    const yesterdayQty = metric(skcSales.yesterdayQty);
    const enoughBaseline = recentBaseline >= 10 || metric(row.c7SaleCnt) >= 8;
    if (!enoughBaseline || todayQty > 0) continue;
    const score = 520 + recentBaseline * 35 + metric(row.c7EpsUv) / 12 + metric(row.c7GoodsUv) * 4;
    addAction(actions, {
      type: '库存/销售异常',
      category: '销售异常核库存',
      priority: recentBaseline >= 20 || yesterdayQty >= 3 ? HIGH : MID,
      score,
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn: row.standardGoodsSn || skcSales.goodsSn || '',
      skc: row.skc || '',
      imageUrl: row.imageUrl || link.imageUrl || '',
      title: `${row.storeKey} 今日突然没销量，需核库存菜单：${row.skc}`,
      reason: '这不是库存低结论，只是销售节奏异常；需要人工打开 SHEIN 库存菜单核对展示库存、活动和排名。',
      evidence: `今日订单销量 0；过去7天订单销量 ${metric(skcSales.prev7Qty)}；链接近7天销量 ${metric(row.c7SaleCnt)}；昨日销量 ${yesterdayQty}`,
      nextStep: '先核 SHEIN 库存菜单的展示库存是否够，再看活动/排名/价格是否变化。',
      metrics: {todayQty, yesterdayQty, prev7Qty: metric(skcSales.prev7Qty), linkC7Sale: metric(row.c7SaleCnt), c7Exposure: metric(row.c7EpsUv)},
      source: 'sales_anomaly',
    });
  }

  // 4) Delist / replacement candidates. Never recommend deleting the only useful coverage blindly.
  for (const row of linkIdx.performances) {
    const link = linkIdx.linkByStoreSkc.get(uniqueKey(row.storeKey, row.skc)) || {};
    if (link.isHardDead || link.isOutShelf || link.isSoldOut) continue;
    const inv = linkIdx.invByStoreSkc.get(uniqueKey(row.storeKey, row.skc)) || {};
    const age = linkAgeDays(link, inv);
    const standardStoreLinks = linkIdx.standardStoreLinks.get(uniqueKey(row.standardGoodsSn, row.storeKey)) || [];
    const onShelfSameStore = standardStoreLinks.filter(x => x.isOnShelf || x.shelfStatusName === '已上架').length;
    const ss = linkIdx.standardStats.get(row.standardGoodsSn || '') || {};
    const hasReplacement = onShelfSameStore > 1;
    const zero30 = metric(row.c30SaleCnt) === 0;
    const enoughAge = age >= 30;
    const exposedButNoSale = metric(row.c30EpsUv) >= 500 || metric(row.c30GoodsUv) >= 60;
    if (!zero30 || !enoughAge || !exposedButNoSale) continue;
    const score = metric(row.c30EpsUv) / 2 + metric(row.c30GoodsUv) * 8 + age + (hasReplacement ? 300 : 0);
    const totalOnShelfStores = ss.onShelfStores?.size || 0;
    addAction(actions, {
      type: '淘汰候选',
      category: hasReplacement ? '可下架候选' : '先替换再下架',
      priority: hasReplacement || metric(row.c30EpsUv) >= 2000 ? HIGH : MID,
      score,
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn: row.standardGoodsSn || '',
      skc: row.skc || '',
      imageUrl: row.imageUrl || link.imageUrl || '',
      title: `${row.storeKey} 30天0销量淘汰候选：${row.skc}`,
      reason: hasReplacement
        ? '同货号同店已有其他上架链接，可把这条长期不转化链接列入下架候选。'
        : '该店该货号可能只有这一条上架承接，不建议直接下架；先补新链接或确认该货号不用覆盖。',
      evidence: `上架约 ${age} 天；30天曝光 ${metric(row.c30EpsUv)}，商详访客 ${metric(row.c30GoodsUv)}，销量 0；同店上架链接 ${onShelfSameStore}；全店覆盖 ${totalOnShelfStores}/${selectedStoreKeys.length}`,
      nextStep: hasReplacement ? '复核无误后可下架/停用弱链接。' : '先补新链接或确认不卖，再处理旧链接。',
      metrics: {age, c30Sale: 0, c30Exposure: metric(row.c30EpsUv), onShelfSameStore, allOnShelfStores: totalOnShelfStores},
      source: 'delist_rule',
    });
  }

  // 5) Existing duplicate weak-link suggestions are useful, but keep them under replacement rather than daily must-do.
  for (const row of linkIdx.suggestions) {
    if (row.ruleCode !== 'DUPLICATE_WEAK_LINK') continue;
    if (linkIdx.suppressedStandards.has(row.standardGoodsSn)) continue;
    const perf = linkIdx.perfByStoreSkc.get(uniqueKey(row.storeKey, row.skc)) || {};
    const score = 250 + metric(perf.c30EpsUv) / 5 + metric(perf.c30GoodsUv) * 6;
    addAction(actions, {
      type: '淘汰候选',
      category: '重复弱链接',
      priority: MID,
      score,
      store: row.storeKey,
      group: row.groupKey,
      shopName: row.shopName,
      standardGoodsSn: row.standardGoodsSn || '',
      skc: row.skc || '',
      imageUrl: perf.imageUrl || '',
      title: `${row.storeKey} 重复弱链接：${row.skc || row.standardGoodsSn}`,
      reason: row.reason || '同货号存在多条链接，需要保留强链接、观察或淘汰弱链接。',
      evidence: row.evidence || `30天曝光 ${metric(perf.c30EpsUv)}，30天销量 ${metric(perf.c30SaleCnt)}`,
      nextStep: '先对比同货号同店的强链接，确认替代承接后再下架弱链接。',
      metrics: {c30Sale: metric(perf.c30SaleCnt), c30Exposure: metric(perf.c30EpsUv)},
      source: 'suggestion_duplicate',
    });
  }

  let all = [...actions.values()]
    .filter(row => row.category !== '展示库存低')
    .filter(row => row.type !== '库存预警')
    .sort(actionSort);

  const budgets = [
    ['待上架卡点', 20],
    ['补证书/资料', 20],
    ['销售异常核库存', 18],
    ['可下架候选', 18],
    ['先替换再下架', 12],
    ['重复弱链接', 12],
    ['销量下滑', 14],
    ['曝光下滑', 10],
    ['有流量无销量', 18],
    ['高曝光低点击', 16],
    ['高访客低支付', 16],
    ['补链接', 22],
  ];
  const focusIds = new Set();
  for (const [category, limit] of budgets) {
    all.filter(row => row.category === category).sort(actionSort).slice(0, limit).forEach(row => focusIds.add(row.id));
  }
  let focus = all.filter(row => focusIds.has(row.id)).sort(actionSort).slice(0, args.focusLimit);
  if (focus.length < Math.min(args.focusLimit, 30)) {
    for (const row of all) {
      if (focusIds.size >= args.focusLimit) break;
      focusIds.add(row.id);
    }
    focus = all.filter(row => focusIds.has(row.id)).sort(actionSort).slice(0, args.focusLimit);
  }
  const focusSet = new Set(focus.map(row => row.id));
  all = all.map(row => ({...row, focus: focusSet.has(row.id)})).slice(0, args.poolLimit);
  focus = all.filter(row => row.focus);

  return {actions: all, focus};
}

function buildStoreCockpit(storesCfg, storeKeys, linkIdx, salesAgg, actions) {
  const actionByStore = new Map();
  const focusByStore = new Map();
  for (const a of actions) {
    actionByStore.set(a.store, (actionByStore.get(a.store) || 0) + 1);
    if (a.focus) focusByStore.set(a.store, (focusByStore.get(a.store) || 0) + 1);
  }
  const salesByStore = new Map(salesAgg.storeRows.map(row => [row.storeKey, row]));
  const cfgByStore = new Map((storesCfg.stores || []).map(s => [s.storeKey, s]));
  return storeKeys.map(storeKey => {
    const cfg = cfgByStore.get(storeKey) || {};
    const sales = salesByStore.get(storeKey) || {};
    const links = linkIdx.storeStats.get(storeKey) || {};
    return {
      storeKey,
      groupKey: cfg.groupKey || cfg.group || sales.groupKey || '',
      shopName: cfg.shopName || sales.shopName || '',
      todaySar: metric(sales.todaySar),
      todayQty: metric(sales.todayQty),
      todayOrders: metric(sales.todayOrders),
      last7Sar: metric(sales.last7Sar),
      last30Sar: metric(sales.last30Sar),
      sales7ChangeRate: ratioChange(metric(sales.last7Sar), metric(sales.prev7Sar)),
      linkCount: metric(links.linkCount),
      onShelf: metric(links.onShelf),
      waitShelf: metric(links.waitShelf),
      soldOut: metric(links.soldOut),
      outShelf: metric(links.outShelf),
      linkC30Sale: metric(links.c30Sale),
      linkC30Exposure: metric(links.c30Exposure),
      actionCount: metric(actionByStore.get(storeKey)),
      focusCount: metric(focusByStore.get(storeKey)),
    };
  }).sort((a, b) => b.focusCount - a.focusCount || b.todaySar - a.todaySar || storeSort(a.storeKey, b.storeKey));
}

function buildCoverageMatrix(linkIdx, salesAgg, selectedStoreKeys) {
  const productSales = salesLookupByGoods(salesAgg);
  const rows = [];
  for (const [standardGoodsSn, ss] of linkIdx.standardStats.entries()) {
    if (!standardGoodsSn || linkIdx.suppressedStandards.has(standardGoodsSn)) continue;
    const onShelfStores = [...ss.onShelfStores].sort(storeSort);
    if (!onShelfStores.length) continue;
    const missingStores = selectedStoreKeys.filter(store => !ss.onShelfStores.has(store));
    if (!missingStores.length) continue;
    const sales = productSales.get(standardGoodsSn) || {};
    const score = metric(sales.last30Qty) * 30 + metric(sales.last7Qty) * 35 + metric(ss.c30Sale) * 18 + metric(ss.c30Exposure) / 1000 + onShelfStores.length * 4;
    if (score < 20) continue;
    rows.push({
      standardGoodsSn,
      imageUrl: ss.sampleImage,
      sampleSkc: ss.sampleSkc,
      sampleTitle: ss.sampleTitle,
      onShelfStores,
      missingStores,
      onShelfCount: ss.onShelfCount,
      waitShelfCount: ss.waitShelfCount,
      soldOutCount: ss.soldOutCount,
      linkC30Sale: metric(ss.c30Sale),
      linkC30Exposure: metric(ss.c30Exposure),
      orderLast7Qty: metric(sales.last7Qty),
      orderLast30Qty: metric(sales.last30Qty),
      orderLast30Sar: metric(sales.last30Sar),
      score,
    });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, 160);
}

function enrichSalesProducts(productRows, linkIdx, selectedStoreKeys) {
  return productRows.map(row => {
    const ss = linkIdx.standardStats.get(row.goodsSn) || {};
    const onShelfStores = ss.onShelfStores ? [...ss.onShelfStores].sort(storeSort) : [];
    const missingStores = selectedStoreKeys.filter(store => !ss.onShelfStores?.has(store));
    return {
      ...row,
      onShelfStores,
      missingStores,
      onShelfLinkCount: metric(ss.onShelfCount),
      linkC30Sale: metric(ss.c30Sale),
      linkC30Exposure: metric(ss.c30Exposure),
      salesPerOnShelfLink: metric(ss.onShelfCount) ? metric(row.last30Qty) / metric(ss.onShelfCount) : metric(row.last30Qty),
    };
  });
}
function buildTopLists(actions, salesAgg, coverageMatrix, linkIdx, selectedStoreKeys) {
  const top = category => actions.filter(a => a.category === category).sort(actionSort).slice(0, 10);
  return {
    focus: actions.filter(a => a.focus).sort(actionSort).slice(0, 18),
    missing: top('补链接'),
    blocked: [...top('补证书/资料'), ...top('待上架卡点')].sort(actionSort).slice(0, 10),
    anomaly: top('销售异常核库存'),
    optimize: actions.filter(a => ['销售异常核库存', '有流量无销量', '高曝光低点击', '高访客低支付', '销量下滑', '曝光下滑'].includes(a.category)).sort(actionSort).slice(0, 16),
    delist: actions.filter(a => ['可下架候选', '先替换再下架', '重复弱链接'].includes(a.category)).sort(actionSort).slice(0, 16),
    salesProducts: enrichSalesProducts(salesAgg.productRows.slice(0, 30), linkIdx, selectedStoreKeys).slice(0, 18),
    salesSkc: salesAgg.skcRows.slice(0, 18),
    expansion: coverageMatrix.slice(0, 16),
  };
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row) || '未分类';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}
function sum(rows, key) {
  return rows.reduce((acc, row) => acc + metric(row[key]), 0);
}
function buildKpis(linkIdx, salesAgg, actions, coverageMatrix, monthlyReport) {
  const liveActions = actions.filter(a => a.focus);
  const optimizeCount = actions.filter(a => ['有流量无销量', '高曝光低点击', '高访客低支付', '销量下滑', '曝光下滑'].includes(a.category)).length;
  const delistCount = actions.filter(a => ['可下架候选', '先替换再下架', '重复弱链接'].includes(a.category)).length;
  const missingCount = actions.filter(a => a.category === '补链接').length;
  const salesAnomalyCount = actions.filter(a => a.category === '销售异常核库存').length;
  const monthTotals = monthlyReport?.totals || {};
  return {
    todaySar: salesAgg.totals.todaySar,
    todayRmb: salesAgg.totals.todayRmb,
    todayOrders: salesAgg.totals.todayOrders,
    todayQty: salesAgg.totals.todayQty,
    todayChangeRate: salesAgg.todayChangeRate,
    monthSar: metric(monthTotals.totalSar, salesAgg.totals.todaySar),
    predictedSar: metric(monthTotals.predictedSar, salesAgg.totals.todaySar * 30),
    predictedProfitRmb: metric(monthTotals.predictedProfitRmb, salesAgg.totals.todayRmb * 30 * 0.25),
    focusActions: liveActions.length,
    actionPool: actions.length,
    missingCount,
    optimizeCount,
    delistCount,
    salesAnomalyCount,
    coverageOpportunityCount: coverageMatrix.length,
    onShelfLinks: sum([...linkIdx.storeStats.values()], 'onShelf'),
    waitShelfLinks: sum([...linkIdx.storeStats.values()], 'waitShelf'),
    soldOutLinks: sum([...linkIdx.storeStats.values()], 'soldOut'),
    stockStatus: '准确库存菜单尚未接入，当前不生成库存低预警',
  };
}

function stripForJson(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (value instanceof Set) return [...value];
    return value;
  }));
}
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
function clientScript() {
  return `
const payload = JSON.parse(document.getElementById('payload').textContent);
const state = {tab:'overview', store:'全部', category:'全部', priority:'全部', search:'', focus:true, sort:'score'};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 2});
const rate = n => !Number.isFinite(Number(n)) ? '—' : ((Number(n) >= 0 ? '+' : '') + (Number(n) * 100).toFixed(1) + '%');
const pct = n => !Number.isFinite(Number(n)) ? '—' : (Number(n) * 100).toFixed(1) + '%';
const storeOrder = ${JSON.stringify(STORE_ORDER)};
function storeSort(a,b){ return (storeOrder.indexOf(a)<0?999:storeOrder.indexOf(a)) - (storeOrder.indexOf(b)<0?999:storeOrder.indexOf(b)) || String(a).localeCompare(String(b)); }
function byCount(rows, key){
  const m = new Map();
  rows.forEach(r => m.set(r[key] || '未分类', (m.get(r[key] || '未分类') || 0) + 1));
  return [...m.entries()].sort((a,b)=>b[1]-a[1] || String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN'));
}
function sevClass(priority){ return priority === '高' ? 'high' : priority === '中' ? 'mid' : 'low'; }
function actionRows(){
  const q = state.search.trim().toLowerCase();
  let rows = payload.actions.filter(a => {
    if (state.focus && !a.focus) return false;
    if (state.store !== '全部' && a.store !== state.store) return false;
    if (state.category !== '全部' && a.category !== state.category) return false;
    if (state.priority !== '全部' && a.priority !== state.priority) return false;
    if (!q) return true;
    return [a.store,a.category,a.priority,a.standardGoodsSn,a.skc,a.title,a.reason,a.evidence,a.nextStep].some(v => String(v||'').toLowerCase().includes(q));
  });
  rows.sort((a,b) => {
    if (state.sort === 'store') return storeSort(a.store,b.store) || b.score-a.score;
    if (state.sort === 'category') return String(a.category).localeCompare(String(b.category),'zh-Hans-CN') || b.score-a.score;
    return (a.priority === b.priority ? 0 : (a.priority === '高' ? -1 : b.priority === '高' ? 1 : a.priority === '中' ? -1 : 1)) || b.score-a.score;
  });
  return rows;
}
function cardMetric(label, value, sub, tone){
  return '<article class="metric-card '+(tone||'')+'"><div class="metric-label">'+esc(label)+'</div><div class="metric-value">'+value+'</div><div class="metric-sub">'+esc(sub||'')+'</div></article>';
}
function renderTopMetrics(){
  const k = payload.kpis;
  $('topMetrics').innerHTML = [
    cardMetric('今日销售额', fmt(k.todaySar)+' SAR', '约 '+fmt(k.todayRmb)+' RMB；订单 '+fmt(k.todayOrders)+' / 销量 '+fmt(k.todayQty), 'blue'),
    cardMetric('较昨日', rate(k.todayChangeRate), '昨日 '+fmt(payload.sales.totals.yesterdaySar)+' SAR', k.todayChangeRate >= 0 ? 'green' : 'red'),
    cardMetric('本月累计', fmt(k.monthSar)+' SAR', '预测全月 '+fmt(k.predictedSar)+' SAR', 'purple'),
    cardMetric('今日重点动作', fmt(k.focusActions), '完整诊断池 '+fmt(k.actionPool)+' 条；默认只看重点', 'orange'),
    cardMetric('销售异常核库存', fmt(k.salesAnomalyCount), '只提示手动核库存菜单，不判定缺货', 'purple'),
    cardMetric('淘汰/替换候选', fmt(k.delistCount), '含可下架、先替换再下架、重复弱链接', 'red'),
    cardMetric('覆盖机会', fmt(k.coverageOpportunityCount), '有店已卖、其他店缺上架链接', 'green')
  ].join('');
}
function lineChart(rows, key, label){
  const values = rows.map(r => Number(r[key] || 0));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const w = 740, h = 220, pad = 28;
  const pts = values.map((v,i) => {
    const x = pad + (w - pad * 2) * (rows.length <= 1 ? 0 : i / (rows.length - 1));
    const y = h - pad - (h - pad * 2) * ((v - min) / Math.max(max - min, 1));
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  const area = pts ? pad+','+(h-pad)+' '+pts+' '+(w-pad)+','+(h-pad) : '';
  const ticks = rows.filter((_,i)=>i===0 || i===rows.length-1 || i%7===0).map((r,i) => '<text x="'+(pad+(w-pad*2)*(rows.indexOf(r)/Math.max(rows.length-1,1))).toFixed(1)+'" y="'+(h-6)+'" text-anchor="middle">'+esc(r.date.slice(5))+'</text>').join('');
  return '<svg class="chart" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+esc(label)+'"><defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2563eb" stop-opacity=".26"/><stop offset="100%" stop-color="#2563eb" stop-opacity="0"/></linearGradient></defs><rect x="0" y="0" width="'+w+'" height="'+h+'" rx="20" fill="#f8fbff"/><path d="M '+area+' Z" fill="url(#areaGrad)"/><polyline points="'+pts+'" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="'+pad+'" y="22" fill="#334155" font-size="13" font-weight="700">'+esc(label)+'</text><text x="'+(w-pad)+'" y="22" text-anchor="end" fill="#64748b" font-size="12">最高 '+fmt(max)+' SAR</text><g fill="#94a3b8" font-size="11">'+ticks+'</g></svg>';
}
function renderFocusCards(){
  const cats = ['补链接','补证书/资料','待上架卡点','有流量无销量','高曝光低点击','高访客低支付','销量下滑','曝光下滑','可下架候选','先替换再下架','重复弱链接'];
  $('focusLanes').innerHTML = cats.map(cat => {
    const rows = payload.actions.filter(a => a.focus && a.category === cat).slice(0, 4);
    if (!rows.length) return '';
    return '<section class="lane"><div class="lane-head"><span>'+esc(cat)+'</span><b>'+rows.length+'</b></div>' + rows.map(a =>
      '<div class="mini-action"><div><span class="store-badge">'+esc(a.store)+'</span><span class="priority '+sevClass(a.priority)+'">'+esc(a.priority)+'</span></div><button class="copy-skc" data-copy="'+esc(a.skc)+'">'+esc(a.skc || '按货号补链')+'</button><strong>'+esc(a.standardGoodsSn)+'</strong><p>'+esc(a.reason)+'</p></div>'
    ).join('') + '</section>';
  }).join('');
}
function renderActionFilters(){
  const stores = [['全部', payload.actions.length], ...byCount(payload.actions,'store').sort((a,b)=>storeSort(a[0],b[0]))];
  const cats = [['全部', payload.actions.length], ...byCount(payload.actions,'category')];
  const prios = [['全部', payload.actions.length], ['高', payload.actions.filter(a=>a.priority==='高').length], ['中', payload.actions.filter(a=>a.priority==='中').length], ['低', payload.actions.filter(a=>a.priority==='低').length]];
  function chips(rows, field){
    return rows.map(([name,count]) => '<button class="filter-chip '+(state[field]===name?'active':'')+'" data-filter="'+field+'" data-value="'+esc(name)+'">'+esc(name)+' <span>'+count+'</span></button>').join('');
  }
  $('storeFilters').innerHTML = chips(stores, 'store');
  $('categoryFilters').innerHTML = chips(cats, 'category');
  $('priorityFilters').innerHTML = chips(prios, 'priority');
  $('focusToggle').className = 'switch '+(state.focus ? 'on' : '');
  $('focusToggle').setAttribute('aria-pressed', state.focus ? 'true' : 'false');
  $('focusToggle').textContent = state.focus ? '只看今日重点' : '显示完整诊断池';
}
function renderActionTable(){
  const rows = actionRows();
  $('actionCount').textContent = '显示 '+rows.length+' / '+payload.actions.length+' 条';
  $('actionTableBody').innerHTML = rows.slice(0, 220).map(a => '<tr>'+
    '<td><span class="store-badge">'+esc(a.store)+'</span></td>'+
    '<td><button class="copy-skc" data-copy="'+esc(a.skc)+'">'+esc(a.skc || '—')+'</button></td>'+
    '<td><div class="goods-cell"><strong>'+esc(a.standardGoodsSn)+'</strong><span>'+esc(a.title)+'</span></div></td>'+
    '<td><span class="priority '+sevClass(a.priority)+'">'+esc(a.priority)+'</span></td>'+
    '<td><span class="type-pill">'+esc(a.category)+'</span></td>'+
    '<td>'+esc(a.reason)+'</td>'+
    '<td class="evidence">'+esc(a.evidence)+'</td>'+
    '<td>'+esc(a.nextStep)+'</td>'+
  '</tr>').join('');
  $('actionEmpty').hidden = rows.length > 0;
}
function renderSales(){
  $('salesTrend').innerHTML = lineChart(payload.sales.trend, 'sar', '近30天销售趋势');
  const max = Math.max(...payload.storeCockpit.map(s=>s.todaySar),1);
  $('storeBars').innerHTML = payload.storeCockpit.slice().sort((a,b)=>b.todaySar-a.todaySar).map(s =>
    '<div class="bar-row"><div class="bar-label"><b>'+esc(s.storeKey)+'</b><span>'+fmt(s.todaySar)+' SAR</span></div><div class="bar-track"><span style="width:'+Math.max(2, s.todaySar/max*100).toFixed(1)+'%"></span></div><small>重点 '+s.focusCount+'｜上架 '+s.onShelf+'｜7日 '+fmt(s.last7Sar)+' SAR</small></div>'
  ).join('');
  $('topProducts').innerHTML = payload.topLists.salesProducts.slice(0,10).map((p,i)=>
    '<li><span>'+(i+1)+'</span><div><b>'+esc(p.goodsSn)+'</b><small>订单30天 '+fmt(p.last30Qty)+' 件 / '+fmt(p.last30Sar)+' SAR｜链接覆盖 '+(p.onShelfStores?.length||0)+'/'+payload.meta.storeCount+' 店｜单链接贡献 '+fmt(p.salesPerOnShelfLink)+' 件</small></div></li>'
  ).join('');
}
function renderLinkDiagnosis(){
  function list(id, rows){
    $(id).innerHTML = rows.map(a => '<article class="diag-card"><div><span class="store-badge">'+esc(a.store)+'</span><span class="type-pill">'+esc(a.category)+'</span><span class="priority '+sevClass(a.priority)+'">'+esc(a.priority)+'</span></div><button class="copy-skc" data-copy="'+esc(a.skc)+'">'+esc(a.skc || '—')+'</button><strong>'+esc(a.standardGoodsSn)+'</strong><p>'+esc(a.evidence)+'</p><small>'+esc(a.nextStep)+'</small></article>').join('') || '<div class="empty-note">暂无</div>';
  }
  list('optimizeList', payload.topLists.optimize);
  list('delistList', payload.topLists.delist);
  list('missingList', payload.topLists.missing);
  list('blockedList', payload.topLists.blocked);
}
function renderCoverage(){
  $('coverageBody').innerHTML = payload.coverageMatrix.slice(0,120).map(r => '<tr>'+
    '<td><strong>'+esc(r.standardGoodsSn)+'</strong><small>'+esc(r.sampleSkc || '')+'</small></td>'+
    '<td>'+esc(r.onShelfStores.join('、'))+'</td>'+
    '<td>'+esc(r.missingStores.join('、'))+'</td>'+
    '<td>'+fmt(r.orderLast30Qty)+' 件</td>'+
    '<td>'+fmt(r.linkC30Sale)+' 件</td>'+
    '<td>'+fmt(r.linkC30Exposure)+'</td>'+
    '<td>'+fmt(r.score)+'</td>'+
  '</tr>').join('');
}
function renderStoreTable(){
  $('storeTableBody').innerHTML = payload.storeCockpit.map(s => '<tr>'+
    '<td><span class="store-badge">'+esc(s.storeKey)+'</span><small>'+esc(s.groupKey)+'</small></td>'+
    '<td>'+fmt(s.todaySar)+' SAR<br><small>'+fmt(s.todayQty)+' 件 / '+fmt(s.todayOrders)+' 单</small></td>'+
    '<td>'+fmt(s.last7Sar)+' SAR<br><small class="'+(s.sales7ChangeRate>=0?'pos':'neg')+'">'+rate(s.sales7ChangeRate)+'</small></td>'+
    '<td>'+s.onShelf+' / '+s.waitShelf+' / '+s.soldOut+'</td>'+
    '<td>'+fmt(s.linkC30Sale)+' 件<br><small>'+fmt(s.linkC30Exposure)+' 曝光</small></td>'+
    '<td><b>'+s.focusCount+'</b> / '+s.actionCount+'</td>'+
  '</tr>').join('');
}
function renderDataNotes(){
  $('dataNotes').innerHTML = [
    '<b>库存口径：</b>备货信息里的库存已经证实不适合做低库存预警，所以当前网页不生成库存低动作；现在只在销售突然断崖时提示“手动核库存菜单”，不判定缺货。',
    '<b>废且下架：</b>已标废且已下架的链接只作为历史状态，不进今日动作。',
    '<b>全店未上架：</b>如果一个货号15个店都没有已上架链接，按暂不上/库存未到处理，不提醒补链。',
    '<b>下架候选：</b>30天0销量只进入候选；唯一上架承接会显示“先替换再下架”，并展示同店链接数和全店覆盖数，不会提示直接下架。',
    '<b>今日重点：</b>按全局评分和类型预算挑选，不再每店机械凑8条。'
  ].map(x => '<li>'+x+'</li>').join('');
}
function renderTabs(){
  document.querySelectorAll('[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === state.tab));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.hidden = panel.id !== 'tab-'+state.tab);
}
function renderAll(){
  renderTopMetrics();
  renderFocusCards();
  renderActionFilters();
  renderActionTable();
  renderSales();
  renderLinkDiagnosis();
  renderCoverage();
  renderStoreTable();
  renderDataNotes();
  renderTabs();
}
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; renderTabs(); return; }
  const f = e.target.closest('[data-filter]');
  if (f) { state[f.dataset.filter] = f.dataset.value; renderActionFilters(); renderActionTable(); return; }
  const focus = e.target.closest('#focusToggle');
  if (focus) { state.focus = !state.focus; renderActionFilters(); renderActionTable(); return; }
  const copy = e.target.closest('[data-copy]');
  if (copy && copy.dataset.copy) {
    navigator.clipboard && navigator.clipboard.writeText(copy.dataset.copy);
    const old = copy.textContent;
    copy.textContent = '已复制';
    setTimeout(() => { copy.textContent = old; }, 900);
  }
});
$('search').addEventListener('input', e => { state.search = e.target.value; renderActionTable(); });
$('sortSelect').addEventListener('change', e => { state.sort = e.target.value; renderActionTable(); });
renderAll();
`;
}
function renderHtml(payload) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SHEIN 经营台 v2 - ${htmlEscape(payload.meta.linkDate)}</title>
  <style>
    :root{
      --bg:#07111f;--bg2:#0b1730;--panel:rgba(255,255,255,.92);--panel2:rgba(255,255,255,.78);
      --text:#0f172a;--muted:#64748b;--line:#e2e8f0;--blue:#2563eb;--cyan:#06b6d4;--green:#16a34a;
      --orange:#f97316;--red:#dc2626;--purple:#7c3aed;--shadow:0 22px 70px rgba(15,23,42,.18);--radius:24px
    }
    *{box-sizing:border-box}
    body{margin:0;color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Arial,sans-serif;background:
      radial-gradient(circle at 15% 0%,rgba(37,99,235,.36),transparent 32rem),
      radial-gradient(circle at 85% 8%,rgba(6,182,212,.28),transparent 30rem),
      linear-gradient(180deg,var(--bg) 0,var(--bg2) 310px,#f5f7fb 311px,#f5f7fb 100%);}
    button,input,select{font:inherit}
    button{cursor:pointer}
    .wrap{max-width:1520px;margin:0 auto;padding:28px 24px 72px}
    .hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;color:#fff;margin-bottom:20px}
    .eyebrow{display:inline-flex;gap:8px;align-items:center;padding:7px 12px;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(255,255,255,.08);color:#dbeafe}
    h1{font-size:36px;letter-spacing:-.04em;margin:14px 0 8px}
    .hero p{margin:0;color:#cbd5e1;max-width:900px}
    .hero-meta{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end}
    .meta-pill{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.09);border-radius:16px;padding:10px 12px;color:#e2e8f0}
    .tabs{position:sticky;top:0;z-index:20;display:flex;gap:8px;flex-wrap:wrap;padding:10px;margin:14px 0 18px;border:1px solid rgba(255,255,255,.55);border-radius:22px;background:rgba(255,255,255,.84);backdrop-filter:blur(16px);box-shadow:var(--shadow)}
    .tabs button{border:0;background:transparent;color:#475569;border-radius:14px;padding:10px 14px;font-weight:700}
    .tabs button.active{background:#0f172a;color:#fff}
    .metric-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin:18px 0}
    .metric-card{position:relative;overflow:hidden;background:var(--panel);border:1px solid rgba(255,255,255,.72);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;min-height:126px}
    .metric-card:after{content:"";position:absolute;right:-24px;top:-24px;width:86px;height:86px;border-radius:99px;background:rgba(37,99,235,.12)}
    .metric-label{color:var(--muted);font-size:13px;font-weight:700}
    .metric-value{font-size:29px;font-weight:900;margin:7px 0 4px;letter-spacing:-.03em}
    .metric-sub{color:#64748b;font-size:12px}.metric-card.red:after{background:rgba(220,38,38,.13)}.metric-card.green:after{background:rgba(22,163,74,.14)}.metric-card.orange:after{background:rgba(249,115,22,.14)}.metric-card.purple:after{background:rgba(124,58,237,.14)}
    .section{background:var(--panel);border:1px solid rgba(226,232,240,.9);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:18px}
    .section-head{display:flex;justify-content:space-between;align-items:center;gap:14px;margin-bottom:14px}
    .section h2{font-size:20px;margin:0;letter-spacing:-.02em}.section .sub{color:var(--muted)}
    .focus-lanes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
    .lane{border:1px solid var(--line);border-radius:20px;background:#f8fafc;padding:12px}
    .lane-head{display:flex;justify-content:space-between;align-items:center;font-weight:900;margin-bottom:10px}.lane-head b{background:#e0e7ff;color:#3730a3;border-radius:999px;padding:2px 8px}
    .mini-action{background:#fff;border:1px solid var(--line);border-radius:16px;padding:11px;margin-top:9px}
    .mini-action strong,.diag-card strong{display:block;margin-top:6px}.mini-action p,.diag-card p{margin:6px 0;color:#475569;font-size:12px}
    .toolbar{display:grid;grid-template-columns:1.2fr auto auto;gap:10px;margin-bottom:12px}
    input,select{border:1px solid var(--line);background:#fff;border-radius:14px;padding:11px 12px;outline:none;min-height:44px}
    input:focus,select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    .switch{border:1px solid var(--line);background:#fff;border-radius:14px;padding:0 14px;min-height:44px;font-weight:800;color:#475569}.switch.on{background:#0f172a;color:#fff;border-color:#0f172a}
    .filters{display:grid;grid-template-columns:1fr 1.4fr .9fr;gap:12px;margin-bottom:12px}.filter-box{border:1px solid var(--line);border-radius:18px;padding:12px;background:#f8fafc}.filter-title{font-size:12px;color:#64748b;font-weight:800;margin-bottom:8px}
    .chip-wrap{display:flex;gap:7px;flex-wrap:wrap}.filter-chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:7px 10px;color:#334155}.filter-chip span{color:#94a3b8;margin-left:4px}.filter-chip.active{background:#2563eb;color:#fff;border-color:#2563eb}.filter-chip.active span{color:#bfdbfe}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:18px;max-height:72vh}table{width:100%;border-collapse:separate;border-spacing:0;background:#fff}th,td{padding:12px 13px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f8fafc;z-index:2;color:#475569;font-size:12px;letter-spacing:.03em}tr:hover td{background:#f8fbff}
    small{display:block;color:#64748b}.store-badge{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:26px;border-radius:999px;background:#e0e7ff;color:#3730a3;font-weight:900;margin-right:5px}
    .priority{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:24px;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:900}.priority.high{background:#fee2e2;color:#991b1b}.priority.mid{background:#ffedd5;color:#9a3412}.priority.low{background:#dcfce7;color:#166534}
    .type-pill{display:inline-block;border-radius:999px;background:#f1f5f9;color:#334155;padding:4px 9px;font-size:12px;font-weight:800}.copy-skc{border:0;border-radius:10px;background:#111827;color:#fff;padding:7px 9px;font-family:Consolas,"SFMono-Regular",monospace;font-size:12px;white-space:nowrap}.copy-skc:empty{display:none}
    .goods-cell strong{display:block}.goods-cell span{display:block;color:#64748b;font-size:12px;max-width:260px}.evidence{color:#475569;min-width:220px}.empty-note{padding:24px;color:#64748b;text-align:center}
    .grid-2{display:grid;grid-template-columns:1.25fr .75fr;gap:16px}.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.chart{width:100%;height:auto;display:block}.bar-row{margin:12px 0}.bar-label{display:flex;justify-content:space-between;gap:10px}.bar-track{height:10px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:7px 0}.bar-track span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2563eb,#06b6d4)}
    .rank-list{list-style:none;margin:0;padding:0}.rank-list li{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.rank-list li span{width:24px;height:24px;border-radius:8px;background:#e0e7ff;color:#3730a3;display:flex;align-items:center;justify-content:center;font-weight:900}
    .diag-list{display:grid;gap:10px}.diag-card{border:1px solid var(--line);border-radius:18px;background:#fff;padding:12px}.diag-card small{margin-top:6px;color:#0f172a}
    .notice{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:18px;padding:14px;margin-bottom:14px}.notes li{margin:8px 0}.pos{color:#16a34a}.neg{color:#dc2626}
    [hidden]{display:none!important}
    @media (max-width:1180px){.metric-grid{grid-template-columns:repeat(3,1fr)}.focus-lanes,.grid-4{grid-template-columns:repeat(2,1fr)}.grid-2,.filters,.toolbar{grid-template-columns:1fr}.hero{display:block}.hero-meta{justify-content:flex-start;margin-top:14px}}
    @media (max-width:720px){.wrap{padding:18px 12px 48px}h1{font-size:28px}.metric-grid,.focus-lanes,.grid-4{grid-template-columns:1fr}.tabs{position:static}.section{padding:14px}.table-wrap{max-height:none}}
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <div class="eyebrow">本地网页经营台 v2</div>
        <h1>SHEIN 经营台</h1>
        <p>把销售统计、链接覆盖、优化候选和淘汰候选放在同一个页面里。默认展示“今日重点”，完整诊断池可按店铺、类型、优先级和 SKC 搜索。</p>
      </div>
      <div class="hero-meta">
        <div class="meta-pill">链接数据：${htmlEscape(payload.meta.linkDate)}</div>
        <div class="meta-pill">销售数据：${htmlEscape(payload.meta.salesDate)}</div>
        <div class="meta-pill">生成：${htmlEscape(payload.meta.generatedAt)}</div>
      </div>
    </section>

    <nav class="tabs" aria-label="经营台导航">
      <button data-tab="overview" class="active">总览</button>
      <button data-tab="actions">今日动作</button>
      <button data-tab="sales">销售经营</button>
      <button data-tab="links">链接诊断</button>
      <button data-tab="coverage">货号覆盖</button>
      <button data-tab="notes">数据说明</button>
    </nav>

    <section id="topMetrics" class="metric-grid"></section>

    <section id="tab-overview" class="tab-panel">
      <section class="section">
        <div class="section-head"><div><h2>今日重点</h2><div class="sub">不是每店机械凑数，而是按全局评分和动作类型预算挑重点。</div></div></div>
        <div id="focusLanes" class="focus-lanes"></div>
      </section>
      <section class="grid-2">
        <div class="section"><div class="section-head"><h2>销售趋势</h2><span class="sub">近30天</span></div><div id="salesTrend"></div></div>
        <div class="section"><div class="section-head"><h2>店铺今日排行</h2><span class="sub">销售 + 链接动作</span></div><div id="storeBars"></div></div>
      </section>
    </section>

    <section id="tab-actions" class="tab-panel" hidden>
      <section class="section">
        <div class="section-head"><div><h2>今日动作池</h2><div class="sub">默认只看今日重点；打开完整诊断池后可以看所有候选。</div></div><div id="actionCount" class="sub"></div></div>
        <div class="toolbar">
          <input id="search" placeholder="搜索 SKC、货号、店铺、原因，例如 sv25082988192111895">
          <button id="focusToggle" class="switch on" type="button" aria-pressed="true">只看今日重点</button>
          <select id="sortSelect" aria-label="排序">
            <option value="score">按优先级</option>
            <option value="store">按店铺</option>
            <option value="category">按动作类型</option>
          </select>
        </div>
        <div class="filters">
          <div class="filter-box"><div class="filter-title">店铺</div><div id="storeFilters" class="chip-wrap"></div></div>
          <div class="filter-box"><div class="filter-title">动作类型</div><div id="categoryFilters" class="chip-wrap"></div></div>
          <div class="filter-box"><div class="filter-title">优先级</div><div id="priorityFilters" class="chip-wrap"></div></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>店铺</th><th>SKC</th><th>货号 / 标题</th><th>优先级</th><th>类型</th><th>为什么</th><th>证据</th><th>建议动作</th></tr></thead>
            <tbody id="actionTableBody"></tbody>
          </table>
          <div id="actionEmpty" class="empty-note" hidden>当前筛选没有动作</div>
        </div>
      </section>
    </section>

    <section id="tab-sales" class="tab-panel" hidden>
      <section class="grid-2">
        <div class="section"><div class="section-head"><h2>近30天销售趋势</h2><span class="sub">SAR</span></div><div id="salesTrend2"></div></div>
        <div class="section"><div class="section-head"><h2>热销货号</h2><span class="sub">订单口径近30天</span></div><ol id="topProducts" class="rank-list"></ol></div>
      </section>
      <section class="section">
        <div class="section-head"><h2>店铺经营表</h2><span class="sub">销售、链接状态、今日重点合并看</span></div>
        <div class="table-wrap"><table><thead><tr><th>店铺</th><th>今日销售</th><th>近7天</th><th>链接 已上/待上/售罄</th><th>链接30天表现</th><th>动作 重点/全部</th></tr></thead><tbody id="storeTableBody"></tbody></table></div>
      </section>
    </section>

    <section id="tab-links" class="tab-panel" hidden>
      <div class="notice">库存菜单的准确展示库存尚未接入，当前不再用备货信息库存 0 生成库存低预警，避免再次误判。</div>
      <section class="grid-4">
        <div class="section"><div class="section-head"><h2>优化候选</h2></div><div id="optimizeList" class="diag-list"></div></div>
        <div class="section"><div class="section-head"><h2>淘汰候选</h2></div><div id="delistList" class="diag-list"></div></div>
        <div class="section"><div class="section-head"><h2>补链接</h2></div><div id="missingList" class="diag-list"></div></div>
        <div class="section"><div class="section-head"><h2>待上架卡点</h2></div><div id="blockedList" class="diag-list"></div></div>
      </section>
    </section>

    <section id="tab-coverage" class="tab-panel" hidden>
      <section class="section">
        <div class="section-head"><div><h2>货号覆盖矩阵</h2><div class="sub">只列“已有店铺在卖、其他店缺已上架链接”的货号；全部店都没上架的不提醒。</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>货号</th><th>已上架店铺</th><th>缺上架店铺</th><th>订单30天销量</th><th>链接30天销量</th><th>链接30天曝光</th><th>机会分</th></tr></thead><tbody id="coverageBody"></tbody></table></div>
      </section>
    </section>

    <section id="tab-notes" class="tab-panel" hidden>
      <section class="section">
        <div class="section-head"><h2>数据口径与规则</h2></div>
        <ul id="dataNotes" class="notes"></ul>
      </section>
    </section>
  </main>
  <script id="payload" type="application/json">${jsonForScript(payload)}</script>
  <script>${clientScript()}</script>
  <script>
    document.getElementById('salesTrend2').innerHTML = document.getElementById('salesTrend').innerHTML;
  </script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storesCfg = await readJson(STORES_PATH);
  const storeKeys = selectedStores(storesCfg, args).filter(Boolean).sort(storeSort);
  const {objects, missing: missingLinkFiles} = await loadLinkObjects(args, storeKeys);
  if (!objects.length) {
    throw new Error(`No link data found for ${args.date}. Expected under ${LINK_DIR}`);
  }
  const history = await loadSalesHistory(storeKeys, args.salesDate, 30);
  const monthlyReport = await readMonthlyReport(args.salesDate);
  const linkIdx = buildLinkIndexes(objects, storeKeys);
  const salesAgg = aggregateSales(history, storesCfg);
  const {actions, focus} = buildOperations(linkIdx, salesAgg, storeKeys, args);
  const coverageMatrix = buildCoverageMatrix(linkIdx, salesAgg, storeKeys);
  const storeCockpit = buildStoreCockpit(storesCfg, storeKeys, linkIdx, salesAgg, actions);
  const topLists = buildTopLists(actions, salesAgg, coverageMatrix, linkIdx, storeKeys);
  const fetchTime = objects.map(x => x.obj.fetchTime).filter(Boolean).sort().at(-1) || '';
  const payload = stripForJson({
    meta: {
      version: 'web-cockpit-v2-2026-05-01',
      linkDate: args.date,
      salesDate: args.salesDate,
      generatedAt: bjDateTime(),
      linkFetchTime: fetchTime,
      salesFetchTime: salesAgg.latestFetchTime,
      storeCount: storeKeys.length,
      missingLinkFiles,
      stockSourceStatus: '库存菜单未接入；备货信息库存仅沉淀，不触发预警',
    },
    kpis: buildKpis(linkIdx, salesAgg, actions, coverageMatrix, monthlyReport),
    sales: {
      totals: salesAgg.totals,
      todayChangeRate: salesAgg.todayChangeRate,
      last7ChangeRate: salesAgg.last7ChangeRate,
      trend: salesAgg.trend,
    },
    storeCockpit,
    actions,
    focusActions: focus,
    actionCounts: {
      byCategory: countBy(actions, a => a.category),
      byType: countBy(actions, a => a.type),
      byStore: countBy(actions, a => a.store),
      byPriority: countBy(actions, a => a.priority),
    },
    coverageMatrix,
    topLists,
  });

  await fs.mkdir(OUT_DIR, {recursive: true});
  const jsonFile = path.join(OUT_DIR, `link-ops-dashboard-${args.date}.json`);
  const htmlFile = path.join(OUT_DIR, `link-ops-dashboard-${args.date}.html`);
  const latestFile = path.join(OUT_DIR, 'index.html');
  await fs.writeFile(jsonFile, JSON.stringify(payload, null, 2), 'utf8');
  const html = renderHtml(payload);
  await fs.writeFile(htmlFile, html, 'utf8');
  await fs.writeFile(latestFile, html, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    version: payload.meta.version,
    linkDate: args.date,
    salesDate: args.salesDate,
    focusActions: payload.focusActions.length,
    actionPool: payload.actions.length,
    coverageRows: payload.coverageMatrix.length,
    htmlFile,
    latestFile,
    jsonFile,
  }, null, 2));
}

await main();
