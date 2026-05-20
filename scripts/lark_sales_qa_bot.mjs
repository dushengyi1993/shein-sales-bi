#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = process.env.SHEIN_QA_BI_DATA || path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const STATE_DIR = process.env.SHEIN_QA_STATE_DIR || path.join(ROOT, 'state', 'lark_sales_qa_bot');
const CODEX_CONFIG_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const LLM_TIMEOUT_MS = Number(process.env.SHEIN_QA_LLM_TIMEOUT_MS || 45_000);
const LLM_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_LLM_ENABLED || '1').toLowerCase());
const CODEX_GATEWAY_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CODEX_GATEWAY_ENABLED || '1').toLowerCase());
const CODEX_GATEWAY_TIMEOUT_MS = Number(process.env.SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS || 120_000);
const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';
const LARK_CLI_PREFIX_ARGS = parseArgList(process.env.LARK_CLI_PREFIX_ARGS || '');
const CHART_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CHART_ENABLED || '1').toLowerCase());
const CHART_PYTHON = process.env.SHEIN_QA_CHART_PYTHON || 'python3';
const CHART_SCRIPT = process.env.SHEIN_QA_CHART_SCRIPT || path.join(ROOT, 'scripts', 'render_lark_qa_chart.py');
const CHART_DIR = process.env.SHEIN_QA_CHART_DIR || path.join(STATE_DIR, 'charts');
const STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ'];

function parseArgList(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(v => String(v));
  } catch {}
  return text.split(/\s+/).filter(Boolean);
}

function parseArgs(argv) {
  const args = {answer: '', consume: false, dryRun: false, renderChart: '', chartOutput: ''};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answer') args.answer = argv[++i] || '';
    else if (a === '--consume') args.consume = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--render-chart') args.renderChart = argv[++i] || '';
    else if (a === '--chart-output') args.chartOutput = argv[++i] || '';
  }
  return args;
}

async function readData() {
  return JSON.parse((await fs.readFile(DATA_PATH, 'utf8')).replace(/^\uFEFF/, ''));
}

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function moneySar(value) {
  return `${n(value).toLocaleString('en-US', {maximumFractionDigits: 2})} SAR`;
}

function intNum(value) {
  return `${Math.round(n(value)).toLocaleString('en-US')}`;
}

function addDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pickDate(text, data) {
  const latest = data.dates?.salesDate || data.rankings?.salesSummary?.map(r => r.end_date).sort().at(-1) || '';
  const explicit = String(text).match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0];
  if (explicit) {
    const nums = explicit.match(/\d+/g).map(Number);
    return `${nums[0]}-${String(nums[1]).padStart(2, '0')}-${String(nums[2]).padStart(2, '0')}`;
  }
  if (/前天/.test(text)) return addDays(latest, -2);
  if (/昨天|昨日/.test(text)) return addDays(latest, -1);
  return latest;
}

function pickStore(text) {
  const upper = String(text || '').toUpperCase();
  for (const key of STORE_KEYS) {
    if (new RegExp(`(^|[^A-Z0-9])${key}([^A-Z0-9]|$)`).test(upper)) return key;
  }
  if (/DSY/i.test(upper)) return 'DSY';
  if (/LGM/i.test(upper)) return 'LGM';
  return '';
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function decodeTextContent(content) {
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  const raw = String(content || '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed.text;
  } catch {}
  return raw;
}

function normalizeEventPayload(input) {
  const root = input?.event || input || {};
  const message = root.message || root;
  return {
    ...root,
    ...message,
    event_id: input?.event_id || root.event_id || message.event_id || '',
    message_id: root.message_id || message.message_id || message.id || '',
    chat_type: root.chat_type || message.chat_type || '',
    message_type: root.message_type || message.message_type || '',
    sender_type: root.sender_type || root.sender?.sender_type || input?.sender?.sender_type || '',
    sender_id: root.sender_id || root.sender?.sender_id?.open_id || root.sender?.sender_id?.union_id || '',
    content: decodeTextContent(root.content ?? message.content),
  };
}

function findProduct(text, data) {
  const q = normalizeText(text).toLowerCase();
  if (!q) return '';
  const products = new Set();
  const collect = rows => {
    for (const row of rows || []) {
      for (const key of ['standard_goods_sn', 'goods_sn', 'product', 'product_name']) {
        if (row?.[key]) products.add(String(row[key]));
      }
    }
  };
  collect(data.rankings?.dailyProducts);
  collect(data.rankings?.dailyStoreProducts);
  collect(data.storeLinks || data.links);
  collect(data.matrix);
  collect(data.actions);
  collect(data.products);
  for (const row of data.rankings?.dailyProducts || []) {
    if (row.standard_goods_sn) products.add(String(row.standard_goods_sn));
  }
  const sorted = [...products].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (q.includes(p.toLowerCase())) return p;
  }
  const code = q.match(/[a-z]{1,5}[- ]?\d{2,6}[a-z]?/i)?.[0]?.replace(/\s+/g, '-').toUpperCase();
  if (code) {
    const hit = sorted.find(p => p.toUpperCase().includes(code));
    if (hit) return hit;
  }
  return '';
}

function extractUserMessages(text) {
  const raw = String(text || '');
  const matches = [...raw.matchAll(/用户：([\s\S]*?)(?=\n(?:用户|智能体)：|$)/g)].map(m => normalizeText(m[1]));
  return matches.filter(Boolean);
}

function detectionTexts(text) {
  const userMessages = extractUserMessages(text);
  if (!userMessages.length) return [normalizeText(text)];
  const latest = userMessages[userMessages.length - 1] || '';
  const previous = userMessages.slice(0, -1).reverse().join(' ');
  return [latest, previous, normalizeText(text)].filter(Boolean);
}

function pickStores(text) {
  const upper = String(text || '').toUpperCase();
  const found = [];
  for (const key of STORE_KEYS) {
    if (new RegExp(`(^|[^A-Z0-9])${key}([^A-Z0-9]|$)`).test(upper)) found.push(key);
  }
  if (/DSY/i.test(upper)) found.push('DSY');
  if (/LGM/i.test(upper)) found.push('LGM');
  return [...new Set(found)];
}

function pickStoresSmart(text) {
  for (const part of detectionTexts(text)) {
    const stores = pickStores(part);
    if (stores.length) return stores;
  }
  return [];
}

function findProductSmart(text, data) {
  for (const part of detectionTexts(text)) {
    const product = findProduct(part, data);
    if (product) return product;
  }
  return '';
}

function extractNumberHints(text) {
  return [...new Set((String(text || '').match(/(?:\d{1,3}(?:,\d{3})+|\d{3,7})(?:\.\d+)?/g) || [])
    .map(x => Number(String(x).replace(/,/g, '')))
    .filter(x => Number.isFinite(x) && x >= 10))]
    .slice(0, 40);
}

