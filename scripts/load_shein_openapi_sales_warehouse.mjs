#!/usr/bin/env node
/**
 * Load SHEIN OpenAPI sales artifacts into parallel warehouse tables.
 *
 * This is intentionally isolated from the browser-fetch production fact tables:
 *   fact.openapi_store_daily_sales
 *   fact.openapi_order_header
 *   fact.openapi_order_item
 *   mart.openapi_sales_reconciliation
 *
 * It reads local JSON files only. It does not call SHEIN or Feishu.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';
import {isValidSalesGoodsRow, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';
import {
  ORDER_PAYMENT_FLAG_COLUMNS,
  extractPaymentFlagsFromSalesArtifact,
} from '../lib/order_payment_flags.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENAPI_ORDER_PAYMENT_FLAG_TABLE = 'fact.openapi_order_payment_flag';
const OPENAPI_ORDER_PAYMENT_FLAG_CREATE_SQL = `
CREATE TABLE IF NOT EXISTS fact.openapi_order_payment_flag (
  order_key text PRIMARY KEY,
  store_key text NOT NULL,
  group_key text,
  order_id text,
  order_no text,
  bill_no text,
  created_date date,
  order_create_time timestamp without time zone,
  is_cod boolean,
  payment_method text,
  payment_code text,
  payment_label text,
  payment_source text,
  source_kind text NOT NULL,
  source_file text,
  raw_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openapi_order_payment_flag_store_date_idx
  ON fact.openapi_order_payment_flag (store_key, created_date);
CREATE INDEX IF NOT EXISTS openapi_order_payment_flag_is_cod_date_idx
  ON fact.openapi_order_payment_flag (is_cod, created_date)
  WHERE is_cod IS TRUE;
CREATE INDEX IF NOT EXISTS openapi_order_payment_flag_order_no_idx
  ON fact.openapi_order_payment_flag (store_key, order_no);
`;

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    store: '',
    salesDir: path.join(ROOT, 'outputs', 'shein_openapi_fetch'),
    browserDir: path.join(ROOT, 'outputs', 'shein_fetch'),
    dryRun: false,
    dates: [],
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--store') args.store = String(argv[++i] || '').toUpperCase();
    else if (a === '--sales-dir') args.salesDir = path.resolve(argv[++i]);
    else if (a === '--browser-dir') args.browserDir = path.resolve(argv[++i]);
    else if (a === '--date') args.dates.push(argv[++i]);
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --date 2026-05-05
  node scripts/load_shein_openapi_sales_warehouse.mjs HL --start 2026-05-05 --end 2026-05-06

Loads outputs/shein_openapi_fetch/<STORE>/<DATE>.json into parallel OpenAPI fact tables
and writes API-vs-browser reconciliation rows.`);
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  if (!args.store && rest[0]) args.store = String(rest[0]).toUpperCase();
  if (args.start) {
    if (!args.end) args.end = args.start;
    for (const date of eachDate(args.start, args.end)) args.dates.push(date);
  }
  args.dates = [...new Set(args.dates)].sort();
  if (!args.store) throw new Error('Missing store key. Use --store HL or positional HL.');
  if (!args.dates.length) throw new Error('Missing --date or --start/--end.');
  return args;
}

function* eachDate(start, end) {
  const d = new Date(`${start}T00:00:00+08:00`);
  const stop = new Date(`${end}T00:00:00+08:00`);
  while (d <= stop) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    yield `${y}-${m}-${day}`;
    d.setDate(d.getDate() + 1);
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function ts(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  return s;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function recalculateSummaryFromGoodsRows(data, fallbackSummary = {}) {
  const goodsRows = asArray(data?.goodsRows);
  const goodsSales = summarizeSalesGoodsRows(goodsRows);
  const salesSar = round2(goodsSales.salesSar);
  return {
    ...fallbackSummary,
    orderRefCount: Number(fallbackSummary.orderRefCount || fallbackSummary.apiCount || asArray(data?.orderRefs).length || asArray(data?.orderRows).length || 0),
    apiCount: Number(fallbackSummary.apiCount || fallbackSummary.orderRefCount || asArray(data?.orderRefs).length || 0),
    detailedOrderCount: Number(fallbackSummary.detailedOrderCount || asArray(data?.orderRows).length || 0),
    positiveAmountOrderCount: goodsSales.positiveAmountOrderCount,
    goodsLineCount: goodsRows.length,
    quantityAll: goodsSales.quantityAll,
    quantityPositiveAmount: goodsSales.quantityPositiveAmount,
    salesSar,
    salesRmb: round2(salesSar * 1.8),
    excludedGoodsLineCount: goodsSales.excludedGoodsLineCount,
    excludedSalesSar: round2(goodsSales.excludedSalesSar),
    validityPolicy: 'lib/shein_sales_validity.mjs',
  };
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLen) return text;
  return JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  let s;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

function qIdent(ident) {
  return ident.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.');
}

function tempName(table) {
  return `stage_${table.replace(/\W+/g, '_')}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function runPsqlScript(args, script) {
  const useWsl = process.platform === 'win32';
  const command = useWsl ? 'wsl' : (process.env.SHEIN_BI_DOCKER_COMMAND || 'sudo');
  const commandArgs = useWsl
    ? [
        '-d',
        args.distro,
        '--',
        'bash',
        '-lc',
        `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`,
      ]
    : command === 'sudo'
      ? [
        '-n',
        'docker',
        'exec',
        '-i',
        args.container,
        'psql',
        '-U',
        args.user,
        '-d',
        args.database,
        '-v',
        'ON_ERROR_STOP=1',
      ]
      : [
        'exec',
        '-i',
        args.container,
        'psql',
        '-U',
        args.user,
        '-d',
        args.database,
        '-v',
        'ON_ERROR_STOP=1',
      ];
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (d) => stdoutChunks.push(Buffer.from(d)));
  child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return {stdout, stderr};
}

async function ensureOpenApiTables(args) {
  const script = `
BEGIN;
${OPENAPI_ORDER_PAYMENT_FLAG_CREATE_SQL}
CREATE TABLE IF NOT EXISTS fact.openapi_store_daily_sales (LIKE fact.store_daily_sales INCLUDING DEFAULTS);
CREATE TABLE IF NOT EXISTS fact.openapi_order_header (LIKE fact.order_header INCLUDING DEFAULTS);
CREATE TABLE IF NOT EXISTS fact.openapi_order_item (LIKE fact.order_item INCLUDING DEFAULTS);
CREATE TABLE IF NOT EXISTS mart.openapi_sales_reconciliation (
  date date NOT NULL,
  store_key text NOT NULL,
  browser_source_file text,
  api_source_file text,
  browser_order_count integer,
  api_order_count integer,
  browser_positive_order_count integer,
  api_positive_order_count integer,
  browser_goods_line_count integer,
  api_goods_line_count integer,
  browser_quantity_positive_amount numeric,
  api_quantity_positive_amount numeric,
  browser_sales_sar numeric,
  api_sales_sar numeric,
  order_count_delta integer,
  positive_order_count_delta integer,
  goods_line_count_delta integer,
  quantity_positive_delta numeric,
  sales_sar_delta numeric,
  browser_only_order_count integer,
  api_only_order_count integer,
  browser_only_goods_count integer,
  api_only_goods_count integer,
  status text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (date, store_key)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fact.openapi_store_daily_sales'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fact.openapi_store_daily_sales ADD CONSTRAINT openapi_store_daily_sales_pkey PRIMARY KEY (date, store_key);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fact.openapi_order_header'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fact.openapi_order_header ADD CONSTRAINT openapi_order_header_pkey PRIMARY KEY (order_key);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fact.openapi_order_item'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fact.openapi_order_item ADD CONSTRAINT openapi_order_item_pkey PRIMARY KEY (order_item_key);
  END IF;
END $$;
COMMIT;
`;
  if (args.dryRun) return {skipped: true, dryRun: true};
  await runPsqlScript(args, script);
  return {ok: true};
}

async function cleanupLoadedSlices(args, pairs) {
  if (!pairs.length) return {pairs: 0, skipped: true};
  const script = `BEGIN;
${buildCleanupSql(pairs)}
COMMIT;
`;
  if (args.dryRun) return {pairs: pairs.length, dryRun: true};
  await runPsqlScript(args, script);
  return {pairs: pairs.length};
}

function buildCleanupSql(pairs) {
  const tupleList = pairs.map((p) => `(${sqlLiteral(p.date)}::date, ${sqlLiteral(p.store)})`).join(', ');
  return `DELETE FROM fact.openapi_order_item WHERE (created_date, store_key) IN (${tupleList});
DELETE FROM fact.openapi_order_header WHERE (created_date, store_key) IN (${tupleList});
DELETE FROM fact.openapi_store_daily_sales WHERE (date, store_key) IN (${tupleList});
DELETE FROM mart.openapi_sales_reconciliation WHERE (date, store_key) IN (${tupleList});
DELETE FROM fact.openapi_order_payment_flag WHERE (created_date, store_key) IN (${tupleList});
`;
}

function buildUpsertRowsSql(table, columns, conflictColumns, rows) {
  const originalRowCount = rows.length;
  if (rows.length && conflictColumns.length) {
    const byConflictKey = new Map();
    for (const row of rows) {
      const key = conflictColumns.map((c) => String(row[c] ?? '')).join('\u001F');
      byConflictKey.set(key, row);
    }
    rows = [...byConflictKey.values()];
  }
  const result = {table, rows: rows.length, inputRows: originalRowCount, dedupedRows: originalRowCount - rows.length};
  if (!rows.length) return {script: '', result: {...result, skipped: true}};
  const stage = tempName(table);
  const nonConflict = columns.filter((c) => !conflictColumns.includes(c) && c !== 'updated_at');
  const updateSet = [
    ...nonConflict.map((c) => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`),
    columns.includes('updated_at') ? 'updated_at = now()' : '',
  ].filter(Boolean).join(',\n    ');
  const sqlColumns = columns.map(qIdent).join(', ');
  let script = '';
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map((c) => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM "${stage}"\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  return {script, result};
}

async function upsertRows(args, table, columns, conflictColumns, rows) {
  const {script, result} = buildUpsertRowsSql(table, columns, conflictColumns, rows);
  if (!script) return result;
  if (args.dryRun) return {...result, dryRun: true};
  const wrapped = `BEGIN;\n${script}COMMIT;\n`;
  await runPsqlScript(args, wrapped);
  return result;
}

function openApiSalesLoadSpecs(sales) {
  return [
    {
      table: 'fact.openapi_store_daily_sales',
      columns: ['date','store_key','group_key','shop_name','valid_order_count','goods_line_count','quantity_all','quantity_positive_amount','sales_sar','sales_rmb','fetch_time','source_file','raw_summary'],
      conflictColumns: ['date','store_key'],
      rows: sales.daily,
    },
    {
      table: 'fact.openapi_order_header',
      columns: ['order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','allocate_time','site','order_status','order_status_desc','perform_status','perform_status_desc','source_file','raw_summary'],
      conflictColumns: ['order_key'],
      rows: sales.orders,
    },
    {
      table: 'fact.openapi_order_item',
      columns: ['order_item_key','order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','site','standard_goods_sn','raw_goods_sn','goods_id','entity_id','skc','sku_code','sku_sn','sku_suffix','goods_title','quantity','currency_code','currency_price','sales_sar','sales_rmb','goods_status','goods_performance_status','goods_performance_status_desc','source_file','raw_summary'],
      conflictColumns: ['order_item_key'],
      rows: sales.items,
    },
    {
      table: OPENAPI_ORDER_PAYMENT_FLAG_TABLE,
      columns: ORDER_PAYMENT_FLAG_COLUMNS,
      conflictColumns: ['order_key'],
      rows: sales.paymentFlags,
    },
    {
      table: 'mart.openapi_sales_reconciliation',
      columns: ['date','store_key','browser_source_file','api_source_file','browser_order_count','api_order_count','browser_positive_order_count','api_positive_order_count','browser_goods_line_count','api_goods_line_count','browser_quantity_positive_amount','api_quantity_positive_amount','browser_sales_sar','api_sales_sar','order_count_delta','positive_order_count_delta','goods_line_count_delta','quantity_positive_delta','sales_sar_delta','browser_only_order_count','api_only_order_count','browser_only_goods_count','api_only_goods_count','status','generated_at','raw_summary'],
      conflictColumns: ['date','store_key'],
      rows: sales.reconciliations,
    },
  ];
}

async function loadOpenApiSalesAtomically(args, sales) {
  const cleanup = args.dryRun ? {pairs: sales.pairs.length, dryRun: true} : {pairs: sales.pairs.length};
  let script = 'BEGIN;\n';
  script += buildCleanupSql(sales.pairs);
  const results = [];
  for (const spec of openApiSalesLoadSpecs(sales)) {
    const built = buildUpsertRowsSql(spec.table, spec.columns, spec.conflictColumns, spec.rows);
    script += built.script;
    results.push(args.dryRun ? {...built.result, dryRun: true} : built.result);
  }
  script += 'COMMIT;\n';
  if (args.dryRun) return {cleanup, results};
  await runPsqlScript(args, script);
  return {cleanup, results};
}

export function buildFactRows(data, file) {
  const date = data.start || data.date || path.basename(file, '.json');
  const source = rel(file);
  const summary = recalculateSummaryFromGoodsRows(data, data.summary || {});
  const daily = [{
    date,
    store_key: data.storeKey,
    group_key: data.groupKey,
    shop_name: data.shopName,
    valid_order_count: int(summary.positiveAmountOrderCount),
    goods_line_count: int(summary.goodsLineCount),
    quantity_all: num(summary.quantityAll),
    quantity_positive_amount: num(summary.quantityPositiveAmount),
    sales_sar: num(summary.salesSar),
    sales_rmb: num(summary.salesRmb),
    fetch_time: ts(data.fetchTime),
    source_file: source,
    raw_summary: compactJson(summary),
  }];
  const orders = [];
  const items = [];
  const paymentFlags = extractPaymentFlagsFromSalesArtifact(data, {
    date,
    sourceFile: source,
    sourceKind: 'openapi',
  });
  for (const [idx, row] of asArray(data.orderRows).entries()) {
    const orderId = String(row.orderId || row.id || row.orderNo || idx);
    const orderKey = `${data.storeKey}__${orderId}`;
    orders.push({
      order_key: orderKey,
      store_key: data.storeKey,
      group_key: data.groupKey,
      order_id: row.orderId || '',
      order_no: row.orderNo || '',
      bill_no: row.billno || '',
      created_date: date,
      order_create_time: ts(row.orderCreateTime || row.allocateTimeFull),
      allocate_time: ts(row.allocateTimeFull || row.allocateTime),
      site: row.site || '',
      order_status: row.orderStatus ?? '',
      order_status_desc: row.orderStatusDesc || '',
      perform_status: row.performStatus ?? '',
      perform_status_desc: row.performStatusDesc || '',
      source_file: source,
      raw_summary: compactJson(row),
    });
  }
  for (const [idx, row] of asArray(data.goodsRows).entries()) {
    const norm = normalizeGoodsSnDetailed(row.goodsSn || '', {goodsTitle: row.goodsTitle || row.goodsName || ''});
    const standard = norm.canonical || row.goodsSn || '';
    const orderId = String(row.orderId || row.orderNo || idx);
    const orderKey = `${data.storeKey}__${orderId}`;
    const itemKey = `${data.storeKey}__${date}__${orderId}__${row.goodsId || row.entityId || row.skcName || row.skuCode || idx}__${idx}`;
    const qty = num(row.number) ?? 0;
    const price = num(row.currencyPrice) ?? 0;
    const validSale = isValidSalesGoodsRow(row);
    const salesQty = validSale ? qty : 0;
    const salesPrice = validSale ? price : 0;
    items.push({
      order_item_key: itemKey,
      order_key: orderKey,
      store_key: data.storeKey,
      group_key: data.groupKey,
      order_id: row.orderId || '',
      order_no: row.orderNo || '',
      bill_no: row.billno || '',
      created_date: date,
      order_create_time: ts(row.orderCreateTime || row.allocateTimeFull),
      site: row.site || '',
      standard_goods_sn: standard,
      raw_goods_sn: row.goodsSn || '',
      goods_id: row.goodsId || '',
      entity_id: row.entityId || '',
      skc: row.skcName || '',
      sku_code: row.skuCode || '',
      sku_sn: row.skuSn || '',
      sku_suffix: row.suffix || '',
      goods_title: row.goodsTitle || '',
      quantity: salesQty,
      currency_code: row.currencyCode || '',
      currency_price: price,
      sales_sar: salesPrice,
      sales_rmb: round2(salesPrice * 1.8),
      goods_status: row.newOrderGoodsStatus ?? '',
      goods_performance_status: row.goodsPerformanceStatus ?? '',
      goods_performance_status_desc: row.goodsPerformanceStatusDesc || '',
      source_file: source,
      raw_summary: compactJson(row),
    });
  }
  return {date, daily, orders, items, paymentFlags};
}

function summarizeArtifact(data) {
  const summary = recalculateSummaryFromGoodsRows(data, data?.summary || {});
  return {
    orderCount: Number(summary.orderRefCount || summary.apiCount || 0),
    positiveOrderCount: Number(summary.positiveAmountOrderCount || 0),
    goodsLineCount: Number(summary.goodsLineCount || 0),
    quantityPositiveAmount: Number(summary.quantityPositiveAmount || 0),
    salesSar: round2(summary.salesSar || 0),
    orderNos: asArray(data?.orderRows).map((r) => String(r.orderNo || r.orderId || '')).filter(Boolean).sort(),
    goodsIds: asArray(data?.goodsRows).map((r) => String(r.goodsId || '')).filter(Boolean).sort(),
    fetchTime: data?.fetchTime || null,
  };
}

function setDiff(left, right) {
  return [...left].filter((x) => !right.has(x));
}

async function buildReconciliationRow(args, date, apiFile, apiData) {
  const browserFile = path.join(args.browserDir, args.store, `${date}.json`);
  const api = summarizeArtifact(apiData);
  const browserExists = fssync.existsSync(browserFile);
  const browserData = browserExists ? await readJson(browserFile) : null;
  const browser = browserData ? summarizeArtifact(browserData) : null;
  const browserOrderSet = new Set(browser?.orderNos || []);
  const apiOrderSet = new Set(api.orderNos || []);
  const browserGoodsSet = new Set(browser?.goodsIds || []);
  const apiGoodsSet = new Set(api.goodsIds || []);
  const deltas = browser ? {
    orderCount: api.orderCount - browser.orderCount,
    positiveOrderCount: api.positiveOrderCount - browser.positiveOrderCount,
    goodsLineCount: api.goodsLineCount - browser.goodsLineCount,
    quantityPositiveAmount: api.quantityPositiveAmount - browser.quantityPositiveAmount,
    salesSar: round2(api.salesSar - browser.salesSar),
    browserOnlyOrderCount: setDiff(browserOrderSet, apiOrderSet).length,
    apiOnlyOrderCount: setDiff(apiOrderSet, browserOrderSet).length,
    browserOnlyGoodsCount: setDiff(browserGoodsSet, apiGoodsSet).length,
    apiOnlyGoodsCount: setDiff(apiGoodsSet, browserGoodsSet).length,
  } : null;
  const matched = Boolean(deltas
    && deltas.orderCount === 0
    && deltas.positiveOrderCount === 0
    && deltas.goodsLineCount === 0
    && deltas.quantityPositiveAmount === 0
    && deltas.salesSar === 0
    && deltas.browserOnlyOrderCount === 0
    && deltas.apiOnlyOrderCount === 0
    && deltas.browserOnlyGoodsCount === 0
    && deltas.apiOnlyGoodsCount === 0);
  const status = !browser ? 'missing_browser' : matched ? 'matched' : 'warning';
  return {
    date,
    store_key: args.store,
    browser_source_file: browser ? rel(browserFile) : '',
    api_source_file: rel(apiFile),
    browser_order_count: browser?.orderCount ?? null,
    api_order_count: api.orderCount,
    browser_positive_order_count: browser?.positiveOrderCount ?? null,
    api_positive_order_count: api.positiveOrderCount,
    browser_goods_line_count: browser?.goodsLineCount ?? null,
    api_goods_line_count: api.goodsLineCount,
    browser_quantity_positive_amount: browser?.quantityPositiveAmount ?? null,
    api_quantity_positive_amount: api.quantityPositiveAmount,
    browser_sales_sar: browser?.salesSar ?? null,
    api_sales_sar: api.salesSar,
    order_count_delta: deltas?.orderCount ?? null,
    positive_order_count_delta: deltas?.positiveOrderCount ?? null,
    goods_line_count_delta: deltas?.goodsLineCount ?? null,
    quantity_positive_delta: deltas?.quantityPositiveAmount ?? null,
    sales_sar_delta: deltas?.salesSar ?? null,
    browser_only_order_count: deltas?.browserOnlyOrderCount ?? null,
    api_only_order_count: deltas?.apiOnlyOrderCount ?? null,
    browser_only_goods_count: deltas?.browserOnlyGoodsCount ?? null,
    api_only_goods_count: deltas?.apiOnlyGoodsCount ?? null,
    status,
    generated_at: new Date().toISOString(),
    raw_summary: compactJson({browser, api, deltas, browserFetchTime: browser?.fetchTime || null, apiFetchTime: api.fetchTime || null}),
  };
}

async function collectOpenApiSales(args) {
  const daily = [];
  const orders = [];
  const items = [];
  const paymentFlags = [];
  const reconciliations = [];
  const loadedFiles = [];
  const pairs = [];
  for (const date of args.dates) {
    const file = path.join(args.salesDir, args.store, `${date}.json`);
    if (!fssync.existsSync(file)) {
      throw new Error(`Missing OpenAPI sales file: ${rel(file)}`);
    }
    const data = await readJson(file);
    if (String(data.storeKey || '').toUpperCase() !== args.store) {
      throw new Error(`Store mismatch in ${rel(file)}: expected ${args.store}, got ${data.storeKey}`);
    }
    const factRows = buildFactRows(data, file);
    daily.push(...factRows.daily);
    orders.push(...factRows.orders);
    items.push(...factRows.items);
    paymentFlags.push(...factRows.paymentFlags);
    reconciliations.push(await buildReconciliationRow(args, factRows.date, file, data));
    loadedFiles.push(rel(file));
    pairs.push({date: factRows.date, store: args.store});
  }
  return {daily, orders, items, paymentFlags, reconciliations, loadedFiles, pairs};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sales = await collectOpenApiSales(args);
  const ensure = await ensureOpenApiTables(args);
  const {cleanup, results} = await loadOpenApiSalesAtomically(args, sales);

  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    storeKey: args.store,
    dates: args.dates,
    loadedFiles: sales.loadedFiles,
    ensure,
    cleanup,
    rowCounts: {
      daily: sales.daily.length,
      orders: sales.orders.length,
      items: sales.items.length,
      paymentFlags: sales.paymentFlags.length,
      reconciliations: sales.reconciliations.length,
    },
    reconciliation: sales.reconciliations.map((r) => ({
      date: r.date,
      status: r.status,
      browserSalesSar: r.browser_sales_sar,
      apiSalesSar: r.api_sales_sar,
      salesSarDelta: r.sales_sar_delta,
      browserOnlyOrderCount: r.browser_only_order_count,
      apiOnlyOrderCount: r.api_only_order_count,
    })),
    results,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
