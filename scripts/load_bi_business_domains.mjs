#!/usr/bin/env node
/**
 * Load SHEIN business-domain artifacts into the BI warehouse.
 *
 * Reads outputs from scripts/fetch_shein_business_domains.mjs and writes the
 * new order-adjacent facts: after-sales, waybill, inventory, quality,
 * comments, marketing, fulfillment and home finance summary.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHEIN_TRANSLATION_PROVIDER = 'shein-platform';

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    inputDir: path.join(ROOT, 'outputs', 'shein_business_domains'),
    date: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--input-dir') args.inputDir = path.resolve(argv[++i]);
    else if (a === '--date') args.date = argv[++i];
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
      else if (e.isFile() && /\.json$/i.test(e.name)) {
        const dte = dateFromFile(p);
        if (!dateFilter || dte === dateFilter) out.push(p);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function rate(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const s = String(v).trim();
  const n = num(s);
  if (n === null) return null;
  return s.endsWith('%') ? n / 100 : n;
}

function bool(v) {
  if (v === null || v === undefined || v === '') return null;
  return Boolean(v);
}

function boolLike(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', '是'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', '否'].includes(s)) return false;
  return Boolean(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return '';
}

function ts(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  return s.length === 16 ? `${s}:00` : s;
}

function dateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLen) return text;
  return JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
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

function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function runPsqlScript(args, script) {
  const child = spawn('wsl', [
    '-d', args.distro,
    '--',
    'bash',
    '-lc',
    `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`,
  ], {
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

async function upsertRows(args, table, columns, conflictColumns, rows) {
  if (!rows.length) return {table, rows: 0, skipped: true};
  const originalCount = rows.length;
  if (conflictColumns?.length) {
    // PostgreSQL cannot update the same target row twice in a single
    // INSERT ... ON CONFLICT statement. Some SHEIN pages can return duplicate
    // rows for the same business key across pagination or SKU expansion, so we
    // keep the last row for each conflict key before staging the CSV.
    const deduped = new Map();
    for (const row of rows) {
      const key = JSON.stringify(conflictColumns.map(c => row[c] ?? null));
      deduped.set(key, row);
    }
    rows = [...deduped.values()];
  }
  const stage = tempName(table);
  const nonConflict = columns.filter(c => !conflictColumns.includes(c) && c !== 'updated_at');
  const updateSet = [
    ...nonConflict.map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`),
    columns.includes('updated_at') ? 'updated_at = now()' : '',
  ].filter(Boolean).join(',\n    ');
  const sqlColumns = columns.map(qIdent).join(', ');
  let script = 'BEGIN;\n';
  script += `CREATE TEMP TABLE "${stage}" (LIKE ${qIdent(table)} INCLUDING DEFAULTS) ON COMMIT DROP;\n`;
  script += `COPY "${stage}" (${sqlColumns}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map(c => row[c]));
  script += '\\.\n';
  script += `INSERT INTO ${qIdent(table)} (${sqlColumns})\nSELECT ${sqlColumns} FROM "${stage}"\nON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  script += 'COMMIT;\n';
  if (args.dryRun) return {table, rows: rows.length, dryRun: true};
  await runPsqlScript(args, script);
  return {table, rows: rows.length, dedupedFrom: originalCount === rows.length ? undefined : originalCount};
}

async function cleanupSlices(args, files) {
  const pairs = [];
  for (const file of files) {
    const j = await readJson(file);
    const date = j.date || dateFromFile(file);
    const store = j.store?.storeKey;
    if (date && store) pairs.push({date, store});
  }
  const uniq = [...new Map(pairs.map(x => [`${x.date}__${x.store}`, x])).values()];
  if (!uniq.length) return {pairs: 0};
  const tuple = uniq.map(p => `(${sqlLiteral(p.date)}::date, ${sqlLiteral(p.store)})`).join(', ');
  let script = 'BEGIN;\n';
  for (const table of [
    'fact.home_finance_snapshot',
    'fact.finance_income_overview_snapshot',
    'fact.finance_module_stat_snapshot',
    'fact.finance_account_period_snapshot',
    'fact.finance_no_finish_order',
    'fact.finance_no_finish_order_goods',
    'fact.after_sales_item',
    'fact.waybill_package',
    'fact.visible_inventory_snapshot',
    'fact.management_indicator_daily',
    'fact.marketing_overview_daily',
    'fact.marketing_campaign_snapshot',
    'fact.quality_skc_snapshot',
  ]) {
    const dateCol = table === 'fact.management_indicator_daily' || table === 'fact.marketing_overview_daily'
      ? 'snapshot_date'
      : 'snapshot_date';
    script += `DELETE FROM ${table} WHERE (${dateCol}, store_key) IN (${tuple});\n`;
  }
  script += 'COMMIT;\n';
  if (!args.dryRun) await runPsqlScript(args, script);
  return {pairs: uniq.length};
}

function standardGoods(raw) {
  if (!raw) return '';
  const n = normalizeGoodsSnDetailed(String(raw));
  return n.canonical || n.standardGoodsSn || String(raw);
}

function joinUnique(values) {
  return [...new Set(values.map(x => String(x || '').trim()).filter(Boolean))].join(',');
}

function buildProductMaps(j) {
  const bySpu = new Map();
  const bySkc = new Map();
  for (const p of j.productInventory?.productRows || []) {
    const spu = p.spu_name || p.spu;
    const skcList = [];
    const skuList = [];
    const rawList = [];
    const statuses = [];
    for (const s of p.skc_info_list || []) {
      if (s.skc_name) skcList.push(s.skc_name);
      if (s.supplier_code) rawList.push(s.supplier_code);
      if (p.shelf_status) statuses.push(p.shelf_status);
      for (const sku of s.sku_info || []) if (sku.sku_code) skuList.push(sku.sku_code);
      if (s.skc_name) bySkc.set(s.skc_name, {
        spu,
        rawGoodsSn: s.supplier_code || '',
        standardGoodsSn: standardGoods(s.supplier_code || ''),
        skuCodes: joinUnique((s.sku_info || []).map(x => x.sku_code)),
      });
    }
    if (spu) bySpu.set(spu, {
      spu,
      rawGoodsSn: rawList[0] || '',
      standardGoodsSn: standardGoods(rawList[0] || ''),
      skcList: joinUnique(skcList),
      skuCodeList: joinUnique(skuList),
      shelfStatuses: joinUnique(statuses),
    });
  }
  return {bySpu, bySkc};
}

function extractTime(list, code) {
  const row = (list || []).find(x => x.timeCode === code);
  return ts(row?.g_zcs_time || row?.time);
}

async function collect(args) {
  const files = await listJsonFiles(args.inputDir, args.date);
  const rows = {
    home: [],
    afterSales: [],
    waybill: [],
    fulfillment: [],
    inventory: [],
    management: [],
    marketingOverview: [],
    marketingCampaign: [],
    quality: [],
    comments: [],
    financeOverview: [],
    financeStats: [],
    financeAccount: [],
    financeNoFinishOrder: [],
    financeNoFinishGoods: [],
    catalog: [],
  };
  for (const file of files) {
    const j = await readJson(file);
    if (!j?.store?.storeKey) continue;
    const source = rel(file);
    const date = j.date || dateFromFile(file);
    const store = j.store;
    const {bySpu, bySkc} = buildProductMaps(j);
    rows.catalog.push({
      file_path: source,
      file_kind: 'business_domains',
      store_key: store.storeKey,
      target_date: date,
      record_count: Object.values(j.counts || {}).reduce((s, x) => s + Number(x || 0), 0),
      raw_meta: compactJson({fetchTime: j.fetchTime, counts: j.counts, errors: j.errors}),
    });
    rows.home.push({
      unique_key: `${date}__${store.storeKey}`,
      snapshot_date: date,
      store_key: store.storeKey,
      group_key: store.groupKey,
      shop_name: store.shopName,
      home_update_time: j.home?.metrics?.updateTime || '',
      trade_amount_sar: num(j.home?.metrics?.tradeAmountSar),
      pay_user_count: num(j.home?.metrics?.payUserCount),
      goods_uv: num(j.home?.metrics?.goodsUv),
      sale_count: num(j.home?.metrics?.saleCount),
      in_transit_order_amount_sar: num(j.home?.metrics?.inTransitOrderAmountSar),
      pending_settlement_income_sar: num(j.home?.metrics?.pendingSettlementIncomeSar),
      settlement_abnormal_sar: num(j.home?.metrics?.settlementAbnormalSar),
      withdrawable_amount_sar: num(j.home?.metrics?.withdrawableAmountSar),
      source_file: source,
      raw_summary: compactJson(j.home || {}),
    });

    const finance = j.finance || {};
    for (const item of asArray(finance.incomeOverview?.info)) {
      const module = item.moduleEnum || item.module || item.title || '';
      rows.financeOverview.push({
        unique_key: `${date}__${store.storeKey}__${module}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        module_enum: module,
        title: item.title || '',
        tip: item.tip || '',
        seller_currency_code: item.sellerCurrencyCode || item.sellerCurrency || '',
        pay_amount: num(item.payAmount),
        seller_financing_deduction_amount: num(item.sellerFinancingDeductionAmount),
        ext_show_infos: compactJson(asArray(item.extShowInfos), 20000),
        source_file: source,
        raw_summary: compactJson(item),
      });
    }

    const stat = finance.noFinishStats?.info;
    if (stat && typeof stat === 'object' && !Array.isArray(stat)) {
      const module = stat.moduleEnum || 'NO_FINISH_ORDER';
      rows.financeStats.push({
        unique_key: `${date}__${store.storeKey}__${module}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        module_enum: module,
        tip_msg: stat.tipMsg || '',
        seller_currency_code: stat.sellerCurrency || stat.sellerCurrencyCode || '',
        income: num(stat.income),
        source_file: source,
        raw_summary: compactJson(stat),
      });
    }

    if (finance && Object.keys(finance).length) {
      const account = finance.accountPrivilege?.info || {};
      const allow = finance.allowViewReport?.info || {};
      const tags = asArray(finance.showTag?.info);
      const reportDelay = tags.find(x => x?.tagCode === 'REPORT_DELAY');
      rows.financeAccount.push({
        unique_key: `${date}__${store.storeKey}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        account_period_days: num(account.accountPeriodDays),
        privilege_provide_time: dateOnly(account.privilegeProvideTime),
        is_high_quality_supplier: boolLike(account.isHighQualitySupplier),
        privilege_config_type: account.privilegeConfigType ?? '',
        privilege_config_type_desc: account.privilegeConfigTypeDesc || '',
        allow_view_report: boolLike(allow.allowViewReport),
        report_delay_show: boolLike(reportDelay?.show),
        is_new_platform_gray: boolLike(finance.isNewPlatformGray?.info),
        source_file: source,
        raw_summary: compactJson({
          accountPrivilege: finance.accountPrivilege || {},
          allowViewReport: finance.allowViewReport || {},
          showTag: finance.showTag || {},
          isNewPlatformGray: finance.isNewPlatformGray || {},
          meta: finance.meta || {},
        }),
      });
    }

    for (const [idx, row] of asArray(finance.noFinishRows).entries()) {
      const financeOrderKey = `${date}__${store.storeKey}__${row.id || row.orderNo || idx}`;
      rows.financeNoFinishOrder.push({
        finance_order_key: financeOrderKey,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        finance_row_id: row.id || '',
        order_no: row.orderNo || '',
        check_order_no: row.checkOrderNo || '',
        bz_order_no: row.bzOrderNo || '',
        big_category: row.bigCategory ?? '',
        big_category_name: row.bigCategoryName || '',
        first_order_type: row.firstOrderType ?? '',
        second_order_type: row.secondOrderType ?? '',
        second_order_type_name: row.secondOrderTypeName || '',
        income_expenditure_type: row.incomeExpenditureType ?? '',
        seller_currency_code: row.sellerCurrencyCode || '',
        estimate_income_money_total: num(row.estimateIncomeMoneyTotal),
        site: row.site || '',
        store_type: row.storeType || '',
        check_status: row.checkStatus ?? '',
        order_delivery_time: dateOnly(row.orderDeliveryTime),
        goods_detail_count: asArray(row.goodsDetails).length,
        finance_detail_count: asArray(row.financeDetails).length,
        source_file: source,
        raw_summary: compactJson(row),
      });
      for (const [gidx, g] of asArray(row.goodsDetails).entries()) {
        const raw = pick(g, ['goodsSn', 'goodSn', 'supplierCode', 'supplier_code', 'goods_sn', 'skuSn', 'sku_sn']);
        rows.financeNoFinishGoods.push({
          finance_goods_key: `${financeOrderKey}__${pick(g, ['goodsId', 'entityId', 'skuCode', 'skuSn']) || gidx}`,
          finance_order_key: financeOrderKey,
          snapshot_date: date,
          store_key: store.storeKey,
          group_key: store.groupKey,
          shop_name: store.shopName,
          order_no: row.orderNo || '',
          standard_goods_sn: standardGoods(raw),
          raw_goods_sn: raw,
          spu: pick(g, ['spu', 'spuName', 'spu_name']),
          skc: pick(g, ['skc', 'skcName', 'skc_name']),
          sku_code: pick(g, ['skuCode', 'sku_code', 'skuSn', 'sku_sn']),
          goods_id: pick(g, ['goodsId', 'goods_id']),
          entity_id: pick(g, ['entityId', 'entity_id']),
          goods_title: pick(g, ['goodsTitle', 'goodsName', 'goods_name', 'productName']),
          quantity: num(pick(g, ['quantity', 'number', 'goodsQuantity', 'goodsNum'])),
          amount: num(pick(g, ['estimateIncomeMoney', 'estimateIncomeMoneyTotal', 'incomeMoney', 'goodsAmount', 'priceAmount', 'payAmount'])),
          currency_code: pick(g, ['sellerCurrencyCode', 'currencyCode', 'currency_code']) || row.sellerCurrencyCode || '',
          source_file: source,
          raw_summary: compactJson(g),
        });
      }
    }

    for (const a of j.afterSales?.rows || []) {
      const reasons = a.afterSalesReasonList || [];
      for (const [idx, g] of (a.afterSalesOrderGoodsInfos || [{}]).entries()) {
        const raw = g.goodsSn || '';
        rows.afterSales.push({
          after_sales_item_key: `${store.storeKey}__${a.aftersalesOrderNo || a.id}__${g.goodsId || g.entityId || idx}`,
          snapshot_date: date,
          store_key: store.storeKey,
          group_key: store.groupKey,
          shop_name: store.shopName,
          request_time: ts(a.g_zcs_requestTime || a.requestTime),
          aftersales_order_no: a.aftersalesOrderNo || '',
          return_order_no: a.returnOrderNo || '',
          order_no: a.orderNo || '',
          order_id: a.orderId || '',
          site: a.site || '',
          resolution_plan: a.aftersalesResolutionPlan ?? '',
          resolution_plan_name: a.aftersalesResolutionPlanName || '',
          order_sub_status: a.orderSubStatus ?? '',
          order_sub_status_name: a.orderSubStatusName || '',
          return_package_status: a.returnPackageStatus ?? '',
          return_package_status_name: a.returnPackageStatusName || '',
          reason_codes: joinUnique(reasons.map(x => x.reasonCode)),
          reason_names: joinUnique(reasons.map(x => x.reasonName)),
          price_amount_total: num(a.priceAmountTotal),
          currency_code: a.priceAmountCurrencyCode || g.priceAmountCurrencyCode || '',
          goods_id: g.goodsId || '',
          entity_id: g.entityId || '',
          standard_goods_sn: standardGoods(raw),
          raw_goods_sn: raw,
          skc: g.skc || g.skcName || '',
          sku_sn: g.skuSn || '',
          suffix: g.suffix || '',
          goods_title: g.goodsTitle || '',
          quantity: num(g.quantity),
          price_amount: num(g.priceAmount),
          return_expense: num(g.returnExpense),
          performance_price: num(g.performancePrice),
          freeze_amount: num(g.freezeAmount),
          estimated_income_amount: num(g.estimatedIncomeAmount),
          performance_fee_amount: num(g.performanceFeeAmount),
          return_expense_amount: num(g.returnExpenseAmount),
          appeal_status: g.appealStatus ?? a.appealStatus ?? '',
          source_file: source,
          raw_summary: compactJson({case: a, goods: g}),
        });
      }
    }

    for (const w of j.waybill?.rows || []) {
      const times = w.placeOrderStatusTimeResp?.placeOrderTimeInfo || [];
      const goods = w.placeOrderGoodsInfoRespList || [];
      const orders = w.placeOrderRespList || [];
      rows.waybill.push({
        package_key: `${store.storeKey}__${w.placeOrderPackageId || w.expressCode || w.expressNo}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        place_order_package_id: w.placeOrderPackageId || '',
        place_batch_code: w.placeBatchCode || '',
        express_code: w.expressCode || '',
        express_no: w.expressNo || '',
        warehouse_name: w.warehouseName || '',
        warehouse_code: w.warehouseCode || '',
        provider_name: w.placeProviderName || '',
        place_state: w.placeState ?? '',
        print_state: w.printState ?? '',
        performance_status: w.performanceStatus ?? '',
        show_status_code: w.placeOrderStatusTimeResp?.showStatusCode || '',
        show_status_desc: w.placeOrderStatusTimeResp?.showStatusDesc || '',
        tag_code: w.placeOrderStatusTimeResp?.tagCode || '',
        tag_desc: w.placeOrderStatusTimeResp?.tagDesc || '',
        collect_time: extractTime(times, 'COLLECT_TIME'),
        print_time: extractTime(times, 'PRINT_TIME'),
        weight: num(w.weight),
        length: num(w.length),
        width: num(w.width),
        height: num(w.height),
        estimate_performance_price: num(w.estimatePerformancePrice),
        currency_code: w.estimatePerformancePriceCurrencyCode || '',
        order_no_list: joinUnique(orders.map(x => x.orderNo)),
        goods_sn_list: joinUnique(goods.map(x => x.goodsSn)),
        skc_list: joinUnique(goods.map(x => x.skcName)),
        goods_quantity: goods.reduce((s, x) => s + Number(x.number || 0), 0),
        source_file: source,
        raw_summary: compactJson(w),
      });
    }

    for (const f of j.fulfillment?.lineRows || []) {
      const d = dateOnly(f.index_date) || String(f.index_date || '').slice(0, 10);
      if (!d) continue;
      rows.fulfillment.push({
        unique_key: `${store.storeKey}__${d}`,
        date: d,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        collect_ok_rate: rate(f.collect_ok_rate),
        collect_ok_cnt: num(f.collect_ok_cnt),
        collect_ok_total_cnt: num(f.collect_ok_total_cnt),
        sign_ok_rate: rate(f.sign_ok_rate),
        sign_ok_cnt: num(f.sign_ok_cnt),
        sign_ok_total_cnt: num(f.sign_ok_total_cnt),
        collect_bad_rate: rate(f.collect_bad_rate),
        collect_bad_cnt: num(f.collect_bad_cnt),
        collect_bad_total_cnt: num(f.collect_bad_total_cnt),
        sign_bad_rate: rate(f.sign_bad_rate),
        sign_bad_cnt: num(f.sign_bad_cnt),
        sign_bad_total_cnt: num(f.sign_bad_total_cnt),
        seller_cancel_rate: rate(f.seller_cancel_rate),
        seller_cancel_cnt: num(f.seller_cancel_cnt),
        seller_cancel_total_cnt: num(f.seller_cancel_total_cnt),
        delivery_timeout_rate: rate(f.delivery_timeout_rate),
        num_delivery_timeout: num(f.num_delivery_timeout),
        num_delivery: num(f.num_delivery),
        valid_track_rate: rate(f.valid_track_rate),
        total_order_item_cnt: num(f.total_order_item_cnt),
        source_file: source,
        raw_summary: compactJson(f),
      });
    }

    for (const inv of j.productInventory?.visibleStockRows || []) {
      const meta = bySpu.get(inv.spu_name) || {};
      const usable = num(inv.usable_inventory);
      rows.inventory.push({
        unique_key: `${date}__${store.storeKey}__${inv.spu_name}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        spu: inv.spu_name || '',
        standard_goods_sn: meta.standardGoodsSn || '',
        raw_goods_sn: meta.rawGoodsSn || '',
        skc_list: meta.skcList || '',
        sku_code_list: meta.skuCodeList || '',
        shelf_statuses: meta.shelfStatuses || '',
        inventory_quantity: num(inv.inventory_quantity),
        usable_inventory: usable,
        order_locked_quantity: num(inv.order_locked_quantity),
        pay_locked_quantity: num(inv.pay_locked_quantity),
        display_stock_low: usable !== null && usable <= 10,
        source_file: source,
        raw_summary: compactJson(inv),
      });
    }

    const mgmt = j.management?.comprehensive?.info || {};
    const goods = mgmt.goods || {};
    const flow = mgmt.flow || {};
    const service = mgmt.service || {};
    const purchase = mgmt.purchase || {};
    const metricDate = j.management?.meta?.metricDate || mgmt.dataDate || date;
    rows.management.push({
      unique_key: `${metricDate}__${store.storeKey}`,
      date: metricDate,
      snapshot_date: date,
      store_key: store.storeKey,
      group_key: store.groupKey,
      shop_name: store.shopName,
      push_skc_cnt: num(goods.pushSkcCnt1d),
      push_skc_success_rate: rate(goods.pushSkcSuccessRate1d),
      release_skc_cnt: num(goods.releaseSkcCnt1d),
      sale_cny_cd: num(flow.saleCnyCd),
      shop_click_rate: rate(flow.shopClickRate1d ?? flow.idxShopClickRate1d),
      shop_cart_rate: rate(flow.shopCartRate1d ?? flow.idxShopCartRate1d),
      shop_pay_rate: rate(flow.shopPayRate1d ?? flow.idxShopPayRate1d),
      refund_price: num(service.refundPrice1d),
      bad_comment_rate: rate(service.badCommentRate1d),
      raw_trade: compactJson(mgmt.trade || {}),
      raw_goods: compactJson(goods),
      raw_flow: compactJson(flow),
      raw_service: compactJson(service),
      raw_purchase: compactJson(purchase),
      source_file: source,
      raw_summary: compactJson(mgmt),
    });

    const mo = j.marketing?.overview?.info || {};
    rows.marketingOverview.push({
      unique_key: `${date}__${store.storeKey}__${mo.businessActivityTp ?? '1'}`,
      date,
      snapshot_date: date,
      store_key: store.storeKey,
      group_key: store.groupKey,
      shop_name: store.shopName,
      business_activity_type: mo.businessActivityTp ?? '1',
      sale_cnt: num(mo.saleCnt),
      sale_cnt_change_pct: rate(mo.saleCntChngPct),
      sale_amt: num(mo.saleAmt),
      sale_amt_change_pct: rate(mo.saleAmtChngPct),
      avg_goods_uv_idx: num(mo.avgGoodsUvIdx),
      avg_goods_uv_idx_change_pct: rate(mo.avgGoodsUvIdxChngPct),
      has_activity: bool(mo.hasActivity),
      last_campaign_date: dateOnly(mo.lastCampaignDate),
      source_file: source,
      raw_summary: compactJson(mo),
    });
    for (const c of j.marketing?.campaignRows || []) {
      rows.marketingCampaign.push({
        unique_key: `${date}__${store.storeKey}__${c.businessActivityId || c.activityName}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        business_activity_type: c.businessActivityTp ?? '',
        business_activity_id: c.businessActivityId ?? '',
        activity_name: c.activityName || '',
        active_status: c.activeStatus ?? '',
        start_date: dateOnly(c.startDate),
        end_date: dateOnly(c.endDate),
        active_product_cnt: num(c.activeProductCnt),
        avg_product_sale: num(c.avgProductSale),
        avg_product_amt: num(c.avgProductAmt),
        goods_uv: num(c.goodsUv),
        cart_uv: num(c.cartUv),
        sale_amt: num(c.saleAmt),
        source_file: source,
        raw_summary: compactJson(c),
      });
    }

    for (const q of j.quality?.rows || []) {
      const skc = q.skc_info?.skc_name || '';
      const map = bySkc.get(skc) || {};
      rows.quality.push({
        unique_key: `${date}__${store.storeKey}__${skc}`,
        snapshot_date: date,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        skc,
        spu: q.spu_info?.spu_name || map.spu || '',
        standard_goods_sn: map.standardGoodsSn || '',
        raw_goods_sn: map.rawGoodsSn || '',
        product_grade: q.product_grade ?? '',
        on_sale_status: q.on_sale_status ?? '',
        sales_volume_7d: num(q.sales_volume7_days),
        goods_quality_level: q.goods_quality_level ?? '',
        goods_quality_level_type: q.goods_quality_level_type ?? '',
        return_volume: num(q.return_volume),
        quality_return_volume: num(q.quality_return_volume),
        quality_return_rate: rate(q.quality_return_rate),
        show_bad_eval_rate: rate(q.show_bad_eval_rate),
        eval_cnt: num(q.eval_cnt),
        bad_eval_cnt: num(q.bad_eval_cnt),
        optimize_status: q.optimize_status ?? '',
        optimize_sub_status: q.optimize_sub_status ?? '',
        potential_quality_risks: Array.isArray(q.potential_quality_risks) ? q.potential_quality_risks.join(',') : String(q.potential_quality_risks || ''),
        source_file: source,
        raw_summary: compactJson(q),
      });
    }

    for (const c of j.comments?.rows || []) {
      const raw = c.goodSn || '';
      const commentZh = pick(c, [
        'goodsCommentContentZh',
        'goodsCommentContentZH',
        'goodsCommentContentCn',
        'goodsCommentContentCN',
        'translatedGoodsCommentContent',
        'goodsCommentTranslateContent',
        'goodsCommentTranslation',
      ]);
      const translationProvider = commentZh
        ? (c.translationProvider || SHEIN_TRANSLATION_PROVIDER)
        : '';
      rows.comments.push({
        comment_key: `${store.storeKey}__${c.commentId}`,
        store_key: store.storeKey,
        group_key: store.groupKey,
        shop_name: store.shopName,
        comment_id: c.commentId || '',
        comment_date: dateOnly(c.commentTime),
        comment_time: ts(c.commentTime),
        order_time: ts(c.orderTime),
        bill_no: c.billNo || '',
        supply_order_no: c.supplyOrderNo || '',
        standard_goods_sn: standardGoods(raw),
        raw_goods_sn: raw,
        spu: c.spu || '',
        skc: c.skc || '',
        sku: c.sku || '',
        goods_title: c.goodsTitle || '',
        goods_attribute: c.goodsAttribute || '',
        goods_comment_star: num(c.goodsCommentStar),
        goods_comment_star_name: c.goodsCommentStarName || '',
        goods_comment_content: c.goodsCommentContent || '',
        goods_comment_content_zh: commentZh,
        translation_provider: translationProvider,
        translated_at: commentZh ? (c.translatedAt || new Date().toISOString()) : '',
        bad_comment_labels: joinUnique((c.badCommentLabelList || []).map(x => x.labelName || x.name || x)),
        logistic_comment_star: num(c.logisticCommentStar),
        is_quality: c.isQuality ?? '',
        is_quality_label: c.isQualityLabel ?? '',
        is_quality_complaint: c.isQualityComplaint ?? '',
        source_file: source,
        raw_summary: compactJson(c),
      });
    }
  }
  return {files, rows};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {files, rows} = await collect(args);
  const cleanup = await cleanupSlices(args, files);
  const batches = [
    ['raw.local_file_catalog', ['file_path','file_kind','store_key','target_date','record_count','raw_meta'], ['file_path'], rows.catalog],
    ['fact.home_finance_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','home_update_time','trade_amount_sar','pay_user_count','goods_uv','sale_count','in_transit_order_amount_sar','pending_settlement_income_sar','settlement_abnormal_sar','withdrawable_amount_sar','source_file','raw_summary'], ['unique_key'], rows.home],
    ['fact.finance_income_overview_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','module_enum','title','tip','seller_currency_code','pay_amount','seller_financing_deduction_amount','ext_show_infos','source_file','raw_summary'], ['unique_key'], rows.financeOverview],
    ['fact.finance_module_stat_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','module_enum','tip_msg','seller_currency_code','income','source_file','raw_summary'], ['unique_key'], rows.financeStats],
    ['fact.finance_account_period_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','account_period_days','privilege_provide_time','is_high_quality_supplier','privilege_config_type','privilege_config_type_desc','allow_view_report','report_delay_show','is_new_platform_gray','source_file','raw_summary'], ['unique_key'], rows.financeAccount],
    ['fact.finance_no_finish_order', ['finance_order_key','snapshot_date','store_key','group_key','shop_name','finance_row_id','order_no','check_order_no','bz_order_no','big_category','big_category_name','first_order_type','second_order_type','second_order_type_name','income_expenditure_type','seller_currency_code','estimate_income_money_total','site','store_type','check_status','order_delivery_time','goods_detail_count','finance_detail_count','source_file','raw_summary'], ['finance_order_key'], rows.financeNoFinishOrder],
    ['fact.finance_no_finish_order_goods', ['finance_goods_key','finance_order_key','snapshot_date','store_key','group_key','shop_name','order_no','standard_goods_sn','raw_goods_sn','spu','skc','sku_code','goods_id','entity_id','goods_title','quantity','amount','currency_code','source_file','raw_summary'], ['finance_goods_key'], rows.financeNoFinishGoods],
    ['fact.after_sales_item', ['after_sales_item_key','snapshot_date','store_key','group_key','shop_name','request_time','aftersales_order_no','return_order_no','order_no','order_id','site','resolution_plan','resolution_plan_name','order_sub_status','order_sub_status_name','return_package_status','return_package_status_name','reason_codes','reason_names','price_amount_total','currency_code','goods_id','entity_id','standard_goods_sn','raw_goods_sn','skc','sku_sn','suffix','goods_title','quantity','price_amount','return_expense','performance_price','freeze_amount','estimated_income_amount','performance_fee_amount','return_expense_amount','appeal_status','source_file','raw_summary'], ['after_sales_item_key'], rows.afterSales],
    ['fact.waybill_package', ['package_key','snapshot_date','store_key','group_key','shop_name','place_order_package_id','place_batch_code','express_code','express_no','warehouse_name','warehouse_code','provider_name','place_state','print_state','performance_status','show_status_code','show_status_desc','tag_code','tag_desc','collect_time','print_time','weight','length','width','height','estimate_performance_price','currency_code','order_no_list','goods_sn_list','skc_list','goods_quantity','source_file','raw_summary'], ['package_key'], rows.waybill],
    ['fact.fulfillment_performance_daily', ['unique_key','date','snapshot_date','store_key','group_key','shop_name','collect_ok_rate','collect_ok_cnt','collect_ok_total_cnt','sign_ok_rate','sign_ok_cnt','sign_ok_total_cnt','collect_bad_rate','collect_bad_cnt','collect_bad_total_cnt','sign_bad_rate','sign_bad_cnt','sign_bad_total_cnt','seller_cancel_rate','seller_cancel_cnt','seller_cancel_total_cnt','delivery_timeout_rate','num_delivery_timeout','num_delivery','valid_track_rate','total_order_item_cnt','source_file','raw_summary'], ['unique_key'], rows.fulfillment],
    ['fact.visible_inventory_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','spu','standard_goods_sn','raw_goods_sn','skc_list','sku_code_list','shelf_statuses','inventory_quantity','usable_inventory','order_locked_quantity','pay_locked_quantity','display_stock_low','source_file','raw_summary'], ['unique_key'], rows.inventory],
    ['fact.management_indicator_daily', ['unique_key','date','snapshot_date','store_key','group_key','shop_name','push_skc_cnt','push_skc_success_rate','release_skc_cnt','sale_cny_cd','shop_click_rate','shop_cart_rate','shop_pay_rate','refund_price','bad_comment_rate','raw_trade','raw_goods','raw_flow','raw_service','raw_purchase','source_file','raw_summary'], ['unique_key'], rows.management],
    ['fact.marketing_overview_daily', ['unique_key','date','snapshot_date','store_key','group_key','shop_name','business_activity_type','sale_cnt','sale_cnt_change_pct','sale_amt','sale_amt_change_pct','avg_goods_uv_idx','avg_goods_uv_idx_change_pct','has_activity','last_campaign_date','source_file','raw_summary'], ['unique_key'], rows.marketingOverview],
    ['fact.marketing_campaign_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','business_activity_type','business_activity_id','activity_name','active_status','start_date','end_date','active_product_cnt','avg_product_sale','avg_product_amt','goods_uv','cart_uv','sale_amt','source_file','raw_summary'], ['unique_key'], rows.marketingCampaign],
    ['fact.quality_skc_snapshot', ['unique_key','snapshot_date','store_key','group_key','shop_name','skc','spu','standard_goods_sn','raw_goods_sn','product_grade','on_sale_status','sales_volume_7d','goods_quality_level','goods_quality_level_type','return_volume','quality_return_volume','quality_return_rate','show_bad_eval_rate','eval_cnt','bad_eval_cnt','optimize_status','optimize_sub_status','potential_quality_risks','source_file','raw_summary'], ['unique_key'], rows.quality],
    ['fact.product_comment', ['comment_key','store_key','group_key','shop_name','comment_id','comment_date','comment_time','order_time','bill_no','supply_order_no','standard_goods_sn','raw_goods_sn','spu','skc','sku','goods_title','goods_attribute','goods_comment_star','goods_comment_star_name','goods_comment_content','goods_comment_content_zh','translation_provider','translated_at','bad_comment_labels','logistic_comment_star','is_quality','is_quality_label','is_quality_complaint','source_file','raw_summary'], ['comment_key'], rows.comments],
  ];
  const results = [];
  for (const [table, columns, conflict, batchRows] of batches) {
    results.push(await upsertRows(args, table, columns, conflict, batchRows));
  }
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    files: files.length,
    cleanup,
    counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
    results,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