function extractSkcHints(text) {
  return [...new Set((String(text || '').match(/\b(?:sv|sb)\d{8,}\b/ig) || [])
    .map(x => x.trim()))]
    .slice(0, 40);
}

function valueMatchesNumberHint(value, hints) {
  const actual = Number(value);
  return Number.isFinite(actual) && hints.some(h => Math.abs(actual - h) < 0.0001);
}

function rowMatchesStores(row, stores) {
  if (!stores.length) return true;
  return stores.some(store => {
    if (store === 'DSY' || store === 'LGM') return row.group_key === store;
    return row.store_key === store;
  });
}

function linkRelevanceScore(row, {stores, product, numberHints, latestNumberHints, skcHints}) {
  let score = 0;
  if (stores.length && rowMatchesStores(row, stores)) score += 2000;
  if (product && (row.standard_goods_sn === product || String(row.standard_goods_sn || '').includes(product))) score += 2000;
  if (skcHints.some(x => String(row.skc || '').toLowerCase() === x.toLowerCase())) score += 100000;
  if ((latestNumberHints || []).some(h =>
    valueMatchesNumberHint(row.c30_eps_uv, [h]) ||
    valueMatchesNumberHint(row.c30_goods_uv, [h]) ||
    valueMatchesNumberHint(row.goods_uv, [h]) ||
    valueMatchesNumberHint(row.c30_sale_cnt, [h]) ||
    valueMatchesNumberHint(row.c7_sale_cnt, [h])
  )) score += 150000;
  if (numberHints.some(h =>
    valueMatchesNumberHint(row.c30_eps_uv, [h]) ||
    valueMatchesNumberHint(row.c30_goods_uv, [h]) ||
    valueMatchesNumberHint(row.goods_uv, [h]) ||
    valueMatchesNumberHint(row.c30_sale_cnt, [h]) ||
    valueMatchesNumberHint(row.c7_sale_cnt, [h])
  )) score += 50000;
  if (row.retire_candidate) score += 800;
  if (row.high_exposure_low_click || row.high_visit_low_pay) score += 500;
  if (n(row.c30_sale_cnt) <= 0 && n(row.c30_eps_uv) > 0) score += 300;
  if (row.is_on_shelf) score += 100;
  score += Math.min(200, n(row.c30_eps_uv) / 1000);
  score += Math.min(100, n(row.c30_goods_uv || row.goods_uv) / 50);
  score += Math.min(200, n(row.c30_sale_cnt) * 10);
  return score;
}

function wantsInventoryQuestion(text) {
  return /ET|et|货代|库存|在库|在途|仓库|仓|去化|补货|可卖|售罄|缺货|断货|周转|剩余/.test(String(text || ''));
}

function inventoryRelevanceScore(row, {product, numberHints, latestNumberHints, wantsInventory}) {
  let score = wantsInventory ? 500 : 0;
  const standardGoodsSn = String(row?.standard_goods_sn || row?.standard_goods_sn_list || '');
  if (product && (standardGoodsSn === product || standardGoodsSn.includes(product))) score += 100000;
  const numericFields = [
    row?.et_loose_sellable_qty,
    row?.et_full_carton_qty,
    row?.et_estimated_available_qty,
    row?.estimated_on_hand_quantity,
    row?.incoming_quantity,
    row?.estimated_total_supply_quantity,
    row?.gross_sold_7d,
    row?.gross_sold_30d,
    row?.days_of_supply_on_hand,
    row?.days_of_supply_with_incoming,
  ];
  if ((latestNumberHints || []).some(h => numericFields.some(v => valueMatchesNumberHint(v, [h])))) score += 50000;
  if ((numberHints || []).some(h => numericFields.some(v => valueMatchesNumberHint(v, [h])))) score += 20000;
  if (row?.has_et_inventory) score += 3000;
  if (String(row?.risk_level || '').toLowerCase() === 'high') score += 1200;
  if (/售罄|缺货|断货|补货|在途/i.test(String(row?.stock_status || ''))) score += 900;
  if (n(row?.days_of_supply_on_hand) <= 7 && n(row?.weighted_daily_gross_sales) > 0) score += 700;
  if (n(row?.et_estimated_available_qty) > 0) score += Math.min(500, n(row.et_estimated_available_qty));
  score += Math.min(500, n(row?.gross_sold_30d) * 2);
  return score;
}

function compactInventoryContext({question, data, product, numberHints, latestNumberHints}) {
  const wantsInventory = wantsInventoryQuestion(question);
  const inventory = data.inventoryDepletion || {};
  const products = asArray(inventory.products)
    .filter(row => {
      if (!product) return true;
      const standardGoodsSn = String(row?.standard_goods_sn || row?.standard_goods_sn_list || '');
      return standardGoodsSn === product || standardGoodsSn.includes(product);
    })
    .sort((a, b) => inventoryRelevanceScore(b, {product, numberHints, latestNumberHints, wantsInventory})
      - inventoryRelevanceScore(a, {product, numberHints, latestNumberHints, wantsInventory})
      || n(a.days_of_supply_on_hand) - n(b.days_of_supply_on_hand)
      || n(b.gross_sold_30d) - n(a.gross_sold_30d))
    .slice(0, product ? 12 : 24);
  const batches = asArray(inventory.batches)
    .filter(row => {
      if (!product) return false;
      const standardGoodsSn = String(row?.standard_goods_sn || '');
      return standardGoodsSn === product || standardGoodsSn.includes(product);
    })
    .slice(0, 12);
  const lowPlatformStock = asArray(data.inventoryAlerts)
    .filter(row => {
      if (!product) return true;
      const standardGoodsSn = String(row?.standard_goods_sn || '');
      return standardGoodsSn === product || standardGoodsSn.includes(product);
    })
    .sort((a, b) => n(a.usable_inventory ?? a.inventory_quantity) - n(b.usable_inventory ?? b.inventory_quantity))
    .slice(0, product ? 20 : 16);
  return {
    freshness: {
      etUpdatedAt: data.dates?.etUpdatedAt || '',
      etLatestBatchId: data.dates?.etLatestBatchId || '',
      costFileUpdatedAt: data.dates?.manualCostFileUpdatedAt || '',
    },
    method: inventory.method || null,
    products: products.map(r => ({
      standard_goods_sn: r.standard_goods_sn,
      goods_title: r.goods_title,
      stock_status: r.stock_status,
      risk_level: r.risk_level,
      has_et_inventory: r.has_et_inventory,
      et_loose_sellable_qty: r.et_loose_sellable_qty,
      et_full_carton_qty: r.et_full_carton_qty,
      et_estimated_available_qty: r.et_estimated_available_qty,
      et_pending_process_qty: r.et_pending_process_qty,
      et_damaged_qty: r.et_damaged_qty,
      et_rtv_qty: r.et_rtv_qty,
      estimated_on_hand_quantity: r.estimated_on_hand_quantity,
      incoming_quantity: r.incoming_quantity,
      estimated_total_supply_quantity: r.estimated_total_supply_quantity,
      gross_sold_7d: r.gross_sold_7d,
      gross_sold_30d: r.gross_sold_30d,
      weighted_daily_gross_sales: r.weighted_daily_gross_sales,
      days_of_supply_on_hand: r.days_of_supply_on_hand,
      days_of_supply_with_incoming: r.days_of_supply_with_incoming,
      et_loose_warehouses: r.et_loose_warehouses,
      et_box_warehouses: r.et_box_warehouses,
      et_store_snapshot_date: r.et_store_snapshot_date,
      et_box_snapshot_date: r.et_box_snapshot_date,
    })),
    batches: batches.map(r => ({
      batch_no: r.batch_no,
      standard_goods_sn: r.standard_goods_sn,
      batch_status: r.batch_status,
      shipped_quantity: r.shipped_quantity,
      estimated_remaining_quantity: r.estimated_remaining_quantity,
      shipped_date: r.shipped_date,
      arrived_date: r.arrived_date,
    })),
    platformStockAlerts: lowPlatformStock.map(r => ({
      store_key: r.store_key,
      standard_goods_sn: r.standard_goods_sn,
      skc: r.skc,
      snapshot_date: r.snapshot_date,
      shelf_statuses: r.shelf_statuses,
      usable_inventory: r.usable_inventory,
      inventory_quantity: r.inventory_quantity,
      pay_locked_quantity: r.pay_locked_quantity,
      order_locked_quantity: r.order_locked_quantity,
    })),
  };
}

