#!/usr/bin/env node
/**
 * Create a Feishu/Lark Base native Dashboard that actually renders in frontend.
 *
 * Important lesson (2026-04-27):
 * Dashboard blocks created through OpenAPI can return success but fail in the
 * Feishu frontend when their chart config contains filters (especially date or
 * select filters) against normal fact tables. The frontend chart data API then
 * returns:
 *   fxdb table or field not found: [code=800008006] fieldValue is null,
 *   condition value is *expression.L
 *
 * This script keeps the deliverable as a native Base Dashboard, but feeds it
 * with tiny pre-aggregated "看板数据-*" tables. Dashboard blocks do no filtering;
 * they only aggregate/group simple text + number columns, which has been
 * verified to render in the Feishu frontend.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSn} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const FETCH_DIR = path.join(ROOT, 'outputs', 'shein_fetch');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');
const FX_SAR_TO_RMB = 1.8;
const PROFIT_RATE = 0.25;

function parseArgs(argv) {
  const args = {
    group: 'DSY',
    month: null,
    dashboardName: 'DSY经营看板 v6-正式版',
    themeStyle: 'futuristic',
    trendDays: 31,
    topProducts: 15,
    createDashboard: true,
    refreshSources: true,
    arrange: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--name') args.dashboardName = argv[++i];
    else if (a === '--theme-style') args.themeStyle = argv[++i];
    else if (a === '--trend-days') args.trendDays = Number(argv[++i]);
    else if (a === '--top-products') args.topProducts = Number(argv[++i]);
    else if (a === '--no-create-dashboard') args.createDashboard = false;
    else if (a === '--no-refresh-sources') args.refreshSources = false;
    else if (a === '--no-arrange') args.arrange = false;
  }
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new Error('Invalid --month, expected YYYY-MM');
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function round0(n) { return Math.round(Number(n || 0)); }

function beijingDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function beijingNowString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dateRange(start, end) {
  const out = [];
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop) {
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function monthDates(month) {
  return dateRange(`${month}-01`, `${month}-${pad2(daysInMonth(month))}`);
}

function currentMonth() {
  return beijingDate(0).slice(0, 7);
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in lark-cli output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

async function runLarkOnce(args, payloadName = null, payload = null) {
  const finalArgs = [...args];
  if (payload) {
    const file = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, file).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}

async function runLark(args, payloadName = null, payload = null, attempts = 5) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try { return await runLarkOnce(args, payloadName, payload); }
    catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const retryable = /limited|rate.?limit|800004135|EOF|ECONNRESET|ETIMEDOUT|timeout|503|502|504|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn|5000/i.test(msg);
      if (!retryable || i === attempts) break;
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
  throw lastError;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function textField(name) { return {type: 'text', name}; }
function numberField(name, precision = 2) {
  return {type: 'number', name, style: {type: 'plain', precision, percentage: false, thousands_separator: true}};
}

async function listTables(baseToken) {
  const resp = await runLark(['base', '+table-list', '--as', 'user', '--base-token', baseToken, '--offset', '0', '--limit', '100']);
  return resp.parsed?.data?.tables || [];
}

function stateTableId(state, name) {
  return state.tables?.[name]?.table_id || null;
}

async function ensureTable(state, baseToken, name, fields) {
  const known = stateTableId(state, name);
  if (known) return {tableId: known, created: false};
  const existing = (await listTables(baseToken)).find(t => t.name === name);
  if (existing?.id) {
    state.tables = state.tables || {};
    state.tables[name] = {table_id: existing.id, raw: {discovered: true}};
    await saveState(state);
    return {tableId: existing.id, created: false};
  }
  const resp = await runLark([
    'base', '+table-create',
    '--as', 'user',
    '--base-token', baseToken,
    '--name', name,
    '--fields', JSON.stringify(fields),
  ]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Cannot resolve table id after creating ${name}`);
  state.tables = state.tables || {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await saveState(state);
  return {tableId, created: true};
}

async function listRecordMap(baseToken, tableId) {
  const map = new Map();
  let offset = 0;
  while (true) {
    const resp = await runLark([
      'base', '+record-list',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--field-id', '唯一键',
      '--offset', String(offset),
      '--limit', '200',
      '--format', 'json',
    ]);
    const data = resp.parsed?.data || {};
    const rows = data.data || [];
    const ids = data.record_id_list || [];
    for (let i = 0; i < rows.length; i++) if (rows[i]?.[0] && ids[i]) map.set(rows[i][0], ids[i]);
    if (!data.has_more) break;
    offset += rows.length || 200;
  }
  return map;
}

async function batchCreate(baseToken, tableId, items) {
  const results = [];
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    if (!chunk.length) continue;
    const fields = Object.keys(chunk[0].record);
    const payload = {fields, rows: chunk.map(x => fields.map(f => x.record[f] ?? null))};
    const resp = await runLark([
      'base', '+record-batch-create',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
    ], `dashboard-source-create-${tableId}-${i}`, payload);
    const ids = resp.parsed?.data?.record_id_list || [];
    chunk.forEach((x, j) => results.push({uniqueKey: x.uniqueKey, action: 'created', recordId: ids[j] || null}));
  }
  return results;
}

async function upsertRecords(baseToken, tableId, records) {
  const existing = await listRecordMap(baseToken, tableId);
  const creates = [];
  const updates = [];
  for (const record of records) {
    const uniqueKey = record['唯一键'];
    const recordId = existing.get(uniqueKey);
    if (recordId) updates.push({uniqueKey, recordId, record});
    else creates.push({uniqueKey, record});
  }
  const results = [];
  results.push(...await batchCreate(baseToken, tableId, creates));
  for (const item of updates) {
    await runLark([
      'base', '+record-upsert',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--record-id', item.recordId,
    ], `dashboard-source-update-${item.uniqueKey}`, item.record);
    results.push({uniqueKey: item.uniqueKey, action: 'updated', recordId: item.recordId});
  }
  return results;
}

function getStores(storesConfig, group) {
  const meta = new Map(storesConfig.stores.map(s => [s.storeKey, s]));
  if (group === 'ALL') return storesConfig.stores.filter(s => s.enabled !== false);
  return (storesConfig.groups?.[group] || []).map(k => meta.get(k)).filter(Boolean);
}

async function readFetch(storeKey, date) {
  return await readJson(path.join(FETCH_DIR, storeKey, `${date}.json`));
}

async function loadStoreDay(store, date) {
  const obj = await readFetch(store.storeKey, date);
  const s = obj?.summary || {};
  return {
    storeKey: store.storeKey,
    salesSar: round2(s.salesSar || 0),
    salesRmb: round2((s.salesSar || 0) * FX_SAR_TO_RMB),
    orders: Number(s.positiveAmountOrderCount || 0),
    qty: Number(s.quantityPositiveAmount || 0),
  };
}

async function loadGroupDay(stores, date) {
  const rows = [];
  for (const store of stores) rows.push(await loadStoreDay(store, date));
  const salesSar = round2(rows.reduce((sum, r) => sum + r.salesSar, 0));
  return {
    date,
    rows,
    salesSar,
    salesRmb: round2(salesSar * FX_SAR_TO_RMB),
    orders: rows.reduce((sum, r) => sum + r.orders, 0),
    qty: rows.reduce((sum, r) => sum + r.qty, 0),
  };
}

async function loadGroupMonth(stores, month) {
  const totals = {salesSar: 0, orders: 0, qty: 0};
  for (const date of monthDates(month)) {
    const day = await loadGroupDay(stores, date);
    totals.salesSar = round2(totals.salesSar + day.salesSar);
    totals.orders += day.orders;
    totals.qty += day.qty;
  }
  const elapsed = Math.max(1, month === currentMonth() ? Number(beijingDate(0).slice(-2)) : daysInMonth(month));
  const avgSar = round2(totals.salesSar / elapsed);
  const predictedSar = round2(avgSar * daysInMonth(month));
  const predictedRmb = round2(predictedSar * FX_SAR_TO_RMB);
  return {
    salesSar: round2(totals.salesSar),
    salesRmb: round2(totals.salesSar * FX_SAR_TO_RMB),
    orders: totals.orders,
    qty: totals.qty,
    avgSar,
    predictedSar,
    predictedRmb,
    predictedProfitRmb: round2(predictedRmb * PROFIT_RATE),
  };
}

async function buildTrendRows(stores, month, trendDays) {
  const today = beijingDate(0);
  const lastDay = month === today.slice(0, 7) ? Number(today.slice(-2)) : daysInMonth(month);
  const startDay = Math.max(1, lastDay - trendDays + 1);
  const rows = [];
  for (let d = startDay; d <= lastDay; d++) {
    const date = `${month}-${pad2(d)}`;
    const day = await loadGroupDay(stores, date);
    rows.push({
      '唯一键': `trend-${pad2(d - startDay + 1)}`,
      '日期': date.slice(5),
      '完整日期': date,
      '排序': d - startDay + 1,
      '销售额SAR': day.salesSar,
      '销售额RMB': day.salesRmb,
      '有效订单数': day.orders,
      '销量': day.qty,
    });
  }
  return rows;
}

async function buildStoreRows(stores, month) {
  const totals = [];
  for (const store of stores) {
    let salesSar = 0, orders = 0, qty = 0;
    for (const date of monthDates(month)) {
      const d = await loadStoreDay(store, date);
      salesSar += d.salesSar;
      orders += d.orders;
      qty += d.qty;
    }
    totals.push({
      storeKey: store.storeKey,
      shopName: store.shopName,
      salesSar: round2(salesSar),
      salesRmb: round2(salesSar * FX_SAR_TO_RMB),
      orders,
      qty,
    });
  }
  totals.sort((a, b) => b.salesSar - a.salesSar || a.storeKey.localeCompare(b.storeKey));
  return totals.map((r, i) => ({
    '唯一键': `store-${r.storeKey}`,
    '排名': i + 1,
    '店铺代号': r.storeKey,
    '店铺名称': r.shopName || r.storeKey,
    '月销售额SAR': r.salesSar,
    '月销售额RMB': r.salesRmb,
    '有效订单数': r.orders,
    '销量': r.qty,
  }));
}

async function buildProductRows(stores, month, limit) {
  const byProduct = new Map();
  for (const store of stores.filter(s => s.productStatsEnabled !== false)) {
    for (const date of monthDates(month)) {
      const obj = await readFetch(store.storeKey, date);
      for (const g of obj?.goodsRows || []) {
        const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
        const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
        const qty = Number(g.number || 0);
        const salesSar = Number(g.currencyPrice || 0);
        if (!goodsSn || qty <= 0 || salesSar <= 0) continue;
        if (!byProduct.has(goodsSn)) byProduct.set(goodsSn, {goodsSn, title: String(g.goodsTitle || '').slice(0, 500), qty: 0, salesSar: 0});
        const row = byProduct.get(goodsSn);
        row.qty += qty;
        row.salesSar = round2(row.salesSar + salesSar);
        if (!row.title && g.goodsTitle) row.title = String(g.goodsTitle).slice(0, 500);
      }
    }
  }
  return [...byProduct.values()]
    .sort((a, b) => b.qty - a.qty || b.salesSar - a.salesSar || a.goodsSn.localeCompare(b.goodsSn, 'zh-CN'))
    .slice(0, limit)
    .map((r, i) => ({
      '唯一键': `product-${pad2(i + 1)}`,
      '排名': i + 1,
      '货号': r.goodsSn,
      '商品名称': r.title,
      '销量': round0(r.qty),
      '销售额SAR': round2(r.salesSar),
      '销售额RMB': round2(r.salesSar * FX_SAR_TO_RMB),
    }));
}

function buildHistoryRows(validation, limit = 12) {
  return (validation?.rows || [])
    .slice(-limit)
    .map((r, i) => ({
      '唯一键': `history-${pad2(i + 1)}`,
      '月份': r.month,
      '销售额SAR': round2(r.storeTotalSar),
      '销售额RMB': round2(r.storeTotalSar * FX_SAR_TO_RMB),
      '产品销售额SAR': round2(r.productTotalSar),
      '差异SAR': round2(r.diffSar),
      '销量': round0(r.productQty),
    }));
}

function coreFields() {
  return [
    textField('唯一键'), textField('统计月'), textField('更新时间'), textField('说明'),
    numberField('昨日销售额SAR'), numberField('昨日销售额RMB'),
    numberField('今日销售额SAR'), numberField('今日销售额RMB'),
    numberField('月累计SAR'), numberField('月累计RMB'),
    numberField('月日均SAR'), numberField('预测业绩SAR'), numberField('预测业绩RMB'), numberField('预测利润RMB'),
    numberField('昨日订单数', 0), numberField('今日订单数', 0), numberField('昨日销量', 0), numberField('今日销量', 0),
  ];
}

function trendFields() {
  return [textField('唯一键'), textField('日期'), textField('完整日期'), numberField('排序', 0), numberField('销售额SAR'), numberField('销售额RMB'), numberField('有效订单数', 0), numberField('销量', 0)];
}
function storeFields() {
  return [textField('唯一键'), numberField('排名', 0), textField('店铺代号'), textField('店铺名称'), numberField('月销售额SAR'), numberField('月销售额RMB'), numberField('有效订单数', 0), numberField('销量', 0)];
}
function productFields() {
  return [textField('唯一键'), numberField('排名', 0), textField('货号'), textField('商品名称'), numberField('销量', 0), numberField('销售额SAR'), numberField('销售额RMB')];
}
function historyFields() {
  return [textField('唯一键'), textField('月份'), numberField('销售额SAR'), numberField('销售额RMB'), numberField('产品销售额SAR'), numberField('差异SAR'), numberField('销量', 0)];
}

async function listDashboards(baseToken) {
  const resp = await runLark(['base', '+dashboard-list', '--as', 'user', '--base-token', baseToken]);
  return resp.parsed?.data?.items || resp.parsed?.items || [];
}

async function createDashboard(baseToken, name, themeStyle) {
  const resp = await runLark(['base', '+dashboard-create', '--as', 'user', '--base-token', baseToken, '--name', name, '--theme-style', themeStyle]);
  return resp.parsed?.data?.dashboard || resp.parsed?.data || resp.parsed?.dashboard;
}

async function listBlocks(baseToken, dashboardId) {
  const resp = await runLark(['base', '+dashboard-block-list', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId, '--page-size', '100']);
  return resp.parsed?.data?.items || resp.parsed?.items || [];
}

async function createBlock(baseToken, dashboardId, block) {
  const file = await writePayload(`native-dashboard-${block.name}`, block.dataConfig);
  const resp = await runLark([
    'base', '+dashboard-block-create',
    '--as', 'user',
    '--base-token', baseToken,
    '--dashboard-id', dashboardId,
    '--name', block.name,
    '--type', block.type,
    '--data-config', `@${path.relative(ROOT, file).replace(/\\/g, '/')}`,
  ]);
  return resp.parsed?.data?.block || resp.parsed?.block || resp.parsed?.data;
}

function sourceBlocks(month, tableNames) {
  return [
    {
      name: '更新时间',
      type: 'text',
      dataConfig: {text: [
        `**SHEIN 15店经营看板｜${month}**`,
        `更新时间：${beijingNowString()}（北京时间）｜金额单位：SAR / RMB`,
      ].join('\n')},
    },
    {name: '今日销售额 SAR', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '今日销售额SAR', rollup: 'SUM'}]}},
    {name: '今日销售额 RMB', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '今日销售额RMB', rollup: 'SUM'}]}},
    {name: '昨日销售额 SAR', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '昨日销售额SAR', rollup: 'SUM'}]}},
    {name: '昨日销售额 RMB', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '昨日销售额RMB', rollup: 'SUM'}]}},
    {name: '本月累计 SAR', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '月累计SAR', rollup: 'SUM'}]}},
    {name: '本月累计 RMB', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '月累计RMB', rollup: 'SUM'}]}},
    {name: '预测业绩 SAR', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '预测业绩SAR', rollup: 'SUM'}]}},
    {name: '预测业绩 RMB', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '预测业绩RMB', rollup: 'SUM'}]}},
    {name: '预测利润 RMB', type: 'statistics', dataConfig: {table_name: tableNames.core, series: [{field_name: '预测利润RMB', rollup: 'SUM'}]}},
    {
      name: '日销售趋势 SAR',
      type: 'line',
      dataConfig: {table_name: tableNames.trend, series: [{field_name: '销售额SAR', rollup: 'SUM'}], group_by: [{field_name: '日期', mode: 'integrated', sort: {type: 'group', order: 'asc'}}]},
    },
    {
      name: '店铺销售排行 SAR',
      type: 'bar',
      dataConfig: {table_name: tableNames.store, series: [{field_name: '月销售额SAR', rollup: 'SUM'}], group_by: [{field_name: '店铺代号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}]},
    },
    {
      name: '产品销量排行',
      type: 'bar',
      dataConfig: {table_name: tableNames.product, series: [{field_name: '销量', rollup: 'SUM'}], group_by: [{field_name: '货号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}]},
    },
    {
      name: '产品销售额排行 SAR',
      type: 'bar',
      dataConfig: {table_name: tableNames.product, series: [{field_name: '销售额SAR', rollup: 'SUM'}], group_by: [{field_name: '货号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}]},
    },
    {
      name: '历史月销趋势',
      type: 'column',
      dataConfig: {table_name: tableNames.history, series: [{field_name: '销售额SAR', rollup: 'SUM'}], group_by: [{field_name: '月份', mode: 'integrated', sort: {type: 'group', order: 'asc'}}]},
    },
    {
      name: '店铺订单排行',
      type: 'column',
      dataConfig: {table_name: tableNames.store, series: [{field_name: '有效订单数', rollup: 'SUM'}], group_by: [{field_name: '店铺代号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}]},
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const month = args.month || currentMonth();
  const group = args.group;
  const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const storesConfig = JSON.parse((await fs.readFile(STORES_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const baseToken = state.baseToken;
  const stores = getStores(storesConfig, group);
  const monthly = await readJson(path.join(REPORT_DIR, `monthly-sales-${month}.json`), {});
  const groupProductReport = await readJson(path.join(REPORT_DIR, `product-sales-${group}-${month}.json`), {});
  const legacyProductReport = await readJson(path.join(REPORT_DIR, `product-sales-${month}.json`), {});
  const productReport = groupProductReport?.group === group ? groupProductReport : (legacyProductReport?.group === group ? legacyProductReport : {});
  const validation = await readJson(path.join(REPORT_DIR, 'history-product-vs-store-validation.json'), {});
  const today = beijingDate(0);
  const yesterday = beijingDate(-1);
  const todayData = await loadGroupDay(stores, today);
  const yesterdayData = await loadGroupDay(stores, yesterday);
  const monthData = await loadGroupMonth(stores, month);

  const tableNames = {
    core: `看板数据-${group}-核心指标`,
    trend: `看板数据-${group}-日趋势`,
    store: `看板数据-${group}-店铺排行`,
    product: `看板数据-${group}-产品排行`,
    history: `看板数据-${group}-历史月销`,
  };
  const tableDefs = [
    [tableNames.core, coreFields()],
    [tableNames.trend, trendFields()],
    [tableNames.store, storeFields()],
    [tableNames.product, productFields()],
    [tableNames.history, historyFields()],
  ];

  const sourceResults = [];
  const ensured = {};
  for (const [name, fields] of tableDefs) {
    ensured[name] = await ensureTable(state, baseToken, name, fields);
  }

  if (args.refreshSources) {
    const coreRecord = {
      '唯一键': 'current',
      '统计月': month,
      '更新时间': beijingNowString(),
      '说明': 'Dashboard 专用聚合数据源；图表不再使用筛选条件，避免前端配置失效。',
      '昨日销售额SAR': yesterdayData.salesSar,
      '昨日销售额RMB': yesterdayData.salesRmb,
      '今日销售额SAR': todayData.salesSar,
      '今日销售额RMB': todayData.salesRmb,
      '月累计SAR': round2(monthly?.totals?.totalSar || 0),
      '月累计RMB': round2(monthly?.totals?.totalRmb || (monthly?.totals?.totalSar || 0) * FX_SAR_TO_RMB),
      '月日均SAR': round2(monthly?.totals?.avgSar || 0),
      '预测业绩SAR': round2(monthly?.totals?.predictedSar || 0),
      '预测业绩RMB': round2(monthly?.totals?.predictedRmb || 0),
      '预测利润RMB': round2(monthly?.totals?.predictedProfitRmb || ((monthly?.totals?.predictedRmb || 0) * PROFIT_RATE)),
      '昨日订单数': yesterdayData.orders,
      '今日订单数': todayData.orders,
      '昨日销量': yesterdayData.qty,
      '今日销量': todayData.qty,
    };
    const sourceRows = {
      [tableNames.core]: [coreRecord],
      [tableNames.trend]: await buildTrendRows(stores, month, args.trendDays),
      [tableNames.store]: await buildStoreRows(stores, month),
      [tableNames.product]: await buildProductRows(stores, month, args.topProducts),
      [tableNames.history]: buildHistoryRows(validation, 12),
    };
    for (const [name, rows] of Object.entries(sourceRows)) {
      const writes = await upsertRecords(baseToken, ensured[name].tableId, rows);
      sourceResults.push({name, tableId: ensured[name].tableId, rowCount: rows.length, writes: writes.length});
    }
  }

  let dashboardId = state.dashboards?.[args.dashboardName]?.dashboard_id || null;
  let dashboardCreated = false;
  let blockResults = [];
  let arrangeResult = null;
  if (args.createDashboard) {
    const existingDashboard = (await listDashboards(baseToken)).find(d => d.name === args.dashboardName);
    let dashboard = existingDashboard;
    if (!dashboard) {
      dashboard = await createDashboard(baseToken, args.dashboardName, args.themeStyle);
      dashboardCreated = true;
    }
    dashboardId = dashboard.dashboard_id || dashboard.id;
    const existingBlocks = await listBlocks(baseToken, dashboardId);
    const existingByName = new Map(existingBlocks.map(b => [b.name, b]));
    for (const block of sourceBlocks(month, tableNames)) {
      const existing = existingByName.get(block.name);
      if (existing) {
        blockResults.push({name: block.name, type: block.type, action: 'skipped_existing', blockId: existing.block_id || existing.id});
        continue;
      }
      const created = await createBlock(baseToken, dashboardId, block);
      blockResults.push({name: block.name, type: block.type, action: 'created', blockId: created?.block_id || created?.id || null});
    }
    if (args.arrange) {
      arrangeResult = (await runLark(['base', '+dashboard-arrange', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId])).parsed?.data;
    }
    state.dashboards = state.dashboards || {};
    state.dashboards[args.dashboardName] = {
      dashboard_id: dashboardId,
      month,
      group,
      source_tables: Object.fromEntries(Object.entries(tableNames).map(([k, name]) => [k, {name, table_id: ensured[name].tableId}])),
      updated_at: new Date().toISOString(),
      blocks: blockResults,
    };
    await saveState(state);
  }

  const result = {
    ok: true,
    group,
    month,
    dashboardName: args.dashboardName,
    dashboardId,
    dashboardCreated,
    dashboardUrl: dashboardId ? `https://zcnm3ts63aph.feishu.cn/base/${baseToken}?table=${dashboardId}` : null,
    sourceResults,
    blockResults,
    arranged: Boolean(arrangeResult),
    note: '原生 Dashboard 已改为读取看板专用聚合表；图表配置不使用 filter，避免前端“配置数据发生变更”。',
  };
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const reportFile = path.join(REPORT_DIR, `native-dashboard-${group}-${month}.json`);
  await fs.writeFile(reportFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({...result, reportFile: path.relative(ROOT, reportFile)}, null, 2));
}

await main();
