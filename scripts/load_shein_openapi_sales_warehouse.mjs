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
import {
  isValidSalesGoodsRow,
  salesExclusionReason,
  summarizeSalesGoodsRows,
} from '../lib/shein_sales_validity.mjs';
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
  source_snapshot_at timestamptz,
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
    ensureOnly: false,
    skipEnsure: false,
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
    else if (a === '--ensure-only') args.ensureOnly = true;
    else if (a === '--skip-ensure') args.skipEnsure = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/load_shein_openapi_sales_warehouse.mjs --store HL --date 2026-05-05
  node scripts/load_shein_openapi_sales_warehouse.mjs HL --start 2026-05-05 --end 2026-05-06

Loads outputs/shein_openapi_fetch/<STORE>/<DATE>.json into parallel OpenAPI fact tables
and writes API-vs-browser reconciliation rows.

Schema orchestration:
  --ensure-only   create/migrate parallel tables, then exit
  --skip-ensure   load data without DDL (only after a successful ensure step)`);
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  if (args.ensureOnly) return args;
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

function sourceSnapshotAt(data, label = 'OpenAPI artifact') {
  const raw = ts(data?.fetchTime);
  const parsed = raw ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is missing a valid fetchTime; refusing an unversioned warehouse write`);
  }
  return parsed.toISOString();
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
ALTER TABLE fact.openapi_order_header ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;
ALTER TABLE fact.openapi_order_item ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;
ALTER TABLE fact.openapi_order_payment_flag ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;
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
  browser_invalid_goods_line_count integer,
  api_invalid_goods_line_count integer,
  browser_invalid_sales_sar numeric,
  api_invalid_sales_sar numeric,
  invalid_goods_line_count_delta integer,
  invalid_sales_sar_delta numeric,
  business_line_diff_count integer,
  scatter_point_diff_count integer,
  order_time_diff_count integer,
  cod_diff_count integer,
  metadata_diff_count integer,
  status_diff_count integer,
  identity_overlay_required boolean,
  status text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (date, store_key)
);
ALTER TABLE mart.openapi_sales_reconciliation
  ADD COLUMN IF NOT EXISTS browser_invalid_goods_line_count integer,
  ADD COLUMN IF NOT EXISTS api_invalid_goods_line_count integer,
  ADD COLUMN IF NOT EXISTS browser_invalid_sales_sar numeric,
  ADD COLUMN IF NOT EXISTS api_invalid_sales_sar numeric,
  ADD COLUMN IF NOT EXISTS invalid_goods_line_count_delta integer,
  ADD COLUMN IF NOT EXISTS invalid_sales_sar_delta numeric,
  ADD COLUMN IF NOT EXISTS business_line_diff_count integer,
  ADD COLUMN IF NOT EXISTS scatter_point_diff_count integer,
  ADD COLUMN IF NOT EXISTS order_time_diff_count integer,
  ADD COLUMN IF NOT EXISTS cod_diff_count integer,
  ADD COLUMN IF NOT EXISTS metadata_diff_count integer,
  ADD COLUMN IF NOT EXISTS status_diff_count integer,
  ADD COLUMN IF NOT EXISTS identity_overlay_required boolean;
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
${buildStoreLoadLocksSql(pairs)}
${buildCleanupSql(pairs)}
COMMIT;
`;
  if (args.dryRun) return {pairs: pairs.length, dryRun: true};
  await runPsqlScript(args, script);
  return {pairs: pairs.length};
}

function buildStoreLoadLocksSql(pairs) {
  const stores = [...new Set((pairs || []).map(pair => String(pair?.store || '').trim().toUpperCase()).filter(Boolean))].sort();
  return stores.map(store => `SELECT pg_advisory_xact_lock(hashtextextended('shein-openapi-order:' || ${sqlLiteral(store)}, 0));`).join('\n');
}

function buildCleanupSql(pairs) {
  const tupleList = pairs.map((p) => `(${sqlLiteral(p.date)}::date, ${sqlLiteral(p.store)}, ${sqlLiteral(p.sourceSnapshotAt)}::timestamptz)`).join(', ');
  return `CREATE TEMP TABLE incoming_openapi_sales_slice(date date, store_key text, source_snapshot_at timestamptz) ON COMMIT DROP;
