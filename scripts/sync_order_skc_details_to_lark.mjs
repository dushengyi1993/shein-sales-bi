#!/usr/bin/env node
/**
 * Sync local SHEIN fetch detail JSON into order-level and SKC/link-level
 * fact tables. This is a bottom data layer for returns, cost/profit, traffic
 * and SKC performance analysis; dashboards should read aggregated tables.
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
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const FX_SAR_TO_RMB = 1.8;

function parseArgs(argv) {
  const args = {group: 'DSY', writeOrders: true, writeGoods: true, writeSkcMap: true};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--no-orders') args.writeOrders = false;
    else if (a === '--no-goods') args.writeGoods = false;
    else if (a === '--no-skc-map') args.writeSkcMap = false;
  }
  if (args.file) return args;
  if (args.date) { args.start = args.date; args.end = args.date; }
  if (args.month) {
    args.start = `${args.month}-01`;
    args.end = `${args.month}-${pad2(daysInMonth(args.month))}`;
  }
  if (!args.start || !args.end) throw new Error('Use --file, --date, --month, or --start/--end');
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function* eachDate(start, end) {
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop) {
    yield `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

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
    const payloadFile = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, payloadFile).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli ${code}`));
      else resolve({stdout, stderr, parsed});
    });
    child.on('error', reject);
  });
}
async function runLark(args, payloadName = null, payload = null, attempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await runLarkOnce(args, payloadName, payload); }
    catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const rateLimited = /limited|rate.?limit|800004135|OpenAPISearchRecord limited/i.test(msg);
      const retryable = rateLimited || /EOF|ECONNRESET|ETIMEDOUT|timeout|503|502|504|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn/i.test(msg);
      if (!retryable || attempt === attempts) break;
      await new Promise(r => setTimeout(r, rateLimited ? attempt * 10000 : attempt * 1500));
    }
  }
  throw lastError;
}

async function readJsonIfExists(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}
function selectedStores(storesConfig, args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  if (args.stores?.length) return args.stores.map(k => {
    const s = enabled.find(x => x.storeKey.toUpperCase() === k);
    if (!s) throw new Error(`Unknown or disabled store ${k}`);
    return s;
  });
  if (args.group === 'ALL') return enabled;
  return (storesConfig.groups?.[args.group] || []).map(k => enabled.find(s => s.storeKey === k)).filter(Boolean);
}

async function listRecordMap(baseToken, tableId) {
  const map = new Map();
  let offset = 0;
  while (true) {
    const resp = await runLark([
      'base', '+record-list', '--as', 'user', '--base-token', baseToken, '--table-id', tableId,
      '--field-id', '唯一键', '--offset', String(offset), '--limit', '200', '--format', 'json',
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
      'base', '+record-batch-create', '--as', 'user', '--base-token', baseToken, '--table-id', tableId,
    ], `order-skc-create-${tableId}-${i}`, payload);
    const ids = resp.parsed?.data?.record_id_list || [];
    chunk.forEach((x, j) => results.push({uniqueKey: x.uniqueKey, action: 'created', recordId: ids[j] || null}));
  }
  return results;
}
async function updateRecord(baseToken, tableId, recordId, record, uniqueKey) {
  await runLark([
    'base', '+record-upsert', '--as', 'user', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId,
  ], `order-skc-update-${uniqueKey}`, record);
  return {uniqueKey, action: 'updated', recordId};
}
async function upsertRecords(baseToken, tableId, records) {
  if (!records.length) return [];
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
  results.push(...await batchCreate(baseToken, tableId, creates.map(x => ({uniqueKey: x.uniqueKey, record: x.record}))));
  for (const u of updates) results.push(await updateRecord(baseToken, tableId, u.recordId, u.record, u.uniqueKey));
  return results;
}

function businessDateFromFile(obj, fallback) {
  return obj?.start || fallback;
}
function validGoods(g) {
  return Number(g?.number || 0) > 0 && Number(g?.currencyPrice || 0) > 0;
}
function orderKey(storeKey, orderNo, orderId) {
  return `${storeKey}__${orderNo || orderId}`;
}
function goodsKey(storeKey, orderNo, orderId, g, index) {
  return `${storeKey}__${orderNo || orderId}__${g.goodsId || g.entityId || g.skcName || g.skuCode || index}`;
}
function skcKey(storeKey, g) {
  return `${storeKey}__${g.skcName || ''}__${g.skuCode || ''}__${g.entityId || g.goodsId || ''}`;
}

function buildRows(files) {
  const orderMap = new Map();
  const goodsRows = [];
  const skcMap = new Map();
  for (const {file, obj, store} of files) {
    const date = businessDateFromFile(obj, path.basename(file, '.json'));
    for (const [i, g] of (obj.goodsRows || []).entries()) {
      const goodsSn = normalizeGoodsSn(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '', {goodsTitle: g.goodsTitle});
      const rawGoodsSn = String(g.goodsSn || '').trim();
      const qty = Number(g.number || 0);
      const sar = round2(Number(g.currencyPrice || 0));
      const isValid = validGoods(g);
      const orderNo = g.orderNo || g.billno || g.orderId;
      const ok = orderKey(store.storeKey, orderNo, g.orderId);
      if (!orderMap.has(ok)) {
        orderMap.set(ok, {
          store, date, orderNo, orderId: g.orderId, orderCreateTime: g.orderCreateTime || g.allocateTimeFull || g.allocateTime,
          orderCustomerTime: g.orderCustomerTime || '', site: g.site || '', orderStatus: g.orderStatusDesc || String(g.orderStatus || ''),
          performStatus: g.performStatusDesc || String(g.performStatus || ''), salesSar: 0, goodsLines: 0, qty: 0, valid: false,
          fetchTime: obj.fetchTime || '',
        });
      }
      const o = orderMap.get(ok);
      o.salesSar = round2(o.salesSar + sar);
      o.goodsLines += 1;
      o.qty += qty;
      if (isValid) o.valid = true;
      goodsRows.push({
        '唯一键': goodsKey(store.storeKey, orderNo, g.orderId, g, i),
        '订单号': orderNo || '',
        '订单ID': String(g.orderId || ''),
        '分组': store.groupKey,
        '店铺代号': store.storeKey,
        '店铺名称': store.shopName || '',
        '日期': date,
        '订单创建时间': g.orderCreateTime || g.allocateTimeFull || g.allocateTime || '',
        '货号': goodsSn,
        '原始货号': rawGoodsSn,
        'SKC': String(g.skcName || ''),
        'SKU Code': String(g.skuCode || ''),
        'SKU Sn': String(g.skuSn || ''),
        '商品ID': String(g.goodsId || ''),
        'Entity ID': String(g.entityId || ''),
        '规格': String(g.suffix || '').slice(0, 1000),
        '商品名称': String(g.goodsTitle || '').slice(0, 1000),
        '销量': qty,
        '币种': g.currencyCode || 'SAR',
        '销售额SAR': sar,
        '销售额RMB': round2(sar * FX_SAR_TO_RMB),
        '是否有效销售': isValid,
        '商品状态': String(g.newOrderGoodsStatus || ''),
        '履约状态': g.goodsPerformanceStatusDesc || String(g.goodsPerformanceStatus || ''),
        '售后单号': String(g.aftersalesOrderNo || ''),
        '退货单号': String(g.returnOrderNo || ''),
        '抓取时间': obj.fetchTime || '',
        '备注': `source=${path.relative(ROOT, file)}`,
      });
      const sk = skcKey(store.storeKey, g);
      if (!skcMap.has(sk)) {
        skcMap.set(sk, {
          '唯一键': sk, '分组': store.groupKey, '店铺代号': store.storeKey, '店铺名称': store.shopName || '',
          '货号': goodsSn, 'SKC': String(g.skcName || ''), 'SKU Code': String(g.skuCode || ''), 'SKU Sn': String(g.skuSn || ''),
          '商品ID': String(g.goodsId || ''), 'Entity ID': String(g.entityId || ''), '规格': String(g.suffix || '').slice(0, 1000),
          '商品名称': String(g.goodsTitle || '').slice(0, 1000), '累计销量': 0, '累计销售额SAR': 0, '累计销售额RMB': 0,
          '首次订单日期': date, '最近订单日期': date, '更新时间': obj.fetchTime || new Date().toISOString(), '备注': '',
        });
      }
      const skc = skcMap.get(sk);
      skc['累计销量'] += qty;
      skc['累计销售额SAR'] = round2(skc['累计销售额SAR'] + sar);
      skc['累计销售额RMB'] = round2(skc['累计销售额SAR'] * FX_SAR_TO_RMB);
      if (date < skc['首次订单日期']) skc['首次订单日期'] = date;
      if (date > skc['最近订单日期']) skc['最近订单日期'] = date;
      skc['更新时间'] = obj.fetchTime || new Date().toISOString();
    }
  }
  const orderRows = [...orderMap.values()].map(o => ({
    '唯一键': orderKey(o.store.storeKey, o.orderNo, o.orderId),
    '订单号': String(o.orderNo || ''),
    '订单ID': String(o.orderId || ''),
    '分组': o.store.groupKey,
    '店铺代号': o.store.storeKey,
    '店铺名称': o.store.shopName || '',
    '日期': o.date,
    '订单创建时间': o.orderCreateTime || '',
    '客户下单时间': o.orderCustomerTime || '',
    '站点': o.site || '',
    '订单状态': o.orderStatus || '',
    '履约状态': o.performStatus || '',
    '订单销售额SAR': round2(o.salesSar),
    '订单销售额RMB': round2(o.salesSar * FX_SAR_TO_RMB),
    '商品行数': o.goodsLines,
    '销量': o.qty,
    '是否有效销售': o.valid,
    '抓取时间': o.fetchTime || '',
    '备注': '',
  }));
  return {orderRows, goodsRows, skcRows: [...skcMap.values()]};
}

async function loadInputFiles(args, storesConfig) {
  if (args.file) {
    const obj = await readJsonIfExists(path.resolve(args.file));
    const key = obj?.storeKey;
    const store = storesConfig.stores.find(s => s.storeKey === key) || {storeKey: key, shopName: obj?.shopName, groupKey: obj?.groupKey};
    return [{file: path.resolve(args.file), obj, store}];
  }
  const stores = selectedStores(storesConfig, args);
  const files = [];
  for (const store of stores) {
    for (const date of eachDate(args.start, args.end)) {
      const file = path.join(FETCH_DIR, store.storeKey, `${date}.json`);
      const obj = await readJsonIfExists(file);
      if (obj?.goodsRows) files.push({file, obj, store});
    }
  }
  return files;
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
const storesConfig = JSON.parse((await fs.readFile(STORES_PATH, 'utf8')).replace(/^\uFEFF/, ''));
const baseToken = state.baseToken;
const tableIds = {
  orders: state.tables?.['订单明细事实']?.table_id,
  goods: state.tables?.['订单商品SKC明细事实']?.table_id,
  skc: state.tables?.['SKC链接映射']?.table_id,
};
if (args.writeOrders && !tableIds.orders) throw new Error('Missing table: 订单明细事实');
if (args.writeGoods && !tableIds.goods) throw new Error('Missing table: 订单商品SKC明细事实');
if (args.writeSkcMap && !tableIds.skc) throw new Error('Missing table: SKC链接映射');

const files = await loadInputFiles(args, storesConfig);
const rows = buildRows(files);
const writes = {};
if (args.writeOrders) writes.orders = await upsertRecords(baseToken, tableIds.orders, rows.orderRows);
if (args.writeGoods) writes.goods = await upsertRecords(baseToken, tableIds.goods, rows.goodsRows);
if (args.writeSkcMap) writes.skc = await upsertRecords(baseToken, tableIds.skc, rows.skcRows);

const report = {
  generatedAt: new Date().toISOString(),
  input: {date: args.date || null, month: args.month || null, start: args.start || null, end: args.end || null, group: args.group, stores: args.stores || null, file: args.file || null},
  fileCount: files.length,
  orderRows: rows.orderRows.length,
  goodsRows: rows.goodsRows.length,
  skcRows: rows.skcRows.length,
  writeCounts: Object.fromEntries(Object.entries(writes).map(([k, v]) => [k, v.length])),
};
await fs.mkdir(REPORT_DIR, {recursive: true});
const reportFile = path.join(REPORT_DIR, `order-skc-sync-${Date.now()}.json`);
await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({...report, reportFile: path.relative(ROOT, reportFile)}, null, 2));
