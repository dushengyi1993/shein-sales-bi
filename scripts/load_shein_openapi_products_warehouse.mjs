#!/usr/bin/env node
/**
 * Load SHEIN OpenAPI product/link basics into isolated warehouse tables.
 *
 * Isolation boundary:
 * - writes only fact.openapi_product_* and mart.openapi_product_reconciliation;
 * - reads current production link snapshot only for comparison;
 * - never updates fact.link_master_snapshot, inventory, sales or any SHEIN data.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    store: '',
    productDir: path.join(ROOT, 'outputs', 'shein_openapi_products'),
    dryRun: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--product-dir') args.productDir = path.resolve(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/load_shein_openapi_products_warehouse.mjs --store HL

Loads outputs/shein_openapi_products/<STORE>/latest.json into isolated OpenAPI
product tables and writes an API-vs-current-link-snapshot reconciliation row.`);
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  if (!args.store && rest[0]) args.store = String(rest[0] || '').trim().toUpperCase();
  if (!args.store) throw new Error('Missing store key. Use --store HL or positional HL.');
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
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

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

function bool(v) {
  if (v === null || v === undefined || v === '') return null;
  return v ? 't' : 'f';
}

function ts(v) {
  const text = String(v || '').trim();
  return text ? text : null;
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLen) return text;
  return JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

async function runPsqlScript(args, script) {
  const useWsl = process.platform === 'win32';
  const command = useWsl ? 'wsl' : (process.env.SHEIN_BI_DOCKER_COMMAND || 'sudo');
  const commandArgs = useWsl
    ? [
        '-d', args.distro, '--', 'bash', '-lc',
        `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`,
      ]
    : command === 'sudo'
      ? ['-n', 'docker', 'exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1']
      : ['exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1'];
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', d => stdoutChunks.push(Buffer.from(d)));
  child.stderr.on('data', d => stderrChunks.push(Buffer.from(d)));
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return {stdout, stderr};
}

async function ensureOpenApiProductTables(args) {
  const script = `
BEGIN;
CREATE SCHEMA IF NOT EXISTS fact;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE TABLE IF NOT EXISTS fact.openapi_product_link (
  store_key text NOT NULL,
  skc text NOT NULL,
  fetched_at timestamptz NOT NULL,
  source_file text,
  spu text,
  sku_codes text,
  supplier_code text,
  standard_goods_sn text,
  product_name_en text,
  product_name_ar text,
  category_id text,
  product_type_id text,
  brand_code text,
  shelf_status_code text,
  shelf_status_name text,
  first_shelf_time timestamp without time zone,
  last_shelf_time timestamp without time zone,
  last_update_time timestamp without time zone,
  sku_count integer,
  cost_sar numeric,
  cost_cny numeric,
  image_url text,
  shein_usable_inventory numeric,
  shein_inventory_quantity numeric,
  shein_locked_quantity numeric,
  has_detail boolean,
  has_stock boolean,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_key, skc)
);
CREATE INDEX IF NOT EXISTS openapi_product_link_store_supplier_idx ON fact.openapi_product_link (store_key, standard_goods_sn);
CREATE INDEX IF NOT EXISTS openapi_product_link_spu_idx ON fact.openapi_product_link (store_key, spu);
CREATE TABLE IF NOT EXISTS mart.openapi_product_reconciliation (
  store_key text PRIMARY KEY,
  source_file text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  api_link_count integer,
  api_on_shelf_count integer,
  browser_link_count integer,
  browser_on_shelf_count integer,
  matched_skc_count integer,
  api_only_skc_count integer,
  browser_only_skc_count integer,
  status_mismatch_count integer,
  exact_status_mismatch_count integer,
  detail_missing_count integer,
  stock_missing_count integer,
  status text NOT NULL,
  warnings text,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE mart.openapi_product_reconciliation
  ADD COLUMN IF NOT EXISTS exact_status_mismatch_count integer;
ALTER TABLE fact.openapi_product_link
  ADD COLUMN IF NOT EXISTS product_name_ar text;
COMMIT;
`;
  if (args.dryRun) return {skipped: true, dryRun: true};
  await runPsqlScript(args, script);
  return {ok: true};
}

function buildUpsertRowsSql(table, columns, conflictColumns, rows) {
  const result = {table, rows: rows.length};
  if (!rows.length) return {script: '', result};
  if (conflictColumns.length) {
    const byConflict = new Map();
    for (const row of rows) {
      const key = conflictColumns.map(c => String(row[c] ?? '')).join('\u001F');
      byConflict.set(key, row);
    }
    rows = [...byConflict.values()];
    result.rows = rows.length;
  }
  const updateColumns = columns.filter(c => !conflictColumns.includes(c));
  const updateSet = updateColumns.map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`).join(',\n    ');
  const stage = tempName(table);
  const sqlColumns = columns.map(qIdent).join(', ');
  let script = '';
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map(c => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM "${stage}"\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  return {script, result};
}

function statusCodeFromBrowser(row) {
  if (row?.is_on_shelf === true) return '1';
  if (row?.is_wait_shelf === true) return '2';
  if (row?.is_sold_out === true) return '3';
  if (row?.is_out_shelf === true) return '4';
  const name = String(row?.shelf_status_name || '').trim();
  if (name.includes('已上架')) return '1';
  if (name.includes('待上架')) return '2';
  if (name.includes('售罄')) return '3';
  if (name.includes('下架')) return '4';
  return '';
}

function buildProductRows(data, file) {
  const sourceFile = rel(file);
  const byStoreSkc = new Map();
  for (const row of asArray(data.normalizedRows)) {
    const goods = compact(row.supplierCode);
    const detail = normalizeGoodsSnDetailed(goods, {goodsTitle: row.productNameAr || row.productNameEn});
    const key = `${String(row.storeKey || data.storeKey || '').trim().toUpperCase()}\u001F${compact(row.skc)}`;
    if (!key.trim() || byStoreSkc.has(key)) continue;
    byStoreSkc.set(key, {
      store_key: row.storeKey || data.storeKey,
      skc: compact(row.skc),
      fetched_at: row.fetchedAt || data.fetchedAt,
      source_file: sourceFile,
      spu: compact(row.spu),
      sku_codes: asArray(row.skuCodes).map(compact).filter(Boolean).join(' '),
      supplier_code: goods,
      standard_goods_sn: detail.canonical || goods,
      product_name_en: compact(row.productNameEn),
      product_name_ar: compact(row.productNameAr),
      category_id: compact(row.categoryId),
      product_type_id: compact(row.productTypeId),
      brand_code: compact(row.brandCode),
      shelf_status_code: compact(row.shelfStatusCode),
      shelf_status_name: compact(row.shelfStatusName),
      first_shelf_time: ts(row.firstShelfTime),
      last_shelf_time: ts(row.lastShelfTime),
      last_update_time: ts(row.lastUpdateTime),
      sku_count: int(row.skuCount),
      cost_sar: num(row.costSar),
      cost_cny: num(row.costCny),
      image_url: compact(row.imageUrl),
      shein_usable_inventory: num(row.sheinUsableInventory),
      shein_inventory_quantity: num(row.sheinInventoryQuantity),
      shein_locked_quantity: num(row.sheinLockedQuantity),
      has_detail: bool(row.sourceCompleteness?.hasDetail),
      has_stock: bool(row.sourceCompleteness?.hasStock),
      raw_summary: compactJson({
        skuCodes: row.skuCodes || [],
        sourceCompleteness: row.sourceCompleteness || {},
      }),
      updated_at: new Date().toISOString(),
    });
  }
  return [...byStoreSkc.values()].filter(row => row.store_key && row.skc);
}

function buildReconciliationSql(args, productRows, sourceFile) {
  const apiValues = productRows.map(row => `(${sqlLiteral(row.store_key)}, ${sqlLiteral(row.skc)}, ${sqlLiteral(row.shelf_status_code)}, ${row.has_detail === 't' ? 'true' : 'false'}, ${row.has_stock === 't' ? 'true' : 'false'})`).join(',\n');
  const apiCte = apiValues
    ? `api AS (SELECT * FROM (VALUES\n${apiValues}\n) AS v(store_key, skc, shelf_status_code, has_detail, has_stock))`
    : `api AS (SELECT ${sqlLiteral(args.store)}::text AS store_key, ''::text AS skc, ''::text AS shelf_status_code, false AS has_detail, false AS has_stock WHERE false)`;
  return `
WITH latest AS (
  SELECT store_key, max(snapshot_date) AS snapshot_date
  FROM fact.link_master_snapshot
  WHERE store_key = ${sqlLiteral(args.store)}
  GROUP BY store_key
),
browser AS (
  SELECT
    l.store_key,
    l.skc,
    CASE
      WHEN l.is_on_shelf IS TRUE THEN '1'
      WHEN l.is_wait_shelf IS TRUE THEN '2'
      WHEN l.is_sold_out IS TRUE THEN '3'
      WHEN l.is_out_shelf IS TRUE THEN '4'
      WHEN coalesce(l.shelf_status_name,'') LIKE '%已上架%' THEN '1'
      WHEN coalesce(l.shelf_status_name,'') LIKE '%待上架%' THEN '2'
      WHEN coalesce(l.shelf_status_name,'') LIKE '%售罄%' THEN '3'
      WHEN coalesce(l.shelf_status_name,'') LIKE '%下架%' THEN '4'
      ELSE ''
    END AS shelf_status_code
  FROM fact.link_master_snapshot l
  JOIN latest ON latest.store_key = l.store_key AND latest.snapshot_date = l.snapshot_date
  WHERE coalesce(l.is_hard_dead,false) IS FALSE
    AND coalesce(l.skc,'') <> ''
),
${apiCte},
joined AS (
  SELECT
    coalesce(api.store_key, browser.store_key) AS store_key,
    coalesce(api.skc, browser.skc) AS skc,
    api.skc IS NOT NULL AS in_api,
    browser.skc IS NOT NULL AS in_browser,
    api.shelf_status_code AS api_status,
    browser.shelf_status_code AS browser_status,
    (api.shelf_status_code = '1') AS api_is_on_shelf,
    (browser.shelf_status_code = '1') AS browser_is_on_shelf,
    api.has_detail,
    api.has_stock
  FROM api
  FULL OUTER JOIN browser ON browser.store_key = api.store_key AND browser.skc = api.skc
),
agg AS (
  SELECT
    ${sqlLiteral(args.store)}::text AS store_key,
    ${sqlLiteral(sourceFile)}::text AS source_file,
    count(*) FILTER (WHERE in_api) AS api_link_count,
    count(*) FILTER (WHERE in_api AND api_status = '1') AS api_on_shelf_count,
    count(*) FILTER (WHERE in_browser) AS browser_link_count,
    count(*) FILTER (WHERE in_browser AND browser_status = '1') AS browser_on_shelf_count,
    count(*) FILTER (WHERE in_api AND in_browser) AS matched_skc_count,
    count(*) FILTER (WHERE in_api AND NOT in_browser) AS api_only_skc_count,
    count(*) FILTER (WHERE in_browser AND NOT in_api) AS browser_only_skc_count,
    count(*) FILTER (WHERE in_api AND in_browser AND coalesce(api_is_on_shelf,false) <> coalesce(browser_is_on_shelf,false)) AS status_mismatch_count,
    count(*) FILTER (WHERE in_api AND in_browser AND coalesce(api_status,'') <> coalesce(browser_status,'')) AS exact_status_mismatch_count,
    count(*) FILTER (WHERE in_api AND has_detail IS NOT TRUE) AS detail_missing_count,
    count(*) FILTER (WHERE in_api AND has_stock IS NOT TRUE) AS stock_missing_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'skc', skc,
      'apiStatus', api_status,
      'browserStatus', browser_status,
      'apiIsOnShelf', api_is_on_shelf,
      'browserIsOnShelf', browser_is_on_shelf,
      'inApi', in_api,
      'inBrowser', in_browser
    ) ORDER BY skc) FILTER (
      WHERE (in_api AND NOT in_browser)
         OR (in_browser AND NOT in_api)
         OR (in_api AND in_browser AND coalesce(api_is_on_shelf,false) <> coalesce(browser_is_on_shelf,false))
    ), '[]'::jsonb) AS samples
  FROM joined
),
final AS (
  SELECT
    *,
    CASE
      WHEN browser_link_count = 0 THEN 'missing_browser'
      WHEN api_only_skc_count = 0 AND browser_only_skc_count = 0 AND status_mismatch_count = 0 THEN 'matched'
      ELSE 'warning'
    END AS status,
    concat_ws(';',
      CASE WHEN api_only_skc_count > 0 THEN 'OpenAPI 独有 SKC ' || api_only_skc_count END,
      CASE WHEN browser_only_skc_count > 0 THEN '浏览器源独有 SKC ' || browser_only_skc_count END,
      CASE WHEN status_mismatch_count > 0 THEN '是否已上架不一致 ' || status_mismatch_count END,
      CASE WHEN detail_missing_count > 0 THEN '详情缺失 ' || detail_missing_count END,
      CASE WHEN stock_missing_count > 0 THEN '库存缺失 ' || stock_missing_count END
    ) AS warnings
  FROM agg
)
INSERT INTO mart.openapi_product_reconciliation (
  store_key, source_file, generated_at, api_link_count, api_on_shelf_count,
  browser_link_count, browser_on_shelf_count, matched_skc_count, api_only_skc_count,
  browser_only_skc_count, status_mismatch_count, exact_status_mismatch_count, detail_missing_count,
  stock_missing_count, status, warnings, raw_summary
)
SELECT
  store_key, source_file, now(), api_link_count, api_on_shelf_count,
  browser_link_count, browser_on_shelf_count, matched_skc_count, api_only_skc_count,
  browser_only_skc_count, status_mismatch_count, exact_status_mismatch_count, detail_missing_count,
  stock_missing_count, status, warnings,
  jsonb_build_object(
    'samples', samples,
    'statusGranularity', 'OpenAPI product shelfStatus is treated as binary on-shelf evidence; browser four-state status remains evidence only.',
    'exactStatusMismatchCount', exact_status_mismatch_count
  )
FROM final
ON CONFLICT (store_key) DO UPDATE SET
  source_file = EXCLUDED.source_file,
  generated_at = EXCLUDED.generated_at,
  api_link_count = EXCLUDED.api_link_count,
  api_on_shelf_count = EXCLUDED.api_on_shelf_count,
  browser_link_count = EXCLUDED.browser_link_count,
  browser_on_shelf_count = EXCLUDED.browser_on_shelf_count,
  matched_skc_count = EXCLUDED.matched_skc_count,
  api_only_skc_count = EXCLUDED.api_only_skc_count,
  browser_only_skc_count = EXCLUDED.browser_only_skc_count,
  status_mismatch_count = EXCLUDED.status_mismatch_count,
  exact_status_mismatch_count = EXCLUDED.exact_status_mismatch_count,
  detail_missing_count = EXCLUDED.detail_missing_count,
  stock_missing_count = EXCLUDED.stock_missing_count,
  status = EXCLUDED.status,
  warnings = EXCLUDED.warnings,
  raw_summary = EXCLUDED.raw_summary;
`;
}

async function loadProductsAtomically(args, productRows, sourceFile) {
  const columns = [
    'store_key', 'skc', 'fetched_at', 'source_file', 'spu', 'sku_codes',
    'supplier_code', 'standard_goods_sn', 'product_name_en', 'product_name_ar',
    'category_id', 'product_type_id', 'brand_code', 'shelf_status_code',
    'shelf_status_name', 'first_shelf_time', 'last_shelf_time', 'last_update_time',
    'sku_count', 'cost_sar', 'cost_cny', 'image_url', 'shein_usable_inventory',
    'shein_inventory_quantity', 'shein_locked_quantity', 'has_detail', 'has_stock',
    'raw_summary', 'updated_at',
  ];
  const {script: upsertSql, result} = buildUpsertRowsSql('fact.openapi_product_link', columns, ['store_key', 'skc'], productRows);
  const reconSql = buildReconciliationSql(args, productRows, sourceFile);
  const cleanupSql = `DELETE FROM fact.openapi_product_link WHERE store_key = ${sqlLiteral(args.store)};\nDELETE FROM mart.openapi_product_reconciliation WHERE store_key = ${sqlLiteral(args.store)};\n`;
  const script = `BEGIN;\n${cleanupSql}${upsertSql}${reconSql}COMMIT;\n`;
  if (args.dryRun) return {cleanup: {storeKey: args.store, dryRun: true}, results: [{...result, dryRun: true}]};
  await runPsqlScript(args, script);
  return {cleanup: {storeKey: args.store}, results: [result]};
}

async function queryReconciliation(args) {
  const script = `COPY (
SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
FROM (
  SELECT store_key, source_file, generated_at, api_link_count, api_on_shelf_count,
         browser_link_count, browser_on_shelf_count, matched_skc_count,
         api_only_skc_count, browser_only_skc_count, status_mismatch_count,
         exact_status_mismatch_count,
         detail_missing_count, stock_missing_count, status, warnings
  FROM mart.openapi_product_reconciliation
  WHERE store_key = ${sqlLiteral(args.store)}
) t
) TO STDOUT;`;
  if (args.dryRun) return [];
  const {stdout} = await runPsqlScript(args, script);
  try {
    return JSON.parse(stdout.trim() || '[]');
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = path.join(args.productDir, args.store, 'latest.json');
  if (!fssync.existsSync(file)) throw new Error(`Missing OpenAPI product file: ${rel(file)}`);
  const data = await readJson(file);
  const productRows = buildProductRows(data, file);
  const ensure = await ensureOpenApiProductTables(args);
  const {cleanup, results} = await loadProductsAtomically(args, productRows, rel(file));
  const reconciliation = await queryReconciliation(args);
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    storeKey: args.store,
    loadedFile: rel(file),
    ensure,
    cleanup,
    rowCounts: {
      productLinks: productRows.length,
      reconciliations: reconciliation.length || 1,
    },
    loadResults: results,
    reconciliation,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
