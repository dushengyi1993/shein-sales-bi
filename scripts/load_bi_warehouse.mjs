#!/usr/bin/env node
/**
 * Load existing local SHEIN sales/link artifacts into the PostgreSQL BI warehouse.
 *
 * No network calls to SHEIN/Feishu are made here. The script only reads local
 * JSON outputs and writes to the local Docker PostgreSQL warehouse.
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
  ORDER_PAYMENT_FLAG_CREATE_SQL,
  ORDER_PAYMENT_FLAG_TABLE,
  extractPaymentFlagsFromSalesArtifact,
} from '../lib/order_payment_flags.mjs';
import {guardFormalSalesFacts} from '../lib/primary_sales_cutover_guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    salesDir: path.join(ROOT, 'outputs', 'shein_fetch'),
    linksDir: path.join(ROOT, 'outputs', 'shein_links'),
    dashboardJson: path.join(ROOT, 'outputs', 'link-dashboard', 'link-ops-dashboard-2026-04-30.json'),
    salesDate: '',
    linkDate: '',
    skipLinks: false,
    skipDashboard: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--sales-dir') args.salesDir = path.resolve(argv[++i]);
    else if (a === '--links-dir') args.linksDir = path.resolve(argv[++i]);
    else if (a === '--dashboard-json') args.dashboardJson = path.resolve(argv[++i]);
    else if (a === '--sales-date') args.salesDate = argv[++i];
    else if (a === '--link-date') args.linkDate = argv[++i];
    else if (a === '--skip-links') args.skipLinks = true;
    else if (a === '--skip-dashboard') args.skipDashboard = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function dateFromFile(file) {
  const m = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  return m ? m[1] : '';
}

async function listJsonFiles(dir, dateFilter = '') {
  const out = [];
  async function walk(d) {
    if (!fssync.existsSync(d)) return;
    const entries = await fs.readdir(d, {withFileTypes: true});
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /\.json$/i.test(e.name) && !/_summary\.json$/i.test(e.name)) {
        const dte = dateFromFile(p);
        if (!dte) continue;
        if (!dateFilter || dte === dateFilter) out.push(p);
      }
    }
  }
  await walk(dir);
  return out.sort();
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

function bool(v) {
  if (v === null || v === undefined || v === '') return null;
  return Boolean(v);
}

function ts(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  return s;
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLen) return text;
  return JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

function normalizeStandardGoodsSn(value, context = {}) {
  const raw = value || context.rawGoodsSn || context.raw_goods_sn || context.goodsSn || '';
  const norm = normalizeGoodsSnDetailed(raw, {
    goodsTitle: context.goodsTitle || context.goodsName || context.saleName || context.productNameCn || context.product_name_cn || context.title || '',
  });
  if (norm.ignored) return '';
  return norm.canonical || raw || '';
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
  return ident.split('.').map(x => `"${x.replace(/"/g, '""')}"`).join('.');
}

function tempName(table) {
  return `stage_${table.replace(/\W+/g, '_')}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerPrefix() {
  if (process.platform === 'win32') return 'sudo ';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return '';
  return 'sudo ';
}

function psqlSpawnCommand(args, extraFlags = '') {
  const psql = `${dockerPrefix()}docker exec -i ${shellQuote(args.container)} psql -U ${shellQuote(args.user)} -d ${shellQuote(args.database)} -v ON_ERROR_STOP=1${extraFlags}`;
  if (process.platform === 'win32') {
    return {
      command: 'wsl',
      args: ['-d', args.distro, '--', 'bash', '-lc', psql],
    };
  }
  return {
    command: 'bash',
    args: ['-lc', psql],
  };
}

async function runPsqlScript(args, script, extraFlags = '') {
  const psql = psqlSpawnCommand(args, extraFlags);
  const child = spawn(psql.command, psql.args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return {stdout, stderr};
}

async function readPrimarySalesGuard(args) {
  if (args.dryRun) {
    return {enabled: false, cutoverDate: '', source: 'dry-run'};
  }
  const result = await runPsqlScript(args, `
SELECT
  CASE WHEN ops.shein_webhook_primary_sales_enabled(current_date) THEN 'true' ELSE 'false' END,
  COALESCE((
    SELECT setting_value
    FROM ops.shein_webhook_runtime_setting
    WHERE setting_key='primary_sales_cutover_date'
  ), '');
`, ' -qAt -F "|"');
  const [enabledRaw = '', cutoverDate = ''] = String(result.stdout || '').trim().split('|');
  const enabled = enabledRaw === 'true';
  if (enabled && !/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
    throw new Error(`Primary sales is enabled but cutover date is invalid: ${cutoverDate || '(empty)'}`);
  }
  return {enabled, cutoverDate, source: 'ops.shein_webhook_runtime_setting'};
}

async function ensureOrderPaymentFlagTable(args) {
  if (args.dryRun) return {skipped: true, dryRun: true};
  await runPsqlScript(args, `BEGIN;\n${ORDER_PAYMENT_FLAG_CREATE_SQL}\nCOMMIT;\n`);
  return {ok: true};
}

async function upsertRows(args, table, columns, conflictColumns, rows) {
  const originalRowCount = rows.length;
  if (rows.length && conflictColumns.length) {
    const byConflictKey = new Map();
    for (const row of rows) {
      const key = conflictColumns.map(c => String(row[c] ?? '')).join('\u001F');
      byConflictKey.set(key, row);
    }
    rows = [...byConflictKey.values()];
  }
  if (!rows.length) return {table, rows: 0, skipped: true};
  const stage = tempName(table);
  const nonConflict = columns.filter(c => !conflictColumns.includes(c) && c !== 'updated_at');
  const updateSet = [
    ...nonConflict.map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`),
    columns.includes('updated_at') ? 'updated_at = now()' : '',
  ].filter(Boolean).join(',\n    ');
  const sqlColumns = columns.map(qIdent).join(', ');
  let script = '';
  script += 'BEGIN;\n';
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map(c => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} (${sqlColumns})\n`;
  script += `SELECT ${sqlColumns} FROM "${stage}"\n`;
  script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  script += 'COMMIT;\n';
  if (args.dryRun) return {table, rows: rows.length, inputRows: originalRowCount, dedupedRows: originalRowCount - rows.length, dryRun: true};
  await runPsqlScript(args, script);
  return {table, rows: rows.length, inputRows: originalRowCount, dedupedRows: originalRowCount - rows.length};
}

function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function cleanupLoadedSlices(args, salesRows, linkRows, dashboard) {
  const salesPairs = [...new Set(salesRows.map(r => `${r.date}__${r.store_key}`))]
    .map(x => {
      const [date, store] = x.split('__');
      return {date, store};
    })
    .filter(x => x.date && x.store);
  const linkPairs = [...new Set(linkRows.map(r => `${r.snapshot_date}__${r.store_key}`))]
    .map(x => {
      const [date, store] = x.split('__');
      return {date, store};
    })
    .filter(x => x.date && x.store);
  const actionDates = [...new Set((dashboard.actions || []).map(r => r.date).filter(Boolean))];
  const cockpitDates = [...new Set((dashboard.storeCockpit || []).map(r => r.date).filter(Boolean))];

  const tupleList = pairs => pairs.map(p => `(${sqlLiteral(p.date)}::date, ${sqlLiteral(p.store)})`).join(', ');
  let script = 'BEGIN;\n';
  if (salesPairs.length) {
    const t = tupleList(salesPairs);
    script += `DELETE FROM fact.order_payment_flag WHERE (created_date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.order_item WHERE (created_date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.order_header WHERE (created_date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.store_daily_sales WHERE (date, store_key) IN (${t});\n`;
  }
  if (linkPairs.length) {
    const t = tupleList(linkPairs);
    script += `DELETE FROM fact.link_suggestion WHERE (date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.product_store_coverage WHERE (date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.link_performance_daily WHERE (date, store_key) IN (${t});\n`;
    script += `DELETE FROM fact.link_master_snapshot WHERE (snapshot_date, store_key) IN (${t});\n`;
  }
  if (actionDates.length) {
    script += `DELETE FROM mart.link_action_candidate WHERE date IN (${actionDates.map(d => `${sqlLiteral(d)}::date`).join(', ')});\n`;
  }
  if (cockpitDates.length) {
    script += `DELETE FROM mart.store_cockpit_daily WHERE date IN (${cockpitDates.map(d => `${sqlLiteral(d)}::date`).join(', ')});\n`;
  }
  script += 'COMMIT;\n';

  if (script === 'BEGIN;\nCOMMIT;\n') return {salesPairs: 0, linkPairs: 0, actionDates: 0, cockpitDates: 0};
  if (!args.dryRun) await runPsqlScript(args, script);
  return {salesPairs: salesPairs.length, linkPairs: linkPairs.length, actionDates: actionDates.length, cockpitDates: cockpitDates.length};
}

function addProduct(productMap, row) {
  const standard = row.standardGoodsSn || row.standard_goods_sn || '';
  if (!standard) return;
  const prev = productMap.get(standard) || {};
  productMap.set(standard, {
    standard_goods_sn: standard,
    sample_raw_goods_sn: prev.sample_raw_goods_sn || row.rawGoodsSn || row.raw_goods_sn || row.goodsSn || '',
    needs_review: Boolean(prev.needs_review || row.needsGoodsSnReview),
    review_reason: prev.review_reason || row.goodsSnReviewReason || '',
    first_seen_date: [prev.first_seen_date, row.date, row.created_date, row.snapshot_date].filter(Boolean).sort()[0] || null,
    last_seen_date: [prev.last_seen_date, row.date, row.created_date, row.snapshot_date].filter(Boolean).sort().pop() || null,
  });
}

function addSkc(skcMap, row) {
  const skc = row.skc || row.skcName || row.skc_name || '';
  if (!skc) return;
  const prev = skcMap.get(skc) || {};
  skcMap.set(skc, {
    skc,
    spu: prev.spu || row.spu || '',
    standard_goods_sn: prev.standard_goods_sn || row.standardGoodsSn || row.standard_goods_sn || row.goodsSnStandard || '',
    raw_goods_sn: prev.raw_goods_sn || row.rawGoodsSn || row.raw_goods_sn || row.goodsSn || '',
    sku_code: prev.sku_code || row.skuCode || row.sku_code || '',
    title: prev.title || row.goodsTitle || row.goodsName || row.saleName || row.productNameCn || '',
    image_url: prev.image_url || row.imageUrl || row.image_url || '',
    category_l1: prev.category_l1 || row.categoryName || '',
    category_l2: prev.category_l2 || '',
    category_l3: prev.category_l3 || '',
    category_l4: prev.category_l4 || '',
    first_seen_date: [prev.first_seen_date, row.date, row.created_date, row.snapshot_date].filter(Boolean).sort()[0] || null,
    last_seen_date: [prev.last_seen_date, row.date, row.created_date, row.snapshot_date].filter(Boolean).sort().pop() || null,
  });
}

async function collectStores() {
  const config = await readJson(path.join(ROOT, 'config', 'stores.json'));
  return (config.stores || []).map(s => ({
    store_key: s.storeKey,
    group_key: s.groupKey,
    shop_name: s.shopName,
    profile_key: s.profileKey,
    cdp_port: int(s.port),
    profile_name: s.profileName,
    enabled: s.enabled !== false,
    product_stats_enabled: s.productStatsEnabled !== false,
  }));
}

async function collectSales(args, productMap, skcMap) {
  const files = await listJsonFiles(args.salesDir, args.salesDate);
  const daily = [];
  const orders = [];
  const items = [];
  const paymentFlags = [];
  const catalog = [];
  for (const file of files) {
    let j;
    try { j = await readJson(file); } catch { continue; }
    if (!j || !j.storeKey || !Array.isArray(j.goodsRows)) continue;
    const date = j.start || dateFromFile(file);
    const source = rel(file);
    const salesSourceKind = j.source === 'shein-openapi' ? 'openapi' : 'browser_webapi';
    const summary = j.summary || {};
    const goodsSales = summarizeSalesGoodsRows(j.goodsRows || []);
    const salesSar = Math.round((goodsSales.salesSar + Number.EPSILON) * 100) / 100;
    daily.push({
      date,
      store_key: j.storeKey,
      group_key: j.groupKey,
      shop_name: j.shopName,
      valid_order_count: int(goodsSales.positiveAmountOrderCount),
      goods_line_count: int((j.goodsRows || []).length),
      quantity_all: num(goodsSales.quantityAll),
      quantity_positive_amount: num(goodsSales.quantityPositiveAmount),
      sales_sar: num(salesSar),
      sales_rmb: Math.round((salesSar * 1.8 + Number.EPSILON) * 100) / 100,
      fetch_time: ts(j.fetchTime),
      source_file: source,
      raw_summary: compactJson(summary),
    });
    catalog.push({
      file_path: source,
      file_kind: 'sales',
      store_key: j.storeKey,
      target_date: date,
      record_count: (j.goodsRows || []).length,
      raw_meta: compactJson({fetchTime: j.fetchTime, summary}),
    });
    paymentFlags.push(...extractPaymentFlagsFromSalesArtifact(j, {
      date,
      sourceFile: source,
      sourceKind: salesSourceKind,
    }));
    for (const [idx, row] of (j.orderRows || []).entries()) {
      const orderId = String(row.orderId || row.id || row.orderNo || idx);
      const orderKey = `${j.storeKey}__${orderId}`;
      orders.push({
        order_key: orderKey,
        store_key: j.storeKey,
        group_key: j.groupKey,
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
    for (const [idx, row] of (j.goodsRows || []).entries()) {
      const norm = normalizeGoodsSnDetailed(row.goodsSn || '', {goodsTitle: row.goodsTitle || row.goodsName || ''});
      const standard = norm.canonical || row.goodsSn || '';
      const orderId = String(row.orderId || row.orderNo || idx);
      const orderKey = `${j.storeKey}__${orderId}`;
      const itemKey = `${j.storeKey}__${date}__${orderId}__${row.goodsId || row.entityId || row.skcName || row.skuCode || idx}__${idx}`;
      const qty = num(row.number) ?? 0;
      const price = num(row.currencyPrice) ?? 0;
      const validSale = isValidSalesGoodsRow(row);
      const salesQty = validSale ? qty : 0;
      const salesPrice = validSale ? price : 0;
      const item = {
        order_item_key: itemKey,
        order_key: orderKey,
        store_key: j.storeKey,
        group_key: j.groupKey,
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
        sales_rmb: Math.round((salesPrice * 1.8 + Number.EPSILON) * 100) / 100,
        goods_status: row.newOrderGoodsStatus ?? '',
        goods_performance_status: row.goodsPerformanceStatus ?? '',
        goods_performance_status_desc: row.goodsPerformanceStatusDesc || '',
        source_file: source,
        raw_summary: compactJson(row),
      };
      items.push(item);
      addProduct(productMap, {standardGoodsSn: standard, rawGoodsSn: row.goodsSn, date});
      addSkc(skcMap, {...row, standardGoodsSn: standard, date});
    }
  }
  return {daily, orders, items, paymentFlags, catalog, fileCount: files.length};
}

async function collectLinks(args, productMap, skcMap) {
  if (args.skipLinks) {
    return {master: [], perf: [], coverage: [], suggestions: [], catalog: [], fileCount: 0};
  }
  const files = await listJsonFiles(args.linksDir, args.linkDate);
  const master = [];
  const perf = [];
  const coverage = [];
  const suggestions = [];
  const catalog = [];
  for (const file of files) {
    let j;
    try { j = await readJson(file); } catch { continue; }
    if (!j || !j.store?.storeKey || !Array.isArray(j.linkRows)) continue;
    const store = j.store || {};
    const source = rel(file);
    const date = j.date || dateFromFile(file);
    catalog.push({
      file_path: source,
      file_kind: 'links',
      store_key: store.storeKey,
      target_date: date,
      record_count: (j.linkRows || []).length,
      raw_meta: compactJson({fetchTime: j.fetchTime, counts: j.counts}),
    });
    for (const row of j.linkRows || []) {
      const standard = normalizeStandardGoodsSn(row.standardGoodsSn, row);
      master.push({
        unique_key: row.uniqueKey || `${row.date}__${row.storeKey}__${row.skc}`,
        snapshot_date: row.date || date,
        store_key: row.storeKey || store.storeKey,
        group_key: row.groupKey || store.groupKey,
        shop_name: row.shopName || store.shopName,
        standard_goods_sn: standard,
        raw_goods_sn: row.rawGoodsSn || '',
        spu: row.spu || row.spuCode || '',
        skc: row.skc || row.skcCode || '',
        sku_codes: row.skuCodes || '',
        sale_name: row.saleName || '',
        image_url: row.imageUrl || '',
        product_name_cn: row.productNameCn || '',
        product_name_en: row.productNameEn || '',
        brand_name: row.brandName || '',
        shelf_status: row.shelfStatus || '',
        shelf_status_name: row.shelfStatusName || '',
        is_on_shelf: bool(row.isOnShelf),
        is_wait_shelf: bool(row.isWaitShelf),
        is_sold_out: bool(row.isSoldOut),
        is_out_shelf: bool(row.isOutShelf),
        is_hard_dead: bool(row.isHardDead),
        wait_shelf_blocked: bool(row.waitShelfBlocked),
        wait_shelf_block_reason: row.waitShelfBlockReason || row.waitShelfBlockageReason || '',
        created_time: ts(row.createdTime || row.createTime),
        shelf_time: ts(row.shelfTime || row.publishTime),
        first_shelf_time: ts(row.firstShelfTime),
        expect_shelf_time: ts(row.expectShelfTime || row.expectedShelfTime),
        source_file: source,
        raw_summary: compactJson(row),
      });
      addProduct(productMap, {...row, standardGoodsSn: standard, date});
      addSkc(skcMap, {...row, standardGoodsSn: standard, date});
    }
    for (const row of j.performanceRows || []) {
      const standard = normalizeStandardGoodsSn(row.standardGoodsSn, row);
      perf.push({
        unique_key: row.uniqueKey || `${row.date}__${row.storeKey}__${row.skc}`,
        date: row.date || date,
        store_key: row.storeKey || store.storeKey,
        group_key: row.groupKey || store.groupKey,
        shop_name: row.shopName || store.shopName,
        standard_goods_sn: standard,
        raw_goods_sn: row.rawGoodsSn || '',
        spu: row.spu || '',
        skc: row.skc || '',
        goods_name: row.goodsName || '',
        image_url: row.imageUrl || '',
        sale_cnt: num(row.saleCnt),
        pay_order_cnt: num(row.payOrderCnt),
        eps_uv: num(row.epsUv),
        goods_uv: num(row.goodsUv),
        click_rate: num(row.clickRate),
        cart_uv: num(row.cartUv),
        cart_pv: num(row.cartPv),
        cart_rate: num(row.cartRate),
        pay_uv: num(row.payUv),
        pay_rate: num(row.payRate),
        c7_sale_cnt: num(row.c7SaleCnt),
        prev7_sale_cnt: num(row.prev7SaleCnt),
        c30_sale_cnt: num(row.c30SaleCnt),
        quality_grade: row.qualityGrade || '',
        comment_count: num(row.commentCount || row.commentCnt),
        bad_comment_rate: num(row.badCommentRate),
        return_order_count: num(row.returnOrderCount || row.returnOrderCnt),
        return_item_count: num(row.returnItemCount || row.returnItemCnt),
        activity_tag: row.activityTag || '',
        activity_names: row.activityNames || '',
        flow_diagnose_tabs: row.flowDiagnoseTabs || '',
        source_file: source,
        raw_summary: compactJson(row),
      });
      addProduct(productMap, {...row, standardGoodsSn: standard, date});
      addSkc(skcMap, {...row, standardGoodsSn: standard, date});
    }
    for (const row of j.coverageRows || []) {
      const standard = normalizeStandardGoodsSn(row.standardGoodsSn, row);
      coverage.push({
        unique_key: row.uniqueKey || `${row.date}__${row.storeKey}__${standard}`,
        date: row.date || date,
        store_key: row.storeKey || store.storeKey,
        group_key: row.groupKey || store.groupKey,
        shop_name: row.shopName || store.shopName,
        standard_goods_sn: standard,
        coverage_status: row.coverageStatus || '',
        has_on_shelf_link: bool(row.hasOnShelfLink),
        need_supplement_link: bool(row.needSupplementLink),
        link_count: int(row.linkCount),
        on_shelf_count: int(row.onShelfCount),
        wait_shelf_count: int(row.waitShelfCount),
        sold_out_count: int(row.soldOutCount),
        out_shelf_count: int(row.outShelfCount),
        hard_dead_count: int(row.hardDeadCount),
        duplicate_on_shelf: bool(row.duplicateOnShelf),
        best_skc: row.bestSkc || '',
        best_link_c30_sale: num(row.bestLinkC30Sale),
        skc_list: row.skcList || '',
        recommendation: row.recommendation || '',
        source_file: source,
        raw_summary: compactJson(row.rawSummary || row),
      });
      addProduct(productMap, {...row, standardGoodsSn: standard, date});
    }
    for (const row of j.suggestionRows || []) {
      const standard = normalizeStandardGoodsSn(row.standardGoodsSn, row);
      suggestions.push({
        unique_key: row.uniqueKey || `${row.date}__${row.storeKey}__${row.ruleCode}__${row.targetKey || row.skc || standard}`,
        date: row.date || date,
        store_key: row.storeKey || store.storeKey,
        group_key: row.groupKey || store.groupKey,
        shop_name: row.shopName || store.shopName,
        target_type: row.targetType || '',
        target_key: row.targetKey || '',
        standard_goods_sn: standard,
        skc: row.skc || '',
        rule_code: row.ruleCode || '',
        suggestion_type: row.suggestionType || '',
        priority: int(row.priority),
        reason: row.reason || '',
        action: row.action || '',
        evidence: row.evidence || '',
        source_file: source,
        raw_summary: compactJson(row),
      });
      addProduct(productMap, {...row, standardGoodsSn: standard, date});
      addSkc(skcMap, {...row, standardGoodsSn: standard, date});
    }
  }
  return {master, perf, coverage, suggestions, catalog, fileCount: files.length};
}

async function collectDashboard(args) {
  if (args.skipDashboard) return {actions: [], storeCockpit: []};
  if (!fssync.existsSync(args.dashboardJson)) return {actions: [], storeCockpit: []};
  const j = await readJson(args.dashboardJson);
  const date = j.meta?.linkDate || j.meta?.salesDate || null;
  const actions = (j.actions || []).map(a => {
    const standard = normalizeStandardGoodsSn(a.standardGoodsSn, a);
    return ({
    action_id: a.id || `${date}__${a.type}__${a.store}__${a.skc || a.standardGoodsSn}`,
    date,
    type: a.type || '',
    category: a.category || '',
    priority: a.priority || '',
    score: num(a.score),
    store_key: a.store || '',
    group_key: a.group || '',
    shop_name: a.shopName || '',
    standard_goods_sn: standard,
    skc: a.skc || '',
    image_url: a.imageUrl || '',
    title: a.title || '',
    reason: a.reason || '',
    evidence: a.evidence || '',
    next_step: a.nextStep || '',
    source: a.source || '',
    focus: bool(a.focus),
    metrics: compactJson(a.metrics || {}),
    raw_summary: compactJson(a),
  });
  });
  const storeDate = j.meta?.salesDate || date;
  const storeCockpit = (j.storeCockpit || []).map(s => ({
    date: storeDate,
    store_key: s.storeKey || '',
    group_key: s.groupKey || '',
    shop_name: s.shopName || '',
    today_sar: num(s.todaySar),
    today_qty: num(s.todayQty),
    today_orders: num(s.todayOrders),
    last7_sar: num(s.last7Sar),
    last30_sar: num(s.last30Sar),
    sales7_change_rate: num(s.sales7ChangeRate),
    link_count: int(s.linkCount),
    on_shelf: int(s.onShelf),
    wait_shelf: int(s.waitShelf),
    sold_out: int(s.soldOut),
    out_shelf: int(s.outShelf),
    link_c30_sale: num(s.linkC30Sale),
    link_c30_exposure: num(s.linkC30Exposure),
    action_count: int(s.actionCount),
    focus_count: int(s.focusCount),
    raw_summary: compactJson(s),
  }));
  return {actions, storeCockpit};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const productMap = new Map();
  const skcMap = new Map();

  const stores = await collectStores();
  const sales = await collectSales(args, productMap, skcMap);
  const primarySalesGuard = await readPrimarySalesGuard(args);
  const guardedSales = guardFormalSalesFacts(sales, primarySalesGuard);
  const formalSales = guardedSales.sales;
  const links = await collectLinks(args, productMap, skcMap);
  const dashboard = await collectDashboard(args);
  const products = [...productMap.values()];
  const skcs = [...skcMap.values()];
  const catalog = [...sales.catalog, ...links.catalog];

  const paymentFlagTable = await ensureOrderPaymentFlagTable(args);
  const cleanup = await cleanupLoadedSlices(args, formalSales.daily, links.master, dashboard);

  const batches = [
    ['dim.store', ['store_key','group_key','shop_name','profile_key','cdp_port','profile_name','enabled','product_stats_enabled'], ['store_key'], stores],
    ['dim.product', ['standard_goods_sn','sample_raw_goods_sn','needs_review','review_reason','first_seen_date','last_seen_date'], ['standard_goods_sn'], products],
    ['dim.skc', ['skc','spu','standard_goods_sn','raw_goods_sn','sku_code','title','image_url','category_l1','category_l2','category_l3','category_l4','first_seen_date','last_seen_date'], ['skc'], skcs],
    ['raw.local_file_catalog', ['file_path','file_kind','store_key','target_date','record_count','raw_meta'], ['file_path'], catalog],
    ['fact.store_daily_sales', ['date','store_key','group_key','shop_name','valid_order_count','goods_line_count','quantity_all','quantity_positive_amount','sales_sar','sales_rmb','fetch_time','source_file','raw_summary'], ['date','store_key'], formalSales.daily],
    ['fact.order_header', ['order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','allocate_time','site','order_status','order_status_desc','perform_status','perform_status_desc','source_file','raw_summary'], ['order_key'], formalSales.orders],
    ['fact.order_item', ['order_item_key','order_key','store_key','group_key','order_id','order_no','bill_no','created_date','order_create_time','site','standard_goods_sn','raw_goods_sn','goods_id','entity_id','skc','sku_code','sku_sn','sku_suffix','goods_title','quantity','currency_code','currency_price','sales_sar','sales_rmb','goods_status','goods_performance_status','goods_performance_status_desc','source_file','raw_summary'], ['order_item_key'], formalSales.items],
    [ORDER_PAYMENT_FLAG_TABLE, ORDER_PAYMENT_FLAG_COLUMNS, ['order_key'], formalSales.paymentFlags],
    ['fact.link_master_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','standard_goods_sn','raw_goods_sn','spu','skc','sku_codes','sale_name','image_url','product_name_cn','product_name_en','brand_name','shelf_status','shelf_status_name','is_on_shelf','is_wait_shelf','is_sold_out','is_out_shelf','is_hard_dead','wait_shelf_blocked','wait_shelf_block_reason','created_time','shelf_time','first_shelf_time','expect_shelf_time','source_file','raw_summary'], ['unique_key'], links.master],
    ['fact.link_performance_daily', ['unique_key','date','store_key','group_key','shop_name','standard_goods_sn','raw_goods_sn','spu','skc','goods_name','image_url','sale_cnt','pay_order_cnt','eps_uv','goods_uv','click_rate','cart_uv','cart_pv','cart_rate','pay_uv','pay_rate','c7_sale_cnt','prev7_sale_cnt','c30_sale_cnt','quality_grade','comment_count','bad_comment_rate','return_order_count','return_item_count','activity_tag','activity_names','flow_diagnose_tabs','source_file','raw_summary'], ['unique_key'], links.perf],
    ['fact.product_store_coverage', ['unique_key','date','store_key','group_key','shop_name','standard_goods_sn','coverage_status','has_on_shelf_link','need_supplement_link','link_count','on_shelf_count','wait_shelf_count','sold_out_count','out_shelf_count','hard_dead_count','duplicate_on_shelf','best_skc','best_link_c30_sale','skc_list','recommendation','source_file','raw_summary'], ['unique_key'], links.coverage],
    ['fact.link_suggestion', ['unique_key','date','store_key','group_key','shop_name','target_type','target_key','standard_goods_sn','skc','rule_code','suggestion_type','priority','reason','action','evidence','source_file','raw_summary'], ['unique_key'], links.suggestions],
    ['mart.link_action_candidate', ['action_id','date','type','category','priority','score','store_key','group_key','shop_name','standard_goods_sn','skc','image_url','title','reason','evidence','next_step','source','focus','metrics','raw_summary'], ['action_id'], dashboard.actions],
    ['mart.store_cockpit_daily', ['date','store_key','group_key','shop_name','today_sar','today_qty','today_orders','last7_sar','last30_sar','sales7_change_rate','link_count','on_shelf','wait_shelf','sold_out','out_shelf','link_c30_sale','link_c30_exposure','action_count','focus_count','raw_summary'], ['date','store_key'], dashboard.storeCockpit],
  ];

  const results = [];
  for (const [table, columns, conflict, rows] of batches) {
    results.push(await upsertRows(args, table, columns, conflict, rows));
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    salesFiles: sales.fileCount,
    linkFiles: links.fileCount,
    dashboardFile: fssync.existsSync(args.dashboardJson) ? rel(args.dashboardJson) : null,
    paymentFlagTable,
    primarySalesGuard: {
      ...primarySalesGuard,
      skipped: guardedSales.skipped,
      skippedTotal: guardedSales.skippedTotal,
    },
    cleanup,
    results,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
