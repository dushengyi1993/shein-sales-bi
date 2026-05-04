#!/usr/bin/env node
/**
 * Sync SHEIN product sales from local fetch detail JSON files into Lark Base.
 *
 * Data source:
 *   outputs/shein_fetch/<store>/<YYYY-MM-DD>.json
 *
 * Writes by default:
 *   1) 产品日销量事实：one row per store + day + goodsSn
 *   2) 产品日销量-YYYY-MM：monthly wide display table, one row per group + goodsSn
 *
 * Product weekly/monthly wide display tables are refreshed by
 * scripts/generate_compact_display_tables.mjs. Legacy narrow aggregate tables
 * (产品周销量 / 产品月销量) are opt-in only for compatibility.
 *
 * Examples:
 *   node scripts/sync_product_sales_to_lark.mjs --date 2026-04-26 --group DSY
 *   node scripts/sync_product_sales_to_lark.mjs --month 2026-03 --group DSY
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
  const args = {
    group: 'DSY',
    writeDaily: true,
    writeWeekly: false,
    writeMonthly: false,
    writeDisplay: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--no-daily') args.writeDaily = false;
    else if (a === '--write-weekly' || a === '--with-weekly') args.writeWeekly = true;
    else if (a === '--no-weekly') args.writeWeekly = false;
    else if (a === '--write-monthly' || a === '--with-monthly') args.writeMonthly = true;
    else if (a === '--no-monthly') args.writeMonthly = false;
    else if (a === '--no-display') args.writeDisplay = false;
    else if (a === '--replace-period') args.replacePeriod = true;
  }
  if (!args.date && !args.month) throw new Error('Missing --date YYYY-MM-DD or --month YYYY-MM');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('Invalid --date, expected YYYY-MM-DD');
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new Error('Invalid --month, expected YYYY-MM');
  if (args.date && !args.month) args.month = args.date.slice(0, 7);
  return args;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateTimeString(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function daysInMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0).getDate();
}

function* eachDate(start, end) {
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop) {
    yield `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function monthDates(month) {
  return [...eachDate(`${month}-01`, `${month}-${pad2(daysInMonth(month))}`)];
}

function weekRangeForDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Monday=1, Sunday=7
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - (day - 1));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = x => `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
  return {start: fmt(start), end: fmt(end)};
}

function isoWeekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${pad2(week)}`;
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
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) {
        const msg = parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`;
        reject(new Error(msg));
      } else {
        resolve({stdout, stderr, parsed});
      }
    });
  });
}

async function runLark(args, payloadName = null, payload = null, attempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runLarkOnce(args, payloadName, payload);
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const rateLimited = /limited|rate.?limit|800004135|OpenAPISearchRecord limited/i.test(msg);
      const retryable = rateLimited || /EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily|503|502|504|5000|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn|HTTP 500/i.test(msg);
      if (!retryable || attempt === attempts) break;
      const delayMs = rateLimited ? attempt * 10000 : attempt * 1500;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function selectedStores(storesConfig, args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false && s.productStatsEnabled !== false);
  if (args.stores?.length) {
    return args.stores.map(key => {
      const store = enabled.find(s => s.storeKey.toUpperCase() === key);
      if (!store) throw new Error(`Unknown, disabled, or product-disabled store: ${key}`);
      return store;
    });
  }
  const keys = storesConfig.groups?.[args.group] || [];
  return keys.map(key => enabled.find(s => s.storeKey === key)).filter(Boolean);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function addAgg(map, key, seed, qty, salesSar) {
  if (!map.has(key)) map.set(key, {...seed, qty: 0, salesSar: 0});
  const row = map.get(key);
  row.qty += qty;
  row.salesSar = round2(row.salesSar + salesSar);
}

async function loadDailyProductRows(stores, dates) {
  const daily = new Map();
  const skipped = [];
  for (const store of stores) {
    for (const date of dates) {
      const file = path.join(FETCH_DIR, store.storeKey, `${date}.json`);
      const obj = await readJsonIfExists(file);
      if (!obj?.goodsRows) {
        skipped.push({storeKey: store.storeKey, date, reason: 'missing detail json'});
        continue;
      }
      for (const g of obj.goodsRows || []) {
        const qty = Number(g.number || 0);
        const salesSar = Number(g.currencyPrice || 0);
        const rawGoodsSn = String(g.goodsSn || g.skuSn || g.skuCode || g.skcName || '').trim();
        const goodsSn = normalizeGoodsSn(rawGoodsSn, {goodsTitle: g.goodsTitle});
        if (!goodsSn || qty <= 0 || salesSar <= 0) continue;
        const uniqueKey = `${date}__${store.storeKey}__${goodsSn}`;
        addAgg(daily, uniqueKey, {
          date,
          storeKey: store.storeKey,
          shopName: store.shopName,
          groupKey: store.groupKey,
          goodsSn,
          rawGoodsSn,
          goodsTitle: String(g.goodsTitle || '').slice(0, 500),
        }, qty, salesSar);
      }
    }
  }
  return {rows: [...daily.values()], skipped};
}

function aggregateWeekly(dailyRows, dates) {
  const dateSet = new Set(dates);
  const map = new Map();
  for (const row of dailyRows.filter(r => dateSet.has(r.date))) {
    const range = weekRangeForDate(row.date);
    const yearWeek = isoWeekKey(row.date);
    const uniqueKey = `${yearWeek}__${row.groupKey}__${row.goodsSn}`;
    addAgg(map, uniqueKey, {
      yearWeek,
      weekStart: range.start,
      weekEnd: range.end,
      groupKey: row.groupKey,
      goodsSn: row.goodsSn,
      goodsTitle: row.goodsTitle,
    }, row.qty, row.salesSar);
  }
  return [...map.values()];
}

function aggregateMonthly(dailyRows, month) {
  const map = new Map();
  for (const row of dailyRows.filter(r => r.date.startsWith(`${month}-`))) {
    const uniqueKey = `${month}__${row.groupKey}__${row.goodsSn}`;
    addAgg(map, uniqueKey, {
      month,
      groupKey: row.groupKey,
      goodsSn: row.goodsSn,
      goodsTitle: row.goodsTitle,
    }, row.qty, row.salesSar);
  }
  return [...map.values()];
}

function groupInSelectedScope(groupKey, selectedGroup) {
  if (selectedGroup === 'ALL') return groupKey === 'DSY' || groupKey === 'LGM';
  return groupKey === selectedGroup;
}

function buildDailyDisplayRows(dailyRows, month) {
  const days = daysInMonth(month);
  const map = new Map();
  for (const row of dailyRows.filter(r => r.date.startsWith(`${month}-`))) {
    const uniqueKey = `${month}__${row.groupKey}__${row.goodsSn}`;
    if (!map.has(uniqueKey)) {
      map.set(uniqueKey, {
        uniqueKey,
        groupKey: row.groupKey,
        goodsSn: row.goodsSn,
        goodsTitle: row.goodsTitle,
        totalQty: 0,
        totalSar: 0,
        dailyQty: Array(days).fill(0),
      });
    }
    const item = map.get(uniqueKey);
    const day = Number(row.date.slice(8, 10));
    item.dailyQty[day - 1] += Number(row.qty || 0);
    item.totalQty += Number(row.qty || 0);
    item.totalSar = round2(item.totalSar + Number(row.salesSar || 0));
  }
  return [...map.values()].sort((a, b) => b.totalQty - a.totalQty || a.goodsSn.localeCompare(b.goodsSn));
}

async function findRecord(baseToken, tableId, uniqueKey) {
  const resp = await runLark([
    'base', '+record-search',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
  ], `product-search-${uniqueKey}`, {
    keyword: uniqueKey,
    search_fields: ['唯一键'],
    select_fields: ['唯一键'],
    offset: 0,
    limit: 10,
  });
  return resp.parsed?.data?.record_id_list?.[0] || null;
}

async function listExistingRecordEntries(baseToken, tableId) {
  const entries = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const resp = await runLark([
      'base', '+record-list',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--field-id', '唯一键',
      '--offset', String(offset),
      '--limit', String(limit),
      '--format', 'json',
    ]);
    const data = resp.parsed?.data || {};
    const rows = data.data || [];
    const ids = data.record_id_list || [];
    const fields = data.fields || [];
    const keyIndex = Math.max(0, fields.indexOf('唯一键'));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawKey = Array.isArray(row) ? row[keyIndex] : (row?.fields?.['唯一键'] ?? row?.['唯一键']);
      const uniqueKey = String(rawKey ?? '').trim();
      const recordId = ids[i] || row?.record_id || row?.id || null;
      if (uniqueKey && recordId) entries.push({uniqueKey, recordId});
    }
    if (!data.has_more) break;
    offset += rows.length || limit;
  }
  return entries;
}

async function listExistingRecordMap(baseToken, tableId) {
  const map = new Map();
  for (const {uniqueKey, recordId} of await listExistingRecordEntries(baseToken, tableId)) {
    if (!map.has(uniqueKey)) map.set(uniqueKey, recordId);
  }
  return map;
}

async function updateRecordById(baseToken, tableId, recordId, record) {
  const args = [
    'base', '+record-upsert',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
  ];
  const resp = await runLark(args, `product-update-${recordId}`, record);
  return {action: 'updated', recordId, response: resp.parsed};
}

async function deleteRecordById(baseToken, tableId, recordId) {
  const resp = await runLark([
    'base', '+record-delete',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--yes',
  ]);
  return resp.parsed;
}

async function batchCreateRecords(baseToken, tableId, records) {
  if (!records.length) return [];
  const fields = Object.keys(records[0].record);
  const results = [];
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const payload = {
      fields,
      rows: chunk.map(item => fields.map(field => item.record[field] ?? null)),
    };
    const resp = await runLark([
      'base', '+record-batch-create',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
    ], `product-batch-create-${tableId}-${i}`, payload);
    const ids = resp.parsed?.data?.record_id_list || [];
    for (let j = 0; j < chunk.length; j++) {
      results.push({
        uniqueKey: chunk[j].uniqueKey,
        goodsSn: chunk[j].goodsSn,
        qty: chunk[j].qty,
        action: 'created',
        recordId: ids[j] || null,
      });
    }
  }
  return results;
}

async function upsertMany(baseToken, tableId, rows, mapper) {
  const entries = await listExistingRecordEntries(baseToken, tableId);
  const existing = new Map();
  const duplicates = [];
  for (const {uniqueKey, recordId} of entries) {
    if (!existing.has(uniqueKey)) existing.set(uniqueKey, recordId);
    else duplicates.push({uniqueKey, recordId});
  }
  const dedupedRows = new Map();
  for (const row of rows) {
    const mapped = mapper(row);
    if (!mapped.uniqueKey) throw new Error(`Product row missing uniqueKey for table ${tableId}`);
    dedupedRows.set(mapped.uniqueKey, {row, mapped});
  }
  const createItems = [];
  const updateItems = [];
  for (const {row, mapped} of dedupedRows.values()) {
    const item = {
      ...mapped,
      goodsSn: row.goodsSn,
      qty: row.qty ?? row.totalQty,
    };
    const recordId = existing.get(mapped.uniqueKey);
    if (recordId) updateItems.push({...item, recordId});
    else createItems.push(item);
  }
  const results = [];
  results.push(...await batchCreateRecords(baseToken, tableId, createItems));
  for (const item of updateItems) {
    const result = await updateRecordById(baseToken, tableId, item.recordId, item.record);
    results.push({uniqueKey: item.uniqueKey, goodsSn: item.goodsSn, qty: item.qty, ...result});
  }
  for (const item of duplicates.filter(d => dedupedRows.has(d.uniqueKey))) {
    await deleteRecordById(baseToken, tableId, item.recordId);
    results.push({uniqueKey: item.uniqueKey, action: 'deleted_duplicate', recordId: item.recordId});
  }
  return results;
}

async function deleteStaleRecords(baseToken, tableId, desiredUniqueKeys, inScope, label) {
  const existing = await listExistingRecordEntries(baseToken, tableId);
  const seen = new Set();
  const stale = [];
  for (const {uniqueKey, recordId} of existing) {
    if (!inScope(uniqueKey)) continue;
    if (desiredUniqueKeys.has(uniqueKey) && !seen.has(uniqueKey)) {
      seen.add(uniqueKey);
      continue;
    }
    stale.push({uniqueKey, recordId});
  }
  const deleted = [];
  for (const {uniqueKey, recordId} of stale) {
    await deleteRecordById(baseToken, tableId, recordId);
    deleted.push({uniqueKey, recordId});
  }
  return {label, deletedCount: deleted.length, deleted};
}

function dailyRecord(row, now) {
  const uniqueKey = `${row.date}__${row.storeKey}__${row.goodsSn}`;
  return {
    uniqueKey,
    record: {
      '唯一键': uniqueKey,
      '日期': `${row.date} 00:00:00`,
      '店铺代号': row.storeKey,
      '店铺名称': row.shopName,
      '分组': row.groupKey,
      '货号': row.goodsSn,
      '商品名称': row.goodsTitle,
      '销量': row.qty,
      '销售额SAR': round2(row.salesSar),
      '销售额RMB': round2(row.salesSar * FX_SAR_TO_RMB),
      '抓取时间': now,
      '备注': '按订单创建时间统计；仅统计正金额商品行，销量取商品 number。',
    },
  };
}

function weeklyRecord(row) {
  const uniqueKey = `${row.yearWeek}__${row.groupKey}__${row.goodsSn}`;
  return {
    uniqueKey,
    record: {
      '唯一键': uniqueKey,
      '年周': row.yearWeek,
      '周开始日期': `${row.weekStart} 00:00:00`,
      '周结束日期': `${row.weekEnd} 00:00:00`,
      '分组': row.groupKey,
      '货号': row.goodsSn,
      '商品名称': row.goodsTitle,
      '销量': row.qty,
      '销售额SAR': round2(row.salesSar),
      '销售额RMB': round2(row.salesSar * FX_SAR_TO_RMB),
      '备注': '周一到周日为一周；当前基于本地已抓取明细聚合。',
    },
  };
}

function monthlyRecord(row) {
  const uniqueKey = `${row.month}__${row.groupKey}__${row.goodsSn}`;
  return {
    uniqueKey,
    record: {
      '唯一键': uniqueKey,
      '月份': row.month,
      '分组': row.groupKey,
      '货号': row.goodsSn,
      '商品名称': row.goodsTitle,
      '销量': row.qty,
      '销售额SAR': round2(row.salesSar),
      '销售额RMB': round2(row.salesSar * FX_SAR_TO_RMB),
      '备注': '自然月聚合；当前基于本地已抓取明细聚合。',
    },
  };
}

function displayTableName(month) {
  return `产品日销量-${month}`;
}

async function listTables(baseToken) {
  const resp = await runLark([
    'base', '+table-list',
    '--as', 'user',
    '--base-token', baseToken,
    '--offset', '0',
    '--limit', '100',
  ]);
  return resp.parsed?.data?.tables || [];
}

async function ensureDisplayTable(state, baseToken, month) {
  const name = displayTableName(month);
  const known = state.tables?.[name]?.table_id;
  if (known) return {tableId: known, created: false};
  const existing = (await listTables(baseToken)).find(t => t.name === name);
  if (existing?.id) {
    state.tables = state.tables || {};
    state.tables[name] = {table_id: existing.id, raw: {discovered: true}};
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return {tableId: existing.id, created: false};
  }

  const fields = [
    {type: 'text', name: '唯一键'},
    {type: 'select', name: '分组', multiple: false, options: [
      {name: 'DSY', hue: 'Blue', lightness: 'Light'},
      {name: 'LGM', hue: 'Purple', lightness: 'Light'},
    ]},
    {type: 'text', name: '货号'},
    {type: 'text', name: '商品名称'},
    {type: 'number', name: '合计销量', style: {type: 'plain', precision: 0, percentage: false, thousands_separator: true}},
    {type: 'number', name: '合计销售额SAR', style: {type: 'plain', precision: 2, percentage: false, thousands_separator: true}},
    {type: 'number', name: '合计销售额RMB', style: {type: 'plain', precision: 2, percentage: false, thousands_separator: true}},
    ...Array.from({length: daysInMonth(month)}, (_, i) => ({
      type: 'number',
      name: `${Number(month.slice(5, 7))}.${i + 1}`,
      style: {type: 'plain', precision: 0, percentage: false, thousands_separator: true},
    })),
    {type: 'text', name: '备注'},
  ];

  const resp = await runLark([
    'base', '+table-create',
    '--as', 'user',
    '--base-token', baseToken,
    '--name', name,
    '--fields', JSON.stringify(fields),
  ]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Failed to create display table: ${JSON.stringify(resp.parsed).slice(0, 500)}`);
  state.tables = state.tables || {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  return {tableId, created: true};
}

function displayRecord(row, month) {
  const record = {
    '唯一键': row.uniqueKey,
    '分组': row.groupKey,
    '货号': row.goodsSn,
    '商品名称': row.goodsTitle,
    '合计销量': row.totalQty,
    '合计销售额SAR': round2(row.totalSar),
    '合计销售额RMB': round2(row.totalSar * FX_SAR_TO_RMB),
    '备注': '月度产品日销量宽表；销量按商品 number 汇总。',
  };
  for (let i = 0; i < daysInMonth(month); i++) {
    record[`${Number(month.slice(5, 7))}.${i + 1}`] = row.dailyQty[i] || 0;
  }
  return {uniqueKey: row.uniqueKey, record};
}

async function configureDisplayView(baseToken, tableId, month) {
  const viewsResp = await runLark([
    'base', '+view-list',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--offset', '0',
    '--limit', '100',
  ]);
  const view = viewsResp.parsed?.data?.views?.[0];
  if (!view?.id) return {configured: false, reason: 'no view found'};
  await runLark([
    'base', '+view-set-sort',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--view-id', view.id,
  ], `product-display-sort-${month}`, {
    sort_config: [{field: '合计销量', desc: true}],
  });
  const visibleFields = [
    '货号',
    '商品名称',
    '分组',
    '合计销量',
    '合计销售额SAR',
    ...Array.from({length: daysInMonth(month)}, (_, i) => `${Number(month.slice(5, 7))}.${i + 1}`),
    '备注',
  ];
  await runLark([
    'base', '+view-set-visible-fields',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--view-id', view.id,
  ], `product-display-visible-${month}`, {
    visible_fields: visibleFields,
  });
  return {configured: true, viewId: view.id, viewName: view.name};
}

async function writeReport(args, payload) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const groupSuffix = String(args.group || 'DSY').toUpperCase();
  const label = args.date || args.month;
  const file = path.join(REPORT_DIR, `product-sales-${groupSuffix}-${label}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  // Keep the historical generic DSY report name for backward compatibility only.
  if (groupSuffix === 'DSY') {
    await fs.writeFile(path.join(REPORT_DIR, `product-sales-${label}.json`), JSON.stringify(payload, null, 2), 'utf8');
  }
  if (args.date) {
    const monthPayload = {
      ...payload,
      mode: 'month-snapshot-from-date',
      date: null,
      snapshotSourceDate: args.date,
      dailyRowCount: payload.monthDailyRowCount,
      totalDailyQty: payload.totalMonthQty,
      totalDailySalesSar: payload.totalMonthSalesSar,
    };
    const monthFile = path.join(REPORT_DIR, `product-sales-${groupSuffix}-${args.month}.json`);
    await fs.writeFile(monthFile, JSON.stringify(monthPayload, null, 2), 'utf8');
    if (groupSuffix === 'DSY') {
      await fs.writeFile(path.join(REPORT_DIR, `product-sales-${args.month}.json`), JSON.stringify(monthPayload, null, 2), 'utf8');
    }
  }
  return file;
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
const baseToken = state.baseToken;
if (!baseToken) throw new Error('Missing baseToken in state/lark_base.json');

const tableIds = {
  daily: args.writeDaily ? state.tables?.['产品日销量事实']?.table_id : null,
  weekly: args.writeWeekly ? state.tables?.['产品周销量']?.table_id : null,
  monthly: args.writeMonthly ? state.tables?.['产品月销量']?.table_id : null,
};
for (const [name, tableId] of Object.entries(tableIds)) {
  const requested = (name === 'daily' && args.writeDaily)
    || (name === 'weekly' && args.writeWeekly)
    || (name === 'monthly' && args.writeMonthly);
  if (requested && !tableId) {
    throw new Error(`Missing product ${name} table id in state/lark_base.json`);
  }
}

const stores = selectedStores(storesConfig, args);
const dailyDates = args.date ? [args.date] : monthDates(args.month);
const monthAggDates = monthDates(args.month);
const weekAggDates = args.date
  ? [...eachDate(weekRangeForDate(args.date).start, weekRangeForDate(args.date).end)]
  : [...eachDate(weekRangeForDate(`${args.month}-01`).start, weekRangeForDate(`${args.month}-${pad2(daysInMonth(args.month))}`).end)];
const loadDates = [...new Set([...monthAggDates, ...weekAggDates])].sort();

const monthLoaded = await loadDailyProductRows(stores, loadDates);
const dailyRows = monthLoaded.rows.filter(r => dailyDates.includes(r.date));
const weeklyRows = aggregateWeekly(monthLoaded.rows, weekAggDates);
const monthlyRows = aggregateMonthly(monthLoaded.rows, args.month);
const displayRows = buildDailyDisplayRows(monthLoaded.rows, args.month);
const now = localDateTimeString();

const writeResults = {};
const staleDeletes = {};
if (args.replacePeriod) {
  const selectedStoreKeys = new Set(stores.map(s => s.storeKey));
  if (args.writeDaily) {
    const desired = new Set(dailyRows.map(row => dailyRecord(row, now).uniqueKey));
    staleDeletes.daily = await deleteStaleRecords(
      baseToken,
      tableIds.daily,
      desired,
      uniqueKey => {
        const [date, storeKey] = String(uniqueKey).split('__');
        return dailyDates.includes(date) && selectedStoreKeys.has(storeKey);
      },
      'daily',
    );
  }
  if (args.writeWeekly) {
    const desired = new Set(weeklyRows.map(row => weeklyRecord(row).uniqueKey));
    const weekKeys = new Set(weeklyRows.map(row => row.yearWeek));
    staleDeletes.weekly = await deleteStaleRecords(
      baseToken,
      tableIds.weekly,
      desired,
      uniqueKey => {
        const [yearWeek, groupKey] = String(uniqueKey).split('__');
        return weekKeys.has(yearWeek) && groupInSelectedScope(groupKey, args.group);
      },
      'weekly',
    );
  }
  if (args.writeMonthly) {
    const desired = new Set(monthlyRows.map(row => monthlyRecord(row).uniqueKey));
    staleDeletes.monthly = await deleteStaleRecords(
      baseToken,
      tableIds.monthly,
      desired,
      uniqueKey => {
        const [month, groupKey] = String(uniqueKey).split('__');
        return month === args.month && groupInSelectedScope(groupKey, args.group);
      },
      'monthly',
    );
  }
}

if (args.writeDaily) writeResults.daily = await upsertMany(baseToken, tableIds.daily, dailyRows, row => dailyRecord(row, now));
if (args.writeWeekly) writeResults.weekly = await upsertMany(baseToken, tableIds.weekly, weeklyRows, weeklyRecord);
if (args.writeMonthly) writeResults.monthly = await upsertMany(baseToken, tableIds.monthly, monthlyRows, monthlyRecord);

let display = null;
if (args.writeDisplay) {
  const ensured = await ensureDisplayTable(state, baseToken, args.month);
  if (args.replacePeriod) {
    const desired = new Set(displayRows.map(row => displayRecord(row, args.month).uniqueKey));
    staleDeletes.display = await deleteStaleRecords(
      baseToken,
      ensured.tableId,
      desired,
      uniqueKey => {
        const [month, groupKey] = String(uniqueKey).split('__');
        return month === args.month && groupInSelectedScope(groupKey, args.group);
      },
      'display',
    );
  }
  const displayWriteResults = await upsertMany(baseToken, ensured.tableId, displayRows, row => displayRecord(row, args.month));
  const viewConfig = await configureDisplayView(baseToken, ensured.tableId, args.month);
  display = {
    tableName: displayTableName(args.month),
    tableId: ensured.tableId,
    tableCreated: ensured.created,
    rowCount: displayRows.length,
    viewConfig,
    writeResults: displayWriteResults,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: args.date ? 'date' : 'month',
  date: args.date || null,
  month: args.month,
  group: args.group,
  stores: stores.map(s => s.storeKey),
  dailyRowCount: dailyRows.length,
  weeklyRowCount: weeklyRows.length,
  monthlyRowCount: monthlyRows.length,
  displayRowCount: displayRows.length,
  monthDailyRowCount: monthLoaded.rows.filter(r => r.date.startsWith(args.month)).length,
  totalDailyQty: dailyRows.reduce((s, r) => s + Number(r.qty || 0), 0),
  totalDailySalesSar: round2(dailyRows.reduce((s, r) => s + Number(r.salesSar || 0), 0)),
  totalMonthQty: monthlyRows.reduce((s, r) => s + Number(r.qty || 0), 0),
  totalMonthSalesSar: round2(monthlyRows.reduce((s, r) => s + Number(r.salesSar || 0), 0)),
  topProducts: displayRows.slice(0, 20).map(r => ({
    goodsSn: r.goodsSn,
    goodsTitle: r.goodsTitle,
    totalQty: r.totalQty,
    totalSar: round2(r.totalSar),
  })),
  skipped: monthLoaded.skipped,
  writeTargets: {
    dailyFact: args.writeDaily,
    legacyWeeklyNarrow: args.writeWeekly,
    legacyMonthlyNarrow: args.writeMonthly,
    dailyDisplay: args.writeDisplay,
  },
  staleDeletes,
  writeResults,
  display,
};
const reportFile = await writeReport(args, report);

console.log(JSON.stringify({
  ok: true,
  date: args.date || null,
  month: args.month,
  group: args.group,
  stores: stores.map(s => s.storeKey),
  dailyRowCount: dailyRows.length,
  weeklyRowCount: weeklyRows.length,
  monthlyRowCount: monthlyRows.length,
  displayRowCount: displayRows.length,
  totalDailyQty: report.totalDailyQty,
  totalDailySalesSar: report.totalDailySalesSar,
  writeTargets: report.writeTargets,
  topProducts: report.topProducts.slice(0, 10),
  staleDeletes: Object.fromEntries(Object.entries(staleDeletes).map(([k, v]) => [k, v.deletedCount])),
  displayTable: display ? {name: display.tableName, id: display.tableId, created: display.tableCreated, ok: display.viewConfig?.configured} : null,
  reportFile: path.relative(ROOT, reportFile),
}, null, 2));
