#!/usr/bin/env node
/**
 * Load SHEIN OpenAPI return-order artifacts into isolated parallel warehouse tables.
 *
 * It does not modify fact.after_sales_item or any production browser facts.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPENAPI_RETURN_ORDER_TABLE = 'fact.openapi_return_order';
const OPENAPI_RETURN_ITEM_TABLE = 'fact.openapi_return_item';
const OPENAPI_RETURN_RECONCILIATION_TABLE = 'mart.openapi_return_reconciliation';

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    store: '',
    returnsDir: path.join(ROOT, 'outputs', 'shein_openapi_returns'),
    dryRun: false,
    skipEnsure: false,
    ensureOnly: false,
    dates: [],
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--store') args.store = String(argv[++i] || '').toUpperCase();
    else if (a === '--returns-dir') args.returnsDir = path.resolve(argv[++i]);
    else if (a === '--date') args.dates.push(argv[++i]);
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-ensure') args.skipEnsure = true;
    else if (a === '--ensure-only') args.ensureOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/load_shein_openapi_returns_warehouse.mjs --store DL --date 2026-06-24
  node scripts/load_shein_openapi_returns_warehouse.mjs DL --start 2026-06-01 --end 2026-06-07

Loads outputs/shein_openapi_returns/<STORE>/<DATE>.json into isolated OpenAPI
return facts and API-vs-browser after-sales reconciliation rows.`);
      process.exit(0);
    } else rest.push(a);
  }
  if (!args.store && rest[0]) args.store = String(rest[0]).toUpperCase();
  if (args.start) {
    if (!args.end) args.end = args.start;
    for (const date of eachDate(args.start, args.end)) args.dates.push(date);
  }
  args.dates = [...new Set(args.dates)].sort();
  if (!args.store) throw new Error('Missing store key. Use --store DL or positional DL.');
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

function datePart(v) {
  const t = ts(v);
  return t ? t.slice(0, 10) : null;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
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
  return `${values.map(csvEscape).join(',')}\n`;
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
    ? ['-d', args.distro, '--', 'bash', '-lc', `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`]
    : command === 'sudo'
      ? ['-n', 'docker', 'exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1']
      : ['exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1'];
  const child = spawn(command, commandArgs, {cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (d) => stdoutChunks.push(Buffer.from(d)));
  child.stderr.on('data', (d) => stderrChunks.push(Buffer.from(d)));
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (code !== 0) throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  return {stdout, stderr};
}

async function ensureOpenApiReturnTables(args) {
  const script = `
BEGIN;
CREATE TABLE IF NOT EXISTS fact.openapi_return_order (
  return_order_key text PRIMARY KEY,
  ret_order_date date NOT NULL,
  store_key text NOT NULL,
  group_key text,
  shop_name text,
  return_order_no text NOT NULL,
  aftersales_order_no text,
  order_no text,
  site text,
  return_order_status text,
  return_order_status_name text,
  no_return_goods_sign text,
  return_order_tag_code text,
  shipping_code text,
  platform_express_no text,
  member_express_no text,
  express_company_name text,
  refund_order_nos text,
  refund_waybill text,
  refund_express_company_name text,
  performance_cost numeric,
  invoice_status text,
  request_return_time timestamp without time zone,
  add_time timestamp without time zone,
  allocate_time timestamp without time zone,
  last_update_time timestamp without time zone,
  seller_signed_time timestamp without time zone,
  cancel_time timestamp without time zone,
  completed_time timestamp without time zone,
  check_status text,
  stock_mode text,
  receive_type text,
  source_file text,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openapi_return_order_store_date_idx ON fact.openapi_return_order (store_key, ret_order_date);
CREATE INDEX IF NOT EXISTS openapi_return_order_order_no_idx ON fact.openapi_return_order (store_key, order_no);
CREATE INDEX IF NOT EXISTS openapi_return_order_return_no_idx ON fact.openapi_return_order (store_key, return_order_no);

CREATE TABLE IF NOT EXISTS fact.openapi_return_item (
  return_item_key text PRIMARY KEY,
  return_order_key text NOT NULL,
  ret_order_date date NOT NULL,
  store_key text NOT NULL,
  group_key text,
  shop_name text,
  return_order_no text NOT NULL,
  order_no text,
  site text,
  standard_goods_sn text,
  raw_goods_sn text,
  goods_id text,
  entity_id text,
  skc text,
  sku text,
  sku_sn text,
  sku_suffix text,
  goods_title text,
  goods_status text,
  quantity numeric,
  currency_code text,
  sale_currency text,
  seller_currency_price numeric,
  cost_price numeric,
  seller_currency_store_coupon_price numeric,
  seller_currency_promotion_price numeric,
  settle_currency_promotion_price numeric,
  performance_price numeric,
  return_expense numeric,
  return_freight_subsidy numeric,
  seller_real_tax numeric,
  estimate_income_money numeric,
  estimate_tax_income_money numeric,
  amount_sar numeric,
  return_reason_cn text,
  return_reason_en text,
  source_file text,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openapi_return_item_store_date_idx ON fact.openapi_return_item (store_key, ret_order_date);
CREATE INDEX IF NOT EXISTS openapi_return_item_goods_idx ON fact.openapi_return_item (standard_goods_sn, store_key);
CREATE INDEX IF NOT EXISTS openapi_return_item_order_no_idx ON fact.openapi_return_item (store_key, order_no);

CREATE TABLE IF NOT EXISTS mart.openapi_return_reconciliation (
  date date NOT NULL,
  store_key text NOT NULL,
  browser_source text,
  api_source_file text,
  browser_case_count integer,
  api_case_count integer,
  browser_item_count integer,
  api_item_count integer,
  browser_quantity numeric,
  api_quantity numeric,
  browser_amount_sar numeric,
  api_amount_sar numeric,
  case_count_delta integer,
  item_count_delta integer,
  quantity_delta numeric,
  amount_sar_delta numeric,
  browser_only_return_count integer,
  api_only_return_count integer,
  browser_only_order_count integer,
  api_only_order_count integer,
  status text NOT NULL,
  warnings text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (date, store_key)
);
COMMIT;
`;
  if (args.dryRun) return {skipped: true, dryRun: true};
  await runPsqlScript(args, script);
  return {ok: true};
}

function buildCleanupSql(pairs) {
  const tupleList = pairs.map((p) => `(${sqlLiteral(p.date)}::date, ${sqlLiteral(p.store)})`).join(', ');
  return `DELETE FROM ${OPENAPI_RETURN_ITEM_TABLE} WHERE (ret_order_date, store_key) IN (${tupleList});\nDELETE FROM ${OPENAPI_RETURN_ORDER_TABLE} WHERE (ret_order_date, store_key) IN (${tupleList});\nDELETE FROM ${OPENAPI_RETURN_RECONCILIATION_TABLE} WHERE (date, store_key) IN (${tupleList});\n`;
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

function returnLoadSpecs(data) {
  return [
    {
      table: OPENAPI_RETURN_ORDER_TABLE,
      columns: ['return_order_key','ret_order_date','store_key','group_key','shop_name','return_order_no','aftersales_order_no','order_no','site','return_order_status','return_order_status_name','no_return_goods_sign','return_order_tag_code','shipping_code','platform_express_no','member_express_no','express_company_name','refund_order_nos','refund_waybill','refund_express_company_name','performance_cost','invoice_status','request_return_time','add_time','allocate_time','last_update_time','seller_signed_time','cancel_time','completed_time','check_status','stock_mode','receive_type','source_file','raw_summary'],
      conflictColumns: ['return_order_key'],
      rows: data.orders,
    },
    {
      table: OPENAPI_RETURN_ITEM_TABLE,
      columns: ['return_item_key','return_order_key','ret_order_date','store_key','group_key','shop_name','return_order_no','order_no','site','standard_goods_sn','raw_goods_sn','goods_id','entity_id','skc','sku','sku_sn','sku_suffix','goods_title','goods_status','quantity','currency_code','sale_currency','seller_currency_price','cost_price','seller_currency_store_coupon_price','seller_currency_promotion_price','settle_currency_promotion_price','performance_price','return_expense','return_freight_subsidy','seller_real_tax','estimate_income_money','estimate_tax_income_money','amount_sar','return_reason_cn','return_reason_en','source_file','raw_summary'],
      conflictColumns: ['return_item_key'],
      rows: data.items,
    },
    {
      table: OPENAPI_RETURN_RECONCILIATION_TABLE,
      columns: ['date','store_key','browser_source','api_source_file','browser_case_count','api_case_count','browser_item_count','api_item_count','browser_quantity','api_quantity','browser_amount_sar','api_amount_sar','case_count_delta','item_count_delta','quantity_delta','amount_sar_delta','browser_only_return_count','api_only_return_count','browser_only_order_count','api_only_order_count','status','warnings','generated_at','raw_summary'],
      conflictColumns: ['date','store_key'],
      rows: data.reconciliations,
    },
  ];
}

async function loadOpenApiReturnsAtomically(args, data) {
  const cleanup = args.dryRun ? {pairs: data.pairs.length, dryRun: true} : {pairs: data.pairs.length};
  let script = 'BEGIN;\n';
  script += buildCleanupSql(data.pairs);
  const results = [];
  for (const spec of returnLoadSpecs(data)) {
    const built = buildUpsertRowsSql(spec.table, spec.columns, spec.conflictColumns, spec.rows);
    script += built.script;
    results.push(args.dryRun ? {...built.result, dryRun: true} : built.result);
  }
  script += 'COMMIT;\n';
  if (args.dryRun) return {cleanup, results};
  await runPsqlScript(args, script);
  return {cleanup, results};
}

function reasonByLanguage(item, lang) {
  const found = asArray(item.returnReasonList).find((r) => String(r.language || '').toUpperCase() === lang && r.reason);
  return found?.reason || '';
}

function attrSuffix(item) {
  const attrs = asArray(item.commodityAttributeList);
  const cn = attrs.find((a) => String(a.language || '').toUpperCase() === 'CN' && a.attrName && a.attrName !== '-');
  const us = attrs.find((a) => String(a.language || '').toUpperCase() === 'US' && a.attrName && a.attrName !== '-');
  return cn?.attrName || us?.attrName || '';
}

function amountSar(item) {
  // Align the OpenAPI parallel layer with the existing BI after-sales amount
  //口径：售后金额按预计收入扣掉履约/绩效成本，避免把原始退款额和 BI 净额混在一起对账。
  const gross = num(item.estimateIncomeMoney ?? item.estimateTaxIncomeMoney);
  if (gross === null) return null;
  const performance = num(item.performancePrice) ?? 0;
  return round2(gross - performance);
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function itemKeyPart(item, idx) {
  const stable = firstNonEmpty(item.goodsId, item.entityId, item.skuSn);
  if (stable) return stable;
  return `h${shortHash(`${item.sku || ''}|${item.skc || ''}|${item.goodsTitle || ''}|${idx}`)}`;
}

function buildFactRows(data, file) {
  const source = rel(file);
  const orders = [];
  const items = [];
  const refsByReturnNo = new Map(asArray(data.returnOrderRefs)
    .map((row) => [String(row.returnOrderNo || '').trim(), row])
    .filter(([key]) => key));
  for (const [idx, detail] of asArray(data.returnOrders).entries()) {
    const ref = refsByReturnNo.get(String(detail.returnOrderNo || '').trim()) || asArray(data.returnOrderRefs)[idx] || {};
    const aftersalesOrderNo = firstNonEmpty(detail.aftersalesOrderNo, detail.afterSalesOrderNo, detail.aftersales_order_no, ref.aftersalesOrderNo, ref.afterSalesOrderNo, ref.aftersales_order_no);
    const orderNo = firstNonEmpty(detail.orderNo, ref.orderNo);
    const returnOrderNo = firstNonEmpty(detail.returnOrderNo, ref.returnOrderNo, aftersalesOrderNo, orderNo, `missing_${idx}`);
    const retDate = datePart(detail.requestReturnTime || detail.addTime || ref.requestReturnTime || ref.addTime) || data.start || path.basename(file, '.json');
    const returnOrderKey = `${data.storeKey}__${returnOrderNo || aftersalesOrderNo || orderNo}`;
    orders.push({
      return_order_key: returnOrderKey,
      ret_order_date: retDate,
      store_key: data.storeKey,
      group_key: data.groupKey,
      shop_name: data.shopName,
      return_order_no: returnOrderNo,
      aftersales_order_no: aftersalesOrderNo,
      order_no: orderNo,
      site: detail.site || '',
      return_order_status: detail.returnOrderStatus ?? '',
      return_order_status_name: detail.returnOrderStatusName || (detail.returnOrderStatus == null ? '' : `状态码 ${detail.returnOrderStatus}`),
      no_return_goods_sign: detail.noReturnGoodsSign ?? '',
      return_order_tag_code: detail.returnOrderTagCode ?? '',
      shipping_code: detail.shippingCode || '',
      platform_express_no: detail.platformExpressNo || '',
      member_express_no: detail.memberExpressNo || '',
      express_company_name: detail.expressCompanyName || '',
      refund_order_nos: asArray(detail.refundOrderNos).join(','),
      refund_waybill: detail.refundWaybill || '',
      refund_express_company_name: detail.refundExpressCompanyName || '',
      performance_cost: num(detail.performanceCost),
      invoice_status: detail.invoiceStatus ?? '',
      request_return_time: ts(detail.requestReturnTime),
      add_time: ts(detail.addTime || ref.addTime),
      allocate_time: ts(detail.allocateTime),
      last_update_time: ts(detail.lastUpdateTime || detail.updateTime || ref.updateTime),
      seller_signed_time: ts(detail.sellerSignedTime),
      cancel_time: ts(detail.cancelTime),
      completed_time: ts(detail.completedTime),
      check_status: detail.checkStatus ?? '',
      stock_mode: detail.stockMode ?? '',
      receive_type: detail.receiveType ?? '',
      source_file: source,
      raw_summary: compactJson(detail),
    });
    for (const [gidx, item] of asArray(detail.returnGoodsInfoList).entries()) {
      const rawGoods = item.goodsSn || '';
      const norm = normalizeGoodsSnDetailed(rawGoods, {goodsTitle: item.goodsTitle || ''});
      const standard = norm.canonical || rawGoods;
      const itemAmount = amountSar(item);
      items.push({
        return_item_key: `${data.storeKey}__${returnOrderNo}__${itemKeyPart(item, gidx)}__${gidx}`,
        return_order_key: returnOrderKey,
        ret_order_date: retDate,
        store_key: data.storeKey,
        group_key: data.groupKey,
        shop_name: data.shopName,
        return_order_no: returnOrderNo,
        order_no: orderNo,
        site: detail.site || '',
        standard_goods_sn: standard,
        raw_goods_sn: rawGoods,
        goods_id: item.goodsId || '',
        entity_id: item.entityId || '',
        skc: item.skc || '',
        sku: item.sku || '',
        sku_sn: item.skuSn || '',
        sku_suffix: attrSuffix(item),
        goods_title: item.goodsTitle || '',
        goods_status: item.goodsStatus ?? '',
        quantity: 1,
        currency_code: item.currency || item.saleCurrency || '',
        sale_currency: item.saleCurrency || '',
        seller_currency_price: num(item.sellerCurrencyPrice),
        cost_price: num(item.costPrice),
        seller_currency_store_coupon_price: num(item.sellerCurrencyStoreCouponPrice),
        seller_currency_promotion_price: num(item.sellerCurrencyPromotionPrice),
        settle_currency_promotion_price: num(item.settleCurrencyPromotionPrice),
        performance_price: num(item.performancePrice),
        return_expense: num(item.returnExpense),
        return_freight_subsidy: num(item.returnFreightSubsidy),
        seller_real_tax: num(item.sellerRealTax),
        estimate_income_money: num(item.estimateIncomeMoney),
        estimate_tax_income_money: num(item.estimateTaxIncomeMoney),
        amount_sar: itemAmount,
        return_reason_cn: reasonByLanguage(item, 'CN'),
        return_reason_en: reasonByLanguage(item, 'EN'),
        source_file: source,
        raw_summary: compactJson({returnOrder: detail, goods: item}),
      });
    }
  }
  return {orders, items};
}

function summarizeApi(data, rows) {
  const returnNos = new Set(rows.orders.map((r) => r.return_order_no).filter(Boolean));
  const aftersalesNos = new Set(rows.orders.map((r) => r.aftersales_order_no).filter(Boolean));
  const orderNos = new Set(rows.orders.map((r) => r.order_no).filter(Boolean));
  return {
    caseCount: returnNos.size,
    itemCount: rows.items.length,
    quantity: rows.items.reduce((s, r) => s + Number(r.quantity || 0), 0),
    amountSar: round2(rows.items.reduce((s, r) => s + Number(r.amount_sar || 0), 0)),
    missingAmountCount: rows.items.filter((r) => r.amount_sar === null || r.amount_sar === undefined || r.amount_sar === '').length,
    returnNos,
    aftersalesNos,
    orderNos,
    fetchTime: data.fetchTime || null,
  };
}

function setDiff(left, right) {
  return [...left].filter((x) => !right.has(x));
}

async function queryBrowserAfterSalesSummary(args, date) {
  const script = `
WITH rows AS (
  SELECT *
  FROM fact.after_sales_item
  WHERE store_key = ${sqlLiteral(args.store)}
    AND request_time::date = ${sqlLiteral(date)}::date
    AND coalesce(order_sub_status_name,'') <> '已取消'
), agg AS (
  SELECT
    count(DISTINCT coalesce(nullif(return_order_no,''), nullif(aftersales_order_no,''), after_sales_item_key))::int AS case_count,
    count(*)::int AS item_count,
    coalesce(sum(coalesce(quantity,1)),0)::numeric AS quantity,
    round(coalesce(sum(coalesce(estimated_income_amount, price_amount_total, price_amount,0)),0)::numeric, 2) AS amount_sar,
    coalesce(jsonb_agg(DISTINCT coalesce(nullif(return_order_no,''), nullif(aftersales_order_no,''))) FILTER (WHERE coalesce(nullif(return_order_no,''), nullif(aftersales_order_no,'')) IS NOT NULL), '[]'::jsonb) AS return_nos,
    coalesce(jsonb_agg(DISTINCT aftersales_order_no) FILTER (WHERE coalesce(aftersales_order_no,'') <> ''), '[]'::jsonb) AS aftersales_nos,
    coalesce(jsonb_agg(DISTINCT order_no) FILTER (WHERE coalesce(order_no,'') <> ''), '[]'::jsonb) AS order_nos,
    coalesce(jsonb_agg(DISTINCT source_file) FILTER (WHERE coalesce(source_file,'') <> ''), '[]'::jsonb) AS source_files
  FROM rows
)
SELECT jsonb_build_object(
  'caseCount', case_count,
  'itemCount', item_count,
  'quantity', quantity,
  'amountSar', amount_sar,
  'returnNos', return_nos,
  'orderNos', order_nos,
  'sourceFiles', source_files
)::text
FROM agg;
`;
  const out = await runPsqlScript(args, script);
  const line = out.stdout.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('{'));
  if (!line) return null;
  const j = JSON.parse(line);
  return {
    caseCount: Number(j.caseCount || 0),
    itemCount: Number(j.itemCount || 0),
    quantity: Number(j.quantity || 0),
    amountSar: Number(j.amountSar || 0),
    returnNos: new Set(asArray(j.returnNos).map(String).filter(Boolean)),
    aftersalesNos: new Set(asArray(j.aftersalesNos).map(String).filter(Boolean)),
    orderNos: new Set(asArray(j.orderNos).map(String).filter(Boolean)),
    sourceFiles: asArray(j.sourceFiles).map(String),
  };
}

async function buildReconciliationRow(args, date, apiFile, apiData, factRows) {
  const api = summarizeApi(apiData, factRows);
  const browser = args.dryRun ? null : await queryBrowserAfterSalesSummary(args, date);
  const warnings = [];
  const currencies = new Set(factRows.items.map((r) => r.currency_code).filter(Boolean));
  if (currencies.size > 1) warnings.push(`MULTI_CURRENCY:${[...currencies].join('/')}`);
  const nonSarCurrency = [...currencies].some((c) => c && c !== 'SAR');
  if (nonSarCurrency) warnings.push(`NON_SAR_CURRENCY:${[...currencies].join('/')}`);
  if (api.missingAmountCount) warnings.push(`MISSING_OPENAPI_AMOUNT:${api.missingAmountCount}`);
  const apiBridgeKeys = new Set([...api.returnNos, ...api.aftersalesNos, ...api.orderNos]);
  const browserBridgeKeys = browser ? new Set([...browser.returnNos, ...browser.aftersalesNos, ...browser.orderNos]) : new Set();
  const deltas = browser ? {
    caseCount: api.caseCount - browser.caseCount,
    itemCount: api.itemCount - browser.itemCount,
    quantity: api.quantity - browser.quantity,
    amountSar: nonSarCurrency ? null : round2(api.amountSar - browser.amountSar),
    browserOnlyReturnCount: setDiff(browser.returnNos, api.returnNos).length,
    apiOnlyReturnCount: setDiff(api.returnNos, browser.returnNos).length,
    browserOnlyOrderCount: setDiff(browserBridgeKeys, apiBridgeKeys).length,
    apiOnlyOrderCount: setDiff(apiBridgeKeys, browserBridgeKeys).length,
  } : null;
  const matched = Boolean(deltas
    && deltas.caseCount === 0
    && deltas.itemCount === 0
    && deltas.quantity === 0
    && (nonSarCurrency || api.missingAmountCount || deltas.amountSar === 0)
    && deltas.browserOnlyReturnCount === 0
    && deltas.apiOnlyReturnCount === 0
    && deltas.browserOnlyOrderCount === 0
    && deltas.apiOnlyOrderCount === 0
    && !warnings.length);
  const status = !browser ? 'missing_browser' : matched ? 'matched' : 'warning';
  return {
    date,
    store_key: args.store,
    browser_source: browser?.sourceFiles?.join(',') || '',
    api_source_file: rel(apiFile),
    browser_case_count: browser?.caseCount ?? null,
    api_case_count: api.caseCount,
    browser_item_count: browser?.itemCount ?? null,
    api_item_count: api.itemCount,
    browser_quantity: browser?.quantity ?? null,
    api_quantity: api.quantity,
    browser_amount_sar: browser?.amountSar ?? null,
    api_amount_sar: api.amountSar,
    case_count_delta: deltas?.caseCount ?? null,
    item_count_delta: deltas?.itemCount ?? null,
    quantity_delta: deltas?.quantity ?? null,
    amount_sar_delta: deltas?.amountSar ?? null,
    browser_only_return_count: deltas?.browserOnlyReturnCount ?? null,
    api_only_return_count: deltas?.apiOnlyReturnCount ?? null,
    browser_only_order_count: deltas?.browserOnlyOrderCount ?? null,
    api_only_order_count: deltas?.apiOnlyOrderCount ?? null,
    status,
    warnings: warnings.join(';'),
    generated_at: new Date().toISOString(),
    raw_summary: compactJson({
      browser: browser ? {...browser, returnNos: [...browser.returnNos], aftersalesNos: [...browser.aftersalesNos], orderNos: [...browser.orderNos]} : null,
      api: {...api, returnNos: [...api.returnNos], aftersalesNos: [...api.aftersalesNos], orderNos: [...api.orderNos]},
      deltas,
      warnings,
    }),
  };
}

async function collectOpenApiReturns(args) {
  const orders = [];
  const items = [];
  const reconciliations = [];
  const loadedFiles = [];
  const pairs = [];
  for (const date of args.dates) {
    const file = path.join(args.returnsDir, args.store, `${date}.json`);
    if (!fssync.existsSync(file)) throw new Error(`Missing OpenAPI returns file: ${rel(file)}`);
    const data = await readJson(file);
    if (String(data.storeKey || '').toUpperCase() !== args.store) throw new Error(`Store mismatch in ${rel(file)}: expected ${args.store}, got ${data.storeKey}`);
    const factRows = buildFactRows(data, file);
    orders.push(...factRows.orders);
    items.push(...factRows.items);
    reconciliations.push(await buildReconciliationRow(args, date, file, data, factRows));
    loadedFiles.push(rel(file));
    pairs.push({date, store: args.store});
  }
  return {orders, items, reconciliations, loadedFiles, pairs};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ensureOnly) {
    const ensure = await ensureOpenApiReturnTables(args);
    console.log(JSON.stringify({ok: true, dryRun: args.dryRun, storeKey: args.store, ensure}, null, 2));
    return;
  }
  const data = await collectOpenApiReturns(args);
  const ensure = args.skipEnsure ? {skipped: true, reason: 'skip-ensure'} : await ensureOpenApiReturnTables(args);
  const {cleanup, results} = await loadOpenApiReturnsAtomically(args, data);
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    storeKey: args.store,
    dates: args.dates,
    loadedFiles: data.loadedFiles,
    ensure,
    cleanup,
    rowCounts: {
      orders: data.orders.length,
      items: data.items.length,
      reconciliations: data.reconciliations.length,
    },
    reconciliation: data.reconciliations.map((r) => ({
      date: r.date,
      status: r.status,
      warnings: r.warnings,
      browserAmountSar: r.browser_amount_sar,
      apiAmountSar: r.api_amount_sar,
      amountSarDelta: r.amount_sar_delta,
      browserOnlyReturnCount: r.browser_only_return_count,
      apiOnlyReturnCount: r.api_only_return_count,
    })),
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