function rowSummary(row) {
  return `${moneySar(row?.gross_sales_sar ?? row?.sales_sar)}，订单 ${intNum(row?.gross_orders ?? row?.orders)}，销量 ${intNum(row?.gross_quantity ?? row?.quantity)}`;
}

function storeRiskReason(storeKey, data) {
  const store = (data.stores || []).find(r => r.store_key === storeKey) || {};
  const actions = (data.actions || [])
    .filter(a => a.store_key === storeKey)
    .sort((a, b) => n(b.score) - n(a.score))
    .slice(0, 3);
  const reasons = [];
  if (n(store.link_action_count) > 0) reasons.push(`链接动作 ${intNum(store.link_action_count)} 条`);
  if (n(store.missing_product_count) > 0) reasons.push(`缺覆盖货号 ${intNum(store.missing_product_count)} 个`);
  if (n(store.after_sales_case_count) > 0) reasons.push(`售后 ${intNum(store.after_sales_case_count)} 单`);
  if (n(store.low_display_stock_count) > 0) reasons.push(`低展示库存 ${intNum(store.low_display_stock_count)} 条`);
  if (n(store.waybill_exception_count) > 0) reasons.push(`履约异常 ${intNum(store.waybill_exception_count)} 个`);
  if (actions.length) reasons.push(`高优先级动作：${actions.map(a => `${a.title || a.category || a.action_domain}(${intNum(a.score)}分)`).join('；')}`);
  return reasons.join('；') || '暂未看到明显异常，只是今日销售靠后。';
}

function answerWorstStoreQuestion(date, data, latestNote) {
  const rows = (data.rankings?.dailyStores || [])
    .filter(r => r.date === date && STORE_KEYS.includes(String(r.store_key || '')))
    .sort((a, b) => n(a.gross_sales_sar ?? a.sales_sar) - n(b.gross_sales_sar ?? b.sales_sar));
  if (!rows.length) return `没查到 ${date} 的店铺销售数据。\n${latestNote}`;
  const worst = rows[0];
  const zeroRows = rows.filter(r => n(r.gross_sales_sar ?? r.sales_sar) <= 0);
  const bottom = rows.slice(0, 5);
  return [
    `${date} 目前销售最差的是 ${worst.store_key}：${rowSummary(worst)}。`,
    zeroRows.length > 1 ? `另有 ${zeroRows.length - 1} 个店当前也是 0 销售：${zeroRows.slice(1, 8).map(r => r.store_key).join('、')}。` : '',
    `可能原因：${storeRiskReason(worst.store_key, data)}`,
    `倒序参考：${bottom.map((r, i) => `${i + 1}. ${r.store_key} ${moneySar(r.gross_sales_sar ?? r.sales_sar)} / ${intNum(r.gross_orders ?? r.orders)}单`).join('；')}`,
    latestNote,
  ].filter(Boolean).join('\n');
}

function answerInventoryQuestion(text, data) {
  const q = normalizeText(text);
  const product = findProductSmart(q, data);
  const numberHints = extractNumberHints(q);
  const latestNumberHints = extractNumberHints(detectionTexts(q)[0] || q);
  const inventory = compactInventoryContext({question: q, data, product, numberHints, latestNumberHints});
  const products = inventory.products || [];
  const alerts = inventory.platformStockAlerts || [];
  const freshness = inventory.freshness || {};
  const latestNote = `ET 库存更新时间：${freshness.etUpdatedAt || '-'}；ET 批次：${freshness.etLatestBatchId || '-'}；BI生成：${data.generatedAt || '-'}`;
  if (!products.length && !alerts.length) {
    return `没查到${product ? ` ${product}` : ''} 的 ET/库存去化数据。\n${latestNote}`;
  }
  const rows = products.slice(0, product ? 8 : 10);
  return [
    product ? `${product} 库存/去化：` : `当前 ET/库存去化重点：`,
    ...rows.map((r, i) => [
      `${i + 1}. ${r.standard_goods_sn || '-'}`,
      `状态 ${r.stock_status || '-'}`,
      `ET可用 ${intNum(r.et_estimated_available_qty)} 件`,
      `估算在库 ${intNum(r.estimated_on_hand_quantity)} 件`,
      `在途 ${intNum(r.incoming_quantity)} 件`,
      `近30天销量 ${intNum(r.gross_sold_30d)} 件`,
      `在库可卖 ${r.days_of_supply_on_hand ?? '-'} 天`,
      `含在途可卖 ${r.days_of_supply_with_incoming ?? '-'} 天`,
    ].join('；')),
    alerts.length ? `平台低展示库存样本：${alerts.slice(0, 6).map(a => `${a.store_key}/${a.standard_goods_sn} ${intNum(a.usable_inventory ?? a.inventory_quantity)}件`).join('；')}` : '',
    `口径：ET/成本表实物库存与去化，不等同于 SHEIN 平台展示库存。${latestNote}`,
  ].filter(Boolean).join('\n');
}

