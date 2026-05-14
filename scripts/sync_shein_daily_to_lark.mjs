#!/usr/bin/env node
/**
 * Sync SHEIN daily store sales JSON files into Lark Base fact/log tables.
 *
 * Usage:
 *   node scripts/sync_shein_daily_to_lark.mjs --file outputs/shein_fetch/DL/2026-03-31.json --status 历史回补
 *   node scripts/sync_shein_daily_to_lark.mjs --file outputs/shein_fetch/DL/2026-03-01_to_2026-03-31_daily-summary.json --status 历史回补
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {isValidSalesGoodsRow, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');
const FX_SAR_TO_RMB = 1.8;

function parseArgs(argv) {
  const args = {status: '历史回补', source: 'SHEIN抓取', writeLog: true};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--no-log') args.writeLog = false;
    else if (a === '--json') args.json = true;
  }
  if (!args.file) throw new Error('Missing --file');
  args.file = path.resolve(args.file);
  return args;
}

function localDateTimeString(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
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
      const retryable = rateLimited || /EOF|ECONNRESET|ETIMEDOUT|timeout|temporarily|503|502|504|\[5000\]|code"?\s*:\s*5000|tls|x509|certificate|failed to verify certificate|not open\.feishu\.cn/i.test(msg);
      if (!retryable || attempt === attempts) break;
      const delayMs = rateLimited ? attempt * 10000 : attempt * 1500;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function getTableId(state, name) {
  const table = state.tables?.[name];
  if (!table?.table_id) throw new Error(`Missing table in state/lark_base.json: ${name}`);
  return table.table_id;
}

function uniqueOrderCountFromGoods(goodsRows) {
  return new Set((goodsRows || []).filter(isValidSalesGoodsRow).map(g => g.orderNo || g.orderId).filter(Boolean)).size;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

async function loadDailyEntries(file) {
  const obj = JSON.parse(await fs.readFile(file, 'utf8'));
  const baseDir = path.dirname(file);
  if (obj.summary && obj.storeKey && obj.start === obj.end) {
    return [{file, obj}];
  }
  if (Array.isArray(obj.days)) {
    const entries = [];
    for (const day of obj.days) {
      let dailyFile = day.file;
      if (!dailyFile) dailyFile = path.join(baseDir, `${day.date}.json`);
      if (!path.isAbsolute(dailyFile)) dailyFile = path.resolve(ROOT, dailyFile);
      let dailyObj = null;
      try {
        dailyObj = JSON.parse(await fs.readFile(dailyFile, 'utf8'));
      } catch {}
      // Older single-day summary files once overwrote the detailed file. If the
      // referenced file is still a summary, fall back to the day-level metrics.
      if (!dailyObj?.summary) {
        dailyObj = {
          storeKey: obj.storeKey,
          shopName: obj.shopName,
          groupKey: obj.groupKey,
          start: day.date,
          end: day.date,
          summary: {
            detailedOrderCount: day.orders || 0,
            positiveAmountOrderCount: day.orders || 0,
            goodsLineCount: day.goods || 0,
            quantityPositiveAmount: day.qty || 0,
            salesSar: day.salesSar || 0,
            salesRmb: round2((day.salesSar || 0) * FX_SAR_TO_RMB),
          },
          goodsRows: [],
        };
      }
      entries.push({file: dailyFile, obj: dailyObj});
    }
    return entries;
  }
  throw new Error(`Unsupported SHEIN fetch JSON shape: ${file}`);
}

async function listFactKeyEntries(baseToken, tableId) {
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

function buildRecordIndex(entries) {
  const map = new Map();
  for (const {key, recordId} of entries) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(recordId);
  }
  return map;
}

async function deleteRecordById(baseToken, tableId, recordId) {
  await runLark([
    'base', '+record-delete',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--yes',
  ]);
}

async function upsertFact(baseToken, tableId, record, recordIndex) {
  const uniqueKey = record['唯一键'];
  const existingIds = recordIndex.get(uniqueKey) || [];
  const recordId = existingIds[0] || null;
  const args = [
    'base', '+record-upsert',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
  ];
  if (recordId) args.push('--record-id', recordId);
  const resp = await runLark(args, `fact-${uniqueKey}`, record);
  const keptRecordId = recordId || resp.parsed?.data?.record?.record_id || resp.parsed?.record?.record_id;
  let duplicateDeleted = 0;
  for (const duplicateId of existingIds.slice(1)) {
    await deleteRecordById(baseToken, tableId, duplicateId);
    duplicateDeleted++;
  }
  if (keptRecordId) recordIndex.set(uniqueKey, [keptRecordId]);
  return {recordId: keptRecordId, action: recordId ? 'updated' : 'created', duplicateDeleted, response: resp.parsed};
}

async function createLog(baseToken, tableId, record) {
  const resp = await runLark([
    'base', '+record-upsert',
    '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
  ], `log-${record['唯一键']}`, record);
  return {recordId: resp.parsed?.data?.record?.record_id || resp.parsed?.record?.record_id, response: resp.parsed};
}

function buildRecords(dailyObj, args) {
  const date = dailyObj.start;
  const uniqueKey = `${date}__${dailyObj.storeKey}`;
  const goodsSales = Array.isArray(dailyObj.goodsRows) ? summarizeSalesGoodsRows(dailyObj.goodsRows) : null;
  const salesSar = round2(goodsSales?.salesSar ?? dailyObj.summary?.salesSar ?? 0);
  const salesRmb = round2(salesSar * FX_SAR_TO_RMB);
  const positiveOrders = goodsSales?.positiveAmountOrderCount ?? dailyObj.summary?.positiveAmountOrderCount ?? uniqueOrderCountFromGoods(dailyObj.goodsRows);
  const now = localDateTimeString();
  const evidence = `orders=${dailyObj.summary?.detailedOrderCount ?? 0}; goods=${dailyObj.summary?.goodsLineCount ?? 0}; source=${path.relative(ROOT, args.file)}`;
  const logTaskTypeMap = {
    '当天同步': '当天滚动',
    '前日最终版': '前日最终',
    '历史回补': '历史回补',
    '人工修正': '历史回补',
  };
  const logTaskType = logTaskTypeMap[args.status] || args.status;
  const fact = {
    '唯一键': uniqueKey,
    '日期': `${date} 00:00:00`,
    '店铺代号': dailyObj.storeKey,
    '店铺名称': dailyObj.shopName,
    '分组': dailyObj.groupKey,
    '有效订单数': positiveOrders,
    '销售额SAR': salesSar,
    '销售额RMB': salesRmb,
    '数据状态': args.status,
    '抓取时间': now,
    '数据来源': args.source,
    '备注': '接口口径：/orderPlus/listOrder + /orderPlus/listOrderItem，按订单创建时间汇总 goods.currencyPrice。',
  };
  const log = {
    '唯一键': `${uniqueKey}__${args.status}__${now.replace(/[-: ]/g, '')}`,
    '抓取时间': now,
    '目标日期': `${date} 00:00:00`,
    '店铺代号': dailyObj.storeKey,
    '店铺名称': dailyObj.shopName,
    '分组': dailyObj.groupKey,
    '任务类型': logTaskType,
    '状态': '成功',
    '有效订单数': positiveOrders,
    '销售额SAR': salesSar,
    '销售额RMB': salesRmb,
    '错误摘要': '',
    '证据摘要': evidence,
    '备注': '自动写入店铺日报事实表。',
  };
  return {fact, log};
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
const baseToken = state.baseToken;
const factTableId = getTableId(state, '店铺日报事实');
const logTableId = getTableId(state, '抓取日志');
const entries = await loadDailyEntries(args.file);
const factRecordIndex = buildRecordIndex(await listFactKeyEntries(baseToken, factTableId));

const results = [];
for (const entry of entries) {
  const {fact, log} = buildRecords(entry.obj, args);
  const factResult = await upsertFact(baseToken, factTableId, fact, factRecordIndex);
  let logResult = null;
  if (args.writeLog) logResult = await createLog(baseToken, logTableId, log);
  results.push({
    date: entry.obj.start,
    storeKey: entry.obj.storeKey,
    salesSar: fact['销售额SAR'],
    factAction: factResult.action,
    factDuplicateDeleted: factResult.duplicateDeleted,
    factRecordId: factResult.recordId,
    logRecordId: logResult?.recordId || null,
  });
}

const summary = {
  baseToken,
  factTableId,
  logTableId,
  input: path.relative(ROOT, args.file),
  count: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
