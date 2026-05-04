#!/usr/bin/env node
/**
 * Build compact / archive display tables for SHEIN sales.
 *
 * Goals:
 * - Keep recent months as independent display tables.
 * - Keep annual summary tables complete for every available month in the year.
 * - Build weekly/monthly product wide tables where periods are columns.
 *
 * This script only creates/refreshes generated display tables. It does not delete
 * old monthly tables; cleanup should be confirmed with the user separately.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
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
const PROFIT_RATE = 0.25;

function parseArgs(argv) {
  const args = {group: 'DSY', currentMonth: null, recentMonths: 2};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--current-month') args.currentMonth = argv[++i];
    else if (a === '--recent-months') args.recentMonths = Number(argv[++i]);
  }
  if (args.currentMonth && !/^\d{4}-\d{2}$/.test(args.currentMonth)) throw new Error('Invalid --current-month');
  if (!Number.isFinite(args.recentMonths) || args.recentMonths < 1) throw new Error('Invalid --recent-months');
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function daysInMonth(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function monthYear(month) { return month.slice(0, 4); }
function nextMonth(month) { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; }
function prevMonth(month) { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; }
function dateRange(start, end) { const out=[]; const d=new Date(`${start}T00:00:00Z`); const stop=new Date(`${end}T00:00:00Z`); while(d<=stop){ out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`); d.setUTCDate(d.getUTCDate()+1);} return out; }
function monthDates(month) { return dateRange(`${month}-01`, `${month}-${pad2(daysInMonth(month))}`); }
function beijingMonth() { const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit'}).formatToParts(new Date()).reduce((a,p)=>{ if(p.type!=='literal') a[p.type]=p.value; return a; },{}); return `${parts.year}-${parts.month}`; }
function isoWeekKey(date) { const d = new Date(`${date}T00:00:00Z`); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const y = d.getUTCFullYear(); const ys = new Date(Date.UTC(y,0,1)); const w = Math.ceil((((d - ys) / 86400000) + 1) / 7); return `${y}-W${pad2(w)}`; }
function weekRangeForDate(date) { const d = new Date(`${date}T00:00:00Z`); const day = d.getUTCDay() || 7; const start = new Date(d); start.setUTCDate(d.getUTCDate() - (day - 1)); const end = new Date(start); end.setUTCDate(start.getUTCDate()+6); const fmt=x=>`${x.getUTCFullYear()}-${pad2(x.getUTCMonth()+1)}-${pad2(x.getUTCDate())}`; return {start:fmt(start), end:fmt(end), key: isoWeekKey(date)}; }

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in lark-cli output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive:true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

async function runLarkOnce(args, payloadName=null, payload=null) {
  const finalArgs = [...args];
  if (payload) {
    const file = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, file).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout='', stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null; try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}

async function runLark(args, payloadName=null, payload=null, attempts=6) {
  let lastError;
  for (let i=1; i<=attempts; i++) {
    try { return await runLarkOnce(args, payloadName, payload); }
    catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const retryable = /limited|rate.?limit|800004135|OpenAPISearchRecord limited|EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily|503|502|504|5000|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn/i.test(msg);
      if (!retryable || i === attempts) break;
      await new Promise(r => setTimeout(r, /limited|800004135/i.test(msg) ? i * 10000 : i * 3000));
    }
  }
  throw lastError;
}

async function listTables(baseToken) {
  const resp = await runLark(['base','+table-list','--as','user','--base-token',baseToken,'--offset','0','--limit','100']);
  return resp.parsed?.data?.tables || [];
}

function stateTableId(state, name) { return state.tables?.[name]?.table_id || null; }
async function saveState(state) { await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8'); }

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
  const resp = await runLark(['base','+table-create','--as','user','--base-token',baseToken,'--name',name,'--fields',JSON.stringify(fields)]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Cannot resolve table id after creating ${name}`);
  state.tables = state.tables || {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await saveState(state);
  return {tableId, created: true};
}

async function ensureFields(baseToken, tableId, fields) {
  const resp = await runLark(['base','+field-list','--as','user','--base-token',baseToken,'--table-id',tableId]);
  const existingFields = resp.parsed?.data?.items || resp.parsed?.data?.fields || resp.parsed?.items || [];
  const existingNames = new Set(existingFields.map(f => f.name).filter(Boolean));
  const created = [];
  for (const field of fields) {
    if (!field?.name || existingNames.has(field.name)) continue;
    await runLark(['base','+field-create','--as','user','--base-token',baseToken,'--table-id',tableId], `field-${tableId}-${field.name}`, field);
    existingNames.add(field.name);
    created.push(field.name);
  }
  return created;
}

async function listRecordKeyEntries(baseToken, tableId) {
  const entries = [];
  let offset = 0;
  while (true) {
    const resp = await runLark(['base','+record-list','--as','user','--base-token',baseToken,'--table-id',tableId,'--field-id','唯一键','--offset',String(offset),'--limit','200','--format','json']);
    const data = resp.parsed?.data || {};
    const rows = data.data || [];
    const ids = data.record_id_list || [];
    const fields = data.fields || [];
    const keyIndex = Math.max(0, fields.indexOf('唯一键'));
    for (let i=0; i<rows.length; i++) {
      const row = rows[i];
      const rawKey = Array.isArray(row) ? row[keyIndex] : (row?.fields?.['唯一键'] ?? row?.['唯一键']);
      const key = String(rawKey ?? '').trim();
      const recordId = ids[i] || row?.record_id || row?.id || null;
      if (key && recordId) entries.push({key, recordId});
    }
    if (!data.has_more) break;
    offset += rows.length || 200;
  }
  return entries;
}

async function listRecordMap(baseToken, tableId) {
  const map = new Map();
  for (const {key, recordId} of await listRecordKeyEntries(baseToken, tableId)) {
    if (!map.has(key)) map.set(key, recordId);
  }
  return map;
}

async function batchCreate(baseToken, tableId, items) {
  const results = [];
  for (let i=0; i<items.length; i+=200) {
    const chunk = items.slice(i, i+200);
    if (!chunk.length) continue;
    const fields = Object.keys(chunk[0].record);
    const payload = {fields, rows: chunk.map(x => fields.map(f => x.record[f] ?? null))};
    const resp = await runLark(['base','+record-batch-create','--as','user','--base-token',baseToken,'--table-id',tableId], `batch-create-${tableId}-${i}`, payload);
    const ids = resp.parsed?.data?.record_id_list || [];
    chunk.forEach((x, j) => results.push({uniqueKey:x.uniqueKey, action:'created', recordId:ids[j] || null}));
  }
  return results;
}

async function upsertRecords(baseToken, tableId, records) {
  const uniqueRecords = new Map();
  for (const record of records) {
    const uniqueKey = String(record['唯一键'] || '').trim();
    if (!uniqueKey) throw new Error(`Generated record missing 唯一键 for table ${tableId}`);
    uniqueRecords.set(uniqueKey, {...record, '唯一键': uniqueKey});
  }
  records = [...uniqueRecords.values()];
  const entries = await listRecordKeyEntries(baseToken, tableId);
  const existing = new Map();
  const duplicates = [];
  for (const {key, recordId} of entries) {
    if (!existing.has(key)) existing.set(key, recordId);
    else duplicates.push({key, recordId});
  }
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
    await runLark(['base','+record-upsert','--as','user','--base-token',baseToken,'--table-id',tableId,'--record-id',item.recordId], `update-${item.uniqueKey}`, item.record);
    results.push({uniqueKey:item.uniqueKey, action:'updated', recordId:item.recordId});
  }
  const desiredKeys = new Set(records.map(r => r['唯一键']));
  const deletedRecordIds = new Set();
  for (const {key, recordId} of duplicates) {
    await runLark(['base','+record-delete','--as','user','--base-token',baseToken,'--table-id',tableId,'--record-id',recordId,'--yes']);
    deletedRecordIds.add(recordId);
    results.push({uniqueKey:key, action:'deleted_duplicate', recordId});
  }
  for (const {key, recordId} of entries) {
    if (desiredKeys.has(key)) continue;
    if (deletedRecordIds.has(recordId)) continue;
    await runLark(['base','+record-delete','--as','user','--base-token',baseToken,'--table-id',tableId,'--record-id',recordId,'--yes']);
    deletedRecordIds.add(recordId);
    results.push({uniqueKey:key, action:'deleted_stale', recordId});
  }
  return results;
}

function numberField(name, precision=2) { return {type:'number', name, style:{type:'plain', precision, percentage:false, thousands_separator:true}}; }
function textField(name) { return {type:'text', name}; }
function selectField(name, options) { return {type:'select', name, multiple:false, options: options.map(([name,hue])=>({name,hue,lightness:'Light'}))}; }

function monthlyArchiveFields() {
  return [
    textField('唯一键'), textField('月份'), textField('主体/店铺'),
    selectField('分组', [['DSY','Blue'], ['LGM','Purple'], ['总计','Yellow'], ['预测','Green']]),
    selectField('行类型', [['店铺','Blue'], ['小计','Purple'], ['总计','Yellow'], ['预测','Green']]),
    selectField('币种', [['SAR','Blue'], ['RMB','Green']]),
    numberField('排序', 0), numberField('合计', 2), numberField('日均', 2),
    ...Array.from({length:31}, (_,i)=>numberField(String(i+1), 2)),
    textField('备注'),
  ];
}

function productDailyArchiveFields() {
  return [
    textField('唯一键'), textField('月份'), selectField('分组', [['DSY','Blue'], ['LGM','Purple']]),
    textField('货号'), textField('商品名称'), numberField('合计销量', 0), numberField('合计销售额SAR', 2), numberField('合计销售额RMB', 2),
    ...Array.from({length:31}, (_,i)=>numberField(String(i+1), 0)),
    textField('备注'),
  ];
}

function productPeriodWideFields(periods) {
  return [
    textField('唯一键'), selectField('分组', [['DSY','Blue'], ['LGM','Purple']]),
    textField('货号'), textField('商品名称'), numberField('合计销量', 0),
    ...periods.map(p => numberField(p, 0)), textField('备注'),
  ];
}

async function readJsonIfExists(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } }

function availableMonths() {
  const files = fssync.readdirSync(REPORT_DIR).filter(n => /^monthly-sales-\d{4}-\d{2}\.json$/.test(n));
  return files.map(n => n.match(/(\d{4}-\d{2})/)[1]).sort();
}

function recentMonthSet(currentMonth, count) {
  const out = new Set();
  let m = currentMonth;
  for (let i=0; i<count; i++) { out.add(m); m = prevMonth(m); }
  return out;
}

function getStores(storesConfig, group) {
  const meta = new Map(storesConfig.stores.map(s => [s.storeKey, s]));
  if (group === 'ALL') return storesConfig.stores.filter(s => s.enabled !== false);
  const groupKeys = storesConfig.groups?.[group] || [];
  return groupKeys.map(k => meta.get(k)).filter(Boolean);
}

async function readFetch(storeKey, date) {
  return await readJsonIfExists(path.join(FETCH_DIR, storeKey, `${date}.json`));
}

async function buildMonthlyArchiveRows(month, storesConfig, group) {
  const stores = getStores(storesConfig, group);
  const days = daysInMonth(month);
  const dailyByStore = new Map();
  for (const store of stores) {
    const daily = Array(31).fill(null);
    let hasFetch = false;
    for (const date of monthDates(month)) {
      const obj = await readFetch(store.storeKey, date);
      const day = Number(date.slice(8,10));
      if (obj?.summary) hasFetch = true;
      daily[day-1] = round2(obj?.summary?.salesSar || 0);
    }
    dailyByStore.set(store.storeKey, {daily, hasFetch});
  }
  const rows = [];
  let order = 1;
  const add = ({label, groupValue, type, currency, dailySar=null, total=null, avg=null, note=''}) => {
    const daily = dailySar ? dailySar.map(v => currency === 'RMB' ? round2(v * FX_SAR_TO_RMB) : round2(v)) : Array(31).fill(null);
    const finalTotal = total == null ? (dailySar ? round2(daily.slice(0, days).reduce((s,v)=>s+Number(v||0),0)) : null) : round2(total);
    const finalAvg = avg == null ? (finalTotal == null ? null : round2(finalTotal / days)) : round2(avg);
    const record = {'唯一键': `${month}__${String(order).padStart(2,'0')}__${label}`, '月份': month, '主体/店铺': label, '分组': groupValue, '行类型': type, '币种': currency, '排序': order, '合计': finalTotal, '日均': finalAvg, '备注': note};
    for (let i=0; i<31; i++) record[String(i+1)] = i < days ? daily[i] : null;
    rows.push(record); order += 1;
  };
  const sumDaily = Array(31).fill(0);
  for (const store of stores) {
    const storeDaily = dailyByStore.get(store.storeKey) || {daily: Array(31).fill(0), hasFetch: false};
    if (!storeDaily.hasFetch) continue;
    const daily = storeDaily.daily;
    daily.forEach((v,i)=>sumDaily[i]+=Number(v||0));
    add({label: store.storeKey, groupValue: group, type:'店铺', currency:'SAR', dailySar:daily, note:store.shopName || ''});
  }
  const totalSar = round2(sumDaily.slice(0, days).reduce((s,v)=>s+v,0));
  const avgSar = round2(totalSar / days);
  const predictedSar = round2(avgSar * days);
  const predictedRmb = round2(predictedSar * FX_SAR_TO_RMB);
  add({label:`${group}小计 SAR`, groupValue:group, type:'小计', currency:'SAR', dailySar:sumDaily});
  add({label:`${group}小计 RMB`, groupValue:group, type:'小计', currency:'RMB', dailySar:sumDaily});
  add({label:'总计 SAR', groupValue:'总计', type:'总计', currency:'SAR', dailySar:sumDaily, note:`当前归档仅含 ${group} 组；LGM 接入后可重建`});
  add({label:'总计 RMB', groupValue:'总计', type:'总计', currency:'RMB', dailySar:sumDaily, note:`当前归档仅含 ${group} 组；LGM 接入后可重建`});
  add({label:'预测全月 SAR', groupValue:'预测', type:'预测', currency:'SAR', total:predictedSar, avg:avgSar, note:'历史完整月，预测值等于按日均折算的整月值'});
  add({label:'预测全月 RMB', groupValue:'预测', type:'预测', currency:'RMB', total:predictedRmb, avg:round2(predictedRmb/days), note:'1 SAR = 1.8 RMB'});
  add({label:'预测利润 RMB', groupValue:'预测', type:'预测', currency:'RMB', total:round2(predictedRmb*PROFIT_RATE), avg:round2(predictedRmb*PROFIT_RATE/days), note:'按 25% 利润率估算'});
  return rows;
}

function addProductAgg(map, key, seed, qty, sar) {
  if (!map.has(key)) map.set(key, {...seed, qty:0, salesSar:0, dailyQty:Array(31).fill(0), periods:new Map()});
  const r = map.get(key); r.qty += qty; r.salesSar = round2(r.salesSar + sar); return r;
}

async function loadProductRowsForMonths(months, storesConfig, group) {
  const stores = getStores(storesConfig, group).filter(s => s.productStatsEnabled !== false);
  const dailyRows = [];
  for (const month of months) {
    for (const store of stores) {
      for (const date of monthDates(month)) {
        const obj = await readFetch(store.storeKey, date);
        for (const g of obj?.goodsRows || []) {
          const qty = Number(g.number || 0);
          const salesSar = Number(g.currencyPrice || 0);
          const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
          const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
          if (!goodsSn || qty <= 0 || salesSar <= 0) continue;
          dailyRows.push({date, month, day:Number(date.slice(8,10)), group, storeKey:store.storeKey, goodsSn, goodsTitle:String(g.goodsTitle || '').slice(0,500), qty, salesSar});
        }
      }
    }
  }
  return dailyRows;
}

function buildProductDailyArchiveRows(month, dailyRows, group) {
  const map = new Map();
  for (const row of dailyRows.filter(r => r.month === month)) {
    const key = `${month}__${group}__${row.goodsSn}`;
    const agg = addProductAgg(map, key, {month, group, goodsSn:row.goodsSn, goodsTitle:row.goodsTitle}, row.qty, row.salesSar);
    agg.dailyQty[row.day - 1] += row.qty;
    if (!agg.goodsTitle && row.goodsTitle) agg.goodsTitle = row.goodsTitle;
  }
  return [...map.entries()].map(([uniqueKey, r]) => {
    const record = {'唯一键': uniqueKey, '月份': month, '分组': group, '货号': r.goodsSn, '商品名称': r.goodsTitle, '合计销量': r.qty, '合计销售额SAR': round2(r.salesSar), '合计销售额RMB': round2(r.salesSar * FX_SAR_TO_RMB), '备注': '年度归档表：月份+产品一行，日期放列上'};
    for (let i=0; i<31; i++) record[String(i+1)] = i < daysInMonth(month) ? (r.dailyQty[i] || 0) : null;
    return record;
  }).sort((a,b) => a['月份'].localeCompare(b['月份']) || b['合计销量'] - a['合计销量'] || a['货号'].localeCompare(b['货号'], 'zh-CN'));
}

function buildProductMonthWideRows(months, dailyRows, group) {
  const byProduct = new Map();
  for (const row of dailyRows) {
    if (!byProduct.has(row.goodsSn)) byProduct.set(row.goodsSn, {goodsSn:row.goodsSn, goodsTitle:row.goodsTitle, total:0, values:new Map()});
    const p = byProduct.get(row.goodsSn); p.total += row.qty; p.values.set(row.month, (p.values.get(row.month) || 0) + row.qty); if (!p.goodsTitle && row.goodsTitle) p.goodsTitle = row.goodsTitle;
  }
  return [...byProduct.values()].map(p => {
    const record = {'唯一键': `${group}__${p.goodsSn}`, '分组': group, '货号': p.goodsSn, '商品名称': p.goodsTitle, '合计销量': p.total, '备注': '自然月销量宽表：月份放列上'};
    for (const m of months) record[m] = p.values.get(m) || 0;
    return record;
  }).sort((a,b)=>b['合计销量']-a['合计销量'] || a['货号'].localeCompare(b['货号'], 'zh-CN'));
}

function buildProductWeekWideRows(dailyRows, group) {
  const weekSet = new Set(dailyRows.map(r => isoWeekKey(r.date)));
  const weeks = [...weekSet].sort();
  const byProduct = new Map();
  for (const row of dailyRows) {
    const wk = isoWeekKey(row.date);
    if (!byProduct.has(row.goodsSn)) byProduct.set(row.goodsSn, {goodsSn:row.goodsSn, goodsTitle:row.goodsTitle, total:0, values:new Map()});
    const p = byProduct.get(row.goodsSn); p.total += row.qty; p.values.set(wk, (p.values.get(wk) || 0) + row.qty); if (!p.goodsTitle && row.goodsTitle) p.goodsTitle = row.goodsTitle;
  }
  const rows = [...byProduct.values()].map(p => {
    const record = {'唯一键': `${group}__${p.goodsSn}`, '分组': group, '货号': p.goodsSn, '商品名称': p.goodsTitle, '合计销量': p.total, '备注': '周销量宽表：周一到周日为一周，周别放列上'};
    for (const w of weeks) record[w] = p.values.get(w) || 0;
    return record;
  }).sort((a,b)=>b['合计销量']-a['合计销量'] || a['货号'].localeCompare(b['货号'], 'zh-CN'));
  return {weeks, rows};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const storesConfig = JSON.parse((await fs.readFile(STORES_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const baseToken = state.baseToken;
  if (!baseToken) throw new Error('Missing baseToken in state/lark_base.json');

  const currentMonth = args.currentMonth || beijingMonth();
  const months = availableMonths();
  const recent = recentMonthSet(currentMonth, args.recentMonths);
  const annualMonths = months;
  const cleanupCandidateMonths = months.filter(m => !recent.has(m));
  const archiveByYear = new Map();
  for (const m of annualMonths) {
    const y = monthYear(m);
    if (!archiveByYear.has(y)) archiveByYear.set(y, []);
    archiveByYear.get(y).push(m);
  }

  const result = {
    ok:true,
    generatedAt:new Date().toISOString(),
    group:args.group,
    currentMonth,
    recentMonths:[...recent].sort(),
    annualMonths,
    cleanupCandidateMonths,
    tables:[],
  };

  const materializeGroups = args.group === 'ALL' ? ['DSY', 'LGM'] : [args.group];

  for (const [year, yMonths] of archiveByYear.entries()) {
    const monthlyTableName = `${'\u6708\u5ea6\u65e5\u9500'}-${year}${'\u6c47\u603b'}`;
    const ensuredMonthly = await ensureTable(state, baseToken, monthlyTableName, monthlyArchiveFields());
    const monthlyRows = [];
    for (const g of materializeGroups) {
      for (const m of yMonths) monthlyRows.push(...await buildMonthlyArchiveRows(m, storesConfig, g));
    }
    const monthlyWrite = await upsertRecords(baseToken, ensuredMonthly.tableId, monthlyRows);
    result.tables.push({name: monthlyTableName, tableId: ensuredMonthly.tableId, created: ensuredMonthly.created, rowCount: monthlyRows.length, writes: monthlyWrite.length});

    const productDailyTableName = `${'\u4ea7\u54c1\u65e5\u9500\u91cf'}-${year}${'\u6c47\u603b'}`;
    const ensuredProductDaily = await ensureTable(state, baseToken, productDailyTableName, productDailyArchiveFields());
    const productRows = [];
    for (const g of materializeGroups) {
      const productRowsSource = await loadProductRowsForMonths(yMonths, storesConfig, g);
      for (const m of yMonths) productRows.push(...buildProductDailyArchiveRows(m, productRowsSource, g));
    }
    const productWrite = await upsertRecords(baseToken, ensuredProductDaily.tableId, productRows);
    result.tables.push({name: productDailyTableName, tableId: ensuredProductDaily.tableId, created: ensuredProductDaily.created, rowCount: productRows.length, writes: productWrite.length});
  }

  const allProductRows = [];
  const monthWideRows = [];
  for (const g of materializeGroups) {
    const groupProductRows = await loadProductRowsForMonths(months, storesConfig, g);
    allProductRows.push(...groupProductRows);
    monthWideRows.push(...buildProductMonthWideRows(months, groupProductRows, g));
  }
  const monthWideName = '产品月销量-宽表';
  const ensuredMonthWide = await ensureTable(state, baseToken, monthWideName, productPeriodWideFields(months));
  const monthWideCreatedFields = await ensureFields(baseToken, ensuredMonthWide.tableId, productPeriodWideFields(months));
  const monthWideWrite = await upsertRecords(baseToken, ensuredMonthWide.tableId, monthWideRows);
  result.tables.push({name: monthWideName, tableId: ensuredMonthWide.tableId, created: ensuredMonthWide.created, createdFields: monthWideCreatedFields, rowCount: monthWideRows.length, writes: monthWideWrite.length, periods: months.length});

  const weeksSet = new Set();
  const weekWideRows = [];
  for (const g of materializeGroups) {
    const groupProductRows = allProductRows.filter(r => r.group === g);
    const built = buildProductWeekWideRows(groupProductRows, g);
    built.weeks.forEach(w => weeksSet.add(w));
    weekWideRows.push(...built.rows);
  }
  const weeks = [...weeksSet].sort();
  const weekWideName = '产品周销量-宽表';
  const ensuredWeekWide = await ensureTable(state, baseToken, weekWideName, productPeriodWideFields(weeks));
  const weekWideCreatedFields = await ensureFields(baseToken, ensuredWeekWide.tableId, productPeriodWideFields(weeks));
  const weekWideWrite = await upsertRecords(baseToken, ensuredWeekWide.tableId, weekWideRows);
  result.tables.push({name: weekWideName, tableId: ensuredWeekWide.tableId, created: ensuredWeekWide.created, createdFields: weekWideCreatedFields, rowCount: weekWideRows.length, writes: weekWideWrite.length, periods: weeks.length});

  const cleanupCandidates = cleanupCandidateMonths
    .flatMap(m => [`月度日销-${m}`, `产品日销量-${m}`])
    .filter(name => stateTableId(state, name));
  result.cleanupCandidates = cleanupCandidates;
  result.note = '已新建/刷新年度汇总与宽表展示表；年度汇总包含全年所有已抓取月份，最近两个月仍额外保留独立月表。cleanupCandidates 只是后续可让用户确认删除/隐藏的旧展示表清单。';

  await fs.mkdir(REPORT_DIR, {recursive:true});
  const reportFile = path.join(REPORT_DIR, 'compact-display-tables.json');
  await fs.writeFile(reportFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({...result, reportFile:path.relative(ROOT, reportFile)}, null, 2));
}

await main();
