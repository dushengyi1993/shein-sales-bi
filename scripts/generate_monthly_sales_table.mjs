#!/usr/bin/env node
/**
 * Build/rebuild one monthly store daily-sales display table in Lark Base.
 *
 * Data source: 店铺日报事实
 *
 * Usage:
 *   node scripts/generate_monthly_sales_table.mjs --month 2026-03
 *   node scripts/generate_monthly_sales_table.mjs --month 2026-04 --dsy-only
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');

const FX_SAR_TO_RMB = 1.8;
const PROFIT_RATE = 0.25;

function parseArgs(argv) {
  const args = {
    dsyOnly: true,
    reserveLgm: true,
    writeReport: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--dsy-only') args.dsyOnly = true;
    else if (a === '--include-lgm') args.dsyOnly = false;
    else if (a === '--no-reserve-lgm') args.reserveLgm = false;
    else if (a === '--no-report') args.writeReport = false;
  }
  if (!/^\d{4}-\d{2}$/.test(args.month || '')) {
    throw new Error('Missing or invalid --month, expected YYYY-MM');
  }
  return args;
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
      const retryable = rateLimited || /EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily|HTTP 500|5000|503|502|504|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn/i.test(msg);
      if (!retryable || attempt === attempts) break;
      const delayMs = rateLimited ? attempt * 10000 : attempt * 1500;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function daysInMonth(month) {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m, 0).getDate();
}

function dayLabels(month) {
  const m = Number(month.slice(5, 7));
  return Array.from({length: daysInMonth(month)}, (_, i) => `${m}.${i + 1}`);
}

function beijingTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {month: `${parts.year}-${parts.month}`, day: Number(parts.day)};
}

function elapsedDaysForMonth(month) {
  const total = daysInMonth(month);
  const today = beijingTodayParts();
  if (month < today.month) return total;
  if (month > today.month) return 0;
  return Math.min(today.day, total);
}

function tableNameForMonth(month) {
  return `月度日销-${month}`;
}

function getStateTableId(state, tableName) {
  return state.tables?.[tableName]?.table_id || null;
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

async function ensureMonthlyTable(state, baseToken, month) {
  const name = tableNameForMonth(month);
  const known = getStateTableId(state, name);
  if (known) return {tableId: known, created: false};

  const existing = (await listTables(baseToken)).find(t => t.name === name);
  if (existing?.id) {
    state.tables = state.tables || {};
    state.tables[name] = {table_id: existing.id, raw: {discovered: true}};
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return {tableId: existing.id, created: false};
  }

  const fields = [
    {type: 'text', name: '主体/店铺'},
    {
      type: 'select',
      name: '分组',
      multiple: false,
      options: [
        {name: 'DSY', hue: 'Blue', lightness: 'Light'},
        {name: 'LGM', hue: 'Purple', lightness: 'Light'},
        {name: '总计', hue: 'Yellow', lightness: 'Light'},
        {name: '预测', hue: 'Green', lightness: 'Light'},
      ],
    },
    {
      type: 'select',
      name: '行类型',
      multiple: false,
      options: [
        {name: '店铺', hue: 'Blue', lightness: 'Light'},
        {name: '小计', hue: 'Purple', lightness: 'Light'},
        {name: '总计', hue: 'Yellow', lightness: 'Light'},
        {name: '预测', hue: 'Green', lightness: 'Light'},
      ],
    },
    {
      type: 'select',
      name: '币种',
      multiple: false,
      options: [
        {name: 'SAR', hue: 'Blue', lightness: 'Light'},
        {name: 'RMB', hue: 'Green', lightness: 'Light'},
      ],
    },
    {type: 'number', name: '排序', style: {type: 'plain', precision: 0, percentage: false, thousands_separator: false}},
    {type: 'number', name: '合计', style: {type: 'plain', precision: 2, percentage: false, thousands_separator: true}},
    {type: 'number', name: '日均', style: {type: 'plain', precision: 2, percentage: false, thousands_separator: true}},
    ...dayLabels(month).map(name => ({
      type: 'number',
      name,
      style: {type: 'plain', precision: 2, percentage: false, thousands_separator: true},
    })),
    {type: 'text', name: '备注'},
    {type: 'text', name: '唯一键'},
  ];

  const resp = await runLark([
    'base', '+table-create',
    '--as', 'user',
    '--base-token', baseToken,
    '--name', name,
    '--fields', JSON.stringify(fields),
  ]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Cannot find created table id for ${name}`);
  state.tables = state.tables || {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  return {tableId, created: true};
}

async function listFactRecords(baseToken, factTableId) {
  const fields = ['唯一键', '日期', '店铺代号', '店铺名称', '分组', '销售额SAR', '销售额RMB'];
  const all = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const args = [
      'base', '+record-list',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', factTableId,
      '--offset', String(offset),
      '--limit', String(limit),
      '--format', 'json',
    ];
    for (const f of fields) args.push('--field-id', f);
    const resp = await runLark(args);
    const data = resp.parsed?.data?.data || [];
    for (const row of data) {
      const obj = Object.fromEntries(fields.map((f, i) => [f, row[i]]));
      all.push(obj);
    }
    if (!resp.parsed?.data?.has_more) break;
    offset += data.length;
    if (!data.length) break;
  }
  return all;
}

function statusPriority(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  if (text.includes('人工修正')) return 4;
  if (text.includes('前日最终版')) return 3;
  if (text.includes('历史回补')) return 2;
  if (text.includes('当天同步')) return 1;
  return 0;
}

function timeScore(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(text.replace(' ', 'T') + '+08:00');
  return Number.isFinite(parsed) ? parsed : 0;
}

function factRecordIsBetter(candidate, current) {
  if (!current) return true;
  const p1 = statusPriority(candidate['数据状态']);
  const p2 = statusPriority(current['数据状态']);
  if (p1 !== p2) return p1 > p2;
  const t1 = timeScore(candidate['抓取时间']);
  const t2 = timeScore(current['抓取时间']);
  if (t1 !== t2) return t1 > t2;
  return Number(candidate['销售额SAR'] || 0) >= Number(current['销售额SAR'] || 0);
}

function dedupeFactRecords(records) {
  const byKey = new Map();
  for (const rec of records) {
    const key = String(rec['唯一键'] || '').trim();
    if (!key) continue;
    const current = byKey.get(key);
    if (factRecordIsBetter(rec, current)) byKey.set(key, rec);
  }
  return [...byKey.values()];
}

function normalizeDateString(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  return String(v).slice(0, 10);
}

function buildRows({month, storesConfig, factRecords, dsyOnly, reserveLgm}) {
  const days = daysInMonth(month);
  const labels = dayLabels(month);
  const elapsed = elapsedDaysForMonth(month) || days;
  const byStore = new Map();

  for (const rec of factRecords) {
    const date = normalizeDateString(rec['日期']);
    if (!date.startsWith(`${month}-`)) continue;
    const storeKey = rec['店铺代号'];
    const day = Number(date.slice(8, 10));
    if (!storeKey || !day) continue;
    if (!byStore.has(storeKey)) byStore.set(storeKey, Array.from({length: days}, () => null));
    byStore.get(storeKey)[day - 1] = round2(rec['销售额SAR']);
  }

  const groups = storesConfig.groups;
  const storeMeta = new Map(storesConfig.stores.map(s => [s.storeKey, s]));
  const includeStores = [];
  for (const key of groups.DSY) includeStores.push(key);
  if (!dsyOnly || reserveLgm) {
    for (const key of groups.LGM) includeStores.push(key);
  }

  const rows = [];
  const rowMap = new Map();
  let order = 1;

  function calcTotal(daily) {
    return round2((daily || []).reduce((a, b) => a + Number(b || 0), 0));
  }

  function addRow({label, group, type, currency, dailySar = null, total = null, avg = null, note = ''}) {
    const dailyValues = dailySar
      ? (currency === 'RMB' ? dailySar.map(v => round2(v * FX_SAR_TO_RMB)) : dailySar.map(v => round2(v)))
      : Array.from({length: days}, () => null);
    const finalTotal = total == null ? (dailySar ? calcTotal(dailyValues) : null) : round2(total);
    const finalAvg = avg == null ? (finalTotal == null ? null : round2(finalTotal / Math.max(elapsed, 1))) : round2(avg);
    const row = {
      uniqueKey: `${month}__${String(order).padStart(2, '0')}__${label}`,
      values: {
        '主体/店铺': label,
        '分组': group,
        '行类型': type,
        '币种': currency,
        '排序': order,
        '合计': finalTotal,
        '日均': finalAvg,
        ...Object.fromEntries(labels.map((dayLabel, i) => [dayLabel, dailyValues[i]])),
        '备注': note,
        '唯一键': `${month}__${String(order).padStart(2, '0')}__${label}`,
      },
      dailyValues,
      dailySar,
    };
    rows.push(row);
    rowMap.set(label, row);
    order += 1;
    return row;
  }

  function sumDaily(storeKeys) {
    const out = Array.from({length: days}, () => 0);
    for (const key of storeKeys) {
      const daily = byStore.get(key) || Array.from({length: days}, () => null);
      for (let i = 0; i < days; i++) out[i] += Number(daily[i] || 0);
    }
    return out.map(round2);
  }

  for (const key of groups.DSY) {
    const meta = storeMeta.get(key);
    const daily = byStore.get(key) || Array.from({length: days}, () => 0);
    addRow({label: key, group: 'DSY', type: '店铺', currency: 'SAR', dailySar: daily, note: meta?.shopName || ''});
  }
  const dsyDaily = sumDaily(groups.DSY);
  addRow({label: 'DSY小计 SAR', group: 'DSY', type: '小计', currency: 'SAR', dailySar: dsyDaily});
  addRow({label: 'DSY小计 RMB', group: 'DSY', type: '小计', currency: 'RMB', dailySar: dsyDaily});

  if (!dsyOnly || reserveLgm) {
    for (const key of groups.LGM) {
      const meta = storeMeta.get(key);
      const daily = !dsyOnly ? (byStore.get(key) || Array.from({length: days}, () => null)) : null;
      addRow({
        label: key,
        group: 'LGM',
        type: '店铺',
        currency: 'SAR',
        dailySar: daily,
        total: dsyOnly ? null : undefined,
        avg: dsyOnly ? null : undefined,
        note: dsyOnly ? `待接入；${meta?.shopName || ''}` : (meta?.shopName || ''),
      });
    }
    const lgmDaily = !dsyOnly ? sumDaily(groups.LGM) : null;
    addRow({label: 'LGM小计 SAR', group: 'LGM', type: '小计', currency: 'SAR', dailySar: lgmDaily, note: dsyOnly ? 'LGM待接入' : ''});
    addRow({label: 'LGM小计 RMB', group: 'LGM', type: '小计', currency: 'RMB', dailySar: lgmDaily, note: dsyOnly ? 'LGM待接入' : ''});
  }

  const totalDailySar = dsyOnly ? dsyDaily : sumDaily([...groups.DSY, ...groups.LGM]);
  const totalSar = calcTotal(totalDailySar);
  const totalRmb = round2(totalSar * FX_SAR_TO_RMB);
  const avgSar = round2(totalSar / Math.max(elapsed, 1));
  const predictedSar = round2(avgSar * days);
  const predictedRmb = round2(predictedSar * FX_SAR_TO_RMB);
  const predictedProfitRmb = round2(predictedRmb * PROFIT_RATE);
  const totalNote = dsyOnly ? '当前仅含DSY组；LGM后续接入后重建' : '';

  addRow({label: '总计 SAR', group: '总计', type: '总计', currency: 'SAR', dailySar: totalDailySar, note: totalNote});
  addRow({label: '总计 RMB', group: '总计', type: '总计', currency: 'RMB', dailySar: totalDailySar, note: totalNote});
  addRow({label: '预测全月 SAR', group: '预测', type: '预测', currency: 'SAR', total: predictedSar, avg: avgSar, note: `日均按${elapsed}天计算，预测=日均×${days}天`});
  addRow({label: '预测全月 RMB', group: '预测', type: '预测', currency: 'RMB', total: predictedRmb, avg: round2(predictedRmb / Math.max(days, 1)), note: '按 1 SAR = 1.8 RMB'});
  addRow({label: '预测利润 RMB', group: '预测', type: '预测', currency: 'RMB', total: predictedProfitRmb, avg: round2(predictedProfitRmb / Math.max(days, 1)), note: '按 25% 利润率'});

  return {rows, labels, elapsed, days, totals: {totalSar, totalRmb, avgSar, predictedSar, predictedRmb, predictedProfitRmb}};
}

async function listMonthlyKeyEntries(baseToken, tableId) {
  const entries = [];
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

function groupRecordIdsByKey(entries) {
  const map = new Map();
  for (const {key, recordId} of entries) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(recordId);
  }
  return map;
}

async function deleteMonthlyRecord(baseToken, tableId, recordId) {
  await runLark([
    'base', '+record-delete',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--yes',
  ]);
}

async function upsertMonthlyRows(baseToken, tableId, rows) {
  const existing = groupRecordIdsByKey(await listMonthlyKeyEntries(baseToken, tableId));
  const desiredKeys = new Set(rows.map(row => row.uniqueKey));
  const results = [];
  let duplicateDeleted = 0;
  for (const row of rows) {
    const recordIds = existing.get(row.uniqueKey) || [];
    const recordId = recordIds[0] || null;
    const args = [
      'base', '+record-upsert',
      '--as', 'user',
      '--base-token', baseToken,
      '--table-id', tableId,
    ];
    if (recordId) args.push('--record-id', recordId);
    const resp = await runLark(args, `monthly-row-${row.uniqueKey}`, row.values);
    results.push({
      label: row.values['主体/店铺'],
      action: recordId ? 'updated' : 'created',
      recordId: recordId || resp.parsed?.data?.record?.record_id || resp.parsed?.record?.record_id || null,
    });
    for (const duplicateId of recordIds.slice(1)) {
      await deleteMonthlyRecord(baseToken, tableId, duplicateId);
      duplicateDeleted++;
    }
    existing.set(row.uniqueKey, [recordId || resp.parsed?.data?.record?.record_id || resp.parsed?.record?.record_id || null].filter(Boolean));
  }
  let staleDeleted = 0;
  for (const [key, recordIds] of existing.entries()) {
    if (desiredKeys.has(key)) continue;
    for (const recordId of recordIds) {
      await deleteMonthlyRecord(baseToken, tableId, recordId);
      staleDeleted++;
    }
  }
  return {rows: results, duplicateDeleted, staleDeleted};
}

async function configureMonthlyView(baseToken, tableId, month) {
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
  ], `monthly-sort-${month}`, {
    sort_config: [{field: '排序', desc: false}],
  });

  const visibleFields = ['主体/店铺', '分组', '行类型', '币种', '合计', '日均', ...dayLabels(month), '备注'];
  await runLark([
    'base', '+view-set-visible-fields',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--view-id', view.id,
  ], `monthly-visible-fields-${month}`, {
    visible_fields: visibleFields,
  });

  return {configured: true, viewId: view.id, viewName: view.name};
}

async function writeReport(month, built, tableName, tableId) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const report = {
    generatedAt: new Date().toISOString(),
    tableName,
    tableId,
    month,
    elapsedDaysForAverage: built.elapsed,
    daysInMonth: built.days,
    totals: built.totals,
    rows: built.rows.map(r => ({
      uniqueKey: r.uniqueKey,
      label: r.values['主体/店铺'],
      group: r.values['分组'],
      type: r.values['行类型'],
      currency: r.values['币种'],
      total: r.values['合计'],
      average: r.values['日均'],
      note: r.values['备注'],
    })),
  };
  const file = path.join(REPORT_DIR, `monthly-sales-${month}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
const baseToken = state.baseToken;
const factTableId = state.tables?.['店铺日报事实']?.table_id;
if (!baseToken || !factTableId) throw new Error('Missing baseToken or 店铺日报事实 table_id in state/lark_base.json');

const tableName = tableNameForMonth(args.month);
const ensured = await ensureMonthlyTable(state, baseToken, args.month);
const facts = dedupeFactRecords(await listFactRecords(baseToken, factTableId));
const built = buildRows({month: args.month, storesConfig, factRecords: facts, dsyOnly: args.dsyOnly, reserveLgm: args.reserveLgm});
const writeResults = await upsertMonthlyRows(baseToken, ensured.tableId, built.rows);
const viewConfig = await configureMonthlyView(baseToken, ensured.tableId, args.month);
const reportFile = args.writeReport ? await writeReport(args.month, built, tableName, ensured.tableId) : null;

console.log(JSON.stringify({
  ok: true,
  baseToken,
  tableName,
  tableId: ensured.tableId,
  tableCreated: ensured.created,
  month: args.month,
  rowCount: built.rows.length,
  dsyOnly: args.dsyOnly,
  reserveLgm: args.reserveLgm,
  totals: built.totals,
  viewConfig,
  writeResults,
  reportFile: reportFile ? path.relative(ROOT, reportFile) : null,
}, null, 2));
