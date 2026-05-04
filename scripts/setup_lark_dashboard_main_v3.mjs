#!/usr/bin/env node
/**
 * SHEIN 主看板 v3
 *
 * 设计原则：
 * - 只保留一个主看板入口，同时展示 ALL / DSY / LGM，不依赖 Dashboard filter。
 * - 顶部 KPI 使用飞书原生 statistics 大数字卡；ALL/DSY/LGM 用标题色标区分。
 * - 图表仍读取小型聚合表，避免飞书 Dashboard 对 filter 的前端渲染问题。
 * - 榜单数据源写入完整店铺/完整货号，并按金额或销量降序。
 * - 默认不自动 arrange，避免覆盖用户手动调整后的布局和大小。
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
const FX = 1.8;
const PROFIT_RATE = 0.25;
const LARK_COMMAND_TIMEOUT_MS = Number(process.env.LARK_COMMAND_TIMEOUT_MS || 90_000);

function parseArgs(argv) {
  const args = {
    month: null,
    name: 'SHEIN经营看板 v3-主看板',
    sourcePrefix: 'MAIN',
    themeStyle: 'futuristic',
    trendDays: 31,
    topProducts: 999,
    periodMode: 'current',
    createDashboard: true,
    refreshSources: true,
    rebuildBlocks: false,
    arrange: false,
    updateRichTextTime: true,
    richTextProfileDir: null,
    richTextVisible: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--theme-style') args.themeStyle = argv[++i];
    else if (a === '--source-prefix') args.sourcePrefix = argv[++i].toUpperCase();
    else if (a === '--trend-days') args.trendDays = Number(argv[++i]);
    else if (a === '--top-products') args.topProducts = Number(argv[++i]);
    else if (a === '--period-mode') args.periodMode = argv[++i];
    else if (a === '--no-create-dashboard') args.createDashboard = false;
    else if (a === '--no-refresh-sources') args.refreshSources = false;
    else if (a === '--rebuild-blocks') args.rebuildBlocks = true;
    else if (a === '--arrange') args.arrange = true;
    else if (a === '--no-arrange') args.arrange = false;
    else if (a === '--no-richtext-time') args.updateRichTextTime = false;
    else if (a === '--richtext-profile-dir') args.richTextProfileDir = argv[++i];
    else if (a === '--richtext-visible') args.richTextVisible = true;
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function fmt(n, digits = 2) { return Number(n || 0).toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}); }
function fmt0(n) { return Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 0}); }

function beijingDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const d = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function beijingNowString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function currentMonth() { return beijingDate().slice(0, 7); }
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
function monthDates(month) { return dateRange(`${month}-01`, `${month}-${pad2(daysInMonth(month))}`); }

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in lark-cli output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

async function runLarkOnce(args, payloadName = null, payload = null) {
  const finalArgs = [...args];
  if (payload !== null) {
    const file = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, file).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`lark-cli timed out after ${LARK_COMMAND_TIMEOUT_MS}ms: ${finalArgs.join(' ')}`));
    }, LARK_COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}

async function runLark(args, payloadName = null, payload = null, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await runLarkOnce(args, payloadName, payload); }
    catch (err) {
      last = err;
      const msg = String(err?.message || err);
      const retryable = /limited|rate.?limit|800004135|800005999|internal_error|内部错误|"undefined" is not valid JSON|EOF|ECONNRESET|ETIMEDOUT|timeout|timed out|503|502|504|5000|HTTP 500|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn/i.test(msg);
      if (!retryable || i === attempts) break;
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
  throw last;
}

async function runNodeBestEffort(script, args, timeoutMs = 150_000) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ok: false, code: null, stdout, stderr: `${stderr}\nnode timed out after ${timeoutMs}ms`.trim()});
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr: String(err?.message || err)});
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr});
    });
  });
}

function isBestEffortRetryable(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  return /Target page, context or browser has been closed|page\.waitForTimeout|browser has been closed|context has been closed|ECONNRESET|ETIMEDOUT|timeout|timed out|EOF|HTTP 500|5000|502|503|504|tls|x509|certificate|not open\.feishu\.cn/i.test(text);
}

async function runNodeBestEffortWithRetry(script, args, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 150_000;
  const delayMs = options.delayMs ?? 5000;
  const runs = [];
  for (let i = 1; i <= attempts; i++) {
    const result = await runNodeBestEffort(script, args, timeoutMs);
    runs.push({
      attempt: i,
      ok: result.ok,
      code: result.code,
      stdoutTail: result.stdout.slice(-1200),
      stderrTail: result.stderr.slice(-1200),
    });
    if (result.ok) return {...result, attempts: runs};
    if (i >= attempts || !isBestEffortRetryable(result)) return {...result, attempts: runs};
    await new Promise(r => setTimeout(r, delayMs * i));
  }
  return {ok: false, code: null, stdout: '', stderr: 'unreachable retry state', attempts: runs};
}

function textField(name) { return {type: 'text', name}; }
function numberField(name, precision = 2) {
  return {type: 'number', name, style: {type: 'plain', precision, percentage: false, thousands_separator: true}};
}

async function saveState(state) { await writeJson(STATE_PATH, state); }
async function listTables(baseToken) {
  const resp = await runLark(['base', '+table-list', '--as', 'user', '--base-token', baseToken, '--offset', '0', '--limit', '100']);
  return resp.parsed?.data?.tables || [];
}
function stateTableId(state, name) { return state.tables?.[name]?.table_id || null; }

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
    'base', '+table-create', '--as', 'user', '--base-token', baseToken, '--name', name,
    '--fields', JSON.stringify(fields),
  ]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Cannot resolve table id after creating ${name}`);
  state.tables = state.tables || {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await saveState(state);
  return {tableId, created: true};
}

async function ensureField(baseToken, tableId, name, field) {
  const resp = await runLark(['base', '+field-list', '--as', 'user', '--base-token', baseToken, '--table-id', tableId]);
  const fields = resp.parsed?.data?.items || resp.parsed?.data?.fields || resp.parsed?.items || [];
  if (fields.some(f => f.name === name)) return {name, created: false};
  const payload = {...field, name};
  await runLark(['base', '+field-create', '--as', 'user', '--base-token', baseToken, '--table-id', tableId], `field-${name}`, payload);
  return {name, created: true};
}

async function listRecordKeyEntries(baseToken, tableId) {
  const entries = [];
  let offset = 0;
  while (true) {
    const resp = await runLark([
      'base', '+record-list', '--as', 'user', '--base-token', baseToken, '--table-id', tableId,
      '--field-id', '唯一键', '--offset', String(offset), '--limit', '200', '--format', 'json',
    ]);
    const data = resp.parsed?.data || {};
    const rows = data.data || [];
    const ids = data.record_id_list || [];
    const fields = data.fields || [];
    const keyIndex = Math.max(0, fields.indexOf('唯一键'));
    for (let i = 0; i < rows.length; i++) {
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

function dedupeIncomingRecords(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = String(record?.['唯一键'] ?? '').trim();
    if (!key) throw new Error('Dashboard source record missing 唯一键');
    byKey.set(key, {...record, '唯一键': key});
  }
  return [...byKey.values()];
}

async function batchCreate(baseToken, tableId, items) {
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    if (!chunk.length) continue;
    const fields = Object.keys(chunk[0].record);
    const payload = {fields, rows: chunk.map(x => fields.map(f => x.record[f] ?? null))};
    await runLark(['base', '+record-batch-create', '--as', 'user', '--base-token', baseToken, '--table-id', tableId], `create-${tableId}-${i}`, payload);
  }
}

async function upsertRecords(baseToken, tableId, records) {
  records = dedupeIncomingRecords(records);
  const existing = await listRecordMap(baseToken, tableId);
  const creates = [];
  let updated = 0;
  for (const record of records) {
    const key = record['唯一键'];
    const recordId = existing.get(key);
    if (recordId) {
      await runLark([
        'base', '+record-upsert', '--as', 'user', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId,
      ], `update-${key}`, record);
      updated++;
    } else {
      creates.push({record});
    }
  }
  await batchCreate(baseToken, tableId, creates);
  return {created: creates.length, updated, total: records.length};
}

async function deleteStaleRecords(baseToken, tableId, validKeys) {
  const existing = await listRecordKeyEntries(baseToken, tableId);
  const seenValidKeys = new Set();
  let deleted = 0;
  for (const {key, recordId} of existing) {
    if (validKeys.has(key) && !seenValidKeys.has(key)) {
      seenValidKeys.add(key);
      continue;
    }
    await runLark([
      'base', '+record-delete', '--as', 'user', '--base-token', baseToken,
      '--table-id', tableId, '--record-id', recordId, '--yes',
    ], null, null, 5);
    deleted++;
  }
  return deleted;
}

function getGroupStores(storesConfig, scope) {
  const stores = storesConfig.stores.filter(s => s.enabled !== false);
  if (scope === 'ALL') return stores;
  const keys = new Set(storesConfig.groups?.[scope] || []);
  return stores.filter(s => keys.has(s.storeKey));
}

function storeGroup(store) {
  return store.groupKey || store.group || '';
}

async function readFetch(storeKey, date) {
  return await readJson(path.join(FETCH_DIR, storeKey, `${date}.json`), null);
}

async function storeDay(store, date) {
  const obj = await readFetch(store.storeKey, date);
  const s = obj?.summary || {};
  return {
    storeKey: store.storeKey,
    group: storeGroup(store),
    shopName: store.shopName || store.storeKey,
    salesSar: round2(s.salesSar || 0),
    salesRmb: round2((s.salesSar || 0) * FX),
    orders: Number(s.positiveAmountOrderCount || 0),
    qty: Number(s.quantityPositiveAmount || 0),
    fetchTime: obj?.fetchTime || null,
  };
}

async function scopeDay(stores, date) {
  const rows = [];
  for (const store of stores) rows.push(await storeDay(store, date));
  const salesSar = round2(rows.reduce((s, r) => s + r.salesSar, 0));
  const latestFetchTime = rows
    .map(r => r.fetchTime ? new Date(r.fetchTime) : null)
    .filter(d => d && Number.isFinite(d.getTime()))
    .sort((a, b) => b - a)[0];
  return {
    salesSar,
    salesRmb: round2(salesSar * FX),
    orders: rows.reduce((s, r) => s + r.orders, 0),
    qty: rows.reduce((s, r) => s + r.qty, 0),
    latestFetchTime: latestFetchTime ? beijingNowString(latestFetchTime) : null,
  };
}

async function activeProductCountForDay(stores, date) {
  const active = new Set();
  for (const store of stores.filter(s => s.productStatsEnabled !== false)) {
    const obj = await readFetch(store.storeKey, date);
    for (const g of obj?.goodsRows || []) {
      const qty = Number(g.number || 0);
      if (qty <= 0) continue;
      const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
      const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
      if (goodsSn) active.add(goodsSn);
    }
  }
  return active.size;
}

async function scopeMonth(stores, month) {
  let salesSar = 0, orders = 0, qty = 0, latestFetchTime = null;
  for (const date of monthDates(month)) {
    const d = await scopeDay(stores, date);
    salesSar += d.salesSar; orders += d.orders; qty += d.qty;
    if (d.latestFetchTime && (!latestFetchTime || d.latestFetchTime > latestFetchTime)) latestFetchTime = d.latestFetchTime;
  }
  const elapsed = Math.max(1, month === currentMonth() ? Number(beijingDate().slice(-2)) : daysInMonth(month));
  const avgSar = round2(salesSar / elapsed);
  const predictedSar = round2(avgSar * daysInMonth(month));
  return {
    salesSar: round2(salesSar),
    salesRmb: round2(salesSar * FX),
    orders,
    qty,
    avgSar,
    predictedSar,
    predictedRmb: round2(predictedSar * FX),
    predictedProfitRmb: round2(predictedSar * FX * PROFIT_RATE),
    latestFetchTime,
  };
}

async function buildScopeRows(storesConfig, month, updatedAt, periodMode = 'current') {
  const today = beijingDate();
  const yesterday = beijingDate(-1);
  const rows = [];
  for (const scope of ['ALL', 'DSY', 'LGM']) {
    const stores = getGroupStores(storesConfig, scope);
    const t = await scopeDay(stores, today);
    const y = await scopeDay(stores, yesterday);
    const m = await scopeMonth(stores, month);
    const activeProducts = await activeProductCountForDay(stores, today);
    const isAll = scope === 'ALL';
    const monthSnapshot = periodMode === 'month';
    const kpiSalesSar = monthSnapshot ? m.salesSar : t.salesSar;
    const kpiSalesRmb = monthSnapshot ? m.salesRmb : t.salesRmb;
    const kpiOrders = monthSnapshot ? m.orders : t.orders;
    const kpiQty = monthSnapshot ? m.qty : t.qty;
    rows.push({
      '唯一键': `scope-${scope}`,
      '范围': scope === 'ALL' ? '全部' : scope,
      '月份': month,
      '更新时间': updatedAt,
      '数据抓取时间': (monthSnapshot ? m.latestFetchTime : t.latestFetchTime) || updatedAt,
      '今日SAR': t.salesSar,
      '今日RMB': t.salesRmb,
      '今日金额': `${fmt(t.salesSar)} SAR / ${fmt(t.salesRmb)} RMB`,
      '昨日SAR': y.salesSar,
      '昨日RMB': y.salesRmb,
      '昨日金额': `${fmt(y.salesSar)} SAR / ${fmt(y.salesRmb)} RMB`,
      '月累计SAR': m.salesSar,
      '月累计RMB': m.salesRmb,
      '月累计金额': `${fmt(m.salesSar)} SAR / ${fmt(m.salesRmb)} RMB`,
      '月日均SAR': m.avgSar,
      '预测业绩SAR': m.predictedSar,
      '预测业绩RMB': m.predictedRmb,
      '预测业绩': `${fmt(m.predictedSar)} SAR / ${fmt(m.predictedRmb)} RMB`,
      '预测利润RMB': m.predictedProfitRmb,
      '今日订单数': t.orders,
      '昨日订单数': y.orders,
      '月订单数': m.orders,
      '今日销量': t.qty,
      '昨日销量': y.qty,
      '月销量': m.qty,
      '今日动销产品数': activeProducts,
      'KPI今日SAR': isAll ? kpiSalesSar : 0,
      'KPI今日RMB': isAll ? kpiSalesRmb : 0,
      'KPI今日SAR_DSY': scope === 'DSY' ? kpiSalesSar : 0,
      'KPI今日RMB_DSY': scope === 'DSY' ? kpiSalesRmb : 0,
      'KPI今日SAR_LGM': scope === 'LGM' ? kpiSalesSar : 0,
      'KPI今日RMB_LGM': scope === 'LGM' ? kpiSalesRmb : 0,
      'KPI今日订单数': isAll ? kpiOrders : 0,
      'KPI今日销量': isAll ? kpiQty : 0,
      'KPI今日订单数_DSY': scope === 'DSY' ? kpiOrders : 0,
      'KPI今日销量_DSY': scope === 'DSY' ? kpiQty : 0,
      'KPI今日订单数_LGM': scope === 'LGM' ? kpiOrders : 0,
      'KPI今日销量_LGM': scope === 'LGM' ? kpiQty : 0,
      'KPI今日动销产品数': isAll ? activeProducts : 0,
      'KPI今日动销产品数_DSY': scope === 'DSY' ? activeProducts : 0,
      'KPI今日动销产品数_LGM': scope === 'LGM' ? activeProducts : 0,
      'KPI月累计SAR': isAll ? m.salesSar : 0,
      'KPI月累计RMB': isAll ? m.salesRmb : 0,
      'KPI月累计SAR_DSY': scope === 'DSY' ? m.salesSar : 0,
      'KPI月累计RMB_DSY': scope === 'DSY' ? m.salesRmb : 0,
      'KPI月累计SAR_LGM': scope === 'LGM' ? m.salesSar : 0,
      'KPI月累计RMB_LGM': scope === 'LGM' ? m.salesRmb : 0,
      'KPI月订单数': isAll ? m.orders : 0,
      'KPI月销量': isAll ? m.qty : 0,
      'KPI月订单数_DSY': scope === 'DSY' ? m.orders : 0,
      'KPI月销量_DSY': scope === 'DSY' ? m.qty : 0,
      'KPI月订单数_LGM': scope === 'LGM' ? m.orders : 0,
      'KPI月销量_LGM': scope === 'LGM' ? m.qty : 0,
      'KPI预测业绩SAR': isAll ? m.predictedSar : 0,
      'KPI预测业绩RMB': isAll ? m.predictedRmb : 0,
      'KPI预测业绩SAR_DSY': scope === 'DSY' ? m.predictedSar : 0,
      'KPI预测业绩RMB_DSY': scope === 'DSY' ? m.predictedRmb : 0,
      'KPI预测业绩SAR_LGM': scope === 'LGM' ? m.predictedSar : 0,
      'KPI预测业绩RMB_LGM': scope === 'LGM' ? m.predictedRmb : 0,
      'KPI预测利润RMB': isAll ? m.predictedProfitRmb : 0,
      'KPI预测利润RMB_DSY': scope === 'DSY' ? m.predictedProfitRmb : 0,
      'KPI预测利润RMB_LGM': scope === 'LGM' ? m.predictedProfitRmb : 0,
    });
  }
  return rows;
}

async function buildTrendRows(storesConfig, month, trendDays, updatedAt) {
  const today = beijingDate();
  const lastDay = month === today.slice(0, 7) ? Number(today.slice(-2)) : daysInMonth(month);
  const startDay = Math.max(1, lastDay - trendDays + 1);
  const rows = [];
  for (const scope of ['ALL', 'DSY', 'LGM']) {
    const stores = getGroupStores(storesConfig, scope);
    for (let d = startDay; d <= lastDay; d++) {
      const date = `${month}-${pad2(d)}`;
      const day = await scopeDay(stores, date);
      rows.push({
        '唯一键': `trend-${scope}-${date}`,
        '范围': scope === 'ALL' ? '全部' : scope,
        '日期': date.slice(5),
        '完整日期': date,
        '排序': d,
        '更新时间': updatedAt,
        '销售额SAR': day.salesSar,
        '销售额RMB': day.salesRmb,
        '订单数': day.orders,
        '销量': day.qty,
      });
    }
  }
  return rows;
}

async function buildStoreRows(storesConfig, month, updatedAt) {
  const rows = [];
  for (const store of getGroupStores(storesConfig, 'ALL')) {
    let salesSar = 0, orders = 0, qty = 0;
    for (const date of monthDates(month)) {
      const d = await storeDay(store, date);
      salesSar += d.salesSar; orders += d.orders; qty += d.qty;
    }
    rows.push({
      storeKey: store.storeKey,
      group: storeGroup(store),
      shopName: store.shopName || store.storeKey,
      salesSar: round2(salesSar),
      salesRmb: round2(salesSar * FX),
      orders,
      qty,
    });
  }
  const salesRanked = [...rows].sort((a, b) => b.salesSar - a.salesSar || a.storeKey.localeCompare(b.storeKey));
  const orderRanked = [...rows].sort((a, b) => b.orders - a.orders || b.salesSar - a.salesSar || a.storeKey.localeCompare(b.storeKey));
  const qtyRanked = [...rows].sort((a, b) => b.qty - a.qty || b.salesSar - a.salesSar || a.storeKey.localeCompare(b.storeKey));
  const salesRank = new Map(salesRanked.map((r, i) => [r.storeKey, i + 1]));
  const orderRank = new Map(orderRanked.map((r, i) => [r.storeKey, i + 1]));
  const qtyRank = new Map(qtyRanked.map((r, i) => [r.storeKey, i + 1]));
  return salesRanked.map(r => ({
    '\u552f\u4e00\u952e': 'store-' + r.storeKey,
    '\u8303\u56f4': '\u5168\u90e8',
    '\u6392\u540d': salesRank.get(r.storeKey),
    '\u5206\u7ec4': r.group,
    '\u5e97\u94fa\u4ee3\u53f7': r.storeKey,
    '\u5e97\u94fa\u6807\u7b7e': r.storeKey,
    '\u5e97\u94fa\u6392\u884c\u6807\u7b7e': pad2(salesRank.get(r.storeKey)) + ' ' + r.storeKey,
    '\u5e97\u94fa\u8ba2\u5355\u6392\u884c\u6807\u7b7e': pad2(orderRank.get(r.storeKey)) + ' ' + r.storeKey,
    '\u5e97\u94fa\u9500\u91cf\u6392\u884c\u6807\u7b7e': pad2(qtyRank.get(r.storeKey)) + ' ' + r.storeKey,
    '\u5e97\u94fa\u540d\u79f0': r.shopName,
    '\u66f4\u65b0\u65f6\u95f4': updatedAt,
    '\u6708\u9500\u552e\u989dSAR': r.salesSar,
    '\u6708\u9500\u552e\u989dRMB': r.salesRmb,
    '\u6708\u9500\u552e\u989d': fmt(r.salesSar) + ' SAR / ' + fmt(r.salesRmb) + ' RMB',
    '\u8ba2\u5355\u6570': r.orders,
    '\u9500\u91cf': r.qty,
  }));
}

async function buildProductRows(storesConfig, month, limit, updatedAt) {
  const byProduct = new Map();
  for (const store of getGroupStores(storesConfig, 'ALL').filter(s => s.productStatsEnabled !== false)) {
    for (const date of monthDates(month)) {
      const obj = await readFetch(store.storeKey, date);
      for (const g of obj?.goodsRows || []) {
        const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
        const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
        const qty = Number(g.number || 0);
        const salesSar = Number(g.currencyPrice || 0);
        if (!goodsSn || qty <= 0 || salesSar <= 0) continue;
        if (!byProduct.has(goodsSn)) byProduct.set(goodsSn, {goodsSn, title: '', qty: 0, salesSar: 0, groups: new Set(), stores: new Set()});
        const row = byProduct.get(goodsSn);
        row.qty += qty;
        row.salesSar = round2(row.salesSar + salesSar);
        if (storeGroup(store)) row.groups.add(storeGroup(store));
        row.stores.add(store.storeKey);
        if (!row.title && g.goodsTitle) row.title = String(g.goodsTitle).slice(0, 500);
      }
    }
  }
  const allRows = [...byProduct.values()];
  const qtyRanked = [...allRows].sort((a, b) => b.qty - a.qty || b.salesSar - a.salesSar || a.goodsSn.localeCompare(b.goodsSn, 'zh-CN'));
  const salesRanked = [...allRows].sort((a, b) => b.salesSar - a.salesSar || b.qty - a.qty || a.goodsSn.localeCompare(b.goodsSn, 'zh-CN'));
  const qtyRank = new Map(qtyRanked.map((r, i) => [r.goodsSn, i + 1]));
  const salesRank = new Map(salesRanked.map((r, i) => [r.goodsSn, i + 1]));
  return qtyRanked
    .slice(0, limit)
    .map(r => ({
      '\u552f\u4e00\u952e': 'product-' + r.goodsSn,
      '\u8303\u56f4': '\u5168\u90e8',
      '\u6392\u540d': qtyRank.get(r.goodsSn),
      '\u8d27\u53f7': r.goodsSn,
      '\u8d27\u53f7\u6392\u884c\u6807\u7b7e': pad2(qtyRank.get(r.goodsSn)) + ' ' + r.goodsSn,
      '\u8d27\u53f7\u9500\u552e\u989d\u6392\u884c\u6807\u7b7e': pad2(salesRank.get(r.goodsSn)) + ' ' + r.goodsSn,
      '\u5546\u54c1\u540d\u79f0': r.title,
      '\u6d89\u53ca\u5206\u7ec4': [...r.groups].sort().join('/'),
      '\u6d89\u53ca\u5e97\u94fa\u6570': r.stores.size,
      '\u66f4\u65b0\u65f6\u95f4': updatedAt,
      '\u9500\u91cf': Math.round(r.qty),
      '\u9500\u552e\u989dSAR': round2(r.salesSar),
      '\u9500\u552e\u989dRMB': round2(r.salesSar * FX),
      '\u9500\u552e\u989d': fmt(r.salesSar) + ' SAR / ' + fmt(r.salesSar * FX) + ' RMB',
    }));
}

async function buildHistoryRows(storesConfig, updatedAt) {
  const files = (await fs.readdir(REPORT_DIR)).filter(n => /^monthly-sales-\d{4}-\d{2}\.json$/.test(n)).sort();
  const months = files.map(n => n.match(/(\d{4}-\d{2})/)[1]).slice(-12);
  const rows = [];
  for (const scope of ['ALL', 'DSY', 'LGM']) {
    const stores = getGroupStores(storesConfig, scope);
    for (const month of months) {
      const m = await scopeMonth(stores, month);
      rows.push({
        '唯一键': `history-${scope}-${month}`,
        '范围': scope === 'ALL' ? '全部' : scope,
        '月份': month,
        '更新时间': updatedAt,
        '销售额SAR': m.salesSar,
        '销售额RMB': m.salesRmb,
        '销售额': `${fmt(m.salesSar)} SAR / ${fmt(m.salesRmb)} RMB`,
        '订单数': m.orders,
        '销量': m.qty,
      });
    }
  }
  return rows;
}

function kpiScopeFields() {
  return [
    numberField('KPI\u4eca\u65e5SAR'),
    numberField('KPI\u4eca\u65e5RMB'),
    numberField('KPI\u4eca\u65e5SAR_DSY'),
    numberField('KPI\u4eca\u65e5RMB_DSY'),
    numberField('KPI\u4eca\u65e5SAR_LGM'),
    numberField('KPI\u4eca\u65e5RMB_LGM'),
    numberField('KPI\u4eca\u65e5\u8ba2\u5355\u6570', 0),
    numberField('KPI\u4eca\u65e5\u9500\u91cf', 0),
    numberField('KPI\u4eca\u65e5\u8ba2\u5355\u6570_DSY', 0),
    numberField('KPI\u4eca\u65e5\u9500\u91cf_DSY', 0),
    numberField('KPI\u4eca\u65e5\u8ba2\u5355\u6570_LGM', 0),
    numberField('KPI\u4eca\u65e5\u9500\u91cf_LGM', 0),
    numberField('KPI\u4eca\u65e5\u52a8\u9500\u4ea7\u54c1\u6570', 0),
    numberField('KPI\u4eca\u65e5\u52a8\u9500\u4ea7\u54c1\u6570_DSY', 0),
    numberField('KPI\u4eca\u65e5\u52a8\u9500\u4ea7\u54c1\u6570_LGM', 0),
    numberField('KPI\u6708\u7d2f\u8ba1SAR'),
    numberField('KPI\u6708\u7d2f\u8ba1RMB'),
    numberField('KPI\u6708\u7d2f\u8ba1SAR_DSY'),
    numberField('KPI\u6708\u7d2f\u8ba1RMB_DSY'),
    numberField('KPI\u6708\u7d2f\u8ba1SAR_LGM'),
    numberField('KPI\u6708\u7d2f\u8ba1RMB_LGM'),
    numberField('KPI\u6708\u8ba2\u5355\u6570', 0),
    numberField('KPI\u6708\u9500\u91cf', 0),
    numberField('KPI\u6708\u8ba2\u5355\u6570_DSY', 0),
    numberField('KPI\u6708\u9500\u91cf_DSY', 0),
    numberField('KPI\u6708\u8ba2\u5355\u6570_LGM', 0),
    numberField('KPI\u6708\u9500\u91cf_LGM', 0),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9SAR'),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9RMB'),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9SAR_DSY'),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9RMB_DSY'),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9SAR_LGM'),
    numberField('KPI\u9884\u6d4b\u4e1a\u7ee9RMB_LGM'),
    numberField('KPI\u9884\u6d4b\u5229\u6da6RMB'),
    numberField('KPI\u9884\u6d4b\u5229\u6da6RMB_DSY'),
    numberField('KPI\u9884\u6d4b\u5229\u6da6RMB_LGM'),
  ];
}

function scopeFields() {
  return [
    textField('唯一键'), textField('范围'), textField('月份'), textField('更新时间'), textField('数据抓取时间'),
    numberField('今日SAR'), numberField('今日RMB'), textField('今日金额'),
    numberField('昨日SAR'), numberField('昨日RMB'), textField('昨日金额'),
    numberField('月累计SAR'), numberField('月累计RMB'), textField('月累计金额'),
    numberField('月日均SAR'), numberField('预测业绩SAR'), numberField('预测业绩RMB'), textField('预测业绩'),
    numberField('预测利润RMB'),
    numberField('今日订单数', 0), numberField('昨日订单数', 0), numberField('月订单数', 0),
    numberField('今日销量', 0), numberField('昨日销量', 0), numberField('月销量', 0),
    numberField('今日动销产品数', 0),
    ...kpiScopeFields(),
  ];
}
function trendFields() {
  return [textField('唯一键'), textField('范围'), textField('日期'), textField('完整日期'), numberField('排序', 0), textField('更新时间'), numberField('销售额SAR'), numberField('销售额RMB'), numberField('订单数', 0), numberField('销量', 0)];
}
function storeFields() {
  return [
    textField('\u552f\u4e00\u952e'), textField('\u8303\u56f4'), numberField('\u6392\u540d', 0),
    textField('\u5206\u7ec4'), textField('\u5e97\u94fa\u4ee3\u53f7'), textField('\u5e97\u94fa\u6807\u7b7e'),
    textField('\u5e97\u94fa\u6392\u884c\u6807\u7b7e'), textField('\u5e97\u94fa\u8ba2\u5355\u6392\u884c\u6807\u7b7e'), textField('\u5e97\u94fa\u9500\u91cf\u6392\u884c\u6807\u7b7e'),
    textField('\u5e97\u94fa\u540d\u79f0'), textField('\u66f4\u65b0\u65f6\u95f4'),
    numberField('\u6708\u9500\u552e\u989dSAR'), numberField('\u6708\u9500\u552e\u989dRMB'), textField('\u6708\u9500\u552e\u989d'),
    numberField('\u8ba2\u5355\u6570', 0), numberField('\u9500\u91cf', 0),
  ];
}
function productFields() {
  return [textField('唯一键'), textField('范围'), numberField('排名', 0), textField('货号'), textField('货号排行标签'), textField('货号销售额排行标签'), textField('商品名称'), textField('涉及分组'), numberField('涉及店铺数', 0), textField('更新时间'), numberField('销量', 0), numberField('销售额SAR'), numberField('销售额RMB'), textField('销售额')];
}
function historyFields() {
  return [textField('唯一键'), textField('范围'), textField('月份'), textField('更新时间'), numberField('销售额SAR'), numberField('销售额RMB'), textField('销售额'), numberField('订单数', 0), numberField('销量', 0)];
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
async function deleteBlock(baseToken, dashboardId, blockId) {
  return await runLark(['base', '+dashboard-block-delete', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId, '--block-id', blockId, '--yes'], null, null, 5);
}
async function createBlock(baseToken, dashboardId, block) {
  const file = await writePayload(`dashboard-v3-${block.name}`, block.dataConfig);
  const resp = await runLark([
    'base', '+dashboard-block-create', '--as', 'user', '--base-token', baseToken,
    '--dashboard-id', dashboardId, '--name', block.name, '--type', block.type,
    '--data-config', `@${path.relative(ROOT, file).replace(/\\/g, '/')}`,
  ]);
  return resp.parsed?.data?.block || resp.parsed?.block || resp.parsed?.data;
}
async function updateBlock(baseToken, dashboardId, blockId, block) {
  const resp = await runLark([
    'base', '+dashboard-block-update', '--as', 'user', '--base-token', baseToken,
    '--dashboard-id', dashboardId, '--block-id', blockId,
    '--name', block.name,
    '--data-config', JSON.stringify(block.dataConfig),
  ]);
  return resp.parsed?.data?.block || resp.parsed?.block || resp.parsed?.data;
}

function dashboardText(scopeRows, month, updatedAt, periodMode = 'current') {
  const byScope = Object.fromEntries(scopeRows.map(r => [r['\u8303\u56f4'], r]));
  const allFetchAt = byScope['\u5168\u90e8']?.['\u6570\u636e\u6293\u53d6\u65f6\u95f4'] || updatedAt;
  return [
    `# SHEIN \u7ecf\u8425\u770b\u677f\uff5c${month}`,
    '',
    `### \u6570\u636e\u6293\u53d6\u65f6\u95f4\uff1a${allFetchAt}\uff08\u5317\u4eac\u65f6\u95f4\uff09`,
    `### \u770b\u677f\u5237\u65b0\u65f6\u95f4\uff1a${updatedAt}\uff08\u5317\u4eac\u65f6\u95f4\uff09`,
  ].join('\n');
}

function statisticBlock(name, tableName, fieldNames) {
  const fields = Array.isArray(fieldNames) ? fieldNames : [fieldNames];
  return {
    name,
    type: 'statistics',
    dataConfig: {
      table_name: tableName,
      series: fields.map(fieldName => ({field_name: fieldName, rollup: 'SUM'})),
    },
  };
}

function textBlock(name, text) {
  return {name, type: 'text', dataConfig: {text}};
}

function kpiCardText(title, value, sub = null) {
  return [
    `### ${title}`,
    `**${value}**`,
    sub ? `${sub}` : null,
  ].filter(Boolean).join('\n');
}

function kpiTextBlocks(scopeRows, periodMode = 'current') {
  const byScope = Object.fromEntries(scopeRows.map(r => [r['范围'], r]));
  const all = byScope['全部'] || {};
  const dsy = byScope.DSY || {};
  const lgm = byScope.LGM || {};
  if (periodMode === 'month') {
    return [
      textBlock('上月实际销售额｜全部', kpiCardText('上月实际销售额（全部）', all['月累计金额'] || '-')),
      textBlock('上月实际销售额｜DSY', kpiCardText('上月实际销售额（DSY）', dsy['月累计金额'] || '-')),
      textBlock('上月实际销售额｜LGM', kpiCardText('上月实际销售额（LGM）', lgm['月累计金额'] || '-')),
      textBlock('上月订单 / 销量｜全部', kpiCardText('上月订单 / 销量（全部）', `${all['月订单数'] || 0} 单 / ${all['月销量'] || 0} 件`)),
    ];
  }
  return [
    textBlock('今日销售额｜全部', kpiCardText('今日销售额（全部）', all['今日金额'] || '-')),
    textBlock('今日销售额｜DSY', kpiCardText('今日销售额（DSY）', dsy['今日金额'] || '-')),
    textBlock('今日销售额｜LGM', kpiCardText('今日销售额（LGM）', lgm['今日金额'] || '-')),
    textBlock('今日订单 / 销量｜全部', kpiCardText('今日订单 / 销量（全部）', `${all['今日订单数'] || 0} 单 / ${all['今日销量'] || 0} 件`)),
    textBlock('本月累计销售额｜全部', kpiCardText('本月累计销售额（全部）', all['月累计金额'] || '-')),
    textBlock('本月累计销售额｜DSY', kpiCardText('本月累计销售额（DSY）', dsy['月累计金额'] || '-')),
    textBlock('本月累计销售额｜LGM', kpiCardText('本月累计销售额（LGM）', lgm['月累计金额'] || '-')),
    textBlock('预测业绩｜全部', kpiCardText('预测业绩（全部）', all['预测业绩'] || '-')),
    textBlock('预测利润｜全部', kpiCardText('预测利润（全部）', `${fmt(all['预测利润RMB'] || 0)} RMB`)),
  ];
}

const OBSOLETE_KPI_BLOCK_NAMES = new Set([
  '今日销售额 SAR（全部）',
  '今日销售额 RMB（全部）',
  '今日订单数（全部）',
  '今日销量（全部）',
  '本月累计 SAR（全部）',
  '预测业绩 SAR（全部）',
  '上月实际销售额 SAR（全部）',
  '上月实际销售额 RMB（全部）',
  '上月订单数（全部）',
  '上月销量（全部）',
  '今日销售额（全部｜SAR/RMB）',
  '今日销售额（DSY｜SAR/RMB）',
  '今日销售额（LGM｜SAR/RMB）',
  '今日订单 / 销量（全部）',
  '本月累计销售额（全部｜SAR/RMB）',
  '本月累计销售额（DSY｜SAR/RMB）',
  '本月累计销售额（LGM｜SAR/RMB）',
  '预测业绩（全部｜SAR/RMB）',
  '预测利润 RMB（全部）',
  '上月实际销售额（全部｜SAR/RMB）',
  '上月实际销售额（DSY｜SAR/RMB）',
  '上月实际销售额（LGM｜SAR/RMB）',
  '上月订单 / 销量（全部）',
  '今日销售额｜全部',
  '今日销售额｜DSY',
  '今日销售额｜LGM',
  '今日订单 / 销量｜全部',
  '本月累计销售额｜全部',
  '本月累计销售额｜DSY',
  '本月累计销售额｜LGM',
  '预测业绩｜全部',
  '预测利润｜全部',
  '上月实际销售额｜全部',
  '上月实际销售额｜DSY',
  '上月实际销售额｜LGM',
  '上月订单 / 销量｜全部',
]);

const BLOCK_NAME_ALIASES = new Map([
  ['今日销售 SAR（全部）', '🟢 今日销售 SAR（全部）'],
  ['今日销售 RMB（全部）', '🟢 今日销售 RMB（全部）'],
  ['🔷 今日销售 SAR（全部）', '🟢 今日销售 SAR（全部）'],
  ['🔷 今日销售 RMB（全部）', '🟢 今日销售 RMB（全部）'],
  ['今日销售 SAR（DSY）', '🔵 今日销售 SAR（DSY）'],
  ['今日销售 SAR（LGM）', '🟠 今日销售 SAR（LGM）'],
  ['今日订单数（全部）', '🟢 今日订单数（全部）'],
  ['今日销量（全部）', '🟢 今日销量（全部）'],
  ['🔷 今日订单数（全部）', '🟢 今日订单数（全部）'],
  ['🔷 今日销量（全部）', '🟢 今日销量（全部）'],
  ['本月累计 SAR（全部）', '🟢 本月累计 SAR（全部）'],
  ['本月累计 RMB（全部）', '🟢 本月累计 RMB（全部）'],
  ['🔷 本月累计 SAR（全部）', '🟢 本月累计 SAR（全部）'],
  ['🔷 本月累计 RMB（全部）', '🟢 本月累计 RMB（全部）'],
  ['本月累计 SAR（DSY）', '🔵 本月累计 SAR（DSY）'],
  ['本月累计 SAR（LGM）', '🟠 本月累计 SAR（LGM）'],
  ['预测业绩 SAR（全部）', '🟢 预测业绩 SAR（全部）'],
  ['预测业绩 RMB（全部）', '🟢 预测业绩 RMB（全部）'],
  ['预测利润 RMB（全部）', '🟢 预测利润 RMB（全部）'],
  ['🔷 预测业绩 SAR（全部）', '🟢 预测业绩 SAR（全部）'],
  ['🔷 预测业绩 RMB（全部）', '🟢 预测业绩 RMB（全部）'],
  ['🔷 预测利润 RMB（全部）', '🟢 预测利润 RMB（全部）'],
  ['上月实际 SAR（全部）', '🟢 上月累计 SAR（全部）'],
  ['上月实际 RMB（全部）', '🟢 上月累计 RMB（全部）'],
  ['🔷 上月实际 SAR（全部）', '🟢 上月累计 SAR（全部）'],
  ['🔷 上月实际 RMB（全部）', '🟢 上月累计 RMB（全部）'],
  ['上月实际 SAR（DSY）', '🔵 上月累计 SAR（DSY）'],
  ['上月实际 RMB（DSY）', '🔵 上月累计 RMB（DSY）'],
  ['🔵 上月实际 SAR（DSY）', '🔵 上月累计 SAR（DSY）'],
  ['🔵 上月实际 RMB（DSY）', '🔵 上月累计 RMB（DSY）'],
  ['上月实际 SAR（LGM）', '🟠 上月累计 SAR（LGM）'],
  ['上月实际 RMB（LGM）', '🟠 上月累计 RMB（LGM）'],
  ['🟠 上月实际 SAR（LGM）', '🟠 上月累计 SAR（LGM）'],
  ['🟠 上月实际 RMB（LGM）', '🟠 上月累计 RMB（LGM）'],
  ['上月订单数（全部）', '🟢 上月订单数（全部）'],
  ['上月销量（全部）', '🟢 上月销量（全部）'],
  ['🔷 上月订单数（全部）', '🟢 上月订单数（全部）'],
  ['🔷 上月销量（全部）', '🟢 上月销量（全部）'],
]);

function blocks(tableNames, text, scopeRows, periodMode = 'current') {
  const monthSnapshot = periodMode === 'month';
  const kpiBlocks = monthSnapshot ? [
    statisticBlock('🟢 上月累计 SAR（全部）', tableNames.scope, 'KPI今日SAR'),
    statisticBlock('🟢 上月累计 RMB（全部）', tableNames.scope, 'KPI今日RMB'),
    statisticBlock('🟢 上月订单数（全部）', tableNames.scope, 'KPI今日订单数'),
    statisticBlock('🟢 上月销量（全部）', tableNames.scope, 'KPI今日销量'),
    statisticBlock('🟢 上月预测利润 RMB（全部）', tableNames.scope, 'KPI预测利润RMB'),
    statisticBlock('🔵 上月累计 SAR（DSY）', tableNames.scope, 'KPI今日SAR_DSY'),
    statisticBlock('🔵 上月累计 RMB（DSY）', tableNames.scope, 'KPI今日RMB_DSY'),
    statisticBlock('🔵 上月订单数（DSY）', tableNames.scope, 'KPI今日订单数_DSY'),
    statisticBlock('🔵 上月销量（DSY）', tableNames.scope, 'KPI今日销量_DSY'),
    statisticBlock('🔵 上月预测利润 RMB（DSY）', tableNames.scope, 'KPI预测利润RMB_DSY'),
    statisticBlock('🟠 上月累计 SAR（LGM）', tableNames.scope, 'KPI今日SAR_LGM'),
    statisticBlock('🟠 上月累计 RMB（LGM）', tableNames.scope, 'KPI今日RMB_LGM'),
    statisticBlock('🟠 上月订单数（LGM）', tableNames.scope, 'KPI今日订单数_LGM'),
    statisticBlock('🟠 上月销量（LGM）', tableNames.scope, 'KPI今日销量_LGM'),
    statisticBlock('🟠 上月预测利润 RMB（LGM）', tableNames.scope, 'KPI预测利润RMB_LGM'),
  ] : [
    statisticBlock('🟢 今日销售 SAR（全部）', tableNames.scope, 'KPI今日SAR'),
    statisticBlock('🟢 今日销售 RMB（全部）', tableNames.scope, 'KPI今日RMB'),
    statisticBlock('🟢 今日订单数（全部）', tableNames.scope, 'KPI今日订单数'),
    statisticBlock('🟢 今日销量（全部）', tableNames.scope, 'KPI今日销量'),
    statisticBlock('🟢 本月累计 SAR（全部）', tableNames.scope, 'KPI月累计SAR'),
    statisticBlock('🟢 本月累计 RMB（全部）', tableNames.scope, 'KPI月累计RMB'),
    statisticBlock('🟢 本月订单数（全部）', tableNames.scope, 'KPI月订单数'),
    statisticBlock('🟢 本月销量（全部）', tableNames.scope, 'KPI月销量'),
    statisticBlock('🟢 预测业绩 SAR（全部）', tableNames.scope, 'KPI预测业绩SAR'),
    statisticBlock('🟢 预测业绩 RMB（全部）', tableNames.scope, 'KPI预测业绩RMB'),
    statisticBlock('🟢 预测利润 RMB（全部）', tableNames.scope, 'KPI预测利润RMB'),
    statisticBlock('🔵 今日销售 SAR（DSY）', tableNames.scope, 'KPI今日SAR_DSY'),
    statisticBlock('🔵 今日销售 RMB（DSY）', tableNames.scope, 'KPI今日RMB_DSY'),
    statisticBlock('🔵 今日订单数（DSY）', tableNames.scope, 'KPI今日订单数_DSY'),
    statisticBlock('🔵 今日销量（DSY）', tableNames.scope, 'KPI今日销量_DSY'),
    statisticBlock('🔵 今日动销产品数（DSY）', tableNames.scope, 'KPI今日动销产品数_DSY'),
    statisticBlock('🔵 本月累计 SAR（DSY）', tableNames.scope, 'KPI月累计SAR_DSY'),
    statisticBlock('🔵 本月累计 RMB（DSY）', tableNames.scope, 'KPI月累计RMB_DSY'),
    statisticBlock('🔵 本月订单数（DSY）', tableNames.scope, 'KPI月订单数_DSY'),
    statisticBlock('🔵 本月销量（DSY）', tableNames.scope, 'KPI月销量_DSY'),
    statisticBlock('🔵 预测业绩 SAR（DSY）', tableNames.scope, 'KPI预测业绩SAR_DSY'),
    statisticBlock('🔵 预测业绩 RMB（DSY）', tableNames.scope, 'KPI预测业绩RMB_DSY'),
    statisticBlock('🔵 预测利润 RMB（DSY）', tableNames.scope, 'KPI预测利润RMB_DSY'),
    statisticBlock('🟠 今日销售 SAR（LGM）', tableNames.scope, 'KPI今日SAR_LGM'),
    statisticBlock('🟠 今日销售 RMB（LGM）', tableNames.scope, 'KPI今日RMB_LGM'),
    statisticBlock('🟠 今日订单数（LGM）', tableNames.scope, 'KPI今日订单数_LGM'),
    statisticBlock('🟠 今日销量（LGM）', tableNames.scope, 'KPI今日销量_LGM'),
    statisticBlock('🟠 今日动销产品数（LGM）', tableNames.scope, 'KPI今日动销产品数_LGM'),
    statisticBlock('🟠 本月累计 SAR（LGM）', tableNames.scope, 'KPI月累计SAR_LGM'),
    statisticBlock('🟠 本月累计 RMB（LGM）', tableNames.scope, 'KPI月累计RMB_LGM'),
    statisticBlock('🟠 本月订单数（LGM）', tableNames.scope, 'KPI月订单数_LGM'),
    statisticBlock('🟠 本月销量（LGM）', tableNames.scope, 'KPI月销量_LGM'),
    statisticBlock('🟠 预测业绩 SAR（LGM）', tableNames.scope, 'KPI预测业绩SAR_LGM'),
    statisticBlock('🟠 预测业绩 RMB（LGM）', tableNames.scope, 'KPI预测业绩RMB_LGM'),
    statisticBlock('🟠 预测利润 RMB（LGM）', tableNames.scope, 'KPI预测利润RMB_LGM'),
  ];
  return [
    {name: '\u6570\u636e\u65f6\u95f4\u8bf4\u660e', type: 'text', dataConfig: {text}},
    ...kpiBlocks,
    {
      name: '\u8fd1\u65e5\u65e5\u9500\u552e\u8d8b\u52bf\uff08ALL / DSY / LGM\uff09',
      type: 'line',
      dataConfig: {
        table_name: tableNames.trend,
        series: [{field_name: '\u9500\u552e\u989dSAR', rollup: 'SUM'}],
        group_by: [
          {field_name: '\u65e5\u671f', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
          {field_name: '\u8303\u56f4', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
        ],
      },
    },
    {
      name: '\u672c\u6708\u9500\u552e\u989d\u5bf9\u6bd4\uff08ALL / DSY / LGM\uff09',
      type: 'column',
      dataConfig: {
        table_name: tableNames.scope,
        series: [{field_name: '\u6708\u7d2f\u8ba1SAR', rollup: 'SUM'}],
        group_by: [{field_name: '\u8303\u56f4', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
      },
    },
    {
      name: '\u5e97\u94fa\u9500\u552e\u6392\u884c\uff08\u5168\u90e815\u5e97\uff0c\u964d\u5e8f\uff09',
      type: 'bar',
      dataConfig: {
        table_name: tableNames.store,
        series: [{field_name: '\u6708\u9500\u552e\u989dSAR', rollup: 'SUM'}],
        group_by: [
          {field_name: '\u5e97\u94fa\u6392\u884c\u6807\u7b7e', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
          {field_name: '\u5206\u7ec4', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
        ],
      },
    },
    {
      name: '\u4ea7\u54c1\u9500\u91cf\u6392\u884c\uff08\u5168\u90e8\u8d27\u53f7\uff0c\u964d\u5e8f\uff09',
      type: 'bar',
      dataConfig: {
        table_name: tableNames.product,
        series: [{field_name: '\u9500\u91cf', rollup: 'SUM'}],
        group_by: [{field_name: '\u8d27\u53f7\u6392\u884c\u6807\u7b7e', mode: 'integrated', sort: {type: 'group', order: 'asc'}}],
      },
    },
    {
      name: '\u4ea7\u54c1\u9500\u552e\u989d\u6392\u884c\uff08\u5168\u90e8\u8d27\u53f7\uff0c\u964d\u5e8f\uff09',
      type: 'bar',
      dataConfig: {
        table_name: tableNames.product,
        series: [{field_name: '\u9500\u552e\u989dSAR', rollup: 'SUM'}],
        group_by: [{field_name: '\u8d27\u53f7\u9500\u552e\u989d\u6392\u884c\u6807\u7b7e', mode: 'integrated', sort: {type: 'group', order: 'asc'}}],
      },
    },
    {
      name: '\u5386\u53f2\u6708\u9500\u8d8b\u52bf\uff08ALL / DSY / LGM\uff09',
      type: 'line',
      dataConfig: {
        table_name: tableNames.history,
        series: [{field_name: '\u9500\u552e\u989dSAR', rollup: 'SUM'}],
        group_by: [
          {field_name: '\u6708\u4efd', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
          {field_name: '\u8303\u56f4', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
        ],
      },
    },
    {
      name: '\u5e97\u94fa\u9500\u91cf\u6392\u884c\uff08\u5168\u90e815\u5e97\uff0c\u964d\u5e8f\uff09',
      type: 'bar',
      dataConfig: {
        table_name: tableNames.store,
        series: [{field_name: '\u9500\u91cf', rollup: 'SUM'}],
        group_by: [
          {field_name: '\u5e97\u94fa\u9500\u91cf\u6392\u884c\u6807\u7b7e', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
          {field_name: '\u5206\u7ec4', mode: 'integrated', sort: {type: 'group', order: 'asc'}},
        ],
      },
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const month = args.month || currentMonth();
  const updatedAt = beijingNowString();
  const state = await readJson(STATE_PATH);
  const storesConfig = await readJson(STORES_PATH);
  const baseToken = state.baseToken;
  const sourcePrefix = args.sourcePrefix || 'MAIN';
  const tableNames = {
    scope: `看板数据-${sourcePrefix}-范围汇总`,
    trend: `看板数据-${sourcePrefix}-日趋势`,
    store: `看板数据-${sourcePrefix}-店铺排行`,
    product: `看板数据-${sourcePrefix}-产品排行`,
    history: `看板数据-${sourcePrefix}-历史月销`,
  };
  const defs = [
    [tableNames.scope, scopeFields()],
    [tableNames.trend, trendFields()],
    [tableNames.store, storeFields()],
    [tableNames.product, productFields()],
    [tableNames.history, historyFields()],
  ];
  const ensured = {};
  const createdTables = [];
  for (const [name, fields] of defs) {
    ensured[name] = await ensureTable(state, baseToken, name, fields);
    if (ensured[name].created) createdTables.push(name);
  }

  // 兼容旧版本已建表，补充 v3 新字段。
  await ensureField(baseToken, ensured[tableNames.scope].tableId, '今日金额', textField('今日金额'));
  await ensureField(baseToken, ensured[tableNames.scope].tableId, '昨日金额', textField('昨日金额'));
  await ensureField(baseToken, ensured[tableNames.scope].tableId, '月累计金额', textField('月累计金额'));
  await ensureField(baseToken, ensured[tableNames.scope].tableId, '预测业绩', textField('预测业绩'));
  await ensureField(baseToken, ensured[tableNames.scope].tableId, '今日动销产品数', numberField('今日动销产品数', 0));
  for (const field of kpiScopeFields()) {
    await ensureField(baseToken, ensured[tableNames.scope].tableId, field.name, field);
  }
  await ensureField(baseToken, ensured[tableNames.store].tableId, '范围', textField('范围'));
  await ensureField(baseToken, ensured[tableNames.store].tableId, '店铺标签', textField('店铺标签'));
  await ensureField(baseToken, ensured[tableNames.store].tableId, '店铺排行标签', textField('店铺排行标签'));
  await ensureField(baseToken, ensured[tableNames.store].tableId, '\u5e97\u94fa\u8ba2\u5355\u6392\u884c\u6807\u7b7e', textField('\u5e97\u94fa\u8ba2\u5355\u6392\u884c\u6807\u7b7e'));
  await ensureField(baseToken, ensured[tableNames.store].tableId, '\u5e97\u94fa\u9500\u91cf\u6392\u884c\u6807\u7b7e', textField('\u5e97\u94fa\u9500\u91cf\u6392\u884c\u6807\u7b7e'));
  await ensureField(baseToken, ensured[tableNames.store].tableId, '月销售额', textField('月销售额'));
  await ensureField(baseToken, ensured[tableNames.product].tableId, '范围', textField('范围'));
  await ensureField(baseToken, ensured[tableNames.product].tableId, '货号排行标签', textField('货号排行标签'));
  await ensureField(baseToken, ensured[tableNames.product].tableId, '货号销售额排行标签', textField('货号销售额排行标签'));
  await ensureField(baseToken, ensured[tableNames.product].tableId, '销售额', textField('销售额'));
  await ensureField(baseToken, ensured[tableNames.history].tableId, '销售额', textField('销售额'));

  const scopeRows = await buildScopeRows(storesConfig, month, updatedAt, args.periodMode);
  const sourceRows = {
    [tableNames.scope]: scopeRows,
    [tableNames.trend]: await buildTrendRows(storesConfig, month, args.trendDays, updatedAt),
    [tableNames.store]: await buildStoreRows(storesConfig, month, updatedAt),
    [tableNames.product]: await buildProductRows(storesConfig, month, args.topProducts, updatedAt),
    [tableNames.history]: await buildHistoryRows(storesConfig, updatedAt),
  };
  const sourceResults = [];
  if (args.refreshSources) {
    for (const [name, rows] of Object.entries(sourceRows)) {
      const write = await upsertRecords(baseToken, ensured[name].tableId, rows);
      const staleDeleted = await deleteStaleRecords(
        baseToken,
        ensured[name].tableId,
        new Set(rows.map(r => r['唯一键'])),
      );
      sourceResults.push({name, tableId: ensured[name].tableId, rowCount: rows.length, staleDeleted, ...write});
    }
  }

  let dashboardId = null;
  let dashboardCreated = false;
  const blockResults = [];
  let richTextTimeUpdate = null;
  if (args.createDashboard) {
    let dashboard = (await listDashboards(baseToken)).find(d => d.name === args.name);
    if (!dashboard) {
      dashboard = await createDashboard(baseToken, args.name, args.themeStyle);
      dashboardCreated = true;
    }
    dashboardId = dashboard.dashboard_id || dashboard.id;
    const oldBlocks = await listBlocks(baseToken, dashboardId);
    if (args.rebuildBlocks) {
      for (const b of oldBlocks) {
        const blockId = b.block_id || b.id;
        if (blockId) await deleteBlock(baseToken, dashboardId, blockId);
      }
    }
    const desiredBlocks = blocks(tableNames, dashboardText(scopeRows, month, updatedAt, args.periodMode), scopeRows, args.periodMode);
    const desiredNames = new Set(desiredBlocks.map(b => b.name));
    if (!args.rebuildBlocks) {
      for (const b of oldBlocks) {
        if (BLOCK_NAME_ALIASES.has(b.name)) continue;
        if (!OBSOLETE_KPI_BLOCK_NAMES.has(b.name) || desiredNames.has(b.name)) continue;
        const blockId = b.block_id || b.id;
        if (blockId) {
          await deleteBlock(baseToken, dashboardId, blockId);
          blockResults.push({name: b.name, type: b.type, action: 'deleted_obsolete', blockId});
        }
      }
    }
    const existing = args.rebuildBlocks ? [] : await listBlocks(baseToken, dashboardId);
    const existingByName = new Map();
    for (const b of existing) {
      existingByName.set(b.name, b);
      const desiredAlias = BLOCK_NAME_ALIASES.get(b.name);
      if (desiredAlias && !existingByName.has(desiredAlias)) existingByName.set(desiredAlias, b);
    }
    for (const block of desiredBlocks) {
      const old = existingByName.get(block.name);
      const oldBlockId = old?.block_id || old?.id;
      if (oldBlockId) {
        const oldType = old?.type || old?.block_type;
        if (oldType && oldType !== block.type) {
          await deleteBlock(baseToken, dashboardId, oldBlockId);
          const recreated = await createBlock(baseToken, dashboardId, block);
          blockResults.push({name: block.name, type: block.type, action: 'recreated', oldBlockId, blockId: recreated?.block_id || recreated?.id || null});
        } else if (block.type === 'text') {
          // 飞书公开 OpenAPI 创建 text block 时会把 Markdown 转成内部 rich_text，
          // 但更新已存在 text block 时会把 text 再 JSON-stringify 成带引号的普通字符串，
          // 甚至让前端显示字面量 \n / 字体不生效。用户已手动调整看板布局，不能删建文本块。
          // 因此已存在的文本块只保留，不走公开 update；如需更新富文本内容，需通过
          // 飞书 web 内部 rich_text 保存接口单独处理，避免破坏布局和渲染。
          blockResults.push({name: block.name, type: block.type, action: 'preserved_rich_text', blockId: oldBlockId});
        } else {
          await updateBlock(baseToken, dashboardId, oldBlockId, block);
          blockResults.push({name: block.name, type: block.type, action: 'updated', blockId: oldBlockId});
        }
        continue;
      }
      const created = await createBlock(baseToken, dashboardId, block);
      blockResults.push({name: block.name, type: block.type, action: 'created', blockId: created?.block_id || created?.id || null});
    }
    if (args.arrange) {
      await runLark(['base', '+dashboard-arrange', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId]);
    }
    state.dashboards = state.dashboards || {};
    const activeBlockResults = blockResults.filter(r => !String(r.action || '').startsWith('deleted'));
    state.dashboards[args.name] = {
      dashboard_id: dashboardId,
      month,
      group: sourcePrefix,
      source_tables: Object.fromEntries(Object.entries(tableNames).map(([k, name]) => [k, {name, table_id: ensured[name].tableId}])),
      updated_at: new Date().toISOString(),
      blocks: activeBlockResults,
    };
    await saveState(state);

    if (args.updateRichTextTime) {
      const richTextArgs = [
        '--dashboard', sourcePrefix === 'PREV' ? 'prev' : 'main',
        '--month', month,
        '--dashboard-id', dashboardId,
        '--dashboard-name', args.name,
        '--source-prefix', sourcePrefix,
        '--scope-table-id', ensured[tableNames.scope].tableId,
      ];
      if (args.richTextProfileDir) richTextArgs.push('--profile-dir', args.richTextProfileDir);
      if (args.richTextVisible) richTextArgs.push('--visible');
      const richText = await runNodeBestEffortWithRetry('scripts/update_dashboard_time_richtext_ui.mjs', richTextArgs, {
        attempts: 3,
        timeoutMs: 180_000,
        delayMs: 5000,
      });
      let parsed = null;
      try { parsed = parseFirstJson(richText.stdout); } catch {}
      richTextTimeUpdate = {
        ok: richText.ok && parsed?.ok !== false,
        code: richText.code,
        parsed,
        attempts: richText.attempts,
        stdoutTail: richText.stdout.slice(-1200),
        stderrTail: richText.stderr.slice(-1200),
      };
    }
  }

  const result = {
    ok: true,
    month,
    dashboardName: args.name,
    sourcePrefix,
    periodMode: args.periodMode,
    dashboardId,
    dashboardCreated,
    dashboardUrl: dashboardId ? `https://zcnm3ts63aph.feishu.cn/base/${baseToken}?table=${dashboardId}` : null,
    updatedAt,
    createdTables,
    sourceResults,
    blockResults,
    richTextTimeUpdate,
    summary: scopeRows.map(r => ({
      scope: r['范围'],
      today: r['今日金额'],
      yesterday: r['昨日金额'],
      month: r['月累计金额'],
      predicted: r['预测业绩'],
    })),
  };
  const reportFile = path.join(REPORT_DIR, `main-dashboard-v3-${month}.json`);
  await writeJson(reportFile, result);
  console.log(JSON.stringify({...result, reportFile: path.relative(ROOT, reportFile)}, null, 2));
}

await main();
