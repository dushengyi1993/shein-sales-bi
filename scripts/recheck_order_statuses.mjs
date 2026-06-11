#!/usr/bin/env node
/**
 * Recheck non-terminal SHEIN order statuses without rewriting historical sales facts.
 *
 * The sales warehouse keeps the original order/item sales facts.  This job builds a
 * mutable lifecycle evidence layer in ops.order_status_recheck_state by re-fetching
 * current SHEIN order status for date-store slices that still have non-terminal
 * orders.  The V2 orders section can then prefer this lifecycle layer for status
 * display while sales/profit facts remain stable.
 *
 * Examples:
 *   node scripts/recheck_order_statuses.mjs --dry-run --max-pairs 20
 *   node scripts/recheck_order_statuses.mjs --stores DL,FY --date 2026-05-30
 *   node scripts/recheck_order_statuses.mjs --max-pairs 500 --ignore-cooldown
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'order_status_recheck');
const DEFAULT_STATE_FILE = path.join(ROOT, 'state', 'order_status_recheck_last.json');
const DEFAULT_CONTAINER = 'shein-warehouse-db';
const DEFAULT_DATABASE = 'shein_bi';
const DEFAULT_USER = 'shein';

const RECHECK_TABLE_SQL = `
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS ops.order_status_recheck_state (
  order_item_key text PRIMARY KEY,
  order_key text,
  store_key text NOT NULL REFERENCES dim.store(store_key),
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date NOT NULL,
  order_create_time timestamp,
  standard_goods_sn text,
  raw_goods_sn text,
  goods_id text,
  entity_id text,
  skc text,
  sku_code text,
  goods_title text,
  latest_goods_status text,
  latest_goods_performance_status text,
  latest_goods_performance_status_desc text,
  latest_page_status text,
  latest_page_status_desc text,
  latest_order_status text,
  latest_order_status_desc text,
  latest_perform_status text,
  latest_perform_status_desc text,
  lifecycle_status_group text NOT NULL,
  is_terminal boolean DEFAULT false,
  first_seen_at timestamptz DEFAULT now(),
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  check_count integer NOT NULL DEFAULT 1,
  consecutive_same_count integer NOT NULL DEFAULT 1,
  terminal_at timestamptz,
  source_file text,
  transport text,
  fetch_time timestamptz,
  raw_summary jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_status_recheck_date_store
  ON ops.order_status_recheck_state(created_date, store_key);
CREATE INDEX IF NOT EXISTS idx_order_status_recheck_order
  ON ops.order_status_recheck_state(store_key, order_no);
CREATE INDEX IF NOT EXISTS idx_order_status_recheck_group
  ON ops.order_status_recheck_state(lifecycle_status_group, is_terminal, last_checked_at);
`;

const COLUMNS = [
  'order_item_key', 'order_key', 'store_key', 'group_key', 'order_id', 'order_no', 'bill_no',
  'created_date', 'order_create_time', 'standard_goods_sn', 'raw_goods_sn', 'goods_id', 'entity_id',
  'skc', 'sku_code', 'goods_title', 'latest_goods_status', 'latest_goods_performance_status',
  'latest_goods_performance_status_desc', 'latest_page_status', 'latest_page_status_desc',
  'latest_order_status', 'latest_order_status_desc', 'latest_perform_status', 'latest_perform_status_desc',
  'lifecycle_status_group', 'is_terminal', 'last_checked_at', 'terminal_at', 'source_file', 'transport',
  'fetch_time', 'raw_summary',
];

function parseArgs(argv) {
  const args = {
    container: DEFAULT_CONTAINER,
    database: DEFAULT_DATABASE,
    user: DEFAULT_USER,
    distro: 'Ubuntu-24.04',
    outDir: DEFAULT_OUT_DIR,
    stateFile: DEFAULT_STATE_FILE,
    maxPairs: 80,
    minAgeDays: 2,
    cooldownHours: 20,
    ignoreCooldown: false,
    transport: process.env.SHEIN_SALES_TRANSPORT || 'webapi',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--distro') args.distro = argv[++i];
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--state-file') args.stateFile = path.resolve(argv[++i]);
    else if (a === '--max-pairs') args.maxPairs = Math.max(1, Number(argv[++i] || 1));
    else if (a === '--min-age-days') args.minAgeDays = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--cooldown-hours') args.cooldownHours = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--ignore-cooldown') args.ignoreCooldown = true;
    else if (a === '--transport') args.transport = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (args.transport && !['webapi', 'auto', 'browser'].includes(args.transport)) {
    throw new Error('--transport must be one of: webapi, auto, browser');
  }
  if (args.date) {
    args.start = args.date;
    args.end = args.date;
  }
  if (args.start && !args.end) args.end = args.start;
  return args;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sqlLiteral(v) {
  return `'${String(v ?? '').replace(/'/g, "''")}'`;
}

function dockerPrefix() {
  return process.getuid?.() === 0 ? '' : 'sudo ';
}

function psqlCommand(args) {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1 -q -A -t`;
  if (process.platform === 'win32') {
    return {command: 'wsl', args: ['-d', args.distro, '--', 'bash', '-lc', psql]};
  }
  return {command: 'bash', args: ['-lc', psql]};
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const {input = '', timeoutMs = 0, env = process.env, ...spawnOptions} = options;
    const child = spawn(command, args, {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env, ...spawnOptions});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      stderr += `\nCommand timed out after ${timeoutMs}ms`;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      resolve({ok: false, code: -1, stdout, stderr: String(err?.stack || err), timedOut});
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, code: timedOut ? -2 : code, stdout, stderr, timedOut});
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runPsql(args, sql) {
  const cmd = psqlCommand(args);
  const res = await run(cmd.command, cmd.args, {input: sql, timeoutMs: 300_000});
  if (!res.ok) {
    throw new Error(`psql failed code=${res.code}: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

async function ensureSchema(args) {
  if (args.dryRun) return {dryRun: true};
  await runPsql(args, RECHECK_TABLE_SQL);
  return {ok: true};
}

function isoDateOk(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function* eachDate(start, end) {
  if (!isoDateOk(start) || !isoDateOk(end)) throw new Error('Date must be YYYY-MM-DD');
  const d = new Date(`${start}T00:00:00+08:00`);
  const stop = new Date(`${end}T00:00:00+08:00`);
  while (d <= stop) {
    yield `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    d.setDate(d.getDate() + 1);
  }
}

async function manualPairs(args) {
  if (!args.start) return null;
  if (!args.stores?.length) throw new Error('--date/--start requires --stores');
  const pairs = [];
  for (const storeKey of args.stores) {
    for (const createdDate of eachDate(args.start, args.end)) pairs.push({storeKey, createdDate, reason: 'manual'});
  }
  return pairs.slice(0, args.maxPairs);
}

function candidateSql(args) {
  const storeFilter = args.stores?.length
    ? `AND oi.store_key IN (${args.stores.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`
    : '';
  const cooldownFilter = args.ignoreCooldown
    ? 'true'
    : `(last_checked_at IS NULL OR last_checked_at < now() - (${Number(args.cooldownHours)} || ' hours')::interval)`;
  return `
WITH base AS (
  SELECT
    oi.store_key,
    oi.created_date,
    oi.order_item_key,
    coalesce(rs.lifecycle_status_group,
      CASE
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(未妥投|退回|拒收)' THEN 'returning'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(取消|关闭)' THEN 'cancelled'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(已签收|已完成|妥投)' THEN 'done'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(异常|失败|超时|风控|拦截|派件异常)' THEN 'abnormal'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(尾程已发货|已发货|运输|揽收|包裹已揽收)' THEN 'shipped'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(待处理|待发货|待揽收|待出库|待|下单成功|已打印面单)' THEN 'pending'
        ELSE 'other'
      END
    ) AS effective_group,
    coalesce(rs.is_terminal,false) AS is_terminal,
    rs.last_checked_at
  FROM fact.order_item oi
  LEFT JOIN ops.order_status_recheck_state rs
    ON rs.order_item_key = oi.order_item_key
  WHERE oi.created_date <= current_date - (${Number(args.minAgeDays)} || ' days')::interval
    ${storeFilter}
), candidates AS (
  SELECT
    store_key AS "storeKey",
    created_date::text AS "createdDate",
    count(*) AS "itemCount",
    count(*) FILTER (WHERE NOT is_terminal AND effective_group NOT IN ('done','cancelled','returning')) AS "openItemCount",
    min(last_checked_at) AS "oldestCheckedAt",
    max(last_checked_at) AS "latestCheckedAt"
  FROM base
  WHERE NOT is_terminal
    AND effective_group NOT IN ('done','cancelled','returning')
    AND ${cooldownFilter}
  GROUP BY store_key, created_date
  HAVING count(*) FILTER (WHERE NOT is_terminal AND effective_group NOT IN ('done','cancelled','returning')) > 0
  ORDER BY created_date ASC, "openItemCount" DESC, store_key ASC
  LIMIT ${Number(args.maxPairs)}
)
SELECT coalesce(json_agg(candidates), '[]'::json)::text FROM candidates;
`;
}

async function dbCandidatePairs(args) {
  const stdout = await runPsql(args, candidateSql(args));
  const text = stdout.trim() || '[]';
  const parsed = JSON.parse(text);
  return parsed.map(x => ({...x, storeKey: String(x.storeKey || '').toUpperCase(), createdDate: x.createdDate, reason: 'db-backlog'}));
}

async function getCandidatePairs(args) {
  const manual = await manualPairs(args);
  if (manual) return manual;
  return await dbCandidatePairs(args);
}

async function openFactRowsForPair(args, pair) {
  const store = sqlLiteral(pair.storeKey);
  const date = sqlLiteral(pair.createdDate);
  const sql = `
WITH base AS (
  SELECT
    coalesce(nullif(oi.order_item_key,''), md5(concat_ws('|', oi.store_key, coalesce(oi.order_no,''), coalesce(oi.bill_no,''), coalesce(oi.standard_goods_sn,''), coalesce(oi.skc,''), coalesce(oi.order_create_time::text,''), coalesce(oi.goods_title,'')))) AS order_item_key,
    oi.order_key,
    oi.store_key,
    oi.group_key,
    oi.order_id,
    oi.order_no,
    oi.bill_no,
    oi.created_date::text AS created_date,
    oi.order_create_time::text AS order_create_time,
    dim.product_canonical_sn(oi.standard_goods_sn) AS standard_goods_sn,
    oi.raw_goods_sn,
    oi.goods_id,
    oi.entity_id,
    oi.skc,
    oi.sku_code,
    oi.goods_title,
    oi.goods_performance_status_desc,
    oi.raw_summary AS original_raw_summary,
    rs.order_item_key IS NOT NULL AS has_recheck,
    coalesce(rs.is_terminal,false) AS is_terminal,
    coalesce(rs.lifecycle_status_group,
      CASE
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(未妥投|退回|拒收)' THEN 'returning'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(取消|关闭)' THEN 'cancelled'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(已签收|已完成|妥投)' THEN 'done'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(异常|失败|超时|风控|拦截|派件异常)' THEN 'abnormal'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(尾程已发货|已发货|运输|揽收|包裹已揽收)' THEN 'shipped'
        WHEN coalesce(oi.goods_performance_status_desc,'') ~ '(待处理|待发货|待揽收|待出库|待|下单成功|已打印面单)' THEN 'pending'
        ELSE 'other'
      END
    ) AS effective_group
  FROM fact.order_item oi
  LEFT JOIN ops.order_status_recheck_state rs
    ON rs.order_item_key = oi.order_item_key
  WHERE oi.store_key = ${store}
    AND oi.created_date = ${date}::date
)
SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text
FROM (
  SELECT *
  FROM base
  WHERE NOT is_terminal
    AND effective_group NOT IN ('done','cancelled','returning')
  ORDER BY order_no NULLS LAST, bill_no NULLS LAST, order_item_key
) t;
`;
  const stdout = await runPsql(args, sql);
  return JSON.parse(stdout.trim() || '[]');
}

function orderKeysFor(row) {
  return [row.order_no, row.bill_no].map(x => String(x || '').trim()).filter(Boolean);
}

function makeEvidenceRowFromFact(fact, template, meta) {
  const now = meta.checkedAt;
  if (template) {
    return {
      ...template,
      order_item_key: fact.order_item_key,
      order_key: fact.order_key || `${fact.store_key}__${fact.order_no || fact.bill_no || fact.order_item_key}`,
      store_key: fact.store_key,
      group_key: fact.group_key || template.group_key || '',
      order_id: fact.order_id || template.order_id || '',
      order_no: fact.order_no || template.order_no || '',
      bill_no: fact.bill_no || template.bill_no || '',
      created_date: fact.created_date,
      order_create_time: fact.order_create_time || template.order_create_time || null,
      standard_goods_sn: fact.standard_goods_sn || template.standard_goods_sn || '',
      raw_goods_sn: fact.raw_goods_sn || template.raw_goods_sn || fact.standard_goods_sn || '',
      goods_id: fact.goods_id || template.goods_id || '',
      entity_id: fact.entity_id || template.entity_id || '',
      skc: fact.skc || template.skc || '',
      sku_code: fact.sku_code || template.sku_code || '',
      goods_title: fact.goods_title || template.goods_title || '',
      last_checked_at: now,
      terminal_at: template.is_terminal ? now : null,
      source_file: meta.sourceFile,
      transport: meta.transport,
      fetch_time: meta.fetchTime,
      raw_summary: compactJson({
        kind: 'status_copied_to_missing_fact_item',
        reason: 'SHEIN recheck returned the order but not this fact item key; copied order-level lifecycle evidence to keep the fact item observable.',
        source_order_item_key: template.order_item_key,
        source_order_no: template.order_no || template.bill_no || '',
        fact_order_item_key: fact.order_item_key,
        original_goods_performance_status_desc: fact.goods_performance_status_desc || '',
      }),
    };
  }
  return {
    order_item_key: fact.order_item_key,
    order_key: fact.order_key || `${fact.store_key}__${fact.order_no || fact.bill_no || fact.order_item_key}`,
    store_key: fact.store_key,
    group_key: fact.group_key || '',
    order_id: fact.order_id || '',
    order_no: fact.order_no || '',
    bill_no: fact.bill_no || '',
    created_date: fact.created_date,
    order_create_time: fact.order_create_time || null,
    standard_goods_sn: fact.standard_goods_sn || '',
    raw_goods_sn: fact.raw_goods_sn || fact.standard_goods_sn || '',
    goods_id: fact.goods_id || '',
    entity_id: fact.entity_id || '',
    skc: fact.skc || '',
    sku_code: fact.sku_code || '',
    goods_title: fact.goods_title || '',
    latest_goods_status: '',
    latest_goods_performance_status: '',
    latest_goods_performance_status_desc: '复查未返回（SHEIN当前接口未返回该订单）',
    latest_page_status: '',
    latest_page_status_desc: '复查未返回',
    latest_order_status: '',
    latest_order_status_desc: '复查未返回',
    latest_perform_status: '',
    latest_perform_status_desc: '复查未返回',
    lifecycle_status_group: 'platform_unclosed',
    is_terminal: false,
    last_checked_at: now,
    terminal_at: null,
    source_file: meta.sourceFile,
    transport: meta.transport,
    fetch_time: meta.fetchTime,
    raw_summary: compactJson({
      kind: 'not_returned_by_recheck',
      reason: 'SHEIN recheck completed for this store/date, but the current API response did not include this historical fact order item.',
      fact_order_item_key: fact.order_item_key,
      order_no: fact.order_no || '',
      bill_no: fact.bill_no || '',
      original_goods_performance_status_desc: fact.goods_performance_status_desc || '',
    }),
  };
}

async function fillMissingEvidenceRows(args, pair, fetchJson, sourceFile, rows) {
  const factRows = await openFactRowsForPair(args, pair);
  if (!factRows.length) return {rows, missingRows: [], factOpenRows: 0};
  const fetchedKeys = new Set(rows.map(r => String(r.order_item_key || '')));
  const byOrder = new Map();
  for (const row of rows) {
    for (const key of orderKeysFor(row)) if (!byOrder.has(key)) byOrder.set(key, row);
  }
  const checkedAt = new Date().toISOString();
  const meta = {
    checkedAt,
    sourceFile,
    transport: fetchJson.transport || fetchJson.orderPage?.transport || args.transport || '',
    fetchTime: ts(fetchJson.fetchTime),
  };
  const missingRows = [];
  for (const fact of factRows) {
    if (fetchedKeys.has(String(fact.order_item_key || ''))) continue;
    let template = null;
    for (const key of orderKeysFor(fact)) {
      if (byOrder.has(key)) {
        template = byOrder.get(key);
        break;
      }
    }
    const evidence = makeEvidenceRowFromFact(fact, template, meta);
    missingRows.push(evidence);
    fetchedKeys.add(String(fact.order_item_key || ''));
  }
  return {rows: rows.concat(missingRows), missingRows, factOpenRows: factRows.length};
}

function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}

async function fetchPair(args, runDir, pair) {
  const fetchArgs = [
    path.join(ROOT, 'scripts', 'fetch_shein_sales.mjs'),
    pair.storeKey,
    '--date', pair.createdDate,
    '--transport', args.transport,
    '--out', runDir,
    '--json',
  ];
  const res = await run(process.execPath, fetchArgs, {
    timeoutMs: Number(process.env.SHEIN_ORDER_RECHECK_FETCH_TIMEOUT_MS || 180_000),
    env: {...process.env, SHEIN_SALES_TRANSPORT: args.transport},
  });
  const parsed = res.ok ? parseJsonFromOutput(res.stdout) : null;
  return {
    ok: res.ok,
    code: res.code,
    pair,
    parsed,
    stdoutTail: res.stdout.slice(-1500),
    stderrTail: res.stderr.slice(-1500),
    file: path.join(runDir, pair.storeKey, `${pair.createdDate}.json`),
  };
}

function classifyStatus(row) {
  const text = [
    row.goodsPerformanceStatusDesc,
    row.pageStatusDesc,
    row.orderStatusDesc,
    row.performStatusDesc,
    row.newOrderGoodsStatus,
  ].map(x => String(x || '')).join(' ');
  if (/(未妥投|退回|拒收)/.test(text)) return {group: 'returning', terminal: true};
  if (/(取消|关闭)/.test(text)) return {group: 'cancelled', terminal: true};
  if (/(已签收|已完成|妥投)/.test(text)) return {group: 'done', terminal: true};
  if (/(异常|失败|超时|风控|拦截|派件异常)/.test(text)) return {group: 'abnormal', terminal: false};
  if (/(尾程已发货|已发货|运输|揽收|包裹已揽收)/.test(text)) return {group: 'shipped', terminal: false};
  if (/(待处理|待发货|待揽收|待出库|待|下单成功|已打印面单)/.test(text)) return {group: 'pending', terminal: false};
  return {group: 'other', terminal: false};
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLen) return text;
  return JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

function ts(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s && s !== '-' ? s : null;
}

function sourceFileFor(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function rowsFromFetchFile(file) {
  const j = JSON.parse(fssync.readFileSync(file, 'utf8'));
  const date = j.start || path.basename(file, '.json');
  const checkedAt = new Date().toISOString();
  const sourceFile = sourceFileFor(file);
  const rows = [];
  for (const [idx, row] of (j.goodsRows || []).entries()) {
    const orderId = String(row.orderId || row.orderNo || idx);
    const orderKey = `${j.storeKey}__${orderId}`;
    const itemKey = `${j.storeKey}__${date}__${orderId}__${row.goodsId || row.entityId || row.skcName || row.skuCode || idx}__${idx}`;
    const status = classifyStatus(row);
    rows.push({
      order_item_key: itemKey,
      order_key: orderKey,
      store_key: j.storeKey,
      group_key: j.groupKey || '',
      order_id: row.orderId || '',
      order_no: row.orderNo || '',
      bill_no: row.billno || '',
      created_date: date,
      order_create_time: ts(row.orderCreateTime || row.allocateTimeFull),
      standard_goods_sn: row.goodsSn || '',
      raw_goods_sn: row.goodsSn || '',
      goods_id: row.goodsId || '',
      entity_id: row.entityId || '',
      skc: row.skcName || '',
      sku_code: row.skuCode || '',
      goods_title: row.goodsTitle || '',
      latest_goods_status: row.newOrderGoodsStatus ?? '',
      latest_goods_performance_status: row.goodsPerformanceStatus ?? '',
      latest_goods_performance_status_desc: row.goodsPerformanceStatusDesc || '',
      latest_page_status: row.pageStatus ?? '',
      latest_page_status_desc: row.pageStatusDesc || '',
      latest_order_status: row.orderStatus ?? '',
      latest_order_status_desc: row.orderStatusDesc || '',
      latest_perform_status: row.performStatus ?? '',
      latest_perform_status_desc: row.performStatusDesc || '',
      lifecycle_status_group: status.group,
      is_terminal: status.terminal,
      last_checked_at: checkedAt,
      terminal_at: status.terminal ? checkedAt : null,
      source_file: sourceFile,
      transport: j.transport || j.orderPage?.transport || '',
      fetch_time: ts(j.fetchTime),
      raw_summary: compactJson(row),
    });
  }
  return {json: j, rows};
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  let s;
  if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

function qIdent(name) {
  return String(name).split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
}

async function upsertRecheckRows(args, rows) {
  if (!rows.length) return {rows: 0};
  const sqlColumns = COLUMNS.map(qIdent).join(', ');
  const updateSet = COLUMNS
    .filter(c => !['order_item_key', 'store_key', 'created_date', 'terminal_at'].includes(c))
    .map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`);
  updateSet.push('first_seen_at = ops.order_status_recheck_state.first_seen_at');
  updateSet.push('check_count = ops.order_status_recheck_state.check_count + 1');
  updateSet.push(`consecutive_same_count = CASE
    WHEN coalesce(ops.order_status_recheck_state.latest_goods_performance_status_desc,'') = coalesce(EXCLUDED.latest_goods_performance_status_desc,'')
     AND coalesce(ops.order_status_recheck_state.latest_page_status_desc,'') = coalesce(EXCLUDED.latest_page_status_desc,'')
     AND coalesce(ops.order_status_recheck_state.lifecycle_status_group,'') = coalesce(EXCLUDED.lifecycle_status_group,'')
    THEN ops.order_status_recheck_state.consecutive_same_count + 1
    ELSE 1
  END`);
  updateSet.push(`terminal_at = CASE
    WHEN EXCLUDED.is_terminal THEN coalesce(ops.order_status_recheck_state.terminal_at, EXCLUDED.last_checked_at)
    ELSE NULL
  END`);
  updateSet.push('updated_at = now()');
  let script = 'BEGIN;\n';
  script += 'CREATE TEMP TABLE order_status_recheck_stage (LIKE ops.order_status_recheck_state INCLUDING DEFAULTS) ON COMMIT DROP;\n';
  script += `COPY order_status_recheck_stage (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(COLUMNS.map(c => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ops.order_status_recheck_state (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM order_status_recheck_stage\n`;
  script += `ON CONFLICT (order_item_key) DO UPDATE SET\n  ${updateSet.join(',\n  ')};\n`;
  script += 'COMMIT;\n';
  if (args.dryRun) return {rows: rows.length, dryRun: true};
  await runPsql(args, script);
  return {rows: rows.length};
}

function summarizeRows(rows) {
  const byGroup = {};
  for (const row of rows) byGroup[row.lifecycle_status_group] = (byGroup[row.lifecycle_status_group] || 0) + 1;
  return {
    rows: rows.length,
    terminalRows: rows.filter(r => r.is_terminal).length,
    byGroup,
  };
}

async function writeState(args, report) {
  await fs.mkdir(path.dirname(args.stateFile), {recursive: true});
  await fs.writeFile(args.stateFile, JSON.stringify(report, null, 2), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
  const runDir = path.join(args.outDir, runId);
  await fs.mkdir(runDir, {recursive: true});
  const schema = await ensureSchema(args);
  const pairs = await getCandidatePairs(args);
  const report = {
    ok: true,
    dryRun: args.dryRun,
    startedAt,
    finishedAt: null,
    runId,
    runDir: sourceFileFor(runDir),
    schema,
    candidatePairs: pairs.length,
    maxPairs: args.maxPairs,
    minAgeDays: args.minAgeDays,
    cooldownHours: args.ignoreCooldown ? 0 : args.cooldownHours,
    transport: args.transport,
    pairs: [],
    totals: {fetchedPairs: 0, failedPairs: 0, rows: 0, terminalRows: 0, byGroup: {}},
  };

  if (args.dryRun) {
    report.pairs = pairs.map(pair => ({pair, dryRun: true}));
    report.finishedAt = new Date().toISOString();
    await writeState(args, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  for (const pair of pairs) {
    const fetched = await fetchPair(args, runDir, pair);
    if (!fetched.ok || !fssync.existsSync(fetched.file)) {
      report.ok = false;
      report.totals.failedPairs += 1;
      report.pairs.push({pair, ok: false, code: fetched.code, error: fetched.stderrTail || fetched.stdoutTail});
      await writeState(args, report);
      continue;
    }
    const {json, rows} = rowsFromFetchFile(fetched.file);
    const sourceFile = sourceFileFor(fetched.file);
    const evidence = await fillMissingEvidenceRows(args, pair, json, sourceFile, rows);
    const upsert = await upsertRecheckRows(args, evidence.rows);
    const summary = summarizeRows(evidence.rows);
    report.totals.fetchedPairs += 1;
    report.totals.rows += summary.rows;
    report.totals.terminalRows += summary.terminalRows;
    for (const [k, v] of Object.entries(summary.byGroup)) report.totals.byGroup[k] = (report.totals.byGroup[k] || 0) + v;
    report.pairs.push({
      pair,
      ok: true,
      file: sourceFile,
      fetchTime: json.fetchTime,
      apiCount: json.summary?.apiCount ?? null,
      detailedOrderCount: json.summary?.detailedOrderCount ?? null,
      goodsLineCount: json.summary?.goodsLineCount ?? null,
      salesSar: json.summary?.salesSar ?? null,
      factOpenRows: evidence.factOpenRows,
      missingEvidenceRows: evidence.missingRows.length,
      upsert,
      summary,
    });
    await writeState(args, report);
  }

  report.finishedAt = new Date().toISOString();
  await writeState(args, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