function topRows(rows, metric, limit = 8) {
  return [...(rows || [])]
    .sort((a, b) => n(b?.[metric]) - n(a?.[metric]))
    .slice(0, limit);
}

function wantsChartQuestion(text) {
  const q = normalizeText(text);
  if (!CHART_ENABLED || !q) return false;
  const asksChart = /画图|图表|柱状图|折线图|趋势图|可视化|图片|出图|生成图|真正的图|真的图|不是文字图|数据.*图|chart|bar/i.test(q);
  const allowedDomain = /SHEIN|shein|BI|bi|销售|销量|订单|利润|退货|退款|排行|排名|货号|产品|商品|店铺|链接|曝光|访客|点击|支付|ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货/.test(q);
  const chartComplaint = /不是文字图|真正的图|真的图|数据.*(?:画|做|生成).*(?:图|图表)|把数据.*图/.test(q);
  return asksChart && (allowedDomain || chartComplaint);
}

function compactLabel(value, maxLen = 34) {
  const text = String(value || '-').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function chartFreshnessFootnote(data, date) {
  return `数据口径：${date || data.dates?.salesDate || '-'}；BI生成：${data.generatedAt || '-'}；销售源：${data.dates?.salesUpdatedAt || '-'}`;
}

function buildStoreSalesChartSpec(text, data) {
  const q = normalizeText(text);
  const date = pickDate(q, data);
  const stores = pickStoresSmart(text);
  const rows = (data.rankings?.dailyStores || [])
    .filter(r => r.date === date)
    .filter(r => !stores.length || rowMatchesStores(r, stores))
    .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
    .slice(0, 16)
    .map(r => ({
      label: String(r.store_key || '-'),
      value: n(r.gross_sales_sar ?? r.sales_sar),
      valueLabel: moneySar(r.gross_sales_sar ?? r.sales_sar),
      note: `订单 ${intNum(r.gross_orders ?? r.orders)}｜销量 ${intNum(r.gross_quantity ?? r.quantity)}`,
    }));
  if (!rows.length) return null;
  const scope = stores.length ? `${stores.join('/')} ` : '';
  return {
    kind: 'store_sales',
    title: `${date} ${scope}店铺销售排行`,
    subtitle: '按销售额降序；用于快速查看今天/指定日期各店表现',
    metricLabel: '销售额（SAR）',
    unit: ' SAR',
    footnote: chartFreshnessFootnote(data, date),
    rows,
  };
}

function buildProductSalesChartSpec(text, data) {
  const q = normalizeText(text);
  const date = pickDate(q, data);
  const product = findProductSmart(text, data);
  const stores = pickStoresSmart(text);
  const sourceRows = product
    ? (data.rankings?.dailyStoreProducts || [])
      .filter(r => r.date === date && r.standard_goods_sn === product)
      .filter(r => !stores.length || rowMatchesStores(r, stores))
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 16)
      .map(r => ({
        label: String(r.store_key || '-'),
        value: n(r.gross_sales_sar ?? r.sales_sar),
        valueLabel: moneySar(r.gross_sales_sar ?? r.sales_sar),
        note: `订单 ${intNum(r.gross_orders ?? r.orders)}｜销量 ${intNum(r.gross_quantity ?? r.quantity)}`,
      }))
    : (data.rankings?.dailyProducts || [])
      .filter(r => r.date === date)
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 12)
      .map(r => ({
        label: compactLabel(r.standard_goods_sn || r.product_name || '-'),
        value: n(r.gross_sales_sar ?? r.sales_sar),
        valueLabel: moneySar(r.gross_sales_sar ?? r.sales_sar),
        note: `订单 ${intNum(r.gross_orders ?? r.orders)}｜销量 ${intNum(r.gross_quantity ?? r.quantity)}`,
      }));
  if (!sourceRows.length) return null;
  return {
    kind: 'product_sales',
    title: product ? `${date} ${product} 各店销售` : `${date} 货号销售排行`,
    subtitle: product ? '同一货号在各店的当日/指定日期销售表现' : '按货号销售额降序，展示当前表现靠前的产品',
    metricLabel: '销售额（SAR）',
    unit: ' SAR',
    footnote: chartFreshnessFootnote(data, date),
    rows: sourceRows,
  };
}

function buildInventoryChartSpec(text, data) {
  const q = normalizeText(text);
  const product = findProductSmart(text, data);
  const numberHints = extractNumberHints(q);
  const latestNumberHints = extractNumberHints(detectionTexts(q)[0] || q);
  const inventory = compactInventoryContext({question: q, data, product, numberHints, latestNumberHints});
  const metric = /去化|可卖|天|周转/.test(q)
    ? 'days_of_supply_on_hand'
    : (/销量|近30|消耗/.test(q) ? 'gross_sold_30d' : 'et_estimated_available_qty');
  const metricLabel = metric === 'days_of_supply_on_hand'
    ? '在库可卖天数'
    : (metric === 'gross_sold_30d' ? '近30天毛销量（件）' : 'ET估算可用库存（件）');
  const unit = metric === 'days_of_supply_on_hand' ? ' 天' : ' 件';
  const rows = (inventory.products || [])
    .sort((a, b) => {
      if (metric === 'days_of_supply_on_hand') return n(a[metric]) - n(b[metric]) || n(b.gross_sold_30d) - n(a.gross_sold_30d);
      return n(b[metric]) - n(a[metric]) || n(b.gross_sold_30d) - n(a.gross_sold_30d);
    })
    .slice(0, 12)
    .map(r => ({
      label: compactLabel(r.standard_goods_sn || r.goods_title || '-'),
      value: n(r[metric]),
      valueLabel: `${metric === 'days_of_supply_on_hand' ? Number(n(r[metric]).toFixed(1)) : intNum(r[metric])}${unit}`,
      note: `状态 ${r.stock_status || '-'}｜在途 ${intNum(r.incoming_quantity)}｜近30销量 ${intNum(r.gross_sold_30d)}`,
    }));
  if (!rows.length) return null;
  return {
    kind: 'inventory',
    title: product ? `${product} 库存/去化图` : 'ET/库存去化重点图',
    subtitle: '基于 ET/成本表实物库存与销售去化，不等同于 SHEIN 平台展示库存',
    metricLabel,
    unit,
    footnote: `ET更新时间：${inventory.freshness?.etUpdatedAt || '-'}；BI生成：${data.generatedAt || '-'}`,
    rows,
  };
}

