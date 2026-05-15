#!/usr/bin/env node
/**
 * Load ET forwarder fetch artifacts into PostgreSQL BI warehouse.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_PREFIX_RE = /^(DL|DX|FY|LQ|NM|HL|JY|ZL|TS|MZ|CX|YJ|XL|QY|QH)[-_]?0*/i;

function parseArgs(argv) {
  const args = {
    manifest: path.join(ROOT, 'outputs', 'et-forwarder', 'latest-manifest.json'),
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = path.resolve(argv[++i]);
    else if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function ts(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  return s;
}

function text(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function boolStatus(v) {
  if (v === null || v === undefined || v === '') return '';
  return String(v);
}

function compactJson(value, maxLen = 18000) {
  const s = JSON.stringify(value ?? null);
  if (s.length <= maxLen) return s;
  return JSON.stringify({truncated: true, preview: s.slice(0, maxLen)});
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
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

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function psqlSpawnSpec(args) {
  if (process.platform === 'win32') {
    return {
      cmd: 'wsl',
      args: [
        '-d', args.distro,
        '--',
        'bash',
        '-lc',
        `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`,
      ],
    };
  }
  const dockerArgs = ['exec', '-i', args.container, 'psql', '-U', args.user, '-d', args.database, '-v', 'ON_ERROR_STOP=1'];
  if (envTruthy(process.env.SHEIN_DOCKER_USE_SUDO)) {
    return {cmd: 'sudo', args: ['docker', ...dockerArgs]};
  }
  return {cmd: process.env.SHEIN_DOCKER_BIN || 'docker', args: dockerArgs};
}

async function runPsqlScript(args, script) {
  const spec = psqlSpawnSpec(args);
  const child = spawn(spec.cmd, spec.args, {
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

async function upsertRows(args, table, columns, conflictColumns, rows) {
  if (!rows.length) return {table, rows: 0, skipped: true};
  if (conflictColumns.length) {
    const map = new Map();
    for (const row of rows) {
      const key = conflictColumns.map(c => String(row[c] ?? '')).join('\u001F');
      map.set(key, row);
    }
    rows = [...map.values()];
  }
  const stage = tempName(table);
  const nonConflict = columns.filter(c => !conflictColumns.includes(c) && c !== 'updated_at' && c !== 'loaded_at');
  const updateSet = [
    ...nonConflict.map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`),
    columns.includes('updated_at') ? 'updated_at = now()' : '',
    columns.includes('loaded_at') ? 'loaded_at = now()' : '',
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
  if (conflictColumns.length) {
    script += `ON CONFLICT (${conflictColumns.map(qIdent).join(', ')}) DO UPDATE SET\n    ${updateSet};\n`;
  }
  script += 'COMMIT;\n';
  if (args.dryRun) return {table, rows: rows.length, dryRun: true};
  await runPsqlScript(args, script);
  return {table, rows: rows.length};
}

function stripEtStorePrefix(value) {
  const s = String(value || '').trim();
  const stripped = s.replace(STORE_PREFIX_RE, '');
  return stripped && stripped !== s ? stripped : s;
}

function matchKey(value) {
  const key = String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  if (['2001', 'CM2001'].includes(key)) return '2001';
  if (['MZ7028', 'SK7028', '7028'].includes(key)) return 'SK7028';
  return key;
}

function normalizeEtProduct(row) {
  const candidates = [
    row.standard_goods_sn,
    row.ModelNumber,
    row.model_number,
    row.Barcode,
    row.barcode,
    row.SkuCode,
    row.sku_code,
  ].filter(Boolean);
  const expanded = [];
  for (const c of candidates) {
    const stripped = stripEtStorePrefix(c);
    if (stripped !== c) expanded.push(stripped);
    expanded.push(c);
  }
  const context = {goodsTitle: row.TitleCn || row.title_cn || row.GoodsTitle || row.goods_title || row.TitleEn || row.title_en || ''};
  let fallback = null;
  for (const c of expanded) {
    const detail = normalizeGoodsSnDetailed(c, context);
    if (!fallback) fallback = detail;
    if (!detail.needsReview) {
      return {standard_goods_sn: detail.canonical, match_key: matchKey(detail.canonical), normalize_detail: detail};
    }
  }
  const detail = fallback || normalizeGoodsSnDetailed('', context);
  return {standard_goods_sn: detail.canonical || '', match_key: matchKey(detail.canonical || ''), normalize_detail: detail};
}

function rowId(row, fields) {
  return fields.map(f => row?.[f]).filter(v => v !== undefined && v !== null && String(v) !== '').join('|');
}

function rawRowsForEndpoint(batch, endpoint, endpointData, sourceFile) {
  const rows = endpointData.rows || [];
  const idFields = {
    goods: ['GoodsId', 'Barcode'],
    sku_specification: ['SkuId', 'Barcode'],
    store_stock: ['FId', 'SkuId', 'StoreroomId'],
    box_stock: ['FId', 'BoxId', 'SkuId'],
    stock_running: ['FId'],
    ship_order: ['ShipOrderId'],
    ship_order_item: ['__parent_id', 'FId', 'Barcode'],
    ship_order_box: ['__parent_id', 'BoxId', 'Barcode'],
    box_list: ['BoxId'],
    box_item: ['__parent_id', 'FId', 'Barcode'],
    outbound: ['OutboundId'],
    outbound_item: ['__parent_id', 'FId', 'Barcode'],
    return_order: ['ReturnOrderId'],
    return_order_item: ['__parent_id', 'FId', 'Barcode'],
    allocate: ['AllocateId'],
    allocate_item: ['__parent_id', 'FId', 'Barcode'],
    store_receipt: ['ReceiptId'],
    change_pack: ['ChangeId'],
    box_damaged: ['DLNO'],
    income_bill: ['IncomeBillId'],
    income_bill_item: ['__parent_id', 'SkuCode', 'GoodsTitle'],
    income_summary: ['Sort', 'SortName', 'CountryId'],
    income_payment: ['FId', 'PayId'],
    freight_rate: ['TransportId', 'CountryId', 'SortId'],
  }[endpoint] || [];
  return rows.map((r, idx) => {
    const natural = rowId(r, idFields) || `${idx + 1}`;
    return {
      row_key: `${batch.batchId}:${endpoint}:${natural}`,
      batch_id: batch.batchId,
      endpoint_key: endpoint,
      parent_endpoint_key: endpointData.parentEndpoint || '',
      natural_id: natural,
      target_date: batch.targetDate,
      fetched_at: endpointData.fetchedAt || batch.createdAt,
      source_file: sourceFile,
      row_data: compactJson(r),
    };
  });
}

function baseProduct(row) {
  return normalizeEtProduct(row);
}

const C = {
  raw_batch: ['batch_id','mode','target_date','fetched_at','base_url','profile_dir','manifest_path','ok','sync_windows','raw_manifest'],
  raw_row: ['row_key','batch_id','endpoint_key','parent_endpoint_key','natural_id','target_date','fetched_at','source_file','row_data'],
  sku_master: ['goods_id','barcode','sku_code','model_number','standard_goods_sn','match_key','title_cn','title_en','brand_name','report_price','status','status_name','created_time','source_batch_id','raw_summary'],
  sku_spec: ['sku_id','barcode','sku_code','standard_goods_sn','match_key','sku_length','sku_width','sku_height','sku_volume','sku_weight','goods_length','goods_width','goods_height','goods_weight','goods_volume','status','created_time','source_batch_id','raw_summary'],
  store_stock: ['unique_key','snapshot_date','batch_id','f_id','sku_id','storeroom_id','storeroom_name','barcode','sku_code','standard_goods_sn','match_key','title_cn','title_en','quantity','real_quantity','s_b2b_quantity','s_b2b_real_quantity','fbn_quantity','fbn_real_quantity','raw_summary'],
  box_stock: ['unique_key','snapshot_date','batch_id','f_id','box_id','sku_id','goods_id','storeroom_id','storeroom_name','store_site_id','barcode','sku_code','standard_goods_sn','match_key','title_cn','title_en','quantity','real_quantity','sku_lock_status_name','site_lock_status_name','update_time','raw_summary'],
  stock_running: ['f_id','batch_id','storeroom_name','barcode','sku_code','standard_goods_sn','match_key','title_cn','title_en','quantity','balance','supply_price','sort','sort_name','from_id','created_time','raw_summary'],
  ship_order: ['ship_order_id','batch_id','storeroom_id','storeroom_title','transport_title','status','status_name','send_quantity','inland_quantity','overseas_quantity','platform_quantity','case_number','all_box_number','send_box_count','store_box_count','weight','volume','country_id','city_id','storage_area','create_time','check_time','ship_time','into_time','end_time','remark','waybill_code','raw_summary'],
  ship_order_item: ['unique_key','batch_id','ship_order_id','f_id','goods_id','sku_id','barcode','sku_code','model_number','standard_goods_sn','match_key','title_cn','title_en','goods_title','quantity','cost_price','price','receive1','receive2','receive3','raw_summary'],
  ship_order_box: ['unique_key','batch_id','ship_order_id','box_id','client_box_id','barcode','sku_code','standard_goods_sn','match_key','goods_title','case_quantity','real_quantity','storeroom_name','target_store','length','width','height','weight','etd','eta','raw_summary'],
  box: ['box_id','batch_id','client_box_id','ship_order_id','storeroom_name','city_name','transport_name','status_name','logistics_status','get_time','go_time','volume','weight','storage_area','raw_summary'],
  box_item: ['unique_key','batch_id','box_id','f_id','goods_id','sku_id','barcode','sku_code','model_number','standard_goods_sn','match_key','goods_title','case_quantity','real_quantity','raw_summary'],
  outbound: ['outbound_id','batch_id','storeroom_id','storeroom_title','from_id','status','status_name','sku_count','box_count','create_time','reserve_time','outbound_time','logistics_title','remark','waybill_code','file_url','raw_summary'],
  outbound_item: ['unique_key','batch_id','outbound_id','f_id','sku_id','barcode','sku_code','standard_goods_sn','match_key','title_cn','title_en','quantity','raw_summary'],
  return_order: ['return_order_id','batch_id','store_name_out','store_name_in','rtv','shipment_number','status','status_name','to_pickup_name','to_instock_name','is_worn_in_name','out_quantity','in_quantity','all_weight','reserve_time','create_time','operator','reason','reason_remark','raw_summary'],
  return_order_item: ['unique_key','batch_id','return_order_id','f_id','goods_id','sku_id','barcode','sku_code','standard_goods_sn','match_key','goods_title','quantity','instock','differ','create_time','remark','raw_summary'],
  allocate: ['allocate_id','batch_id','from_id','out_storeroom','out_storeroom_id','in_storeroom','in_storeroom_id','status','status_name','case_number','real_number','logistics_name','logistics_no','create_time','reserve_time','raw_summary'],
  allocate_item: ['unique_key','batch_id','allocate_id','f_id','goods_id','sku_id','barcode','sku_code','standard_goods_sn','match_key','goods_title','quantity','pick_amount','refuse_amount','receive_quantity','stock','raw_summary'],
  store_receipt: ['receipt_id','batch_id','storeroom_name','sort_name','from_id','total_plan_quantity','total_quantity','remark','create_time','end_time','status_name','raw_summary'],
  change_pack: ['change_id','batch_id','damage_store','pack_store','single_store','change_sort_name','pack_sort_name','barcode','standard_goods_sn','match_key','quantity','quantity2','money','status','status_name','create_time','raw_summary'],
  box_damaged: ['dlno','batch_id','box_id','oversea_id','ship_order_id','title','allocate_id','allocate_name','allocate_status','box_damaged_status','box_damaged_name','sort_name','barcode','standard_goods_sn','match_key','sku_qty','check_qty','differ','create_time','raw_summary'],
  income_bill: ['income_bill_id','batch_id','client_from_id','oversea_id','source_type','sort','sort_name','status','status_name','freight','tariff','other_income','cq_money','in_money','out_money','pay_id','pay_sort','ship_time','create_time','push_time','first_date','billing_period_date','remark','waybill_code','raw_summary'],
  income_bill_item: ['unique_key','batch_id','income_bill_id','goods_title','sku_code','standard_goods_sn','match_key','quantity','raw_summary'],
  income_summary: ['unique_key','batch_id','target_date','sort','sort_name','country_id','country_name','total_freight','total_tariff','total_other_income','total_cq_money','total_fee','total_in_money','total_out_money','total_unmatured','total_expire','total_overdue','raw_summary'],
  income_payment: ['f_id','batch_id','income_bill_id','pay_id','pay_sort','pay_money','currency','status','status_name','create_time','pay_time','invoice_no','raw_summary'],
  freight_rate: ['unique_key','batch_id','transport_id','transport_title','country_id','country_title','sort_id','sort_title','sort_status','tier_a','tier_b','tier_c','tier_d','tier_e','raw_summary'],
};

function mapEndpoint(endpoint, batch, endpointData) {
  const rows = endpointData.rows || [];
  const b = batch.batchId;
  const d = batch.targetDate;
  switch (endpoint) {
    case 'goods':
      return {table: 'fact.et_sku_master', columns: C.sku_master, conflict: ['goods_id'], rows: rows.map(r => {
        const p = baseProduct(r);
        return {goods_id: text(r.GoodsId || r.Barcode), barcode: text(r.Barcode), sku_code: text(r.SkuCode), model_number: text(r.ModelNumber), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), brand_name: text(r.BrandName), report_price: num(r.ReportPrice), status: boolStatus(r.Status), status_name: text(r.StatusName || r.Status), created_time: ts(r.Createtime), source_batch_id: b, raw_summary: compactJson(r)};
      })};
    case 'sku_specification':
      return {table: 'fact.et_sku_specification', columns: C.sku_spec, conflict: ['sku_id'], rows: rows.map(r => {
        const p = baseProduct(r);
        return {sku_id: text(r.SkuId || r.Barcode), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, sku_length: num(r.SkuLength), sku_width: num(r.SkuWidth), sku_height: num(r.SkuHeight), sku_volume: num(r.SkuVolume), sku_weight: num(r.SkuWeight), goods_length: num(r.GoodsLength), goods_width: num(r.GoodsWidth), goods_height: num(r.GoodsHeight), goods_weight: num(r.GoodsWeight), goods_volume: num(r.GoodsVolume), status: boolStatus(r.Status), created_time: ts(r.Createtime), source_batch_id: b, raw_summary: compactJson(r)};
      })};
    case 'store_stock':
      return {table: 'fact.et_store_stock_snapshot', columns: C.store_stock, conflict: ['unique_key'], rows: rows.map((r, i) => {
        const p = baseProduct(r);
        return {unique_key: `${b}:${r.FId || r.SkuId || i}`, snapshot_date: d, batch_id: b, f_id: text(r.FId), sku_id: text(r.SkuId), storeroom_id: text(r.StoreroomId), storeroom_name: text(r.StoreroomName), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), quantity: num(r.Quantity), real_quantity: num(r.RealQuantity), s_b2b_quantity: num(r.SB2BQuantity), s_b2b_real_quantity: num(r.SB2BRealQuantity), fbn_quantity: num(r.FBNQuantity), fbn_real_quantity: num(r.FBNRealQuantity), raw_summary: compactJson(r)};
      })};
    case 'box_stock':
      return {table: 'fact.et_box_stock_snapshot', columns: C.box_stock, conflict: ['unique_key'], rows: rows.map((r, i) => {
        const p = baseProduct(r);
        return {unique_key: `${b}:${r.FId || r.BoxId || r.SkuId || i}`, snapshot_date: d, batch_id: b, f_id: text(r.FId), box_id: text(r.BoxId), sku_id: text(r.SkuId), goods_id: text(r.GoodsId), storeroom_id: text(r.StoreroomId), storeroom_name: text(r.StoreroomName), store_site_id: text(r.StoreSiteId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), quantity: num(r.Quantity), real_quantity: num(r.RealQuantity), sku_lock_status_name: text(r.SkuLockStatusName), site_lock_status_name: text(r.SiteLockStatusName), update_time: ts(r.UpdateTime), raw_summary: compactJson(r)};
      })};
    case 'stock_running':
      return {table: 'fact.et_stock_running', columns: C.stock_running, conflict: ['f_id'], rows: rows.map((r, i) => {
        const p = baseProduct(r);
        return {f_id: text(r.FId || `${b}:${i}`), batch_id: b, storeroom_name: text(r.StoreroonName || r.StoreroomName), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), quantity: num(r.Quantity), balance: num(r.Balance), supply_price: num(r.SupplyPrice), sort: text(r.Sort), sort_name: text(r.SortName), from_id: text(r.FromId), created_time: ts(r.Createtime), raw_summary: compactJson(r)};
      })};
    case 'ship_order':
      return {table: 'fact.et_ship_order', columns: C.ship_order, conflict: ['ship_order_id'], rows: rows.map(r => ({ship_order_id: text(r.ShipOrderId), batch_id: b, storeroom_id: text(r.StoreroomId), storeroom_title: text(r.StoreroomTitle), transport_title: text(r.TransportTitle), status: boolStatus(r.Status), status_name: text(r.StatusName), send_quantity: num(r.SendQuantity), inland_quantity: num(r.InlandQuantity), overseas_quantity: num(r.OverseasQuantity), platform_quantity: num(r.PlatformQuantity), case_number: num(r.CaseNumber), all_box_number: num(r.AllBoxNumber), send_box_count: num(r.SendBoxCount), store_box_count: num(r.StoreBoxCount), weight: num(r.Weight), volume: num(r.Volume), country_id: text(r.CountryId), city_id: text(r.CityId), storage_area: text(r.StorageArea), create_time: ts(r.CreateTime), check_time: ts(r.CheckTime), ship_time: ts(r.ShipTime), into_time: ts(r.IntoTime), end_time: ts(r.EndTime), remark: text(r.Remark), waybill_code: text(r.WaybillCode), raw_summary: compactJson(r)}))};
    case 'ship_order_item':
      return {table: 'fact.et_ship_order_item', columns: C.ship_order_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.ShipOrderId); return {unique_key: `${parent}:${r.FId || r.Barcode || i}`, batch_id: b, ship_order_id: parent, f_id: text(r.FId), goods_id: text(r.GoodsId), sku_id: text(r.SkuId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), model_number: text(r.ModelNumber), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), goods_title: text(r.GoodsTitle), quantity: num(r.Quantity), cost_price: num(r.CostPrice), price: num(r.Price), receive1: num(r.Receive1), receive2: num(r.Receive2), receive3: num(r.Receive3), raw_summary: compactJson(r)}; })};
    case 'ship_order_box':
      return {table: 'fact.et_ship_order_box', columns: C.ship_order_box, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.ShipOrderId); return {unique_key: `${parent}:${r.BoxId || r.Barcode || i}`, batch_id: b, ship_order_id: parent, box_id: text(r.BoxId), client_box_id: text(r.ClientBoxId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, goods_title: text(r.GoodsTitle), case_quantity: num(r.CaseQuantity), real_quantity: num(r.RealQuantity), storeroom_name: text(r.StoreroomName), target_store: text(r.TargetStore), length: num(r.Length), width: num(r.Width), height: num(r.Height), weight: num(r.Weight), etd: ts(r.ETD), eta: ts(r.ETA), raw_summary: compactJson(r)}; })};
    case 'box_list':
      return {table: 'fact.et_box', columns: C.box, conflict: ['box_id'], rows: rows.map(r => ({box_id: text(r.BoxId), batch_id: b, client_box_id: text(r.ClientBoxId), ship_order_id: text(r.ShipOrderId), storeroom_name: text(r.StoreroomName), city_name: text(r.CityName), transport_name: text(r.TransportName), status_name: text(r.StatusName), logistics_status: text(r.LogisticsStatus), get_time: ts(r.GetTime), go_time: ts(r.GoTime), volume: num(r.Volume), weight: num(r.Weight), storage_area: text(r.StorageArea), raw_summary: compactJson(r)}))};
    case 'box_item':
      return {table: 'fact.et_box_item', columns: C.box_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.BoxId); return {unique_key: `${parent}:${r.FId || r.Barcode || i}`, batch_id: b, box_id: parent, f_id: text(r.FId), goods_id: text(r.GoodsId), sku_id: text(r.SkuId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), model_number: text(r.ModelNumber), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, goods_title: text(r.GoodsTitle), case_quantity: num(r.CaseQuantity), real_quantity: num(r.RealQuantity), raw_summary: compactJson(r)}; })};
    case 'outbound':
      return {table: 'fact.et_outbound', columns: C.outbound, conflict: ['outbound_id'], rows: rows.map(r => ({outbound_id: text(r.OutboundId), batch_id: b, storeroom_id: text(r.StoreroomId), storeroom_title: text(r.StoreroomTitle), from_id: text(r.FromId), status: boolStatus(r.Status), status_name: text(r.StatusName), sku_count: num(r.SkuCount), box_count: num(r.BoxCount), create_time: ts(r.Createtime), reserve_time: ts(r.ReserveTime), outbound_time: ts(r.OutboundTime), logistics_title: text(r.LogisticsTitle), remark: text(r.Remark), waybill_code: text(r.WaybillCode), file_url: text(r.FileUrl), raw_summary: compactJson(r)}))};
    case 'outbound_item':
      return {table: 'fact.et_outbound_item', columns: C.outbound_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.OutboundId); return {unique_key: `${parent}:${r.FId || r.Barcode || i}`, batch_id: b, outbound_id: parent, f_id: text(r.FId), sku_id: text(r.SkuId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, title_cn: text(r.TitleCn), title_en: text(r.TitleEn), quantity: num(r.Quantity), raw_summary: compactJson(r)}; })};
    case 'return_order':
      return {table: 'fact.et_return_order', columns: C.return_order, conflict: ['return_order_id'], rows: rows.map(r => ({return_order_id: text(r.ReturnOrderId), batch_id: b, store_name_out: text(r.StoreNameOut), store_name_in: text(r.StoreNameIn), rtv: text(r.RTV), shipment_number: text(r.ShipmentNumber), status: boolStatus(r.Status), status_name: text(r.StatusName), to_pickup_name: text(r.ToPickupName), to_instock_name: text(r.ToInStockName), is_worn_in_name: text(r.IsWornInName), out_quantity: num(r.OutQuantity), in_quantity: num(r.InQuantity), all_weight: num(r.AllWeight), reserve_time: ts(r.ReserveTime), create_time: ts(r.CreateTime), operator: text(r.Operator), reason: text(r.Reason), reason_remark: text(r.ReasonRemark), raw_summary: compactJson(r)}))};
    case 'return_order_item':
      return {table: 'fact.et_return_order_item', columns: C.return_order_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.ReturnOrderId); return {unique_key: `${parent}:${r.FId || r.Barcode || i}`, batch_id: b, return_order_id: parent, f_id: text(r.FId), goods_id: text(r.GoodsId), sku_id: text(r.SkuId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, goods_title: text(r.GoodsTitle), quantity: num(r.Quantity), instock: num(r.InStock), differ: num(r.Differ), create_time: ts(r.CreateTime), remark: text(r.Remark), raw_summary: compactJson(r)}; })};
    case 'allocate':
      return {table: 'fact.et_allocate', columns: C.allocate, conflict: ['allocate_id'], rows: rows.map(r => ({allocate_id: text(r.AllocateId), batch_id: b, from_id: text(r.FromId), out_storeroom: text(r.OutStoreroom), out_storeroom_id: text(r.OutStoreroomId), in_storeroom: text(r.InStoreroom), in_storeroom_id: text(r.InStoreroomId), status: boolStatus(r.Status), status_name: text(r.StatusName), case_number: num(r.CaseNumber), real_number: num(r.RealNumber), logistics_name: text(r.LogisticsName), logistics_no: text(r.LogisticsNo), create_time: ts(r.Createtime || r.CreateTime), reserve_time: ts(r.ReserveTime), raw_summary: compactJson(r)}))};
    case 'allocate_item':
      return {table: 'fact.et_allocate_item', columns: C.allocate_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct(r); const parent = text(r.__parent_id || r.AllocateId); return {unique_key: `${parent}:${r.FId || r.Barcode || i}`, batch_id: b, allocate_id: parent, f_id: text(r.FId), goods_id: text(r.GoodsId), sku_id: text(r.SkuId), barcode: text(r.Barcode), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, goods_title: text(r.GoodsTitle), quantity: num(r.Quantity), pick_amount: num(r.PickAmount), refuse_amount: num(r.RefuseAmount), receive_quantity: num(r.ReceiveQuantity), stock: num(r.Stock), raw_summary: compactJson(r)}; })};
    case 'store_receipt':
      return {table: 'fact.et_store_receipt', columns: C.store_receipt, conflict: ['receipt_id'], rows: rows.map((r, i) => ({receipt_id: text(r.ReceiptId || `${b}:${i}`), batch_id: b, storeroom_name: text(r.StoreroomName), sort_name: text(r.SortName), from_id: text(r.FromId), total_plan_quantity: num(r.TotalPlanQuantity), total_quantity: num(r.TotalQuantity), remark: text(r.Remark), create_time: ts(r.Createtime || r.CreateTime), end_time: ts(r.EndTime), status_name: text(r.StatusName), raw_summary: compactJson(r)}))};
    case 'change_pack':
      return {table: 'fact.et_change_pack', columns: C.change_pack, conflict: ['change_id'], rows: rows.map((r, i) => { const p = baseProduct(r); return {change_id: text(r.ChangeId || `${b}:${i}`), batch_id: b, damage_store: text(r.DamageStore), pack_store: text(r.PackStore), single_store: text(r.SingleStore), change_sort_name: text(r.ChangeSortName), pack_sort_name: text(r.PackSortName), barcode: text(r.Barcode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, quantity: num(r.Quantity), quantity2: num(r.Quantity2), money: num(r.Money), status: boolStatus(r.Status), status_name: text(r.StatusName), create_time: ts(r.CreateTime), raw_summary: compactJson(r)}; })};
    case 'box_damaged':
      return {table: 'fact.et_box_damaged', columns: C.box_damaged, conflict: ['dlno'], rows: rows.map((r, i) => { const p = baseProduct(r); return {dlno: text(r.DLNO || `${b}:${i}`), batch_id: b, box_id: text(r.BoxId), oversea_id: text(r.OverseaId), ship_order_id: text(r.ShipOrderId), title: text(r.Title), allocate_id: text(r.AllocateId), allocate_name: text(r.AllocateName), allocate_status: text(r.AllocateStatus), box_damaged_status: text(r.BoxDamagedStatus), box_damaged_name: text(r.BoxDamagedName), sort_name: text(r.SortName), barcode: text(r.Barcode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, sku_qty: num(r.SkuQty), check_qty: num(r.CheckQty), differ: num(r.Differ), create_time: ts(r.CreateTime), raw_summary: compactJson(r)}; })};
    case 'income_bill':
      return {table: 'fact.et_income_bill', columns: C.income_bill, conflict: ['income_bill_id'], rows: rows.map(r => ({income_bill_id: text(r.IncomeBillId), batch_id: b, client_from_id: text(r.ClientFromId), oversea_id: text(r.OverseaId), source_type: text(r.SourceType), sort: boolStatus(r.Sort), sort_name: text(r.SortName), status: boolStatus(r.Status), status_name: text(r.StatusName), freight: num(r.Freight), tariff: num(r.Tariff), other_income: num(r.OtherIncome), cq_money: num(r.CqMoney), in_money: num(r.InMoney), out_money: num(r.OutMoney), pay_id: text(r.PayId), pay_sort: text(r.PaySort), ship_time: ts(r.ShipTime), create_time: ts(r.Createtime), push_time: ts(r.PushTime), first_date: ts(r.FirstDate), billing_period_date: ts(r.BillingPeriodDate), remark: text(r.Remark), waybill_code: text(r.WaybillCode), raw_summary: compactJson(r)}))};
    case 'income_bill_item':
      return {table: 'fact.et_income_bill_item', columns: C.income_bill_item, conflict: ['unique_key'], rows: rows.map((r, i) => { const p = baseProduct({...r, SkuCode: r.SkuCode || r.Barcode}); const parent = text(r.__parent_id || r.IncomeBillId); return {unique_key: `${parent}:${r.SkuCode || r.GoodsTitle || i}`, batch_id: b, income_bill_id: parent, goods_title: text(r.GoodsTitle), sku_code: text(r.SkuCode), standard_goods_sn: p.standard_goods_sn, match_key: p.match_key, quantity: num(r.Quantity), raw_summary: compactJson(r)}; })};
    case 'income_summary':
      return {table: 'fact.et_income_bill_summary', columns: C.income_summary, conflict: ['unique_key'], rows: rows.map((r, i) => ({unique_key: `${b}:${r.Sort || r.SortName || i}:${r.CountryId || ''}`, batch_id: b, target_date: d, sort: boolStatus(r.Sort), sort_name: text(r.SortName), country_id: text(r.CountryId), country_name: text(r.CountryName), total_freight: num(r.TotalFreight), total_tariff: num(r.TotalTariff), total_other_income: num(r.TotalOtherIncome), total_cq_money: num(r.TotalCqMoney), total_fee: num(r.TotalFee), total_in_money: num(r.TotalInMoney), total_out_money: num(r.TotalOutMoney), total_unmatured: num(r.TotalUnmatured), total_expire: num(r.TotalExpire), total_overdue: num(r.TotalOverdue), raw_summary: compactJson(r)}))};
    case 'income_payment':
      return {table: 'fact.et_income_payment', columns: C.income_payment, conflict: ['f_id'], rows: rows.map((r, i) => ({f_id: text(r.FId || `${b}:${i}`), batch_id: b, income_bill_id: text(r.IncomeBillId), pay_id: text(r.PayId), pay_sort: text(r.PaySort), pay_money: num(r.PayMoney), currency: text(r.Currency || r.CurrencyId), status: boolStatus(r.Status), status_name: text(r.StatusName), create_time: ts(r.Createtime || r.CreateTime), pay_time: ts(r.PayTime), invoice_no: text(r.InvoiceNo), raw_summary: compactJson(r)}))};
    case 'freight_rate':
      return {table: 'fact.et_freight_rate', columns: C.freight_rate, conflict: ['unique_key'], rows: rows.map((r, i) => ({unique_key: `${r.TransportId || ''}:${r.CountryId || ''}:${r.SortId || i}`, batch_id: b, transport_id: text(r.TransportId), transport_title: text(r.TransportTitle), country_id: text(r.CountryId), country_title: text(r.CountryTitle), sort_id: text(r.SortId), sort_title: text(r.SortTitle), sort_status: text(r.SortStatus), tier_a: text(r.A), tier_b: text(r.B), tier_c: text(r.C), tier_d: text(r.D), tier_e: text(r.E), raw_summary: compactJson(r)}))};
    default:
      return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readJson(args.manifest);
  const manifestDir = path.dirname(args.manifest);
  const batchRow = {
    batch_id: manifest.batchId,
    mode: manifest.mode,
    target_date: manifest.targetDate,
    fetched_at: manifest.createdAt,
    base_url: manifest.baseUrl,
    profile_dir: manifest.profileDir,
    manifest_path: rel(args.manifest),
    ok: manifest.ok,
    sync_windows: compactJson(manifest.windows || {}),
    raw_manifest: compactJson(manifest),
  };
  const results = [];
  results.push(await upsertRows(args, 'raw.et_fetch_batch', C.raw_batch, ['batch_id'], [batchRow]));

  const rawRows = [];
  const structured = [];
  for (const [endpoint, file] of Object.entries(manifest.files || {})) {
    const full = path.resolve(manifestDir, file);
    if (!fssync.existsSync(full)) continue;
    const data = await readJson(full);
    rawRows.push(...rawRowsForEndpoint(manifest, endpoint, data, rel(full)));
    const mapped = mapEndpoint(endpoint, manifest, data);
    if (mapped && mapped.rows.length) structured.push(mapped);
  }
  results.push(await upsertRows(args, 'raw.et_endpoint_row', C.raw_row, ['row_key'], rawRows));
  for (const m of structured) {
    results.push(await upsertRows(args, m.table, m.columns, m.conflict, m.rows));
  }
  console.log(JSON.stringify({ok: true, manifest: args.manifest, results}, null, 2));
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
