#!/usr/bin/env node
/**
 * Audit product-related Lark Base tables for duplicate unique keys and stale
 * SKU aliases that should already have been normalized to canonical goodsSn.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');

function parseArgs(argv) {
  const args = {
    month: null,
    includeDashboard: true,
    includeStore: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--no-dashboard') args.includeDashboard = false;
    else if (a === '--no-store') args.includeStore = false;
  }
  return args;
}

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

function beijingMonth() {
  return localDateTimeString().slice(0, 7);
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
    try {
      return await runLarkOnce(args);
    } catch (err) {
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
      if (Array.isArray(row)) {
        fields.forEach((name, idx) => { obj[name] = row[idx]; });
      } else {
        Object.assign(obj, row?.fields || row || {});
      }
      out.push(obj);
    }
    if (!data.has_more) break;
    offset += rows.length || limit;
  }
  return {fields, rows: out};
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

function auditTable(tableName, tableId, fields, rows) {
  const hasUniqueKey = fields.includes('唯一键') || rows.some(r => r['唯一键'] != null);
  const hasGoodsSn = fields.includes('货号') || rows.some(r => r['货号'] != null);
  const duplicateKeys = [];
  if (hasUniqueKey) {
    for (const [key, group] of groupBy(rows, r => scalar(r['唯一键']).trim())) {
      if (group.length > 1) {
        duplicateKeys.push({
          key,
          count: group.length,
          recordIds: group.map(r => r.recordId).filter(Boolean).slice(0, 10),
        });
      }
    }
  }

  const staleAliases = [];
  const needsReview = [];
  const goodsSnCounts = new Map();
  if (hasGoodsSn) {
    for (const row of rows) {
      const goodsSn = scalar(row['货号']).trim();
      if (!goodsSn) continue;
      goodsSnCounts.set(goodsSn, (goodsSnCounts.get(goodsSn) || 0) + 1);
      const detail = normalizeGoodsSnDetailed(goodsSn, {goodsTitle: scalar(row['商品名称'])});
      if (detail.canonical && detail.canonical !== goodsSn) {
        staleAliases.push({
          recordId: row.recordId,
          uniqueKey: scalar(row['唯一键']).trim(),
          goodsSn,
          normalized: detail.canonical,
          group: scalar(row['分组']),
          matchedAlias: detail.matchedAlias,
        });
      } else if (detail.needsReview) {
        needsReview.push({
          recordId: row.recordId,
          uniqueKey: scalar(row['唯一键']).trim(),
          goodsSn,
          group: scalar(row['分组']),
          reason: detail.reviewReason,
        });
      }
    }
  }

  return {
    tableName,
    tableId,
    rowCount: rows.length,
    hasUniqueKey,
    hasGoodsSn,
    duplicateKeyCount: duplicateKeys.length,
    duplicateRecordCount: duplicateKeys.reduce((sum, x) => sum + x.count - 1, 0),
    staleAliasCount: staleAliases.length,
    needsReviewCount: needsReview.length,
    distinctGoodsSnCount: goodsSnCounts.size,
    duplicateKeys: duplicateKeys.slice(0, 50),
    staleAliases: staleAliases.slice(0, 100),
    needsReview: needsReview.slice(0, 100),
  };
}

function selectTables(state, args) {
  const entries = Object.entries(state.tables || {});
  return entries
    .filter(([name]) => {
      if (/^产品日销量-\d{4}-\d{2}$/.test(name)) return true;
      if (/^产品日销量-\d{4}汇总$/.test(name)) return true;
      if (['产品日销量事实', '产品月销量-宽表', '产品周销量-宽表'].includes(name)) return true;
      if (args.includeDashboard && /^看板数据-(MAIN|PREV)-产品排行$/.test(name)) return true;
      if (args.includeStore && (name === '店铺日报事实' || /^月度日销-\d{4}-\d{2}$/.test(name) || /^月度日销-\d{4}汇总$/.test(name))) return true;
      return false;
    })
    .map(([name, meta]) => ({name, tableId: meta.table_id}));
}

const args = parseArgs(process.argv.slice(2));
args.month ||= beijingMonth();
const state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
const baseToken = state.baseToken || state.baseCreateResponse?.data?.base?.base_token;
if (!baseToken) throw new Error('Cannot resolve base token');

const reports = [];
for (const table of selectTables(state, args)) {
  const {fields, rows} = await listRecords(baseToken, table.tableId);
  reports.push(auditTable(table.name, table.tableId, fields, rows));
}

const blockingTables = reports.filter(r => r.duplicateKeyCount || r.staleAliasCount || r.needsReviewCount);
const summary = {
  ok: blockingTables.length === 0,
  checkedAt: localDateTimeString(),
  month: args.month,
  tableCount: reports.length,
  issueTableCount: blockingTables.length,
  duplicateKeyTableCount: reports.filter(r => r.duplicateKeyCount).length,
  staleAliasTableCount: reports.filter(r => r.staleAliasCount).length,
  needsReviewTableCount: reports.filter(r => r.needsReviewCount).length,
  duplicateRecordCount: reports.reduce((sum, r) => sum + r.duplicateRecordCount, 0),
  staleAliasCount: reports.reduce((sum, r) => sum + r.staleAliasCount, 0),
  needsReviewCount: reports.reduce((sum, r) => sum + r.needsReviewCount, 0),
};

const report = {summary, tables: reports};
await fs.mkdir(REPORT_DIR, {recursive: true});
const reportFile = path.join(REPORT_DIR, `product-table-integrity-audit-${args.month}.json`);
await fs.writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify({
  ...summary,
  issueTables: blockingTables.map(r => ({
    tableName: r.tableName,
    rowCount: r.rowCount,
    duplicateKeyCount: r.duplicateKeyCount,
    duplicateRecordCount: r.duplicateRecordCount,
    staleAliasCount: r.staleAliasCount,
    needsReviewCount: r.needsReviewCount,
    staleAliases: r.staleAliases.slice(0, 10),
    needsReview: r.needsReview.slice(0, 10),
  })),
  reportFile: path.relative(ROOT, reportFile),
}, null, 2));

process.exit(summary.ok ? 0 : 2);