function buildLinkChartSpec(text, data) {
  const q = normalizeText(text);
  const product = findProductSmart(text, data);
  const stores = pickStoresSmart(text);
  const metric = /访客|UV|uv/.test(q)
    ? 'c30_goods_uv'
    : (/销量|成交|出单/.test(q) ? 'c30_sale_cnt' : 'c30_eps_uv');
  const metricLabel = metric === 'c30_sale_cnt' ? '30天销量（件）' : (metric === 'c30_goods_uv' ? '30天商品访客' : '30天曝光');
  const rows = (data.storeLinks || data.links || [])
    .filter(r => !stores.length || rowMatchesStores(r, stores))
    .filter(r => !product || r.standard_goods_sn === product || String(r.standard_goods_sn || '').includes(product))
    .sort((a, b) => n(b[metric]) - n(a[metric]) || n(b.c30_sale_cnt) - n(a.c30_sale_cnt) || n(b.c30_goods_uv) - n(a.c30_goods_uv))
    .slice(0, 12)
    .map(r => ({
      label: compactLabel(`${r.store_key || '-'} ${r.standard_goods_sn || '-'} ${String(r.skc || '').slice(-6)}`),
      value: n(r[metric]),
      valueLabel: intNum(r[metric]),
      note: `30天销量 ${intNum(r.c30_sale_cnt)}｜访客 ${intNum(r.c30_goods_uv || r.goods_uv)}｜${r.shelf_status_name || '-'}`,
    }));
  if (!rows.length) return null;
  return {
    kind: 'link',
    title: product ? `${product} 链接表现图` : '链接表现图',
    subtitle: '基于当前链接表现快照，默认按 30 天曝光/访客/销量展示',
    metricLabel,
    unit: '',
    footnote: `链接数据：${data.dates?.linkUpdatedAt || data.dates?.linkDate || '-'}；BI生成：${data.generatedAt || '-'}`,
    rows,
  };
}

function buildControlledChartSpec(text, data) {
  if (!wantsChartQuestion(text)) return null;
  const q = normalizeText(text);
  if (/ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货|周转|可卖/.test(q)) {
    return buildInventoryChartSpec(text, data);
  }
  if (/链接|曝光|访客|点击|支付|SKC|skc/.test(q)) {
    return buildLinkChartSpec(text, data);
  }
  if (/货号|产品|商品|SKU|sku|销量排行|产品排行/.test(q) || findProductSmart(text, data)) {
    return buildProductSalesChartSpec(text, data);
  }
  return buildStoreSalesChartSpec(text, data);
}

async function renderControlledChart(spec, options = {}) {
  if (!spec) return null;
  await fs.mkdir(CHART_DIR, {recursive: true});
  const stem = `chart-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const inputPath = path.join(CHART_DIR, `${stem}.json`);
  const outputPath = options.outputPath || path.join(CHART_DIR, `${stem}.png`);
  await fs.writeFile(inputPath, JSON.stringify(spec, null, 2), 'utf8');
  const result = await runProcess(CHART_PYTHON, [
    CHART_SCRIPT,
    '--input', inputPath,
    '--output', outputPath,
  ], {cwd: ROOT, timeoutMs: 30_000});
  await fs.rm(inputPath, {force: true}).catch(() => {});
  if (!result.ok) {
    throw new Error(`chart render failed code=${result.code} timeout=${result.timedOut} stderr=${String(result.stderr || '').slice(-500)}`);
  }
  return {path: outputPath, spec};
}

function larkLocalFileArg(filePath) {
  const rel = path.relative(ROOT, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return filePath;
}

function compactSalesContext(question, data) {
  const rawQuestion = String(question || '');
  const q = normalizeText(rawQuestion);
  const detectParts = detectionTexts(rawQuestion);
  const latestDetectionText = detectParts[0] || q;
  const date = pickDate(q, data);
  const stores = pickStoresSmart(rawQuestion);
  const store = stores[0] || '';
  const product = findProductSmart(rawQuestion, data);
  const numberHints = extractNumberHints(q);
  const latestNumberHints = extractNumberHints(latestDetectionText);
  const skcHints = extractSkcHints(q);
  const dailyStores = (data.rankings?.dailyStores || []).filter(r => r.date === date);
  const dailyProducts = (data.rankings?.dailyProducts || []).filter(r => r.date === date);
  const dailyStoreProducts = (data.rankings?.dailyStoreProducts || []).filter(r => r.date === date);
  const scopedStoreProducts = stores.length
    ? dailyStoreProducts.filter(r => rowMatchesStores(r, stores))
    : dailyStoreProducts;
  const productStoreRows = product ? dailyStoreProducts.filter(r => r.standard_goods_sn === product) : [];
  const linkRows = (data.storeLinks || data.links || [])
    .filter(r => {
      if (stores.length && !rowMatchesStores(r, stores)) return false;
      if (product && r.standard_goods_sn !== product && !String(r.standard_goods_sn || '').includes(product)) return false;
      if (skcHints.length && skcHints.some(x => String(r.skc || '').toLowerCase() === x.toLowerCase())) return true;
      return true;
    })
    .sort((a, b) => linkRelevanceScore(b, {stores, product, numberHints, latestNumberHints, skcHints}) - linkRelevanceScore(a, {stores, product, numberHints, latestNumberHints, skcHints})
      || n(b.c30_sale_cnt) - n(a.c30_sale_cnt)
      || n(b.c30_eps_uv) - n(a.c30_eps_uv)
      || n(b.c30_goods_uv || b.goods_uv) - n(a.c30_goods_uv || a.goods_uv))
    .slice(0, 60);
  const matrixRows = (data.matrix || [])
    .filter(r => {
      if (stores.length && !rowMatchesStores(r, stores)) return false;
      if (product && r.standard_goods_sn !== product && !String(r.standard_goods_sn || '').includes(product)) return false;
      return true;
    })
    .sort((a, b) => n(b.max_action_score) - n(a.max_action_score) || n(b.sales_sar) - n(a.sales_sar))
    .slice(0, 30);
  const summary = (data.rankings?.salesSummary || []).filter(r => r.end_date === date).slice(0, 12);
  const inventory = compactInventoryContext({question: rawQuestion, data, product, numberHints, latestNumberHints});
  return {
    dataFreshness: {
      askedDate: date,
      generatedAt: data.generatedAt || '',
      salesUpdatedAt: data.dates?.salesUpdatedAt || '',
      linkDate: data.dates?.linkDate || '',
      businessDate: data.dates?.businessDate || '',
      etUpdatedAt: data.dates?.etUpdatedAt || '',
      etLatestBatchId: data.dates?.etLatestBatchId || '',
    },
    detected: {store, stores, product, numberHints, latestNumberHints, skcHints},
    inventory,
    salesSummary: summary,
    storeTop: topRows(stores.length ? dailyStores.filter(r => rowMatchesStores(r, stores)) : dailyStores, 'gross_sales_sar', 16),
    productTop: topRows(product ? dailyProducts.filter(r => r.standard_goods_sn === product) : dailyProducts, 'gross_sales_sar', 16),
    storeProductTop: topRows(product ? productStoreRows : scopedStoreProducts, 'gross_sales_sar', 24),
    links: linkRows.map(r => ({
      store_key: r.store_key,
      standard_goods_sn: r.standard_goods_sn,
      skc: r.skc,
      status: r.shelf_status_name,
      is_on_shelf: r.is_on_shelf,
      is_wait_shelf: r.is_wait_shelf,
      c7_sale_cnt: r.c7_sale_cnt,
      c30_sale_cnt: r.c30_sale_cnt,
      c30_goods_uv: r.c30_goods_uv,
      c30_eps_uv: r.c30_eps_uv,
      click_rate: r.click_rate,
      pay_rate: r.pay_rate,
      retire_candidate: r.retire_candidate,
      high_exposure_low_click: r.high_exposure_low_click,
      high_visit_low_pay: r.high_visit_low_pay,
      wait_shelf_block_candidate: r.wait_shelf_block_candidate,
      health_bucket: r.health_bucket,
    })),
    coverage: matrixRows.map(r => ({
      store_key: r.store_key,
      standard_goods_sn: r.standard_goods_sn,
      coverage_status: r.coverage_status,
      need_supplement_link: r.need_supplement_link,
      link_count: r.link_count,
      on_shelf_count: r.on_shelf_count,
      wait_shelf_count: r.wait_shelf_count,
      best_skc: r.best_skc,
      best_link_c30_sale: r.best_link_c30_sale,
      sales_sar: r.sales_sar,
      quantity: r.quantity,
      action_count: r.action_count,
      max_action_score: r.max_action_score,
    })),
  };
}

async function readCodexSettings() {
  const configPath = process.env.CODEX_CONFIG_FILE || path.join(CODEX_CONFIG_DIR, 'config.toml');
  const authPath = process.env.CODEX_AUTH_FILE || path.join(CODEX_CONFIG_DIR, 'auth.json');
  const [configRaw, authRaw] = await Promise.all([
    fs.readFile(configPath, 'utf8').catch(() => ''),
    fs.readFile(authPath, 'utf8').catch(() => ''),
  ]);
  const model = process.env.SHEIN_QA_MODEL || configRaw.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || 'gpt-5.5';
  const provider = configRaw.match(/^\s*model_provider\s*=\s*"([^"]+)"/m)?.[1] || '';
  let baseUrl = process.env.OPENAI_BASE_URL || '';
  if (!baseUrl && provider) {
    const section = new RegExp(`\\[model_providers\\.${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(configRaw)?.[1] || '';
    baseUrl = section.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] || '';
  }
  let apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey && authRaw) {
    try {
      const auth = JSON.parse(authRaw);
      apiKey = auth.OPENAI_API_KEY || auth.openai_api_key || auth.api_key || '';
    } catch {}
  }
  return {model, baseUrl: (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''), apiKey};
}

