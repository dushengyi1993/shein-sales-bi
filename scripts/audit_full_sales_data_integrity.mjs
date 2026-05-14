#!/usr/bin/env node
/**
 * Full data-integrity audit for the SHEIN sales automation project.
 *
 * Coverage:
 * - all enabled stores and all local SHEIN fetch files
 * - store daily facts vs local fetch summaries
 * - product daily facts vs local goods rows after SKU normalization
 * - monthly/annual display tables vs facts
 * - product weekly/monthly wide tables vs product facts
 * - generic duplicate unique-key check for every Lark Base table in state
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';
import {isValidSalesGoodsRow, salesAmountSar, salesQuantity, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const EPS_MONEY = 0.05;
const EPS_QTY = 0.0001;

function parseArgs(argv) {
  const args = {checkAllTables: true};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-all-tables') args.checkAllTables = false;
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function moneyDiff(a, b) { return Math.abs(round2(a) - round2(b)); }
function qtyDiff(a, b) { return Math.abs(Number(a || 0) - Number(b || 0)); }
function localDateTimeString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function ymd(value) {
  const text = scalar(value);
  const m = text.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}
function monthOfDate(date) { return String(date || '').slice(0, 7); }
function dayOfDate(date) { return Number(String(date || '').slice(8, 10)); }
function isoWeekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const ys = new Date(Date.UTC(y, 0, 1));
  const w = Math.ceil((((d - ys) / 86400000) + 1) / 7);
  return `${y}-W${pad2(w)}`;
}
function scalar(value) {
  if (Array.isArray(value)) return value.map(v => scalar(v)).filter(Boolean).join(',');
  if (value && typeof value === 'object') {
    if ('text' in value) return String(value.text || '');
    if ('name' in value) return String(value.name || '');
    return JSON.stringify(value);
  }
  return value == null ? '' : String(value);
}
function num(value) {
  if (typeof value === 'number') return value;
  const text = scalar(value).replace(/,/g, '');
  if (!text) return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}
function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
function addAgg(map, key, patch) {
  if (!map.has(key)) map.set(key, {...patch});
  else {
    const cur = map.get(key);
    cur.salesSar = round2(Number(cur.salesSar || 0) + Number(patch.salesSar || 0));
    cur.qty = Number(cur.qty || 0) + Number(patch.qty || 0);
    cur.orders = Number(cur.orders || 0) + Number(patch.orders || 0);
  }
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in lark-cli output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}
async function runLarkOnce(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}
async function runLark(args, attempts = 5) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try { return await runLarkOnce(args); }
    catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const retryable = /limited|rate.?limit|EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily|503|502|504|5000|tls|x509|certificate/i.test(msg);
      if (!retryable || i === attempts) break;
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
  throw lastError;
}
async function listRecords(baseToken, tableId) {
  const out = [];
  let offset = 0;
  const limit = 200;
  let fields = [];
  while (true) {
    const resp = await runLark([
      'base', '+record-list',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--offset', String(offset),
      '--limit', String(limit),
      '--format', 'json',
    ]);
    const data = resp.parsed?.data || {};
    fields = data.fields || fields;
    const rows = data.data || [];
    const ids = data.record_id_list || [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const obj = {recordId: ids[i] || row?.record_id || row?.id || null};
      if (Array.isArray(row)) fields.forEach((name, idx) => { obj[name] = row[idx]; });
      else Object.assign(obj, row?.fields || row || {});
      out.push(obj);
    }
    if (!data.has_more) break;
    offset += rows.length || limit;
  }
  return {fields, rows: out};
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
async function loadLocalExpected(storesCfg) {
  const enabled = new Set(storesCfg.stores.filter(s => s.enabled !== false).map(s => s.storeKey));
  const localFiles = [];
  const storeMap = new Map(storesCfg.stores.map(s => [s.storeKey, s]));
  for (const storeKey of enabled) {
    const dir = path.join(FETCH_DIR, storeKey);
    if (!fssync.existsSync(dir)) continue;
    for (const entry of await fs.readdir(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(entry)) continue;
      const date = entry.slice(0, 10);
      const fullPath = path.join(dir, entry);
      const data = await readJson(fullPath, null);
      if (!data?.summary) continue;
      const store = storeMap.get(storeKey) || {};
      const summary = data.summary || {};
      const goodsSales = Array.isArray(data.goodsRows) ? summarizeSalesGoodsRows(data.goodsRows) : null;
      localFiles.push({date, storeKey, groupKey: store.groupKey || data.groupKey || '', file: fullPath, data});
      addAgg(localStoreExpected, `${date}__${storeKey}`, {
        date,
        storeKey,
        groupKey: store.groupKey || data.groupKey || '',
        salesSar: Number(goodsSales?.salesSar ?? summary.salesSar ?? 0),
        orders: Number(goodsSales?.positiveAmountOrderCount ?? summary.positiveAmountOrderCount ?? summary.orderCount ?? 0),
        qty: Number(goodsSales?.quantityPositiveAmount ?? summary.quantityPositiveAmount ?? summary.quantity ?? 0),
      });
      for (const g of data.goodsRows || []) {
        if (!isValidSalesGoodsRow(g)) continue;
        const qty = salesQuantity(g);
        const salesSar = salesAmountSar(g);
        const detail = normalizeGoodsSnDetailed(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '', {goodsTitle: g.goodsTitle});
        const goodsSn = detail.canonical;
        if (!goodsSn || qty <= 0 || salesSar <= 0) continue;
        addAgg(localProductExpected, `${date}__${storeKey}__${goodsSn}`, {
          date,
          storeKey,
          groupKey: store.groupKey || data.groupKey || '',
          goodsSn,
          salesSar,
          qty,
        });
      }
    }
  }
  return {localFiles};
}

const localStoreExpected = new Map();
const localProductExpected = new Map();

function issue(severity, code, message, details = {}) {
  issues.push({severity, code, message, details});
}
function check(condition, severity, code, message, details = {}) {
  if (!condition) issue(severity, code, message, details);
}

function auditDuplicateKeys(tableName, rows) {
  const duplicateKeys = [];
  for (const [key, group] of groupBy(rows, r => scalar(r['唯一键']).trim())) {
    if (group.length > 1) duplicateKeys.push({key, count: group.length, recordIds: group.map(r => r.recordId).filter(Boolean).slice(0, 10)});
  }
  if (duplicateKeys.length) {
    issue('error', 'BASE_UNIQUE_KEY_DUPLICATE', `${tableName} 存在重复唯一键`, {tableName, duplicateCount: duplicateKeys.length, samples: duplicateKeys.slice(0, 20)});
  }
  return duplicateKeys;
}

function compareStoreFact(rows) {
  const actual = new Map();
  for (const r of rows) {
    const key = scalar(r['唯一键']).trim();
    if (!key) continue;
    actual.set(key, {
      key,
      salesSar: num(r['销售额SAR']),
      orders: num(r['有效订单数']),
      qty: num(r['销量']),
      date: ymd(r['日期']),
      storeKey: scalar(r['店铺代号']).trim(),
    });
  }
  const missing = [];
  const mismatches = [];
  for (const [key, exp] of localStoreExpected) {
    const got = actual.get(key);
    if (!got) {
      missing.push(key);
      continue;
    }
    if (moneyDiff(got.salesSar, exp.salesSar) > EPS_MONEY || qtyDiff(got.orders, exp.orders) > EPS_QTY) {
      mismatches.push({key, expected: {salesSar: round2(exp.salesSar), orders: exp.orders}, actual: {salesSar: got.salesSar, orders: got.orders}});
    }
  }
  const stale = [...actual.keys()].filter(key => !localStoreExpected.has(key));
  check(missing.length === 0, 'error', 'STORE_FACT_MISSING_ROWS', '店铺日报事实缺少本地已抓取日期/店铺', {count: missing.length, samples: missing.slice(0, 30)});
  check(mismatches.length === 0, 'error', 'STORE_FACT_VALUE_MISMATCH', '店铺日报事实与本地抓取汇总不一致', {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(stale.length === 0, 'warn', 'STORE_FACT_STALE_ROWS', '店铺日报事实存在本地抓取文件之外的记录', {count: stale.length, samples: stale.slice(0, 30)});
}

function compareProductFact(rows) {
  const actual = new Map();
  const staleAliases = [];
  const review = [];
  for (const r of rows) {
    const key = scalar(r['唯一键']).trim();
    const goodsSn = scalar(r['货号']).trim();
    const detail = normalizeGoodsSnDetailed(goodsSn, {goodsTitle: scalar(r['商品名称'])});
    if (detail.canonical && detail.canonical !== goodsSn) staleAliases.push({key, goodsSn, canonical: detail.canonical});
    else if (detail.needsReview) review.push({key, goodsSn, reason: detail.reviewReason});
    if (!key) continue;
    actual.set(key, {key, goodsSn, salesSar: num(r['销售额SAR']), qty: num(r['销量'])});
  }
  const missing = [];
  const mismatches = [];
  for (const [key, exp] of localProductExpected) {
    const got = actual.get(key);
    if (!got) {
      missing.push(key);
      continue;
    }
    if (moneyDiff(got.salesSar, exp.salesSar) > EPS_MONEY || qtyDiff(got.qty, exp.qty) > EPS_QTY) {
      mismatches.push({key, expected: {salesSar: round2(exp.salesSar), qty: exp.qty}, actual: {salesSar: got.salesSar, qty: got.qty}});
    }
  }
  const stale = [...actual.keys()].filter(key => !localProductExpected.has(key));
  check(staleAliases.length === 0, 'error', 'PRODUCT_FACT_STALE_ALIAS', '产品日销量事实存在已确认旧别名残留', {count: staleAliases.length, samples: staleAliases.slice(0, 30)});
  check(review.length === 0, 'error', 'PRODUCT_FACT_SKU_NEEDS_REVIEW', '产品日销量事实存在无法确认/未归并货号', {count: review.length, samples: review.slice(0, 30)});
  check(missing.length === 0, 'error', 'PRODUCT_FACT_MISSING_ROWS', '产品日销量事实缺少本地商品聚合记录', {count: missing.length, samples: missing.slice(0, 30)});
  check(mismatches.length === 0, 'error', 'PRODUCT_FACT_VALUE_MISMATCH', '产品日销量事实与本地商品明细聚合不一致', {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(stale.length === 0, 'warn', 'PRODUCT_FACT_STALE_ROWS', '产品日销量事实存在本地商品聚合之外的记录', {count: stale.length, samples: stale.slice(0, 30)});
}

function factStoreByMonth() {
  const map = new Map();
  for (const [key, v] of localStoreExpected) {
    const m = monthOfDate(v.date);
    addAgg(map, `${m}__${v.storeKey}`, {...v, month: m});
  }
  return map;
}
function factProductByMonth() {
  const map = new Map();
  for (const [, v] of localProductExpected) {
    const m = monthOfDate(v.date);
    addAgg(map, `${m}__${v.groupKey}__${v.goodsSn}`, {...v, month: m});
  }
  return map;
}
function factProductByWeek() {
  const map = new Map();
  for (const [, v] of localProductExpected) {
    const wk = isoWeekKey(v.date);
    addAgg(map, `${wk}__${v.groupKey}__${v.goodsSn}`, {...v, yearWeek: wk});
  }
  return map;
}
function factProductWideByMonth() {
  const map = new Map();
  for (const [, v] of localProductExpected) {
    const m = monthOfDate(v.date);
    addAgg(map, `${v.groupKey}__${v.goodsSn}`, {...v, month: m, [m]: Number(v.qty || 0)});
    const item = map.get(`${v.groupKey}__${v.goodsSn}`);
    item[m] = Number(item[m] || 0) + 0; // already added through qty; reassigned below after safer path
  }
  const fixed = new Map();
  for (const [, v] of localProductExpected) {
    const m = monthOfDate(v.date);
    const key = `${v.groupKey}__${v.goodsSn}`;
    if (!fixed.has(key)) fixed.set(key, {groupKey: v.groupKey, goodsSn: v.goodsSn, totalQty: 0, months: {}});
    const item = fixed.get(key);
    item.totalQty += Number(v.qty || 0);
    item.months[m] = Number(item.months[m] || 0) + Number(v.qty || 0);
  }
  return fixed;
}
function factProductWideByWeek() {
  const fixed = new Map();
  for (const [, v] of localProductExpected) {
    const wk = isoWeekKey(v.date);
    const key = `${v.groupKey}__${v.goodsSn}`;
    if (!fixed.has(key)) fixed.set(key, {groupKey: v.groupKey, goodsSn: v.goodsSn, totalQty: 0, weeks: {}});
    const item = fixed.get(key);
    item.totalQty += Number(v.qty || 0);
    item.weeks[wk] = Number(item.weeks[wk] || 0) + Number(v.qty || 0);
  }
  return fixed;
}

function compareStoreMonthDisplay(tableName, fields, rows) {
  const monthMatch = tableName.match(/月度日销-(\d{4}-\d{2})$/);
  const yearMatch = tableName.match(/月度日销-(\d{4})汇总$/);
  const expectedMonthStore = factStoreByMonth();
  const mismatches = [];
  const staleAliases = [];
  for (const r of rows) {
    if (scalar(r['币种']) && scalar(r['币种']) !== 'SAR') continue;
    if (scalar(r['行类型']) && scalar(r['行类型']) !== '店铺') continue;
    const storeKey = scalar(r['主体/店铺']).trim();
    const month = monthMatch ? monthMatch[1] : scalar(r['月份']).trim();
    if (!storeKey || !month) continue;
    const exp = expectedMonthStore.get(`${month}__${storeKey}`);
    if (!exp) {
      staleAliases.push({key: scalar(r['唯一键']), month, storeKey});
      continue;
    }
    if (moneyDiff(num(r['合计']), exp.salesSar) > EPS_MONEY) {
      mismatches.push({key: scalar(r['唯一键']), month, storeKey, field: '合计', expected: round2(exp.salesSar), actual: num(r['合计'])});
    }
    const dayFields = fields.filter(f => /^\d{1,2}(?:\.\d{1,2})?$/.test(f));
    for (const field of dayFields) {
      const day = field.includes('.') ? Number(field.split('.')[1]) : Number(field);
      if (!day) continue;
      const dayKey = `${month}-${pad2(day)}__${storeKey}`;
      const expDay = localStoreExpected.get(dayKey)?.salesSar || 0;
      const got = num(r[field]);
      if (moneyDiff(got, expDay) > EPS_MONEY) {
        mismatches.push({key: scalar(r['唯一键']), month, storeKey, field, expected: round2(expDay), actual: got});
        if (mismatches.length > 100) break;
      }
    }
  }
  check(mismatches.length === 0, 'error', 'STORE_MONTH_TABLE_MISMATCH', `${tableName} 与店铺事实聚合不一致`, {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(staleAliases.length === 0, 'warn', 'STORE_MONTH_TABLE_STALE_ROWS', `${tableName} 存在事实表之外的店铺/月行`, {count: staleAliases.length, samples: staleAliases.slice(0, 30)});
}

function compareProductMonthDisplay(tableName, fields, rows) {
  const monthMatch = tableName.match(/产品日销量-(\d{4}-\d{2})$/);
  const expectedMonthProduct = factProductByMonth();
  const mismatches = [];
  const staleRows = [];
  const staleAliases = [];
  const review = [];
  for (const r of rows) {
    const goodsSn = scalar(r['货号']).trim();
    const groupKey = scalar(r['分组']).trim();
    const month = monthMatch ? monthMatch[1] : scalar(r['月份']).trim();
    if (!goodsSn || !groupKey || !month) continue;
    const detail = normalizeGoodsSnDetailed(goodsSn, {goodsTitle: scalar(r['商品名称'])});
    if (detail.canonical && detail.canonical !== goodsSn) staleAliases.push({key: scalar(r['唯一键']), goodsSn, canonical: detail.canonical});
    else if (detail.needsReview) review.push({key: scalar(r['唯一键']), goodsSn, reason: detail.reviewReason});
    const exp = expectedMonthProduct.get(`${month}__${groupKey}__${goodsSn}`);
    if (!exp) {
      staleRows.push({key: scalar(r['唯一键']), month, groupKey, goodsSn});
      continue;
    }
    if (qtyDiff(num(r['合计销量']), exp.qty) > EPS_QTY || moneyDiff(num(r['合计销售额SAR']), exp.salesSar) > EPS_MONEY) {
      mismatches.push({key: scalar(r['唯一键']), month, groupKey, goodsSn, expected: {qty: exp.qty, salesSar: round2(exp.salesSar)}, actual: {qty: num(r['合计销量']), salesSar: num(r['合计销售额SAR'])}});
    }
    const dayFields = fields.filter(f => /^\d{1,2}(?:\.\d{1,2})?$/.test(f));
    for (const field of dayFields) {
      const day = field.includes('.') ? Number(field.split('.')[1]) : Number(field);
      if (!day) continue;
      let expQty = 0;
      for (const [, v] of localProductExpected) {
        if (v.date === `${month}-${pad2(day)}` && v.groupKey === groupKey && v.goodsSn === goodsSn) expQty += Number(v.qty || 0);
      }
      const got = num(r[field]);
      if (qtyDiff(got, expQty) > EPS_QTY) {
        mismatches.push({key: scalar(r['唯一键']), month, groupKey, goodsSn, field, expected: expQty, actual: got});
        if (mismatches.length > 100) break;
      }
    }
  }
  check(staleAliases.length === 0, 'error', 'PRODUCT_MONTH_TABLE_STALE_ALIAS', `${tableName} 存在旧别名残留`, {count: staleAliases.length, samples: staleAliases.slice(0, 30)});
  check(review.length === 0, 'error', 'PRODUCT_MONTH_TABLE_SKU_REVIEW', `${tableName} 存在未确认货号`, {count: review.length, samples: review.slice(0, 30)});
  check(mismatches.length === 0, 'error', 'PRODUCT_MONTH_TABLE_MISMATCH', `${tableName} 与产品事实聚合不一致`, {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(staleRows.length === 0, 'warn', 'PRODUCT_MONTH_TABLE_STALE_ROWS', `${tableName} 存在产品事实之外的行`, {count: staleRows.length, samples: staleRows.slice(0, 30)});
}

function compareProductMonthlyWide(fields, rows) {
  const expected = factProductWideByMonth();
  const monthFields = fields.filter(f => /^\d{4}-\d{2}$/.test(f));
  const mismatches = [];
  const staleRows = [];
  for (const r of rows) {
    const groupKey = scalar(r['分组']).trim();
    const goodsSn = scalar(r['货号']).trim();
    const key = `${groupKey}__${goodsSn}`;
    const exp = expected.get(key);
    if (!exp) {
      staleRows.push({key: scalar(r['唯一键']), groupKey, goodsSn});
      continue;
    }
    if (qtyDiff(num(r['合计销量']), exp.totalQty) > EPS_QTY) {
      mismatches.push({key, field: '合计销量', expected: exp.totalQty, actual: num(r['合计销量'])});
    }
    for (const m of monthFields) {
      const expectedQty = Number(exp.months[m] || 0);
      const got = num(r[m]);
      if (qtyDiff(got, expectedQty) > EPS_QTY) mismatches.push({key, field: m, expected: expectedQty, actual: got});
    }
  }
  const actualKeys = new Set(rows.map(r => `${scalar(r['分组']).trim()}__${scalar(r['货号']).trim()}`));
  const missing = [...expected.keys()].filter(k => !actualKeys.has(k));
  check(mismatches.length === 0, 'error', 'PRODUCT_MONTHLY_WIDE_MISMATCH', '产品月销量-宽表 与产品事实聚合不一致', {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(staleRows.length === 0, 'warn', 'PRODUCT_MONTHLY_WIDE_STALE_ROWS', '产品月销量-宽表 存在产品事实之外的行', {count: staleRows.length, samples: staleRows.slice(0, 30)});
  check(missing.length === 0, 'error', 'PRODUCT_MONTHLY_WIDE_MISSING_ROWS', '产品月销量-宽表 缺少产品事实中的分组货号行', {count: missing.length, samples: missing.slice(0, 30)});
}

function compareProductWeeklyWide(fields, rows) {
  const expected = factProductWideByWeek();
  const weekFields = fields.filter(f => /^\d{4}-W\d{2}$/.test(f));
  const mismatches = [];
  const staleRows = [];
  for (const r of rows) {
    const groupKey = scalar(r['分组']).trim();
    const goodsSn = scalar(r['货号']).trim();
    const key = `${groupKey}__${goodsSn}`;
    const exp = expected.get(key);
    if (!exp) {
      staleRows.push({key: scalar(r['唯一键']), groupKey, goodsSn});
      continue;
    }
    if (qtyDiff(num(r['合计销量']), exp.totalQty) > EPS_QTY) {
      mismatches.push({key, field: '合计销量', expected: exp.totalQty, actual: num(r['合计销量'])});
    }
    for (const wk of weekFields) {
      const expectedQty = Number(exp.weeks[wk] || 0);
      const got = num(r[wk]);
      if (qtyDiff(got, expectedQty) > EPS_QTY) mismatches.push({key, field: wk, expected: expectedQty, actual: got});
    }
  }
  const actualKeys = new Set(rows.map(r => `${scalar(r['分组']).trim()}__${scalar(r['货号']).trim()}`));
  const missing = [...expected.keys()].filter(k => !actualKeys.has(k));
  check(mismatches.length === 0, 'error', 'PRODUCT_WEEKLY_WIDE_MISMATCH', '产品周销量-宽表 与产品事实聚合不一致', {count: mismatches.length, samples: mismatches.slice(0, 30)});
  check(staleRows.length === 0, 'warn', 'PRODUCT_WEEKLY_WIDE_STALE_ROWS', '产品周销量-宽表 存在产品事实之外的行', {count: staleRows.length, samples: staleRows.slice(0, 30)});
  check(missing.length === 0, 'error', 'PRODUCT_WEEKLY_WIDE_MISSING_ROWS', '产品周销量-宽表 缺少产品事实中的分组货号行', {count: missing.length, samples: missing.slice(0, 30)});
}

const args = parseArgs(process.argv.slice(2));
const issues = [];
const state = await readJson(STATE_PATH, {});
const storesCfg = await readJson(STORES_PATH, {});
const baseToken = state.baseToken || state.baseCreateResponse?.data?.base?.base_token;
if (!baseToken) throw new Error('Cannot resolve base token');

const enabledStores = storesCfg.stores.filter(s => s.enabled !== false).map(s => s.storeKey);
await loadLocalExpected(storesCfg);

const tableReports = [];
async function fetchTable(name) {
  const tableId = state.tables?.[name]?.table_id;
  if (!tableId) {
    issue('warn', 'TABLE_NOT_IN_STATE', `state 中没有表 ${name}`, {name});
    return null;
  }
  const data = await listRecords(baseToken, tableId);
  tableReports.push({name, tableId, rowCount: data.rows.length, fields: data.fields});
  return {name, tableId, ...data};
}

const configuredAllStores = Array.isArray(storesCfg.groups?.ALL) ? storesCfg.groups.ALL : enabledStores;
check(
  enabledStores.length === configuredAllStores.length && configuredAllStores.every(storeKey => enabledStores.includes(storeKey)),
  'error',
  'ENABLED_STORE_GROUP_ALL_MISMATCH',
  '启用店铺与 groups.ALL 配置不一致',
  {enabledStores, configuredAllStores},
);
check(localStoreExpected.size > 0, 'error', 'NO_LOCAL_STORE_EXPECTED', '没有读到本地店铺抓取数据', {});
check(localProductExpected.size > 0, 'error', 'NO_LOCAL_PRODUCT_EXPECTED', '没有读到本地产品抓取数据', {});

const storeFact = await fetchTable('店铺日报事实');
if (storeFact) {
  auditDuplicateKeys(storeFact.name, storeFact.rows);
  compareStoreFact(storeFact.rows);
}

const productFact = await fetchTable('产品日销量事实');
if (productFact) {
  auditDuplicateKeys(productFact.name, productFact.rows);
  compareProductFact(productFact.rows);
}

for (const name of Object.keys(state.tables || {}).filter(n => /^月度日销-\d{4}-\d{2}$/.test(n) || /^月度日销-\d{4}汇总$/.test(n)).sort()) {
  const t = await fetchTable(name);
  if (t) {
    auditDuplicateKeys(t.name, t.rows);
    compareStoreMonthDisplay(t.name, t.fields, t.rows);
  }
}

for (const name of Object.keys(state.tables || {}).filter(n => /^产品日销量-\d{4}-\d{2}$/.test(n) || /^产品日销量-\d{4}汇总$/.test(n)).sort()) {
  const t = await fetchTable(name);
  if (t) {
    auditDuplicateKeys(t.name, t.rows);
    compareProductMonthDisplay(t.name, t.fields, t.rows);
  }
}

const monthlyWide = await fetchTable('产品月销量-宽表');
if (monthlyWide) {
  auditDuplicateKeys(monthlyWide.name, monthlyWide.rows);
  compareProductMonthlyWide(monthlyWide.fields, monthlyWide.rows);
}

const weeklyWide = await fetchTable('产品周销量-宽表');
if (weeklyWide) {
  auditDuplicateKeys(weeklyWide.name, weeklyWide.rows);
  compareProductWeeklyWide(weeklyWide.fields, weeklyWide.rows);
}

if (args.checkAllTables) {
  for (const [name, meta] of Object.entries(state.tables || {})) {
    if (tableReports.some(t => t.name === name)) continue;
    if (!meta?.table_id) continue;
    const t = await listRecords(baseToken, meta.table_id);
    tableReports.push({name, tableId: meta.table_id, rowCount: t.rows.length, fields: t.fields});
    if (t.fields.includes('唯一键') || t.rows.some(r => r['唯一键'] != null)) {
      auditDuplicateKeys(name, t.rows);
    }
  }
}

const errors = issues.filter(i => i.severity === 'error');
const warnings = issues.filter(i => i.severity === 'warn');
const localDates = [...new Set([...localStoreExpected.values()].map(v => v.date))].sort();
const localMonths = [...new Set(localDates.map(d => d.slice(0, 7)))].sort();
const report = {
  ok: errors.length === 0 && warnings.length === 0,
  checkedAt: localDateTimeString(),
  enabledStores,
  localCoverage: {
    firstDate: localDates[0] || '',
    lastDate: localDates.at(-1) || '',
    dateCount: localDates.length,
    months: localMonths,
    storeDayKeys: localStoreExpected.size,
    productDayStoreSkuKeys: localProductExpected.size,
  },
  tableCount: tableReports.length,
  tableReports,
  issueCount: issues.length,
  errorCount: errors.length,
  warningCount: warnings.length,
  issues,
};

await fs.mkdir(REPORT_DIR, {recursive: true});
const reportFile = path.join(REPORT_DIR, `full-sales-data-integrity-audit-${localDateTimeString().slice(0, 10)}.json`);
await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: report.ok,
  checkedAt: report.checkedAt,
  localCoverage: report.localCoverage,
  tableCount: report.tableCount,
  issueCount: report.issueCount,
  errorCount: report.errorCount,
  warningCount: report.warningCount,
  issues: issues.slice(0, 50),
  reportFile: path.relative(ROOT, reportFile),
}, null, 2));

process.exit(report.ok ? 0 : 2);