INSERT INTO incoming_openapi_sales_slice(date, store_key, source_snapshot_at) VALUES ${tupleList};
DELETE FROM fact.openapi_order_item AS item USING incoming_openapi_sales_slice AS slice
WHERE item.created_date=slice.date AND item.store_key=slice.store_key
  AND NOT EXISTS (
    SELECT 1 FROM fact.openapi_order_header AS header
    WHERE header.store_key=item.store_key AND header.order_no=item.order_no
      AND header.source_snapshot_at > slice.source_snapshot_at
  );
DELETE FROM fact.openapi_order_payment_flag AS payment USING incoming_openapi_sales_slice AS slice
WHERE payment.created_date=slice.date AND payment.store_key=slice.store_key
  AND NOT EXISTS (
    SELECT 1 FROM fact.openapi_order_header AS header
    WHERE header.store_key=payment.store_key AND header.order_no=payment.order_no
      AND header.source_snapshot_at > slice.source_snapshot_at
  );
DELETE FROM fact.openapi_order_header AS header USING incoming_openapi_sales_slice AS slice
WHERE header.created_date=slice.date AND header.store_key=slice.store_key
  AND (header.source_snapshot_at IS NULL OR header.source_snapshot_at <= slice.source_snapshot_at);
DELETE FROM fact.openapi_store_daily_sales AS daily USING incoming_openapi_sales_slice AS slice
WHERE daily.date=slice.date AND daily.store_key=slice.store_key;
DELETE FROM mart.openapi_sales_reconciliation AS reconciliation USING incoming_openapi_sales_slice AS slice
WHERE reconciliation.date=slice.date AND reconciliation.store_key=slice.store_key;
`;
}

function buildUpsertRowsSql(table, columns, conflictColumns, rows, {freshnessColumn = '', freshnessParent = null} = {}) {
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
  const stageRef = `"${stage}"`;
  const sourceGuard = freshnessParent
    ? `WHERE NOT EXISTS (SELECT 1 FROM ${qIdent(freshnessParent.table)} AS freshness_parent
      WHERE freshness_parent.${qIdent('store_key')}=${stageRef}.${qIdent('store_key')}
        AND freshness_parent.${qIdent(freshnessParent.keyColumn)}=${stageRef}.${qIdent(freshnessParent.keyColumn)}
        AND freshness_parent.${qIdent(freshnessColumn)} > ${stageRef}.${qIdent(freshnessColumn)})`
    : '';
  const conflictGuard = freshnessColumn
    ? `\nWHERE freshness_target.${qIdent(freshnessColumn)} IS NULL OR EXCLUDED.${qIdent(freshnessColumn)} >= freshness_target.${qIdent(freshnessColumn)}`
    : '';
  let script = '';
  script += `CREATE TEMP TABLE ${stageRef} (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY ${stageRef} (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map((c) => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} AS freshness_target (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM ${stageRef}\n${sourceGuard}\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet}${conflictGuard};\n`;
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
      columns: ['order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','allocate_time','site','order_status','order_status_desc','perform_status','perform_status_desc','source_file','raw_summary','source_snapshot_at'],
      conflictColumns: ['order_key'],
      rows: sales.orders,
      freshnessColumn: 'source_snapshot_at',
    },
    {
      table: 'fact.openapi_order_item',
      columns: ['order_item_key','order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','site','standard_goods_sn','raw_goods_sn','goods_id','entity_id','skc','sku_code','sku_sn','sku_suffix','goods_title','quantity','currency_code','currency_price','sales_sar','sales_rmb','goods_status','goods_performance_status','goods_performance_status_desc','source_file','raw_summary','source_snapshot_at'],
      conflictColumns: ['order_item_key'],
      rows: sales.items,
      freshnessColumn: 'source_snapshot_at',
      freshnessParent: {table: 'fact.openapi_order_header', keyColumn: 'order_no'},
    },
    {
      table: OPENAPI_ORDER_PAYMENT_FLAG_TABLE,
      columns: [...ORDER_PAYMENT_FLAG_COLUMNS, 'source_snapshot_at'],
      conflictColumns: ['order_key'],
      rows: sales.paymentFlags,
      freshnessColumn: 'source_snapshot_at',
      freshnessParent: {table: 'fact.openapi_order_header', keyColumn: 'order_no'},
    },
    {
      table: 'mart.openapi_sales_reconciliation',
      columns: ['date','store_key','browser_source_file','api_source_file','browser_order_count','api_order_count','browser_positive_order_count','api_positive_order_count','browser_goods_line_count','api_goods_line_count','browser_quantity_positive_amount','api_quantity_positive_amount','browser_sales_sar','api_sales_sar','order_count_delta','positive_order_count_delta','goods_line_count_delta','quantity_positive_delta','sales_sar_delta','browser_only_order_count','api_only_order_count','browser_only_goods_count','api_only_goods_count','browser_invalid_goods_line_count','api_invalid_goods_line_count','browser_invalid_sales_sar','api_invalid_sales_sar','invalid_goods_line_count_delta','invalid_sales_sar_delta','business_line_diff_count','scatter_point_diff_count','order_time_diff_count','cod_diff_count','metadata_diff_count','status_diff_count','identity_overlay_required','status','generated_at','raw_summary'],
      conflictColumns: ['date','store_key'],
      rows: sales.reconciliations,
    },
  ];
}

export function buildOpenApiSalesAtomicSql(sales) {
  let script = 'BEGIN;\n';
  script += `${buildStoreLoadLocksSql(sales.pairs)}\n`;
  script += buildCleanupSql(sales.pairs);
  const results = [];
  for (const spec of openApiSalesLoadSpecs(sales)) {
    const built = buildUpsertRowsSql(spec.table, spec.columns, spec.conflictColumns, spec.rows, spec);
    script += built.script;
    results.push(built.result);
  }
  script += 'COMMIT;\n';
  return {script, results};
}

async function loadOpenApiSalesAtomically(args, sales) {
  const cleanup = args.dryRun ? {pairs: sales.pairs.length, dryRun: true} : {pairs: sales.pairs.length};
  const built = buildOpenApiSalesAtomicSql(sales);
  const results = args.dryRun ? built.results.map(result => ({...result, dryRun: true})) : built.results;
  if (args.dryRun) return {cleanup, results};
  await runPsqlScript(args, built.script);
  return {cleanup, results};
}

export function buildFactRows(data, file) {
  const date = data.start || data.date || path.basename(file, '.json');
  const source = rel(file);
  const snapshotAt = sourceSnapshotAt(data, `${data?.storeKey || 'unknown store'} OpenAPI sales artifact`);
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
    fetch_time: snapshotAt,
    source_file: source,
    raw_summary: compactJson(summary),
  }];
  const orders = [];
  const items = [];
  const paymentFlags = extractPaymentFlagsFromSalesArtifact(data, {
    date,
    sourceFile: source,
    sourceKind: 'openapi',
  }).map(row => ({...row, source_snapshot_at: snapshotAt}));
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
      source_snapshot_at: snapshotAt,
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
      source_snapshot_at: snapshotAt,
    });
  }
  return {date, sourceSnapshotAt: snapshotAt, daily, orders, items, paymentFlags};
}

function summarizeArtifact(data) {
  const summary = recalculateSummaryFromGoodsRows(data, data?.summary || {});
  const goodsRows = asArray(data?.goodsRows);
  const invalidRows = goodsRows.filter((row) => !isValidSalesGoodsRow(row));
  return {
    orderCount: Number(summary.orderRefCount || summary.apiCount || 0),
    positiveOrderCount: Number(summary.positiveAmountOrderCount || 0),
    goodsLineCount: Number(summary.goodsLineCount || 0),
    quantityPositiveAmount: Number(summary.quantityPositiveAmount || 0),
    salesSar: round2(summary.salesSar || 0),
    invalidGoodsLineCount: invalidRows.length,
    invalidSalesSar: round2(invalidRows.reduce((sum, row) => sum + Number(row?.currencyPrice || 0), 0)),
    orderNos: [
      ...asArray(data?.orderRows).map((r) => r?.orderNo || r?.billno || r?.billNo),
      ...goodsRows.map((r) => r?.orderNo || r?.billno || r?.billNo),
      ...asArray(data?.orders).map((r) => r?.orderNo || r?.billno || r?.billNo),
      ...asArray(data?.orderRefs).map((r) => r?.orderNo || r?.billno || r?.billNo),
    ].map((value) => String(value || '')).filter(Boolean).sort(),
    goodsIds: goodsRows.map((r) => String(r?.goodsId || '')).filter(Boolean).sort(),
    fetchTime: data?.fetchTime || null,
  };
}

function jsonRowsLiteral(rows) {
  const normalized = rows.map((row) => {
    const copy = {...row};
    for (const key of ['raw_summary', 'raw_evidence']) {
      if (typeof copy[key] !== 'string') continue;
      try { copy[key] = JSON.parse(copy[key]); } catch { /* A jsonb scalar remains valid. */ }
    }
    return copy;
  });
  return `${sqlLiteral(JSON.stringify(normalized))}::jsonb`;
}

function assertTargetedSalesRows(rows, storeKey, orderNo) {
  const normalizedStore = String(storeKey || '').trim().toUpperCase();
  const normalizedOrderNo = String(orderNo || '').trim();
  if (!normalizedStore || !normalizedOrderNo) throw new Error('targeted sales upsert requires storeKey and orderNo');
  for (const row of rows) {
    if (String(row.store_key || '').toUpperCase() !== normalizedStore || String(row.order_no || '') !== normalizedOrderNo) {
      throw new Error(`targeted sales row escaped requested scope ${normalizedStore}/${normalizedOrderNo}`);
    }
  }
  return {storeKey: normalizedStore, orderNo: normalizedOrderNo};
}

/**
 * Build a single-order transaction.  It deliberately excludes daily summaries,
 * reconciliation.  It removes only this order's replaceable detail rows
 * before upserting, never a same-day slice.
 */
export function buildTargetedOpenApiSalesUpsertSql({artifact, file = 'webhook://order-detail', storeKey, orderNo}) {
  const scope = assertTargetedSalesRows([], storeKey, orderNo);
  if (String(artifact?.storeKey || '').trim().toUpperCase() !== scope.storeKey) throw new Error(`Store mismatch: expected ${scope.storeKey}, got ${artifact?.storeKey || '-'}`);
  const rows = buildFactRows(artifact, file);
  const orders = rows.orders.filter((row) => String(row.order_no || '') === scope.orderNo);
  const items = rows.items.filter((row) => String(row.order_no || '') === scope.orderNo);
  const paymentFlags = rows.paymentFlags.filter((row) => String(row.order_no || '') === scope.orderNo);
  assertTargetedSalesRows(orders, scope.storeKey, scope.orderNo);
  assertTargetedSalesRows(items, scope.storeKey, scope.orderNo);
  assertTargetedSalesRows(paymentFlags, scope.storeKey, scope.orderNo);
  if (orders.length !== 1) throw new Error(`Expected exactly one order header for ${scope.storeKey}/${scope.orderNo}, got ${orders.length}`);
  if (items.length < 1) throw new Error(`Refusing targeted order replacement for ${scope.storeKey}/${scope.orderNo}: item detail is empty`);
  const targeted = {orders, items, paymentFlags};
  const specs = openApiSalesLoadSpecs({daily: [], ...targeted, reconciliations: []}).filter((spec) => spec.rows.length || ['fact.openapi_order_header'].includes(spec.table));
  const results = specs.map((spec) => ({table: spec.table, inputRows: spec.rows.length, rows: spec.rows.length}));
  const script = `BEGIN;
SELECT * FROM ops.apply_shein_webhook_order_snapshot(
  ${sqlLiteral(scope.storeKey)},
  ${sqlLiteral(scope.orderNo)},
  ${sqlLiteral(rows.sourceSnapshotAt)}::timestamptz,
  ${jsonRowsLiteral(orders)},
  ${jsonRowsLiteral(items)},
  ${jsonRowsLiteral(paymentFlags)}
);
COMMIT;
`;
  return {scope, script, results, rowCounts: {headers: orders.length, items: items.length, paymentFlags: paymentFlags.length, sourceSnapshotAt: rows.sourceSnapshotAt}};
}

export async function upsertTargetedOpenApiSales(args, input, {executor = runPsqlScript} = {}) {
  const built = buildTargetedOpenApiSalesUpsertSql(input);
  if (args?.dryRun) return {...built, dryRun: true};
  await executor(args, built.script);
  return built;
}

export function buildTargetedOpenApiSalesReadbackSql({storeKey, orderNo}) {
  const scope = assertTargetedSalesRows([], storeKey, orderNo);
  return `SELECT json_build_object('storeKey', ${sqlLiteral(scope.storeKey)}, 'orderNo', ${sqlLiteral(scope.orderNo)}, 'sourceSnapshotAt', (SELECT max(source_snapshot_at) FROM fact.openapi_order_header WHERE store_key = ${sqlLiteral(scope.storeKey)} AND order_no = ${sqlLiteral(scope.orderNo)}), 'headers', (SELECT count(*) FROM fact.openapi_order_header WHERE store_key = ${sqlLiteral(scope.storeKey)} AND order_no = ${sqlLiteral(scope.orderNo)}), 'items', (SELECT count(*) FROM fact.openapi_order_item WHERE store_key = ${sqlLiteral(scope.storeKey)} AND order_no = ${sqlLiteral(scope.orderNo)}), 'paymentFlags', (SELECT count(*) FROM ${OPENAPI_ORDER_PAYMENT_FLAG_TABLE} WHERE store_key = ${sqlLiteral(scope.storeKey)} AND order_no = ${sqlLiteral(scope.orderNo)}))::text;\n`;
}

export async function readbackTargetedOpenApiSales(args, scope, expectedRowCounts, {executor = runPsqlScript} = {}) {
  const out = await executor(args, buildTargetedOpenApiSalesReadbackSql(scope));
  const line = String(out.stdout || '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.startsWith('{'));
  if (!line) throw new Error(`Missing targeted order readback for ${scope.storeKey}/${scope.orderNo}`);
  const result = JSON.parse(line);
  const expected = expectedRowCounts || {};
  const actualSnapshotMs = Date.parse(result.sourceSnapshotAt || '');
  const expectedSnapshotMs = Date.parse(expected.sourceSnapshotAt || '');
  if (!Number.isFinite(actualSnapshotMs) || !Number.isFinite(expectedSnapshotMs)) {
    throw new Error(`Targeted order readback has no valid source snapshot for ${scope.storeKey}/${scope.orderNo}`);
  }
  if (actualSnapshotMs > expectedSnapshotMs) return {...result, superseded: true};
  if (actualSnapshotMs !== expectedSnapshotMs) {
    throw new Error(`Targeted order readback snapshot mismatch for ${scope.storeKey}/${scope.orderNo}: actual=${result.sourceSnapshotAt}, expected=${expected.sourceSnapshotAt}`);
  }
  for (const key of ['headers', 'items', 'paymentFlags']) {
    if (Number(result[key]) !== Number(expected[key])) {
      throw new Error(`Targeted order readback failed for ${scope.storeKey}/${scope.orderNo}: ${key}=${result[key]}, expected=${expected[key]}`);
    }
  }
  return result;
}

function setDiff(left, right) {
  return [...left].filter((x) => !right.has(x));
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function canonicalNumber(value, digits = 6) {
  const number = num(value) ?? 0;
  const scale = 10 ** digits;
  return Math.round((number + Number.EPSILON) * scale) / scale;
}

function canonicalGoodsSn(row) {
  const raw = cleanText(row?.goodsSn || row?.standardGoodsSn || row?.standard_goods_sn);
  const details = normalizeGoodsSnDetailed(raw, {
    goodsTitle: row?.goodsTitle || row?.goodsName || row?.goods_title || '',
  });
  return cleanText(details.canonical || raw);
}

function canonicalExclusion(row) {
  if (isValidSalesGoodsRow(row)) return '';
  const reason = cleanText(salesExclusionReason(row)).toLowerCase();
  if (reason.includes('cancel')) return 'cancelled';
  const statusText = [
    row?.pageStatus,
    row?.pageStatusDesc,
    row?.goodsPerformanceStatusDesc,
    row?.orderStatusDesc,
    row?.performStatusDesc,
  ].map(cleanText).join(' ');
  if (/cancel|取消/i.test(statusText)) return 'cancelled';
  if (canonicalNumber(row?.number ?? row?.quantity) <= 0) return 'non_positive_quantity';
  if (canonicalNumber(row?.currencyPrice) <= 0) return 'non_positive_amount';
  if (row?.isValidSale === false || cleanText(row?.isValidSale).toLowerCase() === 'false') return 'explicit_invalid';
  return reason || 'invalid';
}

function orderNoOf(row) {
  return cleanText(row?.orderNo || row?.billno || row?.billNo || row?.orderId || row?.id);
}

function normalizeBusinessTime(value) {
  const text = cleanText(value);
  if (!text) return '';
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return text;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] || '00'}`;
}

function goodsRowBusinessTime(row) {
  return normalizeBusinessTime(row?.orderCreateTime || row?.allocateTimeFull || row?.allocateTime);
}

function businessLineKey(row) {
  const valid = isValidSalesGoodsRow(row);
  return JSON.stringify([
    orderNoOf(row),
    cleanText(row?.goodsId),
    canonicalGoodsSn(row),
    cleanText(row?.skcName || row?.skc),
    cleanText(row?.skuCode || row?.sku_code),
    canonicalNumber(row?.number ?? row?.quantity),
    cleanText(row?.currencyCode || row?.currency_code).toUpperCase(),
    valid ? round2(row?.currencyPrice) : 0,
    valid,
    canonicalExclusion(row),
  ]);
}

function scatterPointKey(row) {
  const quantity = canonicalNumber(row?.number ?? row?.quantity);
  const amount = round2(row?.currencyPrice);
  return JSON.stringify([
    orderNoOf(row),
    cleanText(row?.goodsId),
    canonicalGoodsSn(row),
    cleanText(row?.skcName || row?.skc),
    goodsRowBusinessTime(row),
    quantity,
    amount,
    quantity > 0 ? canonicalNumber(amount / quantity) : 0,
  ]);
}

function statusLineKey(row) {
  return JSON.stringify([
    orderNoOf(row),
    cleanText(row?.goodsId),
    canonicalGoodsSn(row),
    cleanText(row?.skcName || row?.skc),
    cleanText(row?.skuCode || row?.sku_code),
    cleanText(row?.orderStatus),
    cleanText(row?.orderStatusDesc),
    cleanText(row?.performStatus),
    cleanText(row?.performStatusDesc),
    cleanText(row?.newOrderGoodsStatus),
    cleanText(row?.goodsPerformanceStatus),
    cleanText(row?.goodsPerformanceStatusDesc),
  ]);
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function compareMultisets(browserValues, apiValues, exampleLimit = 6) {
  const browser = multiset(browserValues);
  const api = multiset(apiValues);
  const keys = [...new Set([...browser.keys(), ...api.keys()])].sort();
  let diffCount = 0;
  const examples = [];
  for (const key of keys) {
    const browserCount = browser.get(key) || 0;
    const apiCount = api.get(key) || 0;
    if (browserCount === apiCount) continue;
    diffCount += Math.abs(browserCount - apiCount);
    if (examples.length < exampleLimit) examples.push({key, browserCount, apiCount});
  }
  return {diffCount, examples};
}

function orderTimeKeys(data) {
  const byOrder = new Map();
  const add = (row) => {
    const orderNo = orderNoOf(row);
    const time = goodsRowBusinessTime(row);
    if (!orderNo || !time) return;
    if (!byOrder.has(orderNo)) byOrder.set(orderNo, new Set());
    byOrder.get(orderNo).add(time);
  };
  for (const row of asArray(data?.goodsRows)) add(row);
  for (const row of asArray(data?.orderRows)) add(row);
  return [...byOrder.entries()]
    .flatMap(([orderNo, times]) => [...times].map((time) => JSON.stringify([orderNo, time])))
    .sort();
}

function codKeys(data, sourceKind) {
  return extractPaymentFlagsFromSalesArtifact(data, {
    date: data?.start || data?.date || '',
    sourceKind,
  }).map((row) => JSON.stringify([
    cleanText(row?.order_no),
    row?.is_cod === true ? true : row?.is_cod === false ? false : null,
  ])).sort();
}

function metadataValues(data) {
  return [
    cleanText(data?.storeKey || data?.store_key).toUpperCase(),
    cleanText(data?.groupKey || data?.group_key),
    cleanText(data?.shopName || data?.shop_name),
  ];
}

function identityOverlayRequired(browserData, apiData) {
  const browserOrders = asArray(browserData?.orderRows);
  const apiOrders = asArray(apiData?.orderRows);
  const browserGoods = asArray(browserData?.goodsRows);
  const apiGoods = asArray(apiData?.goodsRows);
  const hasInternalOrderId = (rows) => rows.some((row) => {
    const id = cleanText(row?.orderId || row?.id);
    return id && id !== orderNoOf(row);
  });
  return (hasInternalOrderId(browserOrders) && !hasInternalOrderId(apiOrders))
    || (browserGoods.some((row) => cleanText(row?.entityId)) && !apiGoods.some((row) => cleanText(row?.entityId)))
    || (browserGoods.some((row) => cleanText(row?.suffix)) && !apiGoods.some((row) => cleanText(row?.suffix)));
}

function compactArtifactSummary(summary) {
  if (!summary) return null;
  const {orderNos, goodsIds, ...rest} = summary;
  return {
    ...rest,
    distinctOrderNoCount: new Set(orderNos).size,
    distinctGoodsIdCount: new Set(goodsIds).size,
  };
}

export function compareSalesArtifacts(browserData, apiData) {
  const api = summarizeArtifact(apiData || {});
  if (!browserData) return {matched: false, browser: null, api, deltas: null, quality: null};
  const browser = summarizeArtifact(browserData);
  const browserOrderSet = new Set(browser.orderNos);
  const apiOrderSet = new Set(api.orderNos);
  const browserGoodsSet = new Set(browser.goodsIds);
  const apiGoodsSet = new Set(api.goodsIds);
  const deltas = {
    orderCount: api.orderCount - browser.orderCount,
    positiveOrderCount: api.positiveOrderCount - browser.positiveOrderCount,
    goodsLineCount: api.goodsLineCount - browser.goodsLineCount,
    quantityPositiveAmount: api.quantityPositiveAmount - browser.quantityPositiveAmount,
    salesSar: round2(api.salesSar - browser.salesSar),
    browserOnlyOrderCount: setDiff(browserOrderSet, apiOrderSet).length,
    apiOnlyOrderCount: setDiff(apiOrderSet, browserOrderSet).length,
    browserOnlyGoodsCount: setDiff(browserGoodsSet, apiGoodsSet).length,
    apiOnlyGoodsCount: setDiff(apiGoodsSet, browserGoodsSet).length,
    invalidGoodsLineCount: api.invalidGoodsLineCount - browser.invalidGoodsLineCount,
    invalidSalesSar: round2(api.invalidSalesSar - browser.invalidSalesSar),
  };
  const browserGoodsRows = asArray(browserData?.goodsRows);
  const apiGoodsRows = asArray(apiData?.goodsRows);
  const businessLines = compareMultisets(
    browserGoodsRows.map(businessLineKey),
    apiGoodsRows.map(businessLineKey),
  );
  const scatterPoints = compareMultisets(
    browserGoodsRows.filter(isValidSalesGoodsRow).map(scatterPointKey),
    apiGoodsRows.filter(isValidSalesGoodsRow).map(scatterPointKey),
  );
  const orderTimes = compareMultisets(orderTimeKeys(browserData), orderTimeKeys(apiData));
  const codFlags = compareMultisets(codKeys(browserData, 'browser_webapi'), codKeys(apiData, 'openapi'));
  const metadataDiffCount = metadataValues(browserData)
    .filter((value, index) => value !== metadataValues(apiData)[index]).length;
  const statuses = compareMultisets(
    browserGoodsRows.map(statusLineKey),
    apiGoodsRows.map(statusLineKey),
  );
  const quality = {
    businessLineDiffCount: businessLines.diffCount,
    scatterPointDiffCount: scatterPoints.diffCount,
    orderTimeDiffCount: orderTimes.diffCount,
    codDiffCount: codFlags.diffCount,
    metadataDiffCount,
    statusDiffCount: statuses.diffCount,
    identityOverlayRequired: identityOverlayRequired(browserData, apiData),
    examples: {
      businessLines: businessLines.examples,
      scatterPoints: scatterPoints.examples,
      orderTimes: orderTimes.examples,
      codFlags: codFlags.examples,
      statuses: statuses.examples,
    },
  };
  const matched = Object.values(deltas).every((value) => value === 0)
    && quality.businessLineDiffCount === 0
    && quality.scatterPointDiffCount === 0
    && quality.orderTimeDiffCount === 0
    && quality.codDiffCount === 0
    && quality.metadataDiffCount === 0;
  return {matched, browser, api, deltas, quality};
}

async function buildReconciliationRow(args, date, apiFile, apiData) {
  const browserFile = path.join(args.browserDir, args.store, `${date}.json`);
  const browserExists = fssync.existsSync(browserFile);
  const browserData = browserExists ? await readJson(browserFile) : null;
  const comparison = compareSalesArtifacts(browserData, apiData);
  const {browser, api, deltas, quality, matched} = comparison;
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
    browser_invalid_goods_line_count: browser?.invalidGoodsLineCount ?? null,
    api_invalid_goods_line_count: api.invalidGoodsLineCount,
    browser_invalid_sales_sar: browser?.invalidSalesSar ?? null,
    api_invalid_sales_sar: api.invalidSalesSar,
    invalid_goods_line_count_delta: deltas?.invalidGoodsLineCount ?? null,
    invalid_sales_sar_delta: deltas?.invalidSalesSar ?? null,
    business_line_diff_count: quality?.businessLineDiffCount ?? null,
    scatter_point_diff_count: quality?.scatterPointDiffCount ?? null,
    order_time_diff_count: quality?.orderTimeDiffCount ?? null,
    cod_diff_count: quality?.codDiffCount ?? null,
    metadata_diff_count: quality?.metadataDiffCount ?? null,
    status_diff_count: quality?.statusDiffCount ?? null,
    identity_overlay_required: quality?.identityOverlayRequired ?? null,
    status,
    generated_at: new Date().toISOString(),
    raw_summary: compactJson({
      browser: compactArtifactSummary(browser),
      api: compactArtifactSummary(api),
      deltas,
      quality,
      browserFetchTime: browser?.fetchTime || null,
      apiFetchTime: api.fetchTime || null,
    }),
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
    pairs.push({date: factRows.date, store: args.store, sourceSnapshotAt: factRows.sourceSnapshotAt});
  }
  return {daily, orders, items, paymentFlags, reconciliations, loadedFiles, pairs};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ensureOnly) {
    const ensure = await ensureOpenApiTables(args);
    console.log(JSON.stringify({ok: true, ensureOnly: true, ensure}, null, 2));
    return;
  }
  const sales = await collectOpenApiSales(args);
  const ensure = args.skipEnsure
    ? {skipped: true, reason: 'orchestrator_completed_schema_ensure'}
    : await ensureOpenApiTables(args);
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
      invalidGoodsLineCountDelta: r.invalid_goods_line_count_delta,
      invalidSalesSarDelta: r.invalid_sales_sar_delta,
      businessLineDiffCount: r.business_line_diff_count,
      scatterPointDiffCount: r.scatter_point_diff_count,
      orderTimeDiffCount: r.order_time_diff_count,
      codDiffCount: r.cod_diff_count,
      metadataDiffCount: r.metadata_diff_count,
      statusDiffCount: r.status_diff_count,
      identityOverlayRequired: r.identity_overlay_required,
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