async function callReadonlyLlm(question, context) {
  if (!LLM_ENABLED) return null;
  const {model, baseUrl, apiKey} = await readCodexSettings();
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const payload = {
      model,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                '你是 SHEIN 沙特半托管运营数据助手；回答阶段只基于数据和上层网关上下文，不直接改后台。',
                '你只能根据用户问题和提供的 JSON 数据回答销售、店铺、货号、链接表现、覆盖、ET/成本表库存、去化、售后/利润等经营问题，并可说明上层任务池/执行器的下一步。',
                '每次回答都必须基于本轮 JSON 重新查数；最新用户消息换了店铺、货号、SKC 或指标时，以最新消息为准，指代不完整时再结合上文。',
                '不要编造未提供的数据；缺数据就明确说缺哪类数据。',
                '上下文里的 inventory.products 是 ET/成本表实物库存与去化口径，platformStockAlerts 是 SHEIN 平台展示库存；不要把二者混为一谈。只要 inventory 里有数据，就不能说“看不到 ET 库存”。',
                '不要给出修改 BI 系统、服务器、代码、密钥、账号、非 SHEIN 业务的建议。',
                '涉及上品、改标题、换图、下架、活动报名、限时折扣等写操作时，不能说已经执行；如果用户问题或上层网关说明系统会加入任务池/已识别为动作命令，就说已进入待确认动作/任务，等待执行器预检。',
                '不要把“回答阶段不直接执行”误说成“店铺没有权限”。若上下文说明 HL 已有 OpenAPI 授权，应承认 HL 可进入 API 执行准备；只有真实写适配器未实现/预检未通过时，才说卡在适配器或预检。',
                '遇到“这个链接/2,223 这个/刚才那个”等指代时，优先用上下文里的 SKC、店铺、货号、曝光/访客/销量数字定位，不要因为最新一句没写全就否定上轮数据。',
                '如果用户要求画图、图表、柱状图或可视化，不要说不能画；上层网关会基于受控 BI 数据附上图片图表，你只负责给出简短解读。',
                '回答要简洁，优先给结论、关键数字、原因和下一步。数字保留 SAR / 订单 / 销量单位。',
              ].join('\n')
            }
          ]
        },
        {
          role: 'user',
          content: [
            {type: 'input_text', text: `用户问题：${question}`},
            {type: 'input_text', text: `只读数据上下文 JSON：${JSON.stringify(context)}`},
          ]
        }
      ],
      max_output_tokens: 900,
    };
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw);
    const text = json.output_text ||
      (Array.isArray(json.output) ? json.output.flatMap(item => item.content || []).map(c => c.text || '').filter(Boolean).join('\n') : '');
    return String(text || '').trim() || null;
  } finally {
    clearTimeout(timer);
  }
}

function stripCodexCliNoise(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const marker = 'FINAL_ANSWER:';
  const idx = raw.lastIndexOf(marker);
  if (idx >= 0) return raw.slice(idx + marker.length).trim();
  return raw
    .split(/\r?\n/)
    .filter(line => !/^(OpenAI Codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|tokens used|user$|codex$|warning:|deprecated:)/i.test(line.trim()))
    .join('\n')
    .trim();
}

function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: {...process.env, ...(options.env || {})},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, options.timeoutMs || 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ok: false, code: -1, timedOut, stdout, stderr: String(err?.stack || err)});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, code, timedOut, stdout, stderr});
    });
    child.stdin.end(options.input || '');
  });
}

async function callReadonlyCodexGateway(question, context) {
  if (!CODEX_GATEWAY_ENABLED) return null;
  const prompt = [
    '你是 SHEIN 沙特半托管运营数据智能体，运行在受控网关里；回答阶段只读数据，不直接改后台。',
    '每次回答都必须基于本轮提供的最新 BI JSON 上下文重新查数；如果最新用户消息换了店铺、货号、SKC 或指标，以最新消息为准，指代不完整时再结合上文。',
    '你只能根据下面提供的 BI JSON 上下文回答问题，不允许调用外部网站，不允许修改文件，不允许绕过上层执行器直接执行 SHEIN 写操作。',
    '上下文里的 inventory.products 是 ET/成本表实物库存与去化口径，platformStockAlerts 是 SHEIN 平台展示库存；不要把二者混为一谈。只要 inventory 里有数据，就不能说“看不到 ET 库存”。',
    '如果用户问上品、改标题、换图、下架、活动、限时折扣，不能说已经执行；但如果上下文提示系统会入任务池/已识别为动作命令，应说明已进入待确认动作/任务，等待执行器预检。',
    '不要把“当前回答不直接执行”说成“没有权限”。如果上下文说明 HL 已有 OpenAPI 授权，应承认 HL 可进入 API 执行准备；如果商品发布/提交审核写适配器未实现，只能说卡在适配器/预检，不能泛化为 HL 没权限。',
    '遇到“这个链接/2,223 这个/刚才那个”等指代时，优先用上下文里的 SKC、店铺、货号、曝光/访客/销量数字定位，不要因为最新一句没写全就否定上轮已经查到的数据。',
    '如果用户要求画图、图表、柱状图或可视化，不要说不能画；上层网关会基于受控 BI 数据附上图片图表，你只负责给出简短解读。',
    '如果问题超出 SHEIN 经营数据、链接管理、销售、货号、店铺、售后、利润范围，直接拒绝。',
    '回答要像运营负责人：先结论，再关键数字，再可能原因/下一步。不要只机械列排行。',
    '最终只输出一段中文，并以 FINAL_ANSWER: 开头。',
    '',
    `用户问题：${question}`,
    '',
    `BI JSON 上下文：${JSON.stringify(context)}`,
  ].join('\n');
  const outFile = path.join(os.tmpdir(), `shein-qa-codex-${process.pid}-${Date.now()}.txt`);
  const result = await runProcess('codex', [
    'exec',
    '--cd', ROOT,
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--color', 'never',
    '--output-last-message', outFile,
    '--config', 'approval_policy="never"',
    '--config', 'model_reasoning_effort="low"',
    '-',
  ], {
    cwd: ROOT,
    input: prompt,
    timeoutMs: CODEX_GATEWAY_TIMEOUT_MS,
    env: {CODEX_HOME: CODEX_CONFIG_DIR},
  });
  let answer = '';
  try {
    answer = await fs.readFile(outFile, 'utf8');
    await fs.rm(outFile, {force: true});
  } catch {
    answer = result.stdout;
  }
  if (!result.ok) {
    throw new Error(`codex gateway failed code=${result.code} timeout=${result.timedOut} stderr=${String(result.stderr || '').slice(-400)}`);
  }
  return stripCodexCliNoise(answer || result.stdout) || null;
}

function answerQuestion(text, data) {
  const q = normalizeText(text);
  const date = pickDate(q, data);
  const store = pickStore(q);
  const product = findProduct(q, data);
  const wantsRank = /排行|排名|top|前\d+|最高|最好/.test(q);
  const wantsWorst = /最差|最低|最少|最弱|倒数|垫底|不好|差/.test(q);
  const wantsProduct = product || /货号|产品|商品|SKU|SKC/i.test(q);
  const wantsStore = store || /店铺|哪个店|各店|门店/.test(q);
  const latestNote = `数据口径：${date}；BI 生成：${data.generatedAt || '-'}；销售源：${data.dates?.salesUpdatedAt || '-'}`;

  if (wantsInventoryQuestion(q)) {
    return answerInventoryQuestion(q, data);
  }

  if (wantsWorst && /店|店铺|哪个/.test(q)) {
    return answerWorstStoreQuestion(date, data, latestNote);
  }

  if (wantsRank && wantsProduct) {
    const rows = (data.rankings?.dailyProducts || [])
      .filter(r => r.date === date)
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 8);
    if (!rows.length) return `没查到 ${date} 的产品销售排行。\n${latestNote}`;
    return [
      `${date} 产品销售排行 TOP ${rows.length}`,
      ...rows.map((r, i) => `${i + 1}. ${r.standard_goods_sn || '-'}：${rowSummary(r)}`),
      latestNote,
    ].join('\n');
  }

  if (wantsRank || wantsStore) {
    const rows = (data.rankings?.dailyStores || [])
      .filter(r => r.date === date)
      .filter(r => !store || (store === 'DSY' ? r.group_key === 'DSY' : store === 'LGM' ? r.group_key === 'LGM' : r.store_key === store))
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar));
    if (!rows.length) return `没查到 ${date}${store ? ` ${store}` : ''} 的店铺销售数据。\n${latestNote}`;
    if (store && !['DSY', 'LGM'].includes(store)) {
      return `${date} ${store}：${rowSummary(rows[0])}\n${latestNote}`;
    }
    const top = rows.slice(0, 8);
    return [
      `${date}${store ? ` ${store}` : ''} 店铺销售排行 TOP ${top.length}`,
      ...top.map((r, i) => `${i + 1}. ${r.store_key}：${rowSummary(r)}`),
      latestNote,
    ].join('\n');
  }

  if (wantsProduct && product) {
    const rows = (data.rankings?.dailyProducts || []).filter(r => r.date === date && r.standard_goods_sn === product);
    if (!rows.length) return `没查到 ${date} ${product} 的销售数据。\n${latestNote}`;
    const row = rows.reduce((acc, r) => ({
      gross_sales_sar: n(acc.gross_sales_sar ?? acc.sales_sar) + n(r.gross_sales_sar ?? r.sales_sar),
      gross_orders: n(acc.gross_orders ?? acc.orders) + n(r.gross_orders ?? r.orders),
      gross_quantity: n(acc.gross_quantity ?? acc.quantity) + n(r.gross_quantity ?? r.quantity),
    }), {});
    const storeRows = (data.rankings?.dailyStoreProducts || [])
      .filter(r => r.date === date && r.standard_goods_sn === product)
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 5);
    return [
      `${date} ${product} 合计：${rowSummary(row)}`,
      storeRows.length ? `店铺贡献：${storeRows.map(r => `${r.store_key} ${moneySar(r.gross_sales_sar ?? r.sales_sar)}`).join('；')}` : '',
      latestNote,
    ].filter(Boolean).join('\n');
  }

  const summary = (data.rankings?.salesSummary || []).find(r => r.period_key === 'day' && r.end_date === date);
  if (summary) {
    return `${date} 总销售：${rowSummary(summary)}\n${latestNote}`;
  }
  return [
    `我现在能回答：今日/昨日销售额、订单、销量、店铺排行、产品/货号排行；链接管理写操作需要通过 BI 任务池/执行器留痕。`,
    `你可以问：“今天销售多少”、“昨天店铺排行”、“HL今天销售”、“BHRL-09激光脱毛仪今天卖了多少”。`,
    latestNote,
  ].join('\n');
}

async function answerQuestionSmart(text, data) {
  const context = compactSalesContext(text, data);
  try {
    const codexAnswer = await callReadonlyCodexGateway(text, context);
    if (codexAnswer) {
      const latestNote = `\n\n数据口径：${context.dataFreshness.askedDate || '-'}；BI生成：${context.dataFreshness.generatedAt || '-'}；销售源：${context.dataFreshness.salesUpdatedAt || '-'}`;
      return `${codexAnswer}${latestNote}`;
    }
  } catch (err) {
    console.error(JSON.stringify({ok: false, stage: 'codex_gateway_failed', error: String(err?.message || err).slice(0, 800)}));
  }
  try {
    const llmAnswer = await callReadonlyLlm(text, context);
    if (llmAnswer) {
      const latestNote = `\n\n数据口径：${context.dataFreshness.askedDate || '-'}；BI生成：${context.dataFreshness.generatedAt || '-'}；销售源：${context.dataFreshness.salesUpdatedAt || '-'}`;
      return `${llmAnswer}${latestNote}`;
    }
  } catch (err) {
    console.error(JSON.stringify({ok: false, stage: 'llm_answer_failed', error: String(err?.message || err).slice(0, 800)}));
  }
  return answerQuestion(text, data);
}

function shouldAnswerEvent(event) {
  const content = normalizeText(event?.content || '');
  if (!content) return false;
  if (String(event?.message_type || '') !== 'text') return false;
  if (/app|bot/i.test(String(event?.sender_type || ''))) return false;
  if (event?.chat_type === 'p2p') return true;
  return /销售|销量|订单|利润|退货|退款|排行|排名|货号|产品|商品|店铺|数据|BI|bi|今天|昨天|昨日|ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货|画图|图表|柱状图|折线图|趋势图|可视化|图片/.test(content);
}

function runLark(args) {
  return new Promise(resolve => {
    const child = spawn(LARK_CLI_BIN, [...LARK_CLI_PREFIX_ARGS, ...args], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err?.stack || err)}));
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
}

async function alreadyHandled(eventId) {
  if (!eventId) return false;
  const file = path.join(STATE_DIR, 'events', `${eventId}.json`);
  try { await fs.access(file); return true; } catch { return false; }
}

async function markHandled(eventId, payload) {
  if (!eventId) return;
  const dir = path.join(STATE_DIR, 'events');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, `${eventId}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

async function handleEvent(event, options = {}) {
  const eventId = event.event_id || event.message_id || crypto.createHash('sha1').update(JSON.stringify(event)).digest('hex');
  if (!shouldAnswerEvent(event)) return {ok: true, skipped: true, reason: 'not_sales_question'};
  if (await alreadyHandled(eventId)) return {ok: true, skipped: true, reason: 'duplicate'};
  const data = await readData();
  const chartSpec = buildControlledChartSpec(event.content || '', data);
  const baseAnswer = await answerQuestionSmart(event.content || '', data);
  const answer = chartSpec
    ? `${baseAnswer}\n\n图表：已按当前 BI 数据生成受控图表，图片见下一条。`
    : baseAnswer;
  const sendArgs = [
    'im', '+messages-reply',
    '--as', 'bot',
    '--message-id', event.message_id || event.id,
    '--text', answer,
    '--idempotency-key', `sales-qa-${eventId}`.slice(0, 80),
  ];
  let sent = {ok: true, dryRun: true};
  if (!options.dryRun) sent = await runLark(sendArgs);
  let chartResult = null;
  let chartSent = null;
  let chartError = '';
  if (chartSpec) {
    try {
      chartResult = await renderControlledChart(chartSpec);
      const imageArgs = [
        'im', '+messages-reply',
        '--as', 'bot',
        '--message-id', event.message_id || event.id,
        '--image', larkLocalFileArg(chartResult.path),
        '--idempotency-key', `sales-qa-chart-${eventId}`.slice(0, 80),
      ];
      chartSent = options.dryRun ? {ok: true, dryRun: true} : await runLark(imageArgs);
    } catch (err) {
      chartError = String(err?.message || err).slice(0, 800);
      console.error(JSON.stringify({ok: false, stage: 'chart_reply_failed', eventId, error: chartError}));
    }
  }
  await markHandled(eventId, {
    handledAt: new Date().toISOString(),
    eventId,
    messageId: event.message_id || event.id || '',
    chatType: event.chat_type || '',
    questionPreview: String(event.content || '').slice(0, 200),
    answer,
    sendOk: sent.ok,
    sendCode: sent.code ?? null,
    chartKind: chartSpec?.kind || '',
    chartPath: chartResult?.path || '',
    chartSendOk: chartSent?.ok ?? null,
    chartSendCode: chartSent?.code ?? null,
    chartError,
    stderrTail: String(sent.stderr || '').slice(-500),
  });
  return {
    ok: sent.ok && (chartSent ? chartSent.ok : true) && !chartError,
    eventId,
    answer,
    sendCode: sent.code ?? null,
    chartKind: chartSpec?.kind || '',
    chartPath: chartResult?.path || '',
    chartSendCode: chartSent?.code ?? null,
    chartError,
    stderrTail: String(sent.stderr || '').slice(-500),
  };
}

async function consume(options = {}) {
  await fs.mkdir(STATE_DIR, {recursive: true});
  const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of rl) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    try {
      const event = normalizeEventPayload(JSON.parse(raw));
      const result = await handleEvent(event, options);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error(JSON.stringify({ok: false, error: String(err?.stack || err).slice(0, 2000)}));
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.answer) {
  const data = await readData();
  console.log(await answerQuestionSmart(args.answer, data));
} else if (args.renderChart) {
  const data = await readData();
  const spec = buildControlledChartSpec(args.renderChart, data);
  if (!spec) {
    console.error('No controlled chart spec matched this question.');
    process.exit(2);
  }
  const result = await renderControlledChart(spec, {outputPath: args.chartOutput || ''});
  console.log(JSON.stringify({
    ok: true,
    path: result.path,
    kind: result.spec.kind,
    title: result.spec.title,
    rows: result.spec.rows?.length || 0,
  }, null, 2));
} else if (args.consume) {
  await consume({dryRun: args.dryRun});
} else {
  console.log('Usage: node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少" | --render-chart "今天店铺销售画图" [--chart-output out.png] | --consume');
}
