#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import os from 'node:os';
import {buildProductDisplayName} from '../lib/product_display_name.mjs';
import {inventoryMatchStatusLabel, normalizeInventoryProjection} from '../lib/inventory_projection_contract.mjs';
import {
  buildBiOpsQueryContext,
  buildBiOpsSectionFacts,
  DEFAULT_BI_OPS_CONTEXT_MAX_BYTES,
  DEFAULT_BI_OPS_SECTION_MAX_BYTES,
  loadBiOpsQueryData,
} from '../lib/bi_ops_query_context.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = process.env.SHEIN_QA_BI_DATA || path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const BI_SECTIONS_DIR = process.env.SHEIN_QA_BI_SECTIONS_DIR || process.env.SHEIN_QA_BI_SECTION_DIR || path.join(path.dirname(DATA_PATH), 'sections');
const BI_SECTION_MAX_BYTES = Number(process.env.SHEIN_QA_BI_MAX_SECTION_BYTES || DEFAULT_BI_OPS_SECTION_MAX_BYTES);
const BI_CONTEXT_MAX_BYTES = Number(process.env.SHEIN_QA_CONTEXT_MAX_BYTES || DEFAULT_BI_OPS_CONTEXT_MAX_BYTES);
const STATE_DIR = process.env.SHEIN_QA_STATE_DIR || path.join(ROOT, 'state', 'lark_sales_qa_bot');
const CODEX_CONFIG_DIR = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const LLM_TIMEOUT_MS = Number(process.env.SHEIN_QA_LLM_TIMEOUT_MS || 45_000);
const LLM_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_LLM_ENABLED || '1').toLowerCase());
const CODEX_GATEWAY_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CODEX_GATEWAY_ENABLED || '1').toLowerCase());
const CODEX_GATEWAY_TIMEOUT_MS = Number(process.env.SHEIN_QA_CODEX_GATEWAY_TIMEOUT_MS || 45_000);
const CODEX_GATEWAY_MODEL = process.env.SHEIN_QA_CODEX_MODEL || process.env.SHEIN_BI_AGENT_MODEL_FAST || 'gpt-5.6-terra';
const CODEX_GATEWAY_REASONING_EFFORT = process.env.SHEIN_QA_CODEX_REASONING_EFFORT || process.env.SHEIN_BI_AGENT_REASONING_FAST || 'low';
const CODEX_GATEWAY_EPHEMERAL = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CODEX_EPHEMERAL || '1').toLowerCase());
const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';
const LARK_CLI_PREFIX_ARGS = parseArgList(process.env.LARK_CLI_PREFIX_ARGS || '');
const CHART_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CHART_ENABLED || '1').toLowerCase());
const CHART_INTENT_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_CHART_INTENT_ENABLED || '1').toLowerCase());
const CHART_INTENT_TIMEOUT_MS = Number(process.env.SHEIN_QA_CHART_INTENT_TIMEOUT_MS || process.env.SHEIN_BI_AGENT_TIMEOUT_INTENT_MS || 20_000);
const CHART_INTENT_MODEL = process.env.SHEIN_QA_CHART_INTENT_MODEL || process.env.SHEIN_BI_AGENT_MODEL_INTENT || 'gpt-5.6-luna';
const CHART_INTENT_REASONING_EFFORT = process.env.SHEIN_QA_CHART_INTENT_REASONING_EFFORT || process.env.SHEIN_BI_AGENT_REASONING_INTENT || 'low';
const CHART_PYTHON = process.env.SHEIN_QA_CHART_PYTHON || 'python3';
const CHART_SCRIPT = process.env.SHEIN_QA_CHART_SCRIPT || path.join(ROOT, 'scripts', 'render_lark_qa_chart.py');
const CHART_DIR = process.env.SHEIN_QA_CHART_DIR || path.join(STATE_DIR, 'charts');
const CONVERSATION_DIR = process.env.SHEIN_QA_CONVERSATION_DIR || path.join(STATE_DIR, 'conversations');
const CONVERSATION_TTL_MS = Math.max(0, Number(process.env.SHEIN_QA_CONVERSATION_TTL_MS || 0));
const LINK_OPS_TASK_FILE = process.env.SHEIN_QA_LINK_OPS_TASK_FILE || path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const LARK_LINK_OPS_TASK_WRITE_ENABLED = !['0', 'false', 'no'].includes(String(process.env.SHEIN_QA_LINK_OPS_TASK_WRITE_ENABLED || '0').toLowerCase());
const STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC'];
const biQueryMetaByData = new WeakMap();

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
  const args = {answer: '', consume: false, dryRun: false, renderChart: '', planChart: '', chartOutput: ''};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answer') args.answer = argv[++i] || '';
    else if (a === '--consume') args.consume = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--render-chart') args.renderChart = argv[++i] || '';
    else if (a === '--plan-chart') args.planChart = argv[++i] || '';
    else if (a === '--chart-output') args.chartOutput = argv[++i] || '';
  }
  return args;
}

async function readData(question = '') {
  const loaded = await loadBiOpsQueryData({
    question,
    dataPath: DATA_PATH,
    sectionsDir: BI_SECTIONS_DIR,
    maxSectionBytes: BI_SECTION_MAX_BYTES,
  });
  biQueryMetaByData.set(loaded.data, loaded.meta);
  return loaded.data;
}

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function productDisplayName(rowOrSn, data = null) {
  const row = rowOrSn && typeof rowOrSn === 'object' ? rowOrSn : null;
  const direct = String(row?.product_display_name || '').trim();
  if (direct) return direct;
  const sn = String(row ? (row.standard_goods_sn || row.standard_goods_sn_list || row.goods_sn || '') : (rowOrSn || '')).trim();
  if (sn && data?.productDisplayNames?.[sn]) return data.productDisplayNames[sn];
  return buildProductDisplayName(rowOrSn);
}

function moneySar(value) {
  return `${n(value).toLocaleString('en-US', {maximumFractionDigits: 2})} SAR`;
}

function intNum(value) {
  return `${Math.round(n(value)).toLocaleString('en-US')}`;
}

function addDays(ymd, delta) {
  const [year, month, day] = String(ymd).slice(0, 10).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return '';
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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
    chat_id: root.chat_id || message.chat_id || root.chat?.chat_id || message.chat?.chat_id || '',
    chat_type: root.chat_type || message.chat_type || '',
    thread_id: root.thread_id || message.thread_id || root.message_thread_id || message.message_thread_id || '',
    root_id: root.root_id || message.root_id || root.parent_id || message.parent_id || '',
    message_type: root.message_type || message.message_type || '',
    sender_type: root.sender_type || root.sender?.sender_type || input?.sender?.sender_type || '',
    sender_id: root.sender_id || root.sender?.sender_id?.open_id || root.sender?.sender_id?.union_id || '',
    content: decodeTextContent(root.content ?? message.content),
  };
}

function findProduct(text, data) {
  const q = normalizeText(text).toLowerCase();
  if (!q) return '';
  const candidates = new Map();
  const addCandidate = (key, ...texts) => {
    const productKey = String(key || '').trim();
    if (!productKey) return;
    if (!candidates.has(productKey)) candidates.set(productKey, new Set());
    const set = candidates.get(productKey);
    set.add(productKey);
    for (const value of texts) {
      const s = String(value || '').trim();
      if (s) set.add(s);
    }
  };
  const collect = rows => {
    for (const row of rows || []) {
      const key = row?.standard_goods_sn || row?.goods_sn || row?.product || row?.product_name;
      addCandidate(key, row?.product_display_name, productDisplayName(row, data), row?.product_name, row?.goods_title);
    }
  };
  collect(data.rankings?.dailyProducts);
  collect(data.rankings?.dailyStoreProducts);
  collect(data.storeLinks || data.links);
  collect(data.matrix);
  collect(data.actions);
  collect(data.products);
  for (const [sn, display] of Object.entries(data.productDisplayNames || {})) {
    addCandidate(sn, display);
  }
  const sorted = [...candidates.entries()]
    .flatMap(([key, texts]) => [...texts].map(value => ({key, value})))
    .sort((a, b) => b.value.length - a.value.length);
  for (const candidate of sorted) {
    if (q.includes(candidate.value.toLowerCase())) return candidate.key;
  }
  const code = q.match(/[a-z]{1,5}[- ]?\d{2,6}[a-z]?/i)?.[0]?.replace(/\s+/g, '-').toUpperCase();
  if (code) {
    const hit = sorted.find(p => p.value.toUpperCase().includes(code));
    if (hit) return hit.key;
  }
  return '';
}

function extractUserMessages(text) {
  const raw = String(text || '');
  const matches = [...raw.matchAll(/用户：([\s\S]*?)(?=(?:\s+)(?:用户|智能体)：|$)/g)].map(m => normalizeText(m[1]));
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
  const hasUserMessages = extractUserMessages(text).length > 0;
  const parts = detectionTexts(text);
  for (const part of (hasUserMessages ? parts.slice(0, 2) : parts)) {
    const stores = pickStores(part);
    if (stores.length) return stores;
  }
  return [];
}

function findProductSmart(text, data) {
  const hasUserMessages = extractUserMessages(text).length > 0;
  const parts = detectionTexts(text);
  for (const part of (hasUserMessages ? parts.slice(0, 2) : parts)) {
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
  if (normalizeInventoryProjection(row).fresh_matched) score += 3000;
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
    products: products.map(raw => {
      const r = normalizeInventoryProjection(raw);
      return ({
      standard_goods_sn: r.standard_goods_sn,
      product_display_name: productDisplayName(r, data),
      goods_title: r.goods_title,
      stock_status: r.stock_status,
      risk_level: r.risk_level,
      has_et_inventory: r.has_et_inventory,
      inventory_match_status: r.inventory_match_status,
      fresh_matched: r.fresh_matched,
      current_sellable_quantity: r.current_sellable_quantity,
      arrived_quantity: r.arrived_quantity,
      et_loose_sellable_qty: r.et_loose_sellable_qty,
      et_full_carton_qty: r.et_full_carton_qty,
      et_estimated_available_qty: r.et_estimated_available_qty,
      et_pending_process_qty: r.et_pending_process_qty,
      et_damaged_qty: r.et_damaged_qty,
      et_rtv_qty: r.et_rtv_qty,
      et_scrap_qty: r.et_scrap_qty,
      operational_sellable_on_hand_qty: operationalWarehouseOnHand(r),
      operational_stock_policy: '默认只计 ETRUH09 散件仓；SK-03038 制冰机例外计 ETRUH01 整箱仓；ETRUH03_RTV/ETRUH04Damaged/ETRUH06报废不计可售现货',
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
      });
    }),
    batches: batches.map(r => ({
      batch_no: r.batch_no,
      standard_goods_sn: r.standard_goods_sn,
      product_display_name: productDisplayName(r, data),
      batch_status: r.batch_status,
      shipped_quantity: r.shipped_quantity,
      estimated_remaining_quantity: r.estimated_remaining_quantity,
      shipped_date: r.shipped_date,
      arrived_date: r.arrived_date,
    })),
    platformStockAlerts: lowPlatformStock.map(r => ({
      store_key: r.store_key,
      standard_goods_sn: r.standard_goods_sn,
      product_display_name: productDisplayName(r, data),
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
  const operationalPolicy = wantsOperationalWarehouseStockPolicy(q);
  const latestNote = `ET 库存更新时间：${freshness.etUpdatedAt || '-'}；ET 批次：${freshness.etLatestBatchId || '-'}；BI生成：${data.generatedAt || '-'}`;
  if (!products.length && !alerts.length) {
    return `没查到${product ? ` ${productDisplayName(product, data)}` : ''} 的 ET/库存去化数据。\n${latestNote}`;
  }
  const rows = (operationalPolicy
    ? [...products].sort((a, b) => compareSortTuple(
      operationalInventorySortTuple(a, operationalWarehouseOnHand(a), n(a.weighted_daily_gross_sales), daysForStock(operationalWarehouseOnHand(a), n(a.weighted_daily_gross_sales))),
      operationalInventorySortTuple(b, operationalWarehouseOnHand(b), n(b.weighted_daily_gross_sales), daysForStock(operationalWarehouseOnHand(b), n(b.weighted_daily_gross_sales))),
    ))
    : products).slice(0, product ? 8 : 10);
  return [
    product ? `${productDisplayName(product, data)} 库存/去化：` : `当前 ET/库存去化重点：`,
    ...rows.map((r, i) => {
      const speed = n(r.weighted_daily_gross_sales);
      const opOnHand = operationalWarehouseOnHand(r);
      const opDays = daysForStock(opOnHand, speed);
      const opDaysWithIncoming = daysForStock(opOnHand + n(r.incoming_quantity), speed);
      const hasFreshEt = r.fresh_matched === true;
      const incomingText = r.incoming_quantity == null ? '未知' : `${intNum(r.incoming_quantity)} 件`;
      return [
        `${i + 1}. ${productDisplayName(r, data)}`,
        `状态 ${r.stock_status || '-'}`,
        `ET匹配 ${inventoryMatchStatusLabel(r)}`,
        operationalPolicy ? `09仓可售 ${r.fresh_matched ? `${intNum(opOnHand)} 件${isIceMaker03038(r) ? '（03038取01仓）' : ''}` : '未知（非最新匹配快照）'}` : `ET可用 ${r.current_sellable_quantity == null ? '未知' : `${intNum(r.current_sellable_quantity)} 件`}`,
        operationalPolicy ? `排除03/04/06 ${r.fresh_matched ? `${intNum(n(r.et_rtv_qty) + n(r.et_damaged_qty) + n(r.et_scrap_qty))} 件` : '未知'}` : `累计到仓 ${r.arrived_quantity == null ? '未知' : `${intNum(r.arrived_quantity)} 件`}`,
        `在途 ${incomingText}`,
        `近30天销量 ${intNum(r.gross_sold_30d)} 件`,
        operationalPolicy ? `实际现货可卖 ${hasFreshEt ? formatDays(opDays, speed > 0) : '未知'}` : `在库可卖 ${hasFreshEt ? (r.days_of_supply_on_hand ?? '-') : '未知'}${hasFreshEt ? ' 天' : ''}`,
        operationalPolicy ? `含在途可卖 ${hasFreshEt && r.incoming_quantity != null ? formatDays(opDaysWithIncoming, speed > 0) : '未知'}` : `含在途可卖 ${hasFreshEt && r.incoming_quantity != null ? (r.days_of_supply_with_incoming ?? '-') : '未知'}${hasFreshEt && r.incoming_quantity != null ? ' 天' : ''}`,
      ].join('；');
    }),
    alerts.length ? `平台低展示库存样本：${alerts.slice(0, 6).map(a => `${a.store_key}/${productDisplayName(a, data)} ${intNum(a.usable_inventory ?? a.inventory_quantity)}件`).join('；')}` : '',
    `口径：${operationalPolicy ? '默认只计 ETRUH09散件仓；SK-03038 制冰机例外计 ETRUH01整箱仓；ETRUH03_RTV/04Damaged/06报废不计可售现货。' : '只用新鲜且已匹配的 ET 可售库存；未匹配/过期显示未知，不用成本表倒推当前库存，也不等同于 SHEIN 平台展示库存。'}${latestNote}`,
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
  const asksChart = /画图|图表|柱状图|折线图|趋势图|可视化|图片|出图|生成图|信息图|真正的图|真的图|不是文字图|数据.*图|做成.*图|画成.*图|chart|bar|infographic/i.test(q);
  const allowedDomain = /SHEIN|shein|BI|bi|销售|销量|订单|利润|退货|退款|排行|排名|货号|产品|商品|店铺|链接|曝光|访客|点击|支付|ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货/.test(q);
  const chartComplaint = /不是文字图|真正的图|真的图|图呢|图片呢|图在哪|怎么没图|数据.*(?:画|做|生成).*(?:图|图表)|把数据.*图/.test(q);
  return asksChart && (allowedDomain || chartComplaint);
}

function shouldAskChartIntentPlanner(text, conversation) {
  if (!CHART_ENABLED || !CHART_INTENT_ENABLED) return false;
  const q = normalizeText(text);
  if (!q) return false;
  if (String(process.env.SHEIN_QA_CHART_INTENT_OVERRIDE_JSON || '').trim()) return true;
  if (wantsChartQuestion(q)) return true;
  if (isChartRevisionRequest(q, conversation)) return true;
  if (conversation?.lastChart?.kind && isFollowupText(q)
    && /图|这个|那个|刚才|上张|这张|改|换|重做|重画|重新|不对|不满意|看不懂|不直观|字段|维度|排序|颜色|中文|品名|加上|去掉|放大|缩小|太乱|太长|按/.test(q)) {
    return true;
  }
  return /画一张|画一个|画个|重画|重新画|做一张|做成一张|来一张|搞一张|给我一张|出一张|生成一张|弄一张|弄成一张|做个|出个|给个|弄个|整理成|看板|视觉|版式|信息|看出|体现/.test(q)
    && /销售|销量|库存|去化|链接|曝光|访客|点击|支付|利润|订单|货号|商品|产品|店铺|品类|类目|SKC|sku|撑多久|还能撑|可卖|周期/i.test(q);
}

function compactLabel(value, maxLen = 34) {
  const text = String(value || '-').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function compactProductInventoryLabel(row, maxLen = 46) {
  return compactLabel(productDisplayName(row), maxLen);
}

function productKeyText(row) {
  return String([
    row?.product_display_name,
    row?.standard_goods_sn,
    row?.standard_goods_sn_list,
    row?.raw_goods_sn_list,
    row?.goods_sn,
    row?.goods_title,
    row?.product_name,
  ].filter(Boolean).join(' '));
}

function isIceMaker03038(row) {
  return /(?:^|[^0-9])0?3038(?:[^0-9]|$)|SK-?03038/i.test(productKeyText(row));
}

function wantsOperationalWarehouseStockPolicy(text) {
  const q = normalizeText(text);
  return /09仓|09散件|ETRUH09|03仓|04仓|06仓|01仓|ETRUH01|RTV|rtv|破损|销毁|报废|03038|制冰机|实际现货|现货库存的去化实际|只有.*09.*现货|只有09.*算现货/.test(q);
}

function uniqStrings(values) {
  return [...new Set(asArray(values)
    .map(v => String(v || '').trim())
    .filter(Boolean))];
}

function canonicalStockWarehouse(value) {
  const s = String(value || '').trim();
  const upper = s.toUpperCase().replace(/\s+/g, '');
  if (!upper) return '';
  if (/RTV/.test(upper) || /(^|[^0-9])03([^0-9]|$)/.test(upper) || /ETRUH03/.test(upper)) return 'ETRUH03_RTV';
  if (/DAMAGED|破损/.test(upper) || /(^|[^0-9])04([^0-9]|$)/.test(upper) || /ETRUH04/.test(upper)) return 'ETRUH04_DAMAGED';
  if (/SCRAP|报废|销毁/.test(upper) || /(^|[^0-9])06([^0-9]|$)/.test(upper) || /ETRUH06/.test(upper)) return 'ETRUH06_SCRAP';
  if (/(^|[^0-9])09([^0-9]|$)/.test(upper) || /ETRUH09/.test(upper) || /散件/.test(s)) return 'ETRUH09';
  if (/(^|[^0-9])01([^0-9]|$)/.test(upper) || /ETRUH01/.test(upper) || /整箱/.test(s)) return 'ETRUH01';
  return upper;
}

function stockWarehouseLabel(code) {
  const c = canonicalStockWarehouse(code);
  if (c === 'ETRUH09') return 'ETRUH09散件仓';
  if (c === 'ETRUH01') return 'ETRUH01整箱仓';
  if (c === 'ETRUH03_RTV') return 'ETRUH03_RTV';
  if (c === 'ETRUH04_DAMAGED') return 'ETRUH04Damaged';
  if (c === 'ETRUH06_SCRAP') return 'ETRUH06报废';
  return c || String(code || '');
}

function defaultOperationalStockPolicy() {
  return {
    mode: 'operational_sellable',
    sellableWarehouses: ['ETRUH09'],
    excludedWarehouses: ['ETRUH03_RTV', 'ETRUH04_DAMAGED', 'ETRUH06_SCRAP'],
    exceptionProducts: [{match: '03038', sellableWarehouses: ['ETRUH01']}],
    soldOutWithIncomingPlacement: 'front',
    soldOutWithoutIncomingPlacement: 'last',
  };
}

function normalizeWarehouseList(values) {
  return uniqStrings(values).map(canonicalStockWarehouse).filter(Boolean);
}

function normalizeExceptionProducts(values) {
  return asArray(values).map(item => {
    if (!item) return null;
    if (typeof item === 'string') return {match: item, sellableWarehouses: []};
    const match = String(item.match || item.product || item.standard_goods_sn || item.goods_sn || item.sku || '').trim();
    const sellableWarehouses = normalizeWarehouseList(
      item.sellableWarehouses || item.sellable_warehouses || item.warehouses || item.includeWarehouses || item.include_warehouses || []
    );
    return match ? {match, sellableWarehouses} : null;
  }).filter(Boolean);
}

function normalizeStockPolicy(raw, inferenceText = '') {
  const rawObj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawText = typeof raw === 'string' ? raw : '';
  const combinedText = normalizeText([
    inferenceText,
    rawText,
    rawObj.mode,
    rawObj.reason,
    rawObj.description,
    rawObj.note,
    ...(Array.isArray(rawObj.sellableWarehouses) ? rawObj.sellableWarehouses : []),
    ...(Array.isArray(rawObj.excludedWarehouses) ? rawObj.excludedWarehouses : []),
  ].filter(Boolean).join(' '));
  const hasExplicitPolicy = Boolean(raw)
    || wantsOperationalWarehouseStockPolicy(combinedText)
    || normalizeWarehouseList(rawObj.sellableWarehouses || rawObj.sellable_warehouses || rawObj.includeWarehouses || rawObj.include_warehouses || []).length > 0
    || normalizeExceptionProducts(rawObj.exceptionProducts || rawObj.exception_products || rawObj.exceptions || []).length > 0;
  const modeRaw = String(rawObj.mode || rawObj.type || '').toLowerCase();
  if (!hasExplicitPolicy && !/operational|sellable|现货|可售|warehouse|仓/.test(modeRaw)) return {mode: 'default'};
  if (/default|standard|默认/.test(modeRaw) && !wantsOperationalWarehouseStockPolicy(combinedText)) return {mode: 'default'};
  const defaults = defaultOperationalStockPolicy();
  const sellableWarehouses = normalizeWarehouseList(rawObj.sellableWarehouses || rawObj.sellable_warehouses || rawObj.includeWarehouses || rawObj.include_warehouses || []);
  const excludedWarehouses = normalizeWarehouseList(rawObj.excludedWarehouses || rawObj.excluded_warehouses || rawObj.excludeWarehouses || rawObj.exclude_warehouses || []);
  const exceptionProducts = normalizeExceptionProducts(rawObj.exceptionProducts || rawObj.exception_products || rawObj.exceptions || []);
  return {
    mode: 'operational_sellable',
    sellableWarehouses: sellableWarehouses.length ? sellableWarehouses : defaults.sellableWarehouses,
    excludedWarehouses: excludedWarehouses.length ? excludedWarehouses : defaults.excludedWarehouses,
    exceptionProducts: exceptionProducts.length ? exceptionProducts.map(ex => ({
      ...ex,
      sellableWarehouses: ex.sellableWarehouses.length ? ex.sellableWarehouses : defaults.exceptionProducts[0].sellableWarehouses,
    })) : defaults.exceptionProducts,
    soldOutWithIncomingPlacement: /last|末|后/.test(String(rawObj.soldOutWithIncomingPlacement || rawObj.sold_out_with_incoming_placement || '').toLowerCase())
      ? 'last'
      : defaults.soldOutWithIncomingPlacement,
    soldOutWithoutIncomingPlacement: /front|前/.test(String(rawObj.soldOutWithoutIncomingPlacement || rawObj.sold_out_without_incoming_placement || '').toLowerCase())
      ? 'front'
      : defaults.soldOutWithoutIncomingPlacement,
  };
}

function stockPolicyFromIntent(intent, userIntentText = '') {
  const raw = intent?.constraints?.stockPolicy
    || intent?.constraints?.stock_policy
    || intent?.stockPolicy
    || intent?.stock_policy
    || null;
  return normalizeStockPolicy(raw, `${userIntentText || ''} ${intent?.reason || ''}`);
}

function stockPolicyUsesOperational(policy) {
  return policy?.mode === 'operational_sellable';
}

function supportedOperationalWarehouse(code) {
  return ['ETRUH09', 'ETRUH01'].includes(canonicalStockWarehouse(code));
}

function stockWarehouseQty(row, code) {
  const c = canonicalStockWarehouse(code);
  if (c === 'ETRUH09') return n(row?.et_loose_sellable_qty);
  if (c === 'ETRUH01') return n(row?.et_full_carton_qty);
  if (c === 'ETRUH03_RTV') return n(row?.et_rtv_qty);
  if (c === 'ETRUH04_DAMAGED') return n(row?.et_damaged_qty);
  if (c === 'ETRUH06_SCRAP') return n(row?.et_scrap_qty);
  return 0;
}

function productMatchesPolicyException(row, exception) {
  const needle = String(exception?.match || '').trim();
  if (!needle) return false;
  const haystack = productKeyText(row);
  if (/^[0-9]+$/.test(needle)) return new RegExp(`(?:^|[^0-9])0?${needle.replace(/^0+/, '')}(?:[^0-9]|$)`).test(haystack);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function operationalWarehouseOnHand(row, policy = defaultOperationalStockPolicy()) {
  const projection = normalizeInventoryProjection(row);
  if (!projection.fresh_matched) return null;
  if (!stockPolicyUsesOperational(policy)) {
    return projection.current_sellable_quantity;
  }
  const counted = new Set();
  let total = 0;
  const includeWarehouse = (code) => {
    const c = canonicalStockWarehouse(code);
    if (!supportedOperationalWarehouse(c) || counted.has(c)) return;
    counted.add(c);
    total += stockWarehouseQty(row, c);
  };
  for (const code of normalizeWarehouseList(policy.sellableWarehouses || [])) includeWarehouse(code);
  for (const exception of asArray(policy.exceptionProducts)) {
    if (!productMatchesPolicyException(row, exception)) continue;
    for (const code of normalizeWarehouseList(exception.sellableWarehouses || [])) includeWarehouse(code);
  }
  return total;
}

function summarizeStockPolicy(policy) {
  if (!stockPolicyUsesOperational(policy)) return '';
  const sellable = normalizeWarehouseList(policy.sellableWarehouses || []).map(stockWarehouseLabel).join('/');
  const excluded = normalizeWarehouseList(policy.excludedWarehouses || []).map(stockWarehouseLabel).join('/');
  const exceptions = asArray(policy.exceptionProducts)
    .map(ex => `${ex.match || '-'}=>${normalizeWarehouseList(ex.sellableWarehouses || []).map(stockWarehouseLabel).join('/') || '-'}`)
    .join('; ');
  return `现货口径：计${sellable || '-'}；例外${exceptions || '无'}；排除${excluded || '无'}；已售罄有在途${policy.soldOutWithIncomingPlacement === 'front' ? '靠前' : '靠后'}，无在途${policy.soldOutWithoutIncomingPlacement === 'last' ? '最后' : '靠前'}`;
}

function auditStockPolicy(policy) {
  if (!stockPolicyUsesOperational(policy)) return {applied: [], unapplied: []};
  const applied = [summarizeStockPolicy(policy)];
  const unsupported = [];
  for (const code of normalizeWarehouseList(policy.sellableWarehouses || [])) {
    if (!supportedOperationalWarehouse(code)) unsupported.push(`暂不支持把 ${stockWarehouseLabel(code)} 计入可售现货`);
  }
  for (const exception of asArray(policy.exceptionProducts)) {
    for (const code of normalizeWarehouseList(exception.sellableWarehouses || [])) {
      if (!supportedOperationalWarehouse(code)) unsupported.push(`暂不支持例外 ${exception.match || '-'} 使用 ${stockWarehouseLabel(code)}`);
    }
  }
  return {applied, unapplied: [...new Set(unsupported)]};
}

function daysForStock(stock, speed) {
  if (stock === null || stock === undefined || stock === '') return null;
  const s = n(speed);
  if (s <= 0) return null;
  return n(stock) / s;
}

function operationalInventorySortTuple(row, onHand, speed, daysOnHand) {
  const incoming = n(row?.incoming_quantity);
  if (onHand === null || onHand === undefined) return [8, 999999, -n(row?.gross_sold_30d), productKeyText(row)];
  if (onHand <= 0 && incoming <= 0) return [9, 999999, -n(row?.gross_sold_30d), productKeyText(row)];
  if (onHand <= 0 && incoming > 0) return [0, 0, -incoming, productKeyText(row)];
  if (speed <= 0) return [6, 999998, -onHand, productKeyText(row)];
  return [1, Number.isFinite(daysOnHand) ? daysOnHand : 999997, -n(row?.gross_sold_30d), productKeyText(row)];
}

function compareSortTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i];
    const bv = b[i];
    if (typeof av === 'string' || typeof bv === 'string') {
      const cmp = String(av || '').localeCompare(String(bv || ''), 'zh-Hans-CN');
      if (cmp) return cmp;
    } else if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
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
  const explicitlyAllProducts = /每个货号|按货号|货号.*一行|逐货号|所有货号|全部货号|全量|每个产品|所有产品|全部产品/.test(q);
  const product = explicitlyAllProducts ? '' : findProductSmart(text, data);
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
        label: compactLabel(productDisplayName(r, data)),
        value: n(r.gross_sales_sar ?? r.sales_sar),
        valueLabel: moneySar(r.gross_sales_sar ?? r.sales_sar),
        note: `订单 ${intNum(r.gross_orders ?? r.orders)}｜销量 ${intNum(r.gross_quantity ?? r.quantity)}`,
      }));
  if (!sourceRows.length) return null;
  return {
    kind: 'product_sales',
    title: product ? `${date} ${productDisplayName(product, data)} 各店销售` : `${date} 货号销售排行`,
    subtitle: product ? '同一货号在各店的当日/指定日期销售表现' : '按货号销售额降序，展示当前表现靠前的产品',
    metricLabel: '销售额（SAR）',
    unit: ' SAR',
    footnote: chartFreshnessFootnote(data, date),
    rows: sourceRows,
  };
}

function buildInventoryChartSpec(text, data, intent = null) {
  const q = normalizeText(text);
  const userMessages = extractUserMessages(text);
  const latestUserText = userMessages.at(-1) || detectionTexts(text)[0] || q;
  const priorUserText = userMessages.slice(0, -1).join(' ');
  const userIntentText = normalizeText(`${priorUserText} ${latestUserText}`);
  const explicitlyAllProducts = /每个货号|按货号|货号.*一行|逐货号|所有货号|全部货号|全量|每个产品|所有产品|全部产品/.test(q);
  const product = explicitlyAllProducts ? '' : findProductSmart(text, data);
  const numberHints = extractNumberHints(q);
  const latestNumberHints = extractNumberHints(detectionTexts(q)[0] || q);
  const inventory = compactInventoryContext({question: q, data, product, numberHints, latestNumberHints});
  const allProductsMode = !product && explicitlyAllProducts;
  const wantsCycleFields = /去化周期|可售周期|可卖|周转|现货.*天|含在途.*天|周期/.test(userIntentText);
  const stockPolicy = stockPolicyFromIntent(intent, userIntentText);
  const operationalStockPolicy = stockPolicyUsesOperational(stockPolicy);
  const stockPolicyAudit = auditStockPolicy(stockPolicy);
  const wantsMultiInventoryView = allProductsMode && /库存|现货|在途|去化速度|日销|去化周期|可卖|周转|周期/.test(userIntentText) && wantsCycleFields;
  const latestAsksStockSort = /按.*库存|库存数量|库存数|库存.*降序|现货.*排序/.test(latestUserText);
  const latestAsksSpeedSort = /按.*去化速度|按.*日销|去化速度.*排序|日销.*排序/.test(latestUserText);
  const latestAsksCycleSort = /按.*去化周期|按.*可卖|按.*天|去化周期.*排序|现货去化周期|从短到长|升序|断货风险/.test(userIntentText);
  const metric = wantsMultiInventoryView
    ? 'estimated_on_hand_quantity'
    : (latestAsksStockSort || /库存数量|库存数|按库存/.test(latestUserText)
      ? 'estimated_on_hand_quantity'
      : (latestAsksSpeedSort || /去化速度|日销|速度/.test(latestUserText)
        ? 'weighted_daily_gross_sales'
        : (latestAsksCycleSort || /去化|可卖|天|周转|周期/.test(userIntentText)
          ? 'days_of_supply_on_hand'
          : (/销量|近30|消耗/.test(q) ? 'gross_sold_30d' : 'et_estimated_available_qty'))));
  const metricLabel = metric === 'days_of_supply_on_hand'
    ? '在库可卖天数'
    : (metric === 'gross_sold_30d'
      ? '近30天毛销量（件）'
      : (metric === 'weighted_daily_gross_sales' ? '加权日销（件/天）' : (metric === 'estimated_on_hand_quantity' ? '现货库存（件）' : 'ET估算可用库存（件）')));
  const unit = metric === 'days_of_supply_on_hand' ? ' 天' : (metric === 'weighted_daily_gross_sales' ? ' 件/天' : ' 件');

  const metricValue = row => {
    if (operationalStockPolicy && metric === 'estimated_on_hand_quantity') return operationalWarehouseOnHand(row, stockPolicy);
    const projection = normalizeInventoryProjection(row);
    if (metric === 'estimated_on_hand_quantity') return projection.fresh_matched ? projection.current_sellable_quantity : null;
    if (metric === 'days_of_supply_on_hand' && !projection.fresh_matched) return null;
    const value = row[metric];
    return value === null || value === undefined || value === '' ? null : n(value);
  };
  const sourceRows = allProductsMode
    ? asArray(data.inventoryDepletion?.products)
      .filter(row => {
        const productSn = String(row?.standard_goods_sn || row?.standard_goods_sn_list || row?.goods_sn || '').trim();
        return !!productSn;
      })
      .map(row => ({
        standard_goods_sn: row.standard_goods_sn || row.standard_goods_sn_list || row.goods_sn || '',
        product_display_name: productDisplayName(row, data),
        goods_title: row.goods_title,
        stock_status: row.stock_status,
        et_loose_sellable_qty: row.et_loose_sellable_qty,
        et_full_carton_qty: row.et_full_carton_qty,
        et_rtv_qty: row.et_rtv_qty,
        et_damaged_qty: row.et_damaged_qty,
        et_scrap_qty: row.et_scrap_qty,
        et_loose_warehouses: row.et_loose_warehouses,
        et_box_warehouses: row.et_box_warehouses,
        et_estimated_available_qty: row.et_estimated_available_qty,
        current_sellable_quantity: row.current_sellable_quantity,
        inventory_match_status: row.inventory_match_status,
        has_et_inventory: row.has_et_inventory,
        estimated_on_hand_quantity: row.estimated_on_hand_quantity,
        incoming_quantity: row.incoming_quantity,
        gross_sold_30d: row.gross_sold_30d,
        weighted_daily_gross_sales: row.weighted_daily_gross_sales ?? row.weighted_daily_sales ?? row.daily_sales,
        days_of_supply_on_hand: row.days_of_supply_on_hand,
        days_of_supply_with_incoming: row.days_of_supply_with_incoming,
      }))
    : (inventory.products || []);
  const rows = sourceRows
    .sort((a, b) => {
      if (operationalStockPolicy && wantsMultiInventoryView) {
        const onHandA = operationalWarehouseOnHand(a, stockPolicy);
        const onHandB = operationalWarehouseOnHand(b, stockPolicy);
        const speedA = n(a.weighted_daily_gross_sales);
        const speedB = n(b.weighted_daily_gross_sales);
        return compareSortTuple(
          operationalInventorySortTuple(a, onHandA, speedA, daysForStock(onHandA, speedA)),
          operationalInventorySortTuple(b, onHandB, speedB, daysForStock(onHandB, speedB)),
        );
      }
      if (wantsMultiInventoryView && (latestAsksCycleSort || wantsCycleFields)) {
        const pa = normalizeInventoryProjection(a);
        const pb = normalizeInventoryProjection(b);
        const dayA = pa.fresh_matched && n(a.days_of_supply_on_hand) >= 0 && n(a.weighted_daily_gross_sales) > 0 ? n(a.days_of_supply_on_hand) : 999999;
        const dayB = pb.fresh_matched && n(b.days_of_supply_on_hand) >= 0 && n(b.weighted_daily_gross_sales) > 0 ? n(b.days_of_supply_on_hand) : 999999;
        return dayA - dayB || n(pb.current_sellable_quantity) - n(pa.current_sellable_quantity);
      }
      if (metric === 'days_of_supply_on_hand') {
        const dayA = metricValue(a) > 0 && n(a.weighted_daily_gross_sales) > 0 ? metricValue(a) : 999999;
        const dayB = metricValue(b) > 0 && n(b.weighted_daily_gross_sales) > 0 ? metricValue(b) : 999999;
        return dayA - dayB || n(b.gross_sold_30d) - n(a.gross_sold_30d);
      }
      const av = metricValue(a);
      const bv = metricValue(b);
      if (av == null || bv == null) return av == null && bv == null ? n(b.gross_sold_30d) - n(a.gross_sold_30d) : (av == null ? 1 : -1);
      return bv - av || n(b.gross_sold_30d) - n(a.gross_sold_30d);
    })
    .slice(0, allProductsMode ? 120 : 12)
    .map(r => {
      const speed = n(r.weighted_daily_gross_sales);
      const projection = normalizeInventoryProjection(r);
      const onHand = operationalStockPolicy ? operationalWarehouseOnHand(r, stockPolicy) : projection.current_sellable_quantity;
      const daysOnHandRaw = operationalStockPolicy ? daysForStock(onHand, speed) : (projection.fresh_matched ? Number(r.days_of_supply_on_hand) : null);
      const daysWithIncomingRaw = operationalStockPolicy
        ? daysForStock(onHand == null ? null : onHand + n(r.incoming_quantity), speed)
        : (projection.fresh_matched && r.incoming_quantity != null ? Number(r.days_of_supply_with_incoming) : null);
      const daysOnHand = Number.isFinite(daysOnHandRaw) ? daysOnHandRaw : null;
      const daysWithIncoming = Number.isFinite(daysWithIncomingRaw) ? daysWithIncomingRaw : null;
      const status = String(r.stock_status || '-');
      const stockKnown = projection.fresh_matched && onHand != null;
      const activeSoldOut = operationalStockPolicy && stockKnown && onHand <= 0 && n(r.incoming_quantity) > 0;
      const inactiveSoldOut = operationalStockPolicy && stockKnown && onHand <= 0 && n(r.incoming_quantity) <= 0;
      const riskColor = !stockKnown
        ? '#6B7280'
        : speed > 0 && onHand <= 0
        ? '#DC2626'
        : (speed > 0 && daysOnHand > 0 && daysOnHand <= 14
          ? '#DC2626'
          : (speed > 0 && daysOnHand > 0 && daysOnHand <= 30
            ? '#F97316'
            : (/慢|滞|压/.test(status) || daysOnHand >= 180 ? '#6B7280' : '#2563EB')));
      if (wantsMultiInventoryView) {
        const policyPrefix = operationalStockPolicy ? '09现货' : '现货';
        const policyNote = operationalStockPolicy
          ? `${activeSoldOut ? '已售罄有在途｜' : ''}${inactiveSoldOut ? '已售罄无在途｜' : ''}09=${intNum(r.et_loose_sellable_qty)}${isIceMaker03038(r) ? `｜01例外=${intNum(r.et_full_carton_qty)}` : ''}｜排除03/04/06`
          : '';
        return {
          label: compactProductInventoryLabel(r, allProductsMode ? 52 : 38),
          value: stockKnown ? onHand : 0,
          valueLabel: stockKnown ? `${policyPrefix}${intNum(onHand)}｜日销${Number(speed.toFixed(1))}｜${formatDays(daysOnHand, speed > 0)}` : `${policyPrefix}未知｜${inventoryMatchStatusLabel(r)}`,
          note: `${policyNote ? `${policyNote}｜` : ''}在途 ${r.incoming_quantity == null ? '未知' : intNum(r.incoming_quantity)}｜含在途 ${stockKnown ? formatDays(daysWithIncoming, speed > 0) : '未知'}｜${status}`,
          color: riskColor,
        };
      }
      return {
        label: compactProductInventoryLabel(r, allProductsMode ? 46 : 34),
        value: metricValue(r) == null ? 0 : metricValue(r),
        valueLabel: metricValue(r) == null ? `未知｜${inventoryMatchStatusLabel(r)}` : `${metric === 'days_of_supply_on_hand' || metric === 'weighted_daily_gross_sales' ? Number(metricValue(r).toFixed(1)) : intNum(metricValue(r))}${unit}`,
        note: `状态 ${status}｜在途 ${intNum(r.incoming_quantity)}｜近30销量 ${intNum(r.gross_sold_30d)}`,
        color: riskColor,
      };
    });
  if (!rows.length) return null;
  const cycleTitle = operationalStockPolicy ? '全货号09仓现货去化周期图｜按实际现货周期排序' : '全货号库存去化周期图｜按现货去化周期排序';
  const unappliedFootnote = stockPolicyAudit.unapplied.length ? ` 未应用约束：${stockPolicyAudit.unapplied.join('；')}。` : '';
  return {
    kind: 'inventory',
    title: product ? `${productDisplayName(product, data)} 库存/去化图` : (wantsMultiInventoryView ? cycleTitle : (allProductsMode ? '全货号库存/去化信息图' : 'ET/库存去化重点图')),
    subtitle: wantsMultiInventoryView
      ? (operationalStockPolicy
        ? '每个货号一行：货号+中文品名｜09仓可售现货｜在途｜日销｜实际现货/含在途去化周期；已售罄有在途靠前，已售罄无在途放最后'
        : '每个货号一行：货号+中文品名｜现货库存｜在途｜日销｜现货/含在途去化周期；红=断货风险，橙=30天内补货，灰=慢动销')
      : (allProductsMode
        ? `逐货号展示，按${metricLabel.replace(/（.*?）/g, '')}${metric === 'days_of_supply_on_hand' ? '升序' : '降序'}排列；只用新鲜已匹配 ET 库存，未知不按 0 计算`
        : '只用新鲜已匹配 ET 库存与销售去化；未知不按 0 计算，也不等同于 SHEIN 平台展示库存'),
    metricLabel: wantsMultiInventoryView ? (operationalStockPolicy ? '09仓可售现货（件）；右侧标日销/实际去化周期' : '现货库存（件）；右侧标日销/去化周期') : metricLabel,
    unit,
    footnote: `${operationalStockPolicy ? `${summarizeStockPolicy(stockPolicy)}。` : ''}${unappliedFootnote}ET更新时间：${inventory.freshness?.etUpdatedAt || '-'}；BI生成：${data.generatedAt || '-'}`,
    rows,
    constraints: intent?.constraints || {},
    appliedConstraints: stockPolicyAudit.applied,
    unappliedConstraints: stockPolicyAudit.unapplied,
    maxRows: allProductsMode ? Math.min(120, rows.length) : undefined,
    rowHeight: wantsMultiInventoryView ? 64 : (allProductsMode ? 56 : undefined),
    width: wantsMultiInventoryView ? 2300 : (allProductsMode ? 1800 : undefined),
    labelWidth: wantsMultiInventoryView ? 650 : (allProductsMode ? 520 : undefined),
    valueWidth: wantsMultiInventoryView ? 520 : undefined,
  };
}

function productCategoryMap(data) {
  const countsByProduct = new Map();
  for (const row of asArray(data.storeLinks || data.links)) {
    const product = String(row?.standard_goods_sn || row?.goods_sn || '').trim();
    const category = String(row?.category4_name || row?.category_name || row?.categoryName || '').trim();
    if (!product || !category) continue;
    if (!countsByProduct.has(product)) countsByProduct.set(product, new Map());
    const counts = countsByProduct.get(product);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const result = new Map();
  for (const [product, counts] of countsByProduct.entries()) {
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))[0]?.[0];
    if (best) result.set(product, best);
  }
  return result;
}

function allKnownCategories(data) {
  return [...new Set(asArray(data.storeLinks || data.links)
    .map(row => String(row?.category4_name || row?.category_name || row?.categoryName || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function pickCategoryForProduct(row, categoryByProduct) {
  const candidates = [
    row?.standard_goods_sn,
    String(row?.standard_goods_sn_list || '').split(',')[0],
    row?.goods_sn,
    row?.product,
  ].map(v => String(v || '').trim()).filter(Boolean);
  for (const product of candidates) {
    if (categoryByProduct.has(product)) return categoryByProduct.get(product);
  }
  const direct = String(row?.category4_name || row?.category_name || row?.categoryName || '').trim();
  if (direct) return direct;
  const haystack = `${candidates.join(' ')} ${row?.goods_title || ''} ${row?.product_name || ''}`.toLowerCase();
  const rules = [
    ['绞肉机', ['绞肉']],
    ['榨汁机', ['榨汁']],
    ['咖啡机', ['咖啡']],
    ['电热水壶', ['水壶', '热水壶']],
    ['吸尘器', ['吸尘']],
    ['蒸汽熨烫机', ['熨烫', '蒸汽']],
    ['电动缝纫机', ['缝纫']],
    ['制冰机', ['制冰']],
    ['空气炸锅', ['空气炸']],
    ['电磁炉', ['电磁炉']],
    ['直发器', ['直发', '夹板']],
    ['卷发钳和卷发棒', ['卷发']],
    ['电热水瓶', ['热水瓶']],
    ['料理机', ['破壁', '料理']],
    ['手持打蛋器', ['打蛋']],
    ['手持搅拌器', ['搅拌']],
    ['食品料理机', ['料理机']],
    ['三明治和早餐机', ['三明治', '早餐机']],
  ];
  for (const [category, keywords] of rules) {
    if (keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) return category;
  }
  return '未分类/待补类目';
}

function formatDays(value, hasSpeed = true) {
  const x = Number(value);
  if (!hasSpeed) return '-';
  if (!Number.isFinite(x)) return '-';
  if (x >= 999) return '999+天';
  if (x >= 100) return `${Math.round(x)}天`;
  return `${Number(x.toFixed(1)).toLocaleString('en-US')}天`;
}

function categoryInventoryStatus(row) {
  if (!row.productCount && row.onHand <= 0 && row.pending <= 0 && row.speed <= 0) return {label: '待补数据', priority: 90};
  if (!row.matchedProducts) return {label: '库存未知', priority: 80};
  if (row.speed > 0 && row.onHand <= 0) return {label: '断货', priority: 0};
  if (row.speed > 0 && row.daysOnHand <= 14) return {label: '14天内', priority: 1};
  if (row.speed > 0 && row.daysOnHand <= 30) return {label: '30天内', priority: 2};
  if (row.speed > 0 && row.daysOnHand > 180) return {label: '周期长', priority: 5};
  if (row.speed <= 0 && row.onHand > 0) return {label: '慢动销', priority: 4};
  return {label: '健康', priority: 3};
}

function buildCategoryInventoryChartSpec(text, data) {
  const categoryByProduct = productCategoryMap(data);
  const rowsByCategory = new Map();
  const ensure = category => {
    const key = category || '未归类';
    if (!rowsByCategory.has(key)) {
      rowsByCategory.set(key, {
        category: key,
        products: new Set(),
        matchedProducts: 0,
        unknownProducts: 0,
        onHand: 0,
        pending: 0,
        sold7d: 0,
        sold30d: 0,
        speed: 0,
      });
    }
    return rowsByCategory.get(key);
  };

  for (const category of allKnownCategories(data)) ensure(category);

  for (const row of asArray(data.inventoryDepletion?.products)) {
    const product = String(row?.standard_goods_sn || row?.goods_sn || row?.product || '').trim();
    const category = pickCategoryForProduct(row, categoryByProduct);
    const agg = ensure(category);
    if (product) agg.products.add(product);
    const projection = normalizeInventoryProjection(row);
    if (projection.fresh_matched && projection.current_sellable_quantity != null) {
      agg.matchedProducts += 1;
      agg.onHand += projection.current_sellable_quantity;
      agg.pending += n(row?.incoming_quantity) + n(row?.not_shipped_quantity);
      agg.sold7d += n(row?.gross_sold_7d);
      agg.sold30d += n(row?.gross_sold_30d);
      agg.speed += n(row?.weighted_daily_gross_sales ?? row?.weighted_daily_sales ?? row?.daily_sales);
    } else {
      agg.unknownProducts += 1;
    }
  }

  const categories = [...rowsByCategory.values()].map(row => {
    const daysOnHand = row.speed > 0 ? row.onHand / row.speed : null;
    const daysWithPending = row.speed > 0 ? (row.onHand + row.pending) / row.speed : null;
    const base = {
      ...row,
      productCount: row.products.size,
      daysOnHand,
      daysWithPending,
    };
    const status = categoryInventoryStatus(base);
    return {...base, status: status.label, statusPriority: status.priority};
  });

  const chartRows = categories
    .sort((a, b) => {
      const dayA = Number.isFinite(a.daysOnHand) ? a.daysOnHand : 99999;
      const dayB = Number.isFinite(b.daysOnHand) ? b.daysOnHand : 99999;
      return a.statusPriority - b.statusPriority
        || dayA - dayB
        || b.speed - a.speed
        || b.onHand - a.onHand
        || a.category.localeCompare(b.category, 'zh-Hans-CN');
    })
    .map(row => ({
      label: compactLabel(row.category, 24),
      value: row.onHand,
      valueLabel: `${intNum(row.onHand)}件`,
      note: `${row.status}｜货号${intNum(row.productCount)}｜ET覆盖${intNum(row.matchedProducts)}/${intNum(row.productCount)}｜日销${Number(row.speed.toFixed(1)).toLocaleString('en-US')}｜现货${row.matchedProducts ? formatDays(row.daysOnHand, row.speed > 0) : '未知'}｜待到/待发${row.matchedProducts ? intNum(row.pending) : '未知'}`,
    }));

  if (!chartRows.length) return null;
  const totalOnHand = categories.reduce((sum, row) => sum + row.onHand, 0);
  const totalPending = categories.reduce((sum, row) => sum + row.pending, 0);
  const totalSpeed = categories.reduce((sum, row) => sum + row.speed, 0);
  const overallDays = totalSpeed > 0 ? totalOnHand / totalSpeed : null;
  const matchedProducts = categories.reduce((sum, row) => sum + row.matchedProducts, 0);
  const unknownProducts = categories.reduce((sum, row) => sum + row.unknownProducts, 0);
  return {
    kind: 'category_inventory',
    title: '全品类库存去化信息图',
    subtitle: `已匹配现货 ${intNum(totalOnHand)} 件｜待到/待发 ${intNum(totalPending)} 件｜ET覆盖 ${intNum(matchedProducts)} 个货号｜未知 ${intNum(unknownProducts)} 个｜加权日销 ${Number(totalSpeed.toFixed(1)).toLocaleString('en-US')}｜整体现货周期 ${formatDays(overallDays, totalSpeed > 0 && matchedProducts > 0)}`,
    metricLabel: '现货库存（件）',
    unit: ' 件',
    footnote: `口径：只汇总新鲜且已匹配的 ET current_sellable_quantity；未匹配/过期货号标为未知，不按 0 或断货计算；日销=weighted_daily_gross_sales；ET更新时间：${data.dates?.etUpdatedAt || data.inventoryDepletion?.freshness?.etUpdatedAt || '-'}；BI生成：${data.generatedAt || '-'}`,
    rows: chartRows,
    maxRows: Math.min(80, chartRows.length),
    rowHeight: 56,
    width: 1680,
    labelWidth: 430,
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
      label: compactLabel(`${r.store_key || '-'} ${productDisplayName(r, data)} ${String(r.skc || '').slice(-6)}`),
      value: n(r[metric]),
      valueLabel: intNum(r[metric]),
      note: `30天销量 ${intNum(r.c30_sale_cnt)}｜访客 ${intNum(r.c30_goods_uv || r.goods_uv)}｜${r.shelf_status_name || '-'}`,
    }));
  if (!rows.length) return null;
  return {
    kind: 'link',
    title: product ? `${productDisplayName(product, data)} 链接表现图` : '链接表现图',
    subtitle: '基于当前链接表现快照，默认按 30 天曝光/访客/销量展示',
    metricLabel,
    unit: '',
    footnote: `链接数据：${data.dates?.linkUpdatedAt || data.dates?.linkDate || '-'}；BI生成：${data.generatedAt || '-'}`,
    rows,
  };
}

function chartIntentPrompt(text, intent) {
  if (!intent) return text;
  const parts = [text, ''];
  parts.push(`模型图表意图：${intent.chartFamily || 'auto'} ${intent.scope?.level || ''}`);
  if (intent.scope?.allItems) parts.push('所有 全部 全量');
  if (intent.scope?.product) parts.push(String(intent.scope.product));
  if (Array.isArray(intent.scope?.stores) && intent.scope.stores.length) parts.push(intent.scope.stores.join(' '));
  const metricText = (intent.metrics || []).join(' ');
  if (/on_hand|stock|inventory/.test(metricText)) parts.push('库存 现货 库存数量');
  if (/incoming|pending/.test(metricText)) parts.push('在途 待到 待发');
  if (/daily_speed|speed|sell_through/.test(metricText)) parts.push('去化速度 日销');
  if (/days_on_hand|days_with_incoming|cycle|period/.test(metricText)) parts.push('去化周期 可卖天数 周转 现货周期 含在途周期');
  if (/sales|orders|quantity|revenue/.test(metricText)) parts.push('销量 销售额 订单 排行');
  if (/exposure|uv|visitor|click|pay/.test(metricText)) parts.push('链接 曝光 访客 点击 支付 转化');
  if (intent.scope?.level === 'product') parts.push('每个货号 按货号 逐货号 所有货号');
  if (intent.scope?.level === 'category') parts.push('所有品类 品类 类目 信息图');
  if (intent.scope?.level === 'link') parts.push('链接 SKC 曝光 访客 点击 支付');
  if (intent.scope?.level === 'store') parts.push('店铺 各店 店铺排行');
  if (intent.layout?.includeProductName) parts.push('中文品名 商品中文名');
  if (intent.sort?.metric) parts.push(`按${intent.sort.metric}排序 ${intent.sort.direction === 'asc' ? '升序 从短到长 断货风险' : '降序'}`);
  if (intent.constraints && Object.keys(intent.constraints).length) parts.push(`模型结构化约束：${JSON.stringify(intent.constraints).slice(0, 1200)}`);
  const stockPolicy = stockPolicyFromIntent(intent, text);
  if (stockPolicyUsesOperational(stockPolicy)) parts.push(summarizeStockPolicy(stockPolicy));
  if (intent.reason) parts.push(`模型理解说明：${intent.reason}`);
  if (wantsOperationalWarehouseStockPolicy(intent.reason || '')) parts.push('09仓现货口径 只有ETRUH09散件仓算可售现货 SK-03038制冰机例外计ETRUH01整箱仓 03/04/06/RTV/破损/报废不计可售现货');
  return parts.filter(Boolean).join('\n');
}

function annotateChartSpecWithIntent(spec, intent) {
  if (!spec || !intent) return spec;
  return {
    ...spec,
    chartIntent: {
      source: intent.source || 'llm',
      chartFamily: intent.chartFamily || '',
      scope: intent.scope || {},
      metrics: intent.metrics || [],
      sort: intent.sort || {},
      constraints: intent.constraints || {},
      confidence: intent.confidence ?? null,
      reason: previewText(intent.reason || '', 240),
    },
    appliedConstraints: spec.appliedConstraints || [],
    unappliedConstraints: spec.unappliedConstraints || [],
  };
}

function naturalChartFallbackPrompt(text) {
  const q = normalizeText(text);
  const parts = [text, '图表 可视化'];
  if (/撑多久|还能撑|可卖|周期|周转|去化|库存|现货|在途|补货|断货/.test(q)) parts.push('库存 去化周期 现货 在途 日销 可卖天数');
  if (/货号|商品|产品|sku/i.test(q)) parts.push('每个货号 按货号 所有货号 中文品名');
  if (/品类|类目/.test(q)) parts.push('所有品类 品类 类目');
  if (/链接|SKC|skc|曝光|访客|点击|支付|转化/.test(q)) parts.push('链接 SKC 曝光 访客 点击 支付');
  if (/店铺|各店|门店/.test(q)) parts.push('店铺 各店');
  return parts.join('\n');
}

function buildControlledChartSpec(text, data, intent = null) {
  if (intent?.shouldChart === false) return null;
  if (!intent && !wantsChartQuestion(text)) return null;
  const intentText = intent ? chartIntentPrompt(text, intent) : text;
  const q = normalizeText(intentText);
  if (intent?.chartFamily) {
    const family = intent.chartFamily;
    const forced = family === 'inventory'
      ? buildInventoryChartSpec(intentText, data, intent)
      : (family === 'category_inventory'
        ? buildCategoryInventoryChartSpec(intentText, data)
        : (family === 'link'
          ? buildLinkChartSpec(intentText, data)
          : (family === 'product_sales'
            ? buildProductSalesChartSpec(intentText, data)
            : (family === 'store_sales' ? buildStoreSalesChartSpec(intentText, data) : null))));
    if (forced) return annotateChartSpecWithIntent(forced, intent);
  }
  const latest = detectionTexts(intentText)[0] || q;
  const requestsProductLevelInventory = /每个货号|按货号|货号.*一行|逐货号|所有货号|全部货号|全量|每个产品|所有产品|全部产品/.test(latest)
    || /每个货号|按货号|货号.*一行|逐货号|所有货号|全部货号|全量|每个产品|所有产品|全部产品/.test(q);
  if (requestsProductLevelInventory
    && /ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货|周转|可卖|日销|速度/.test(q)) {
    return buildInventoryChartSpec(intentText, data, intent);
  }
  if (/(所有|全部|全).*(品类|类目)|品类|类目|信息图|infographic/i.test(q)
    && /ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货|周转|可卖/.test(q)) {
    return buildCategoryInventoryChartSpec(intentText, data);
  }
  if (/ET|et|库存|货代|去化|补货|在库|在途|仓库|售罄|缺货|断货|周转|可卖/.test(q)) {
    return buildInventoryChartSpec(intentText, data, intent);
  }
  if (/链接|曝光|访客|点击|支付|SKC|skc/.test(q)) {
    return buildLinkChartSpec(intentText, data);
  }
  if (/货号|产品|商品|SKU|sku|销量排行|产品排行/.test(q) || findProductSmart(intentText, data)) {
    return buildProductSalesChartSpec(intentText, data);
  }
  return buildStoreSalesChartSpec(intentText, data);
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

function conversationIdentity(event = {}) {
  const chat = String(event.chat_id || '').trim();
  const sender = String(event.sender_id || '').trim();
  const chatType = String(event.chat_type || '').trim() || 'unknown';
  const thread = String(event.thread_id || event.root_id || '').trim();
  if (chatType === 'p2p') {
    if (sender) return `feishu:p2p:user:${sender}`;
    if (chat) return `feishu:p2p:chat:${chat}`;
  }
  if (chat) {
    if (thread) return `feishu:${chatType}:chat:${chat}:thread:${thread}`;
    return `feishu:${chatType}:chat:${chat}`;
  }
  if (sender) return `feishu:${chatType}:sender:${sender}`;
  return `${chatType}:unknown`;
}

function conversationScope(event = {}) {
  const chatType = String(event.chat_type || '').trim() || 'unknown';
  if (chatType === 'p2p') return 'feishu_p2p_user';
  if (event.thread_id || event.root_id) return 'feishu_group_thread';
  if (event.chat_id) return 'feishu_group_chat';
  return 'feishu_unknown';
}

function conversationIdentityFallbacks(event = {}) {
  const chat = String(event.chat_id || '').trim();
  const sender = String(event.sender_id || '').trim();
  const chatType = String(event.chat_type || '').trim() || 'unknown';
  const thread = String(event.thread_id || event.root_id || '').trim();
  return [
    // 上一版：所有飞书入口优先按 sender 绑定。私聊可继承这份记忆，群聊不继承，避免个人上下文带进群。
    chatType === 'p2p' && sender ? `feishu-user:${sender}` : '',
    // 更早版本：私聊或无线程群聊按 chat_id 绑定；有线程的群聊不继承群级上下文，避免串话。
    chat && (chatType === 'p2p' || !thread) ? `${chatType}:chat:${chat}` : '',
    // 兼容飞书线程字段可能变化时的同一群线程历史。
    chat && thread ? `${chatType}:chat:${chat}:thread:${thread}` : '',
    sender ? `${chatType}:sender:${sender}` : '',
    `${chatType}:unknown`,
  ].filter(Boolean);
}

function conversationKey(event = {}) {
  return crypto.createHash('sha1').update(conversationIdentity(event)).digest('hex');
}

function conversationKeyForIdentity(identity) {
  return crypto.createHash('sha1').update(String(identity || '')).digest('hex');
}

function conversationFile(event = {}) {
  return path.join(CONVERSATION_DIR, `${conversationKey(event)}.json`);
}

function blankConversationState(event = {}) {
  return {
    version: 1,
    key: conversationKey(event),
    chatType: event.chat_type || '',
    memoryPolicy: {
      ttlMs: CONVERSATION_TTL_MS,
      storage: 'raw_full_conversation_no_manual_summary',
      scope: conversationScope(event),
    },
    createdAt: new Date().toISOString(),
    updatedAt: null,
    turns: [],
    lastChart: null,
    lastEcommerceAt: null,
  };
}

function timeMs(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

function isFreshAt(value, nowMs = Date.now()) {
  if (!CONVERSATION_TTL_MS) return true;
  const t = timeMs(value);
  return !!t && nowMs - t <= CONVERSATION_TTL_MS;
}

function recentConversationTurns(turns, nowMs = Date.now()) {
  return (Array.isArray(turns) ? turns : [])
    .filter(turn => isFreshAt(turn?.at, nowMs));
}

function contextConversationTurns(conversation) {
  return Array.isArray(conversation?.turns) ? conversation.turns : [];
}

async function readConversationState(event = {}) {
  const fallback = blankConversationState(event);
  let raw = await readJsonFile(conversationFile(event), null);
  if (!raw) {
    for (const legacyIdentity of conversationIdentityFallbacks(event)) {
      const legacyKey = conversationKeyForIdentity(legacyIdentity);
      if (legacyKey && legacyKey !== fallback.key) {
        raw = await readJsonFile(path.join(CONVERSATION_DIR, `${legacyKey}.json`), null);
        if (raw) break;
      }
    }
  }
  if (!raw) raw = fallback;
  if (!raw || typeof raw !== 'object') return fallback;
  const nowMs = Date.now();
  const lastChart = raw.lastChart && typeof raw.lastChart === 'object' && isFreshAt(raw.lastChart.renderedAt || raw.lastEcommerceAt || raw.updatedAt, nowMs)
    ? raw.lastChart
    : null;
  return {
    ...fallback,
    ...raw,
    key: fallback.key,
    chatType: raw.chatType || fallback.chatType,
    memoryPolicy: fallback.memoryPolicy,
    turns: recentConversationTurns(raw.turns, nowMs),
    lastChart,
    lastEcommerceAt: isFreshAt(raw.lastEcommerceAt, nowMs) ? raw.lastEcommerceAt : null,
  };
}

async function writeConversationState(state) {
  if (!state?.key) return;
  const safe = {
    version: 1,
    key: state.key,
    chatType: state.chatType || '',
    memoryPolicy: {
      ttlMs: CONVERSATION_TTL_MS,
      storage: 'raw_full_conversation_no_manual_summary',
      scope: state.memoryPolicy?.scope || 'feishu_unknown',
    },
    createdAt: state.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: recentConversationTurns(state.turns),
    lastChart: state.lastChart || null,
    lastEcommerceAt: state.lastEcommerceAt || null,
  };
  await fs.mkdir(CONVERSATION_DIR, {recursive: true});
  await fs.writeFile(path.join(CONVERSATION_DIR, `${safe.key}.json`), JSON.stringify(safe, null, 2), 'utf8');
}

function previewText(text, maxLen = 600) {
  const clean = normalizeText(text).replace(/(token|cookie|密码|密钥|secret|验证码)\s*[:：=]\s*\S+/ig, '$1=[已隐藏]');
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function conversationHasEcommerceContext(conversation) {
  if (!conversation || typeof conversation !== 'object') return false;
  if (conversation.lastChart?.kind) return true;
  return (conversation.turns || []).slice(-6).some(turn =>
    turn?.policyMode !== 'out_of_scope' && (turn?.isEcommerce || turn?.chartKind || /电商|运营|库存|货号|链接|销售|图/.test(String(turn?.user || '')))
  );
}

function isFollowupText(text) {
  const q = normalizeText(text);
  return /这个|那个|上面|刚才|上一张|这张|这图|那图|图呢|图片呢|图在哪|改|修改|重做|重画|重新|不满意|看不懂|不直观|按要求|换成|排序|每个货号|按货号|逐货号|放大|字大|宽一点|精简|只看|再来|继续|不是让你|我不是让你/.test(q);
}

function isChartRevisionRequest(text, conversation) {
  if (!conversation?.lastChart?.kind) return false;
  const q = normalizeText(text);
  return isFollowupText(q) && /图|图片|信息图|可视化|改|修改|重做|重画|重新|不满意|看不懂|不直观|排序|货号|放大|精简|按要求/.test(q);
}

function recentConversationLines(conversation, limit = 4) {
  const turns = contextConversationTurns(conversation);
  return (limit ? turns.slice(-limit) : turns)
    .flatMap(turn => [
      turn.user ? `用户：${turn.user}` : '',
      turn.answer ? `智能体：${turn.answer}` : '',
    ])
    .filter(Boolean);
}

function buildEffectiveQuestion(text, conversation) {
  const current = previewText(text, 1000);
  if (!current) return '';
  if (!isFollowupText(current) || !conversationHasEcommerceContext(conversation)) return current;
  const lines = recentConversationLines(conversation, 4);
  if (!lines.length) return current;
  return [...lines, `用户：${current}`].join('\n');
}

function buildChartQuestion(text, conversation) {
  const current = previewText(text, 1000);
  if (isChartRevisionRequest(current, conversation)) {
    const previous = conversation.lastChart?.sourceQuestion || conversation.lastChart?.title || '';
    const previousBlock = previous.includes('用户：') ? previous : (previous ? `用户：${previous}` : '');
    const recentLines = recentConversationLines(conversation, 8);
    return [
      ...recentLines,
      previousBlock,
      `用户：${current}`,
      '智能体：按整段会话里最新的用户改图要求重新生成受控图表；不要只沿用最早那张图的模板。',
    ].filter(Boolean).join('\n');
  }
  return current;
}

function applyChartRevisionHints(spec, text) {
  if (!spec) return spec;
  const q = normalizeText(text);
  const next = {
    ...spec,
    rows: Array.isArray(spec.rows) ? spec.rows : [],
  };
  if (/看不清|放大|字大|宽一点|更宽|不直观|看不懂/.test(q)) {
    next.width = Math.max(n(next.width), 1800);
    next.rowHeight = Math.max(n(next.rowHeight), 60);
    next.labelWidth = Math.max(n(next.labelWidth), 520);
  }
  if (/精简|太长|只看前10|前十|top\s*10/i.test(q)) {
    next.maxRows = Math.min(10, next.rows.length || 10);
  } else if (/所有|全部|全量|每个货号|逐货号|按货号/.test(q)) {
    next.maxRows = Math.min(120, next.rows.length || 120);
  }
  if (/排序|按/.test(q)) {
    next.subtitle = `${next.subtitle || ''}｜已按续改要求重新排序/重排`.replace(/^｜/, '');
  }
  return next;
}

function summarizeConversationForContext(conversation) {
  if (!conversationHasEcommerceContext(conversation)) return null;
  return {
    memoryPolicy: conversation.memoryPolicy || null,
    turns: contextConversationTurns(conversation).map(turn => ({
      user: turn.user || '',
      answer: turn.answer || '',
      policyMode: turn.policyMode || '',
      chartKind: turn.chartKind || '',
      chartTitle: turn.chartTitle || '',
    })),
    lastChart: conversation.lastChart ? {
      kind: conversation.lastChart.kind || '',
      title: conversation.lastChart.title || '',
      metricLabel: conversation.lastChart.metricLabel || '',
      sourceQuestion: conversation.lastChart.sourceQuestion || '',
      appliedConstraints: conversation.lastChart.appliedConstraints || [],
      unappliedConstraints: conversation.lastChart.unappliedConstraints || [],
    } : null,
  };
}

function appendConversationTurn(conversation, event, {policy, answer, chartSpec, chartResult, linkOpsTask, chartSourceQuestion}) {
  const now = new Date().toISOString();
  const next = conversation || blankConversationState(event);
  const user = previewText(event.content || '', 1000);
  const turn = {
    at: now,
    messageId: event.message_id || event.id || '',
    user,
    answer: previewText(answer || '', 1200),
    policyMode: policy?.mode || '',
    policyReason: policy?.reason || '',
    isEcommerce: !!policy?.isEcommerce,
    linkOpsTaskId: linkOpsTask?.id || '',
    chartKind: chartSpec?.kind || '',
    chartTitle: chartSpec?.title || '',
  };
  next.turns = [...recentConversationTurns(next.turns), turn];
  if (policy?.isEcommerce || chartSpec?.kind) next.lastEcommerceAt = now;
  if (chartSpec?.kind) {
    next.lastChart = {
      kind: chartSpec.kind,
      title: chartSpec.title || '',
      subtitle: chartSpec.subtitle || '',
      metricLabel: chartSpec.metricLabel || '',
      sourceQuestion: previewText(chartSourceQuestion || user, 6000),
      chartPath: chartResult?.path || '',
      renderedAt: chartResult?.path ? now : '',
      rowCount: Array.isArray(chartSpec.rows) ? chartSpec.rows.length : 0,
      chartIntent: chartSpec.chartIntent || null,
      appliedConstraints: chartSpec.appliedConstraints || [],
      unappliedConstraints: chartSpec.unappliedConstraints || [],
    };
  }
  next.updatedAt = now;
  return next;
}

const INFRA_ACTION_RE = /重启|部署|发布版本|发版|改代码|修改代码|提交代码|提交git|git\s+push|push|pull|reset|删库|清库|迁移数据库|执行SQL|跑SQL|改表|drop\s+table|truncate|systemctl|sudo|ssh|shell|命令行|定时器|timer|service|docker|nginx|caddy|metabase|postgres|数据库|服务器|BI系统|BI门户|源码|仓库|github|配置文件|auth\.json|config\.toml/i;
const SECRET_RE = /token|cookie|密码|密钥|secret|app[_ -]?secret|auth\.json|config\.toml|凭据|认证信息|验证码|登录态|session/i;
const SECRET_ACTION_RE = /发|给|看|显示|展示|输出|导出|返回|读取|打印|告诉|是什么|复制|下载|泄露/;
const ECOM_DOMAIN_RE = /SHEIN|shein|希音|沙特|半托|电商|运营|店铺|货号|SKU|sku|SKC|skc|商品|产品|链接|上架|下架|标题|主图|图片|套图|卖点|五点|描述|关键词|竞品|竞对|搜索词|流量|曝光|访客|点击|支付|转化|销售|销量|订单|利润|成本|退货|退款|售后|库存|ET|et|货代|去化|补货|活动|报名|折扣|促销|定价|价格|BI|bi|图表|画图|信息图|日报|看板|动作池|任务池/;
const OPS_WRITE_RE = /改标题|换标题|优化标题并(替换|执行|提交)|换图|更换图片|改主图|上传图片|补链接|补链|创建链接|复制上品|上品|上链接|发布商品|刊登|提交审核|恢复上架|重新上架|再次上架|改为上架|设为上架|设置上架|恢复在售|下架|归档|删除链接|停掉链接|报活动|活动报名|报名活动|设置折扣|限时折扣|改价|调价|改价格|改库存|补证书|补资质|执行|开始处理|加入任务池|加入动作池/;
const DRAFT_OR_RESEARCH_RE = /优化标题|标题优化|写标题|生成标题|改写标题|卖点|五点|描述|文案|关键词|竞品|竞对|参考|调研|搜索|查一下|找一下|分析.*标题|图片方案|套图方案/;

function inferLinkOpsIntent(command) {
  const text = String(command || '').trim();
  const lower = text.toLowerCase();
  const intents = [];
  const activateLinkIntent = /恢复上架|重新上架|再次上架|改为上架|设为上架|设置上架|恢复在售|改回在售|上架回来/.test(text)
    || /\b(activate_link|on_shelf|onshelf|relist|restore_listing)\b/.test(lower);
  const copyProductIntent = /补|复制|上品|草稿|覆盖|缺链接|缺链|创建草稿|创建链接|上链接|发链接|发布商品|刊登|提交审核/.test(text)
    || /\b(copy|draft|create|publish|coverage)\b/.test(lower);
  if (activateLinkIntent) intents.push('activate_link');
  if (copyProductIntent) intents.push('copy_product_draft');
  if (/标题|title/.test(lower)) intents.push('update_title');
  if (/主图|图片|套图|image|photo|pic/.test(lower)) intents.push('update_images');
  if (/下架|死链|淘汰|归档|停掉|移除|删除链接/.test(text)) intents.push('retire_link');
  if (/营销|活动|报名/.test(text)) intents.push('campaign_signup');
  if (/限时|折扣|秒杀|促销|discount/.test(lower)) intents.push('flash_discount');
  if (/证书|资质|合规/.test(text)) intents.push('certificate_review');
  if (!intents.length) intents.push('manual_review');
  return [...new Set(intents)];
}

function linkOpsIntentLabel(intent) {
  return ({
    copy_product_draft: '补链接/复制上品',
    activate_link: '恢复/重新上架',
    update_title: '换标题',
    update_images: '换图',
    retire_link: '下架/归档链接',
    campaign_signup: '报营销活动',
    flash_discount: '限时折扣',
    certificate_review: '证书/资质',
    manual_review: '人工复核',
  })[intent] || String(intent || '');
}

function inferLinkOpsTargets(command) {
  const text = String(command || '');
  const stores = [...new Set((text.match(/\b[A-Z]{2,3}\b/g) || [])
    .map(x => x.toUpperCase())
    .filter(x => STORE_KEYS.includes(x) || ['DSY', 'LGM'].includes(x)))]
    .slice(0, 24);
  const productRefs = [...new Set((text.match(/\b(?:[A-Z]{1,6}-?\d{1,8}[A-Z]?(?:-[A-Z0-9]+)?(?:[\u4e00-\u9fa5A-Za-z0-9-]*)?|(?:sv|sb)\d{8,})\b/giu) || [])
    .map(x => x
      .replace(/[，。；、,.]+$/g, '')
      .replace(/(各店|全店|所有店|差链接|弱链接|死链接|缺链接|链接|建议|下架|换图|补新|补链|覆盖).*$/u, ''))
    .filter(x => /\d/.test(x)))]
    .slice(0, 48);
  return {stores, productRefs};
}

function isClearLinkOpsActionCommand(text) {
  const q = normalizeText(text);
  if (!OPS_WRITE_RE.test(q)) return false;
  if (/建议|分析|看看|找出|哪些|哪个|是否|能否|能不能|可以吗|怎么|如何|为什么|原因/.test(q)
    && !/执行|处理|现在|立即|直接|提交|确认|照做|按这个|加入任务池|加入动作池/.test(q)) {
    return false;
  }
  return true;
}

function asksForSecretMaterial(text) {
  return normalizeText(text).split(/[，。；\n]+/).some(clause => {
    const value = clause.trim();
    if (!value || !SECRET_RE.test(value) || !SECRET_ACTION_RE.test(value)) return false;
    // “不要读取认证信息”是安全约束，不是反向索取凭据。只豁免明确
    // 的否定祈使句；“能不能告诉我密码”仍会被拦截。
    if (/^(?:请)?(?:也)?(?:不要|无需|无须|不得|禁止|避免|不可|不能|不应|不可以|不)\s*(?:读取|返回|展示|显示|输出|导出|打印|泄露|访问|使用|涉及|索取)[^，。；\n]{0,24}(?:token|cookie|密码|密钥|secret|凭据|认证信息|验证码|登录态|session)/i.test(value)) return false;
    return true;
  });
}

function classifySafety(text, event = {}, conversation = null) {
  const q = normalizeText(text);
  const isEcom = ECOM_DOMAIN_RE.test(q);
  const inheritedEcom = !isEcom && isFollowupText(q) && conversationHasEcommerceContext(conversation);
  const effectiveIsEcom = isEcom || inheritedEcom;
  const asksSecret = asksForSecretMaterial(q);
  const isOpsWrite = effectiveIsEcom && isClearLinkOpsActionCommand(q);
  const isDraftOrResearch = DRAFT_OR_RESEARCH_RE.test(q) && effectiveIsEcom;
  const isInfra = INFRA_ACTION_RE.test(q) && !isOpsWrite;
  const policy = {
    decision: 'allow',
    mode: inheritedEcom ? 'conversation_followup_allowed' : 'readonly_analysis',
    reason: inheritedEcom ? 'recent_ecommerce_context' : 'ecommerce_ops_allowed',
    larkLinkOpsTaskWriteEnabled: LARK_LINK_OPS_TASK_WRITE_ENABLED,
    isEcommerce: effectiveIsEcom,
    inheritedEcommerceContext: inheritedEcom,
    isOpsWrite,
    needsPublicWeb: /竞品|竞对|关键词|标题|卖点|五点|描述|公开|网上|网页|搜索|调研/.test(q) && effectiveIsEcom,
    intents: isOpsWrite ? inferLinkOpsIntent(q) : [],
    targets: isOpsWrite ? inferLinkOpsTargets(q) : {},
    blocked: false,
    blockMessage: '',
  };
  if (asksSecret) {
    return {
      ...policy,
      decision: 'block',
      mode: 'blocked_secret',
      reason: 'secret_or_session_request_blocked',
      blocked: true,
      blockMessage: '这个请求我不能处理：涉及 token、cookie、密码、密钥、登录态或验证码等敏感信息。你可以让我查经营数据、生成运营建议或创建受控运营任务，但不能读取或输出凭据。',
    };
  }
  if (isInfra) {
    return {
      ...policy,
      decision: 'block',
      mode: 'blocked_infrastructure',
      reason: 'infrastructure_change_blocked',
      blocked: true,
      blockMessage: '这个请求我不能在飞书机器人里执行：它涉及 BI/数据库/服务器/代码/GitHub/配置等基础设施变更。飞书机器人只处理电商运营、数据分析、图表、草稿和受控 SHEIN 链接/商品运营任务。',
    };
  }
  if (!effectiveIsEcom) {
    return {
      ...policy,
      decision: event.chat_type === 'p2p' ? 'block' : 'ignore',
      mode: 'out_of_scope',
      reason: 'not_ecommerce_ops',
      blocked: event.chat_type === 'p2p',
      blockMessage: '我这里只处理 SHEIN/电商运营相关事项：销售、库存、链接、标题、图片、活动、利润、退货、图表和运营任务。这个问题超出了当前机器人范围。',
    };
  }
  if (isOpsWrite) {
    return {
      ...policy,
      mode: LARK_LINK_OPS_TASK_WRITE_ENABLED ? 'ops_write_task_allowed' : 'ops_write_readonly_advice',
      reason: LARK_LINK_OPS_TASK_WRITE_ENABLED ? 'lark_task_creation_enabled' : 'lark_readonly_only',
      blocked: false,
      decision: 'allow',
      blockMessage: '',
    };
  }
  if (isDraftOrResearch) {
    return {...policy, mode: 'draft_or_public_research_allowed', reason: 'draft_and_public_web_allowed'};
  }
  return policy;
}

function shouldConsiderEvent(event) {
  const content = normalizeText(event?.content || '');
  if (!content) return false;
  if (String(event?.message_type || '') !== 'text') return false;
  if (/app|bot/i.test(String(event?.sender_type || ''))) return false;
  if (event?.chat_type === 'p2p') return true;
  if (/图呢|图片呢|图在哪|改.*图|重做|重画|不满意|看不懂|不直观|按要求|每个货号|按货号|上一张|这张图/.test(content)) return true;
  return classifySafety(content, event).decision !== 'ignore';
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeLinkOpsTaskStore(value) {
  return {
    version: 1,
    updatedAt: value?.updatedAt || null,
    tasks: (Array.isArray(value?.tasks) ? value.tasks : []).filter(x => x && typeof x === 'object').slice(0, 1000),
  };
}

function buildLarkLinkOpsTask({command, event, policy, answer}) {
  const now = new Date().toISOString();
  const id = `lot_lark_${now.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
  const intents = policy.intents?.length ? policy.intents : inferLinkOpsIntent(command);
  const targets = policy.targets && typeof policy.targets === 'object' ? policy.targets : inferLinkOpsTargets(command);
  const actor = event.sender_id ? `lark:${event.sender_id}` : 'lark:unknown';
  return {
    id,
    version: 1,
    status: 'draft',
    progress: 10,
    source: 'lark_qa_optional_task',
    chatSessionId: event.chat_id || event.sender_id || '',
    command,
    intents,
    targets,
    preview: {
      summary: `来自飞书的运营动作建议：${intents.map(linkOpsIntentLabel).join(' / ')}。生产默认飞书只读；仅显式开启任务写入时才进入任务池，执行前仍走 BI 预检和审计。`,
      riskNotes: [
        '生产默认飞书只读，不直接创建/更新链接运营任务。',
        '真实执行仍需执行器检查目标店铺、货号/SKC、素材、价格、库存、证书/资质和接口权限。',
        '如未来开启飞书建任务，需要先接员工账号、角色权限和审计边界。',
      ],
      agentAnswer: String(answer || '').slice(0, 12000),
      agentMode: policy.mode,
    },
    requestedBy: actor,
    requestedByUser: event.sender_id || '',
    requestMeta: {
      source: 'lark_sales_qa_bot',
      chatType: event.chat_type || '',
      messageId: event.message_id || event.id || '',
      larkLinkOpsTaskWriteEnabled: LARK_LINK_OPS_TASK_WRITE_ENABLED,
    },
    createdAt: now,
    updatedAt: now,
    execution: {
      mode: 'optional_lark_task_creation',
      enabled: true,
      note: '生产默认飞书只读；只有显式开启飞书任务写入时，才允许创建任务，执行仍必须回到 BI/执行器预检确认。',
    },
    history: [{
      at: now,
      event: 'created_from_lark_qa',
      by: actor,
      status: 'draft',
      progress: 10,
    }],
  };
}

async function createLarkLinkOpsTask({command, event, policy, answer, dryRun = false}) {
  if (!policy?.isOpsWrite || policy.blocked || !LARK_LINK_OPS_TASK_WRITE_ENABLED) return null;
  const task = buildLarkLinkOpsTask({command, event, policy, answer});
  if (dryRun) return {...task, dryRun: true};
  const store = normalizeLinkOpsTaskStore(await readJsonFile(LINK_OPS_TASK_FILE, {version: 1, updatedAt: null, tasks: []}));
  store.tasks = [task, ...store.tasks].slice(0, 1000);
  store.updatedAt = new Date().toISOString();
  await writeJsonFile(LINK_OPS_TASK_FILE, store);
  return task;
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
      product_display_name: productDisplayName(r, data),
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
      product_display_name: productDisplayName(r, data),
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

function extractResponseText(json) {
  return json?.output_text ||
    (Array.isArray(json?.output)
      ? json.output.flatMap(item => item.content || []).map(c => c.text || '').filter(Boolean).join('\n')
      : '');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeIntentFamily(value) {
  const s = String(value || '').toLowerCase();
  if (/category|品类|类目/.test(s) && /inventory|库存|stock|去化/.test(s)) return 'category_inventory';
  if (/category_inventory/.test(s)) return 'category_inventory';
  if (/inventory|stock|库存|去化|补货|在途|现货|周转/.test(s)) return 'inventory';
  if (/link|skc|链接|曝光|访客|点击|转化/.test(s)) return 'link';
  if (/product|sku|货号|商品|产品/.test(s) && /sales|销售|销量|订单/.test(s)) return 'product_sales';
  if (/store|shop|店铺|各店/.test(s)) return 'store_sales';
  if (/sales|销售|销量|订单/.test(s)) return 'store_sales';
  return '';
}

function normalizeIntentLevel(value, family) {
  const s = String(value || '').toLowerCase();
  if (/category|品类|类目/.test(s) || family === 'category_inventory') return 'category';
  if (/link|skc|链接/.test(s) || family === 'link') return 'link';
  if (/product|sku|货号|商品|产品|item/.test(s) || family === 'inventory' || family === 'product_sales') return 'product';
  if (/store|shop|店铺|各店/.test(s) || family === 'store_sales') return 'store';
  return family === 'category_inventory' ? 'category' : (family === 'link' ? 'link' : (family === 'inventory' ? 'product' : 'store'));
}

function normalizeIntentMetric(value) {
  const s = String(value || '').toLowerCase();
  if (/with[_ -]?incoming|含在途/.test(s)) return 'days_with_incoming';
  if (/days|cycle|period|turnover|周期|可卖|周转|天/.test(s)) return 'days_on_hand';
  if (/on[_ -]?hand|stock|inventory|现货|库存/.test(s)) return 'on_hand';
  if (/incoming|pending|在途|待到|待发/.test(s)) return 'incoming';
  if (/daily|speed|sell[_ -]?through|velocity|日销|速度|去化速度/.test(s)) return 'daily_speed';
  if (/revenue|gmv|sar|销售额|金额/.test(s)) return 'sales_amount';
  if (/sale|qty|quantity|销量|成交|出单/.test(s)) return 'sales_quantity';
  if (/order|订单/.test(s)) return 'orders';
  if (/uv|visitor|访客/.test(s)) return 'uv';
  if (/exposure|impression|曝光/.test(s)) return 'exposure';
  if (/click|点击/.test(s)) return 'click';
  if (/pay|支付|转化/.test(s)) return 'pay';
  return '';
}

function normalizeRequirementList(values) {
  return uniqStrings(values).map(v => previewText(v, 160)).filter(Boolean);
}

function normalizeIntentConstraints(raw, fallbackText = '') {
  const constraintsRaw = raw?.constraints && typeof raw.constraints === 'object' ? raw.constraints : {};
  const stockPolicy = normalizeStockPolicy(
    constraintsRaw.stockPolicy || constraintsRaw.stock_policy || raw?.stockPolicy || raw?.stock_policy || null,
    fallbackText,
  );
  const result = {
    displayRequirements: normalizeRequirementList(
      constraintsRaw.displayRequirements || constraintsRaw.display_requirements || raw?.displayRequirements || raw?.display_requirements || [],
    ),
    negativeRequirements: normalizeRequirementList(
      constraintsRaw.negativeRequirements || constraintsRaw.negative_requirements || raw?.negativeRequirements || raw?.negative_requirements || [],
    ),
  };
  if (stockPolicy.mode !== 'default' || constraintsRaw.stockPolicy || constraintsRaw.stock_policy || raw?.stockPolicy || raw?.stock_policy) {
    result.stockPolicy = stockPolicy;
  }
  return result;
}

function normalizeChartIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const family = normalizeIntentFamily(raw.chartFamily || raw.family || raw.kind || raw.chart_kind);
  const shouldChart = raw.shouldChart !== false && raw.should_chart !== false && family !== '';
  const scopeRaw = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const level = normalizeIntentLevel(scopeRaw.level || raw.level || raw.dimension || raw.scopeLevel, family);
  const metricsRaw = [
    ...(Array.isArray(raw.metrics) ? raw.metrics : []),
    ...(Array.isArray(raw.fields) ? raw.fields : []),
    raw.primaryMetric,
    raw.metric,
  ].filter(Boolean);
  const metrics = [...new Set(metricsRaw.map(normalizeIntentMetric).filter(Boolean))];
  const sortRaw = raw.sort && typeof raw.sort === 'object' ? raw.sort : {};
  const sortMetric = normalizeIntentMetric(sortRaw.metric || raw.sortMetric || raw.orderBy || '');
  const directionRaw = String(sortRaw.direction || raw.sortDirection || '').toLowerCase();
  const direction = /asc|升|小到大|短到长|风险|断货/.test(directionRaw) ? 'asc' : (/desc|降|大到小|高到低/.test(directionRaw) ? 'desc' : '');
  const storesRaw = Array.isArray(scopeRaw.stores || raw.stores) ? (scopeRaw.stores || raw.stores) : [];
  const stores = [...new Set(storesRaw.map(x => String(x || '').toUpperCase()).filter(x => STORE_KEYS.includes(x)))];
  const allItemsRaw = scopeRaw.allItems ?? scopeRaw.all_items ?? raw.allItems ?? raw.all_items;
  const layoutRaw = raw.layout && typeof raw.layout === 'object' ? raw.layout : {};
  const fallbackText = [
    raw.reason,
    raw.userIntent,
    raw.intent,
    ...(Array.isArray(raw.fields) ? raw.fields : []),
    ...(Array.isArray(raw.metrics) ? raw.metrics : []),
  ].filter(Boolean).join(' ');
  return {
    source: raw.source || 'llm',
    shouldChart,
    chartFamily: family,
    scope: {
      level,
      allItems: Boolean(allItemsRaw) || /所有|全部|全量|每个|逐/.test(String(raw.reason || raw.userIntent || raw.intent || '')),
      stores,
      product: previewText(scopeRaw.product || raw.product || raw.standard_goods_sn || '', 80),
    },
    metrics,
    sort: {
      metric: sortMetric,
      direction,
    },
    layout: {
      includeProductName: Boolean(layoutRaw.includeProductName ?? raw.includeProductName ?? raw.include_product_name)
        || /中文|品名|名称|title|name/.test(String([...(Array.isArray(raw.fields) ? raw.fields : []), raw.reason, raw.userIntent].join(' '))),
      maxRows: Math.max(0, Math.min(160, Number(layoutRaw.maxRows || raw.maxRows || 0) || 0)),
      wide: Boolean(layoutRaw.wide ?? raw.wide),
    },
    constraints: normalizeIntentConstraints(raw, fallbackText),
    reason: previewText(raw.reason || raw.userIntent || raw.intent || '', 400),
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
  };
}

function chartIntentDataSummary(data) {
  const inventoryProducts = asArray(data.inventoryDepletion?.products);
  const links = asArray(data.storeLinks || data.links);
  const latestDate = data.dates?.salesDate || data.rankings?.dailyStores?.[0]?.date || '';
  return {
    freshness: {
      salesDate: latestDate,
      generatedAt: data.generatedAt || '',
      salesUpdatedAt: data.dates?.salesUpdatedAt || '',
      linkDate: data.dates?.linkDate || '',
      etUpdatedAt: data.dates?.etUpdatedAt || '',
    },
    availableChartFamilies: ['store_sales', 'product_sales', 'inventory', 'category_inventory', 'link'],
    availableStores: STORE_KEYS,
    availableStockPolicyFields: {
      et_loose_sellable_qty: 'ETRUH09散件仓，可售现货',
      et_full_carton_qty: 'ETRUH01整箱仓，当前仅按结构化例外计入可售现货',
      et_rtv_qty: 'ETRUH03_RTV，不计可售现货',
      et_damaged_qty: 'ETRUH04Damaged，不计可售现货',
      et_scrap_qty: 'ETRUH06报废，不计可售现货',
    },
    counts: {
      dailyStores: asArray(data.rankings?.dailyStores).length,
      dailyProducts: asArray(data.rankings?.dailyProducts).length,
      dailyStoreProducts: asArray(data.rankings?.dailyStoreProducts).length,
      inventoryProducts: inventoryProducts.length,
      links: links.length,
      categories: allKnownCategories(data).length,
    },
    sampleProducts: inventoryProducts.slice(0, 80).map(r => ({
      standard_goods_sn: r.standard_goods_sn || r.standard_goods_sn_list || r.goods_sn || '',
      goods_title: r.goods_title || r.product_name || '',
      stock_status: r.stock_status || '',
    })),
    sampleCategories: allKnownCategories(data).slice(0, 80),
  };
}

async function inferControlledChartIntent(question, data, conversation = null) {
  const override = String(process.env.SHEIN_QA_CHART_INTENT_OVERRIDE_JSON || '').trim();
  if (override) {
    const parsed = extractJsonObject(override) || JSON.parse(override);
    return normalizeChartIntent({...parsed, source: 'override'});
  }
  if (!CHART_INTENT_ENABLED || !LLM_ENABLED) return null;
  const {model, baseUrl, apiKey} = await readCodexSettings();
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHART_INTENT_TIMEOUT_MS);
  try {
    const context = {
      currentUserMessage: question,
      recentConversation: recentConversationLines(conversation, 10),
      lastChart: conversation?.lastChart ? {
        kind: conversation.lastChart.kind || '',
        title: conversation.lastChart.title || '',
        metricLabel: conversation.lastChart.metricLabel || '',
        sourceQuestion: previewText(conversation.lastChart.sourceQuestion || '', 2400),
        appliedConstraints: conversation.lastChart.appliedConstraints || [],
        unappliedConstraints: conversation.lastChart.unappliedConstraints || [],
      } : null,
      dataSummary: chartIntentDataSummary(data),
    };
    const payload = {
      model: CHART_INTENT_MODEL || model,
      input: [
        {
          role: 'system',
          content: [{
            type: 'input_text',
            text: [
              '你是 SHEIN 电商运营图表意图解析器，只负责理解自然语言和上下文，不回答业务问题。',
              '请根据当前用户消息、最近会话和上一张图，判断是否需要生成/修改受控 BI 图表。',
              '必须理解“这张图/刚才那个/按这个改/不满意/换成/加上/去掉/按某指标排”等指代；最新用户要求优先，上文只用于补全省略信息。',
              '安全边界：只允许这些图表族：store_sales、product_sales、inventory、category_inventory、link。不能要求读取外部网页、修改系统、修改 BI、修改数据库或执行后台写操作。',
              '只输出一个 JSON 对象，不要 Markdown，不要解释。',
              'JSON 字段：shouldChart(boolean), chartFamily(enum), scope{level,allItems,stores,product}, metrics(array), sort{metric,direction}, layout{includeProductName,maxRows,wide}, constraints{stockPolicy,displayRequirements,negativeRequirements}, reason(string), confidence(number)。',
              'metric 可用：on_hand、incoming、daily_speed、days_on_hand、days_with_incoming、sales_amount、sales_quantity、orders、uv、exposure、click、pay。',
              '如果用户在上下文里纠正了口径/仓库/排除项/例外品，必须放进 constraints，不能只写在 reason。',
              '库存仓库口径用 constraints.stockPolicy：mode 只能是 operational_sellable 或 default；sellableWarehouses 例如 ["ETRUH09"]；excludedWarehouses 例如 ["ETRUH03_RTV","ETRUH04_DAMAGED","ETRUH06_SCRAP"]；exceptionProducts 例如 [{"match":"03038","sellableWarehouses":["ETRUH01"]}]；soldOutWithIncomingPlacement 可为 front/last；soldOutWithoutIncomingPlacement 可为 front/last。',
              '例：用户说“只有09仓算现货，03038制冰机在01仓，03/04/06/RTV/破损/报废不算，已售罄有在途靠前、无在途最后”，应输出 constraints.stockPolicy={mode:"operational_sellable",sellableWarehouses:["ETRUH09"],excludedWarehouses:["ETRUH03_RTV","ETRUH04_DAMAGED","ETRUH06_SCRAP"],exceptionProducts:[{match:"03038",sellableWarehouses:["ETRUH01"]}],soldOutWithIncomingPlacement:"front",soldOutWithoutIncomingPlacement:"last"}。',
            ].join('\n')
          }]
        },
        {
          role: 'user',
          content: [{type: 'input_text', text: JSON.stringify(context)}],
        },
      ],
      max_output_tokens: 700,
      text: {
        format: {
          type: 'json_schema',
          name: 'shein_bi_chart_intent',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['shouldChart', 'chartFamily', 'scope', 'metrics', 'sort', 'layout', 'constraints', 'reason', 'confidence'],
            properties: {
              shouldChart: {type: 'boolean'},
              chartFamily: {type: 'string', enum: ['store_sales', 'product_sales', 'inventory', 'category_inventory', 'link', 'none']},
              scope: {
                type: 'object',
                additionalProperties: false,
                required: ['level', 'allItems', 'stores', 'product'],
                properties: {
                  level: {type: 'string'},
                  allItems: {type: 'boolean'},
                  stores: {type: 'array', items: {type: 'string'}, maxItems: 19},
                  product: {type: 'string'},
                },
              },
              metrics: {type: 'array', items: {type: 'string'}, maxItems: 12},
              sort: {
                type: 'object',
                additionalProperties: false,
                required: ['metric', 'direction'],
                properties: {metric: {type: 'string'}, direction: {type: 'string', enum: ['asc', 'desc', 'none']}},
              },
              layout: {
                type: 'object',
                additionalProperties: false,
                required: ['includeProductName', 'maxRows', 'wide'],
                properties: {includeProductName: {type: 'boolean'}, maxRows: {type: 'integer', minimum: 0, maximum: 100}, wide: {type: 'boolean'}},
              },
              constraints: {
                type: 'object',
                additionalProperties: false,
                required: ['displayRequirements', 'negativeRequirements', 'stockPolicy'],
                properties: {
                  displayRequirements: {type: 'array', items: {type: 'string'}, maxItems: 20},
                  negativeRequirements: {type: 'array', items: {type: 'string'}, maxItems: 20},
                  stockPolicy: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['mode', 'sellableWarehouses', 'excludedWarehouses', 'exceptionProducts', 'soldOutWithIncomingPlacement', 'soldOutWithoutIncomingPlacement'],
                    properties: {
                      mode: {type: 'string', enum: ['default', 'operational_sellable']},
                      sellableWarehouses: {type: 'array', items: {type: 'string'}, maxItems: 20},
                      excludedWarehouses: {type: 'array', items: {type: 'string'}, maxItems: 20},
                      exceptionProducts: {
                        type: 'array',
                        maxItems: 30,
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['match', 'sellableWarehouses'],
                          properties: {
                            match: {type: 'string'},
                            sellableWarehouses: {type: 'array', items: {type: 'string'}, maxItems: 20},
                          },
                        },
                      },
                      soldOutWithIncomingPlacement: {type: 'string', enum: ['front', 'last']},
                      soldOutWithoutIncomingPlacement: {type: 'string', enum: ['front', 'last']},
                    },
                  },
                },
              },
              reason: {type: 'string', maxLength: 500},
              confidence: {type: 'number', minimum: 0, maximum: 1},
            },
          },
        },
      },
    };
    if (CHART_INTENT_REASONING_EFFORT) payload.reasoning = {effort: CHART_INTENT_REASONING_EFFORT};
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
    if (!res.ok) throw new Error(`chart intent LLM HTTP ${res.status}: ${raw.slice(0, 300)}`);
    const parsed = extractJsonObject(extractResponseText(JSON.parse(raw)));
    return normalizeChartIntent(parsed);
  } finally {
    clearTimeout(timer);
  }
}

async function buildControlledChartSpecSmart(text, data, conversation = null) {
  let intent = null;
  let intentError = '';
  if (shouldAskChartIntentPlanner(text, conversation)) {
    try {
      intent = await inferControlledChartIntent(text, data, conversation);
    } catch (err) {
      intentError = String(err?.message || err).slice(0, 600);
      console.error(JSON.stringify({ok: false, stage: 'chart_intent_failed', error: intentError}));
    }
  }
  let spec = intent?.shouldChart ? buildControlledChartSpec(text, data, intent) : null;
  if (!spec) spec = buildControlledChartSpec(text, data);
  if (!spec && shouldAskChartIntentPlanner(text, conversation)) spec = buildControlledChartSpec(naturalChartFallbackPrompt(text), data);
  return {spec, intent, intentError};
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
                '你只能处理 SHEIN/电商运营相关问题：销售、店铺、货号、链接表现、覆盖、ET/成本表库存、去化、售后/利润、标题、图片、活动、价格、运营动作等。',
                '当前安全边界：禁止修改 BI/数据库/服务器/代码/GitHub/配置/密钥；飞书当前只做可读问数和运营建议，不创建链接运营任务。需要补链、改标题、换图、下架、报活动时，请回到 BI 自动化运营页建任务、预检和确认。',
                '如果 securityPolicy.mode=ops_write_readonly_advice，说明飞书当前只读：你可以给出建议和下一步，但不能说已建任务；请提示用户到 BI 自动化运营页创建任务并预检确认。',
                '标题优化、卖点、关键词、竞品参考等需求允许使用公开网页资料做只读调研；不得登录、绕过权限、抓取内部/敏感信息，也不得输出 token/cookie/密码/密钥。',
                '每次回答都必须基于本轮 JSON 重新查数；最新用户消息换了店铺、货号、SKC 或指标时，以最新消息为准，指代不完整时再结合上文。',
                '不要编造未提供的数据；缺数据就明确说缺哪类数据。',
                '只读经营指标筛选属于允许范围；用户说“不要读取认证信息/不要返回 token”是在声明安全约束，不是索取凭据，不得据此拒绝经营数据查询。',
                '上下文里的 inventory.products 是 ET/成本表实物库存与去化口径，platformStockAlerts 是 SHEIN 平台展示库存；不要把二者混为一谈。只要 inventory 里有数据，就不能说“看不到 ET 库存”。',
                '不要给出修改 BI 系统、服务器、代码、密钥、账号、非 SHEIN 业务的建议。',
                '涉及上品、改标题、换图、下架、活动报名、限时折扣等运营写操作时，必须强调飞书只读，实际建任务/预检/确认要回到 BI 自动化运营页。',
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

function extractCodexSessionId(...parts) {
  const text = parts.map(x => String(x || '')).join('\n');
  return safeCodexSessionId(text.match(/session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || '');
}

function safeCodexSessionId(value) {
  const s = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '';
  return s.toLowerCase();
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
    '你只能处理 SHEIN/电商运营相关问题：销售、店铺、货号、链接表现、覆盖、库存、去化、售后/利润、标题、图片、活动、价格、运营动作等。',
    '当前安全边界：禁止修改 BI/数据库/服务器/代码/GitHub/配置/密钥；飞书当前只做可读问数和运营建议，不创建链接运营任务。需要补链、改标题、换图、下架、报活动时，请回到 BI 自动化运营页建任务、预检和确认。',
    '如果 securityPolicy.mode=ops_write_readonly_advice，说明飞书当前只读：你可以给出建议和下一步，但不能说已建任务；请提示用户到 BI 自动化运营页创建任务并预检确认。',
    '标题优化、卖点、关键词、竞品参考等需求允许使用公开网页资料做只读调研；不得登录、绕过权限、抓取内部/敏感信息，也不得输出 token/cookie/密码/密钥。',
    '每次回答都必须基于本轮提供的最新 BI JSON 上下文重新查数；如果最新用户消息换了店铺、货号、SKC 或指标，以最新消息为准，指代不完整时再结合上文。',
    '只读经营指标筛选属于允许范围；用户说“不要读取认证信息/不要返回 token”是在声明安全约束，不是索取凭据，不得据此拒绝经营数据查询。',
    '你可以根据下面提供的 BI JSON 上下文回答；只有标题/关键词/竞品/公开资料调研类问题才允许读取公开网页，除此之外不要调用外部网站；不允许修改文件，不允许绕过上层执行器直接执行 SHEIN 写操作。',
    '上下文里的 inventory.products 是 ET/成本表实物库存与去化口径，platformStockAlerts 是 SHEIN 平台展示库存；不要把二者混为一谈。只要 inventory 里有数据，就不能说“看不到 ET 库存”。',
    '如果用户问上品、改标题、换图、下架、活动、限时折扣，不能说已经静默执行，也不能说已在飞书建任务；应说明飞书只读，并建议回到 BI 自动化运营页生成任务、预检和确认。',
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
  const requestedSessionId = safeCodexSessionId(process.env.SHEIN_QA_CODEX_SESSION_ID || '');
  const metaFile = String(process.env.SHEIN_QA_CODEX_SESSION_META_FILE || '').trim();
  const codexArgs = requestedSessionId
    ? [
      'exec',
      'resume',
      '--skip-git-repo-check',
      '--ignore-rules',
      '--config', 'sandbox_mode="read-only"',
      '--config', 'agents.max_threads=1',
      '--output-last-message', outFile,
      '--model', CODEX_GATEWAY_MODEL,
      '--config', 'approval_policy="never"',
      '--config', `model_reasoning_effort="${CODEX_GATEWAY_REASONING_EFFORT}"`,
      requestedSessionId,
      '-',
    ]
    : [
      'exec',
      '--cd', ROOT,
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ignore-rules',
      ...(CODEX_GATEWAY_EPHEMERAL ? ['--ephemeral'] : []),
      '--color', 'never',
      '--output-last-message', outFile,
      '--model', CODEX_GATEWAY_MODEL,
      '--config', 'approval_policy="never"',
      '--config', `model_reasoning_effort="${CODEX_GATEWAY_REASONING_EFFORT}"`,
      '-',
    ];
  const result = await runProcess('codex', codexArgs, {
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
  const sessionId = requestedSessionId || extractCodexSessionId(result.stderr, result.stdout, answer);
  if (metaFile) {
    await fs.mkdir(path.dirname(metaFile), {recursive: true}).catch(() => {});
    await fs.writeFile(metaFile, JSON.stringify({
      ok: result.ok,
      sessionId,
      requestedSessionId,
      resumed: Boolean(requestedSessionId),
      code: result.code,
      timedOut: result.timedOut,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8').catch(() => {});
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
      ...rows.map((r, i) => `${i + 1}. ${productDisplayName(r, data)}：${rowSummary(r)}`),
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
    if (!rows.length) return `没查到 ${date} ${productDisplayName(product, data)} 的销售数据。\n${latestNote}`;
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
      `${date} ${productDisplayName(product, data)} 合计：${rowSummary(row)}`,
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

function parseChineseMetricNumber(value) {
  const raw = String(value || '').replace(/,/g, '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const digits = new Map(Object.entries({零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9}));
  const units = new Map(Object.entries({十: 10, 百: 100, 千: 1000}));
  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of raw) {
    if (digits.has(char)) {
      current = digits.get(char);
      continue;
    }
    if (units.has(char)) {
      section += (current || 1) * units.get(char);
      current = 0;
      continue;
    }
    if (char === '万') {
      total += (section + current || 1) * 10_000;
      section = 0;
      current = 0;
      continue;
    }
    return null;
  }
  return total + section + current;
}

function metricThreshold(text, labelPattern) {
  const match = normalizeText(text).match(new RegExp(`${labelPattern}([^，。；\\n]{0,32})`, 'iu'));
  if (!match) return null;
  const percentIndex = match[1].indexOf('百分之');
  const metricText = percentIndex >= 0 ? match[1].slice(percentIndex + 3) : match[1];
  const literals = metricText.match(/\d+(?:,\d{3})*(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+/gu) || [];
  for (const literal of literals) {
    const parsed = parseChineseMetricNumber(literal);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function answerLinkPerformanceFilter(text, data) {
  const q = normalizeText(text);
  if (!/(?:近|最近)\s*7\s*(?:天|日)/u.test(q)) return '';
  if (!/点击率/u.test(q) || !/曝光/u.test(q) || !/(?:销量|成交件数)/u.test(q)) return '';
  if (!/(?:零销量|销量[^，。；\n]{0,12}(?:等于|为|=|不高于|至多)?\s*(?:0|零)|(?:支付)?销量为零)/u.test(q)) return '';

  const clickLiteral = metricThreshold(q, '点击率');
  const exposureThreshold = metricThreshold(q, '曝光(?:量|次数|人数)?');
  if (!Number.isFinite(clickLiteral) || !Number.isFinite(exposureThreshold)) return '';
  const clickThreshold = /百分之|%/u.test(q) || clickLiteral > 1 ? clickLiteral / 100 : clickLiteral;
  const stores = pickStoresSmart(q);
  const sourceRows = asArray(data.storeLinks).length ? asArray(data.storeLinks) : asArray(data.links);
  const uniqueRows = new Map();
  for (const row of sourceRows) {
    const storeKey = String(row?.store_key || '').toUpperCase();
    const skc = String(row?.skc || '').trim();
    if (!storeKey || !skc || !rowMatchesStores(row, stores)) continue;
    const key = `${storeKey}\u0000${skc}`;
    const prior = uniqueRows.get(key);
    if (!prior || String(row.link_date || '') > String(prior.link_date || '')) uniqueRows.set(key, row);
  }
  const matches = [...uniqueRows.values()].map(row => {
    const exposure = n(row.c7_eps_uv);
    const visitors = n(row.c7_goods_uv);
    const clickRate = exposure > 0 ? visitors / exposure : 0;
    return {row, exposure, visitors, clickRate, sales: n(row.c7_sale_cnt)};
  }).filter(item => item.exposure >= exposureThreshold && item.clickRate >= clickThreshold && item.sales === 0)
    .sort((left, right) => right.exposure - left.exposure
      || right.clickRate - left.clickRate
      || String(left.row.store_key || '').localeCompare(String(right.row.store_key || ''))
      || String(left.row.skc || '').localeCompare(String(right.row.skc || '')));

  const latestDate = String(data.dates?.linkDate || matches[0]?.row?.link_date || '').slice(0, 10);
  const startDate = latestDate ? addDays(latestDate, -6) : '';
  const scope = stores.length ? stores.join('、') : '全部店铺';
  const thresholdLabel = `${(clickThreshold * 100).toFixed(2).replace(/\.00$/, '')}%`;
  const header = `${scope}近7天命中 ${matches.length} 条：点击率 ≥ ${thresholdLabel}、曝光量 ≥ ${intNum(exposureThreshold)}、销量 = 0`;
  if (!matches.length) {
    return [header, latestDate ? `统计区间：${startDate} 至 ${latestDate}` : '', '本次没有符合条件的链接。'].filter(Boolean).join('\n');
  }
  const lines = matches.map((item, index) => {
    const row = item.row;
    const product = productDisplayName(row, data) || String(row.standard_goods_sn || row.raw_goods_sn || '未命名商品');
    const supplierCode = String(row.standard_goods_sn || row.raw_goods_sn || '').trim();
    const status = String(row.shelf_status_name || '').trim();
    return `${index + 1}. ${row.store_key}｜${product}${supplierCode && supplierCode !== product ? `｜货号 ${supplierCode}` : ''}｜${row.skc}｜曝光 ${intNum(item.exposure)}｜点击率 ${(item.clickRate * 100).toFixed(2)}%｜销量 0${status ? `｜${status}` : ''}`;
  });
  return [
    header,
    latestDate ? `统计区间：${startDate} 至 ${latestDate}；点击率按近7天商详访客 ÷ 近7天曝光量重算。` : '点击率按近7天商详访客 ÷ 近7天曝光量重算。',
    ...lines,
    'BI 当前没有单独下发可点击的商品网址；以上 SKC 是链接唯一定位编号。',
  ].join('\n');
}

function positivePriceNumbers(value) {
  return (String(value ?? '').match(/-?\d+(?:\.\d+)?/g) || [])
    .map(Number)
    .filter(number => Number.isFinite(number) && number > 0);
}

function currentPriceFlag(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true' || String(value || '') === '1';
}

function activeDiscountCandidates(row) {
  const candidates = [];
  const add = (label, value, sourceAt) => {
    const values = positivePriceNumbers(value);
    if (!values.length) return;
    candidates.push({label, value: Math.min(...values), sourceAt: String(sourceAt || '').trim()});
  };
  const platformPrices = positivePriceNumbers(row?.current_price_range_sar);
  const comparisonPrices = positivePriceNumbers(row?.original_supply_price_range_sar || row?.purchase_price_range_sar || row?.list_price_range_sar);
  if (platformPrices.length) {
    const sameAsComparison = comparisonPrices.length === platformPrices.length
      && platformPrices.every((value, index) => Math.abs(value - comparisonPrices[index]) < 0.005);
    if (!sameAsComparison) add('后台折后价', row.current_price_range_sar, row.current_price_source_at);
  }
  const evidenceType = String(row?.marketing_price_evidence_type || '');
  const ordinaryCurrent = currentPriceFlag(row?.marketing_ordinary_price_is_current)
    || /current_ordinary_marketing_live_scan|active_ordinary/i.test(evidenceType);
  const limitedCurrent = currentPriceFlag(row?.marketing_limited_discount_is_current)
    || /current_limited_discount_live_scan|active_limited_discount_live_scan|active_limited/i.test(evidenceType);
  if (ordinaryCurrent) add('普通活动价', row?.marketing_suggested_ordinary_price_sar, row?.marketing_price_source_at);
  if (limitedCurrent) add('限时折扣价', row?.marketing_limited_discount_price_sar, row?.marketing_price_source_at);
  return candidates.sort((left, right) => left.value - right.value || left.label.localeCompare(right.label, 'zh-Hans-CN'));
}

function requestedProductModels(text) {
  return [...new Set((String(text || '').toUpperCase().match(/\b[A-Z]{1,8}-\d[A-Z0-9-]{1,24}\b/g) || [])
    .filter(value => !/^SV\d/i.test(value)))];
}

function rowMatchesProductModel(row, model) {
  const escaped = String(model || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  const pattern = new RegExp(`(^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`, 'i');
  return pattern.test([
    row?.standard_goods_sn,
    row?.raw_goods_sn,
    row?.product_display_name,
    row?.product_name_cn,
  ].filter(Boolean).join('|'));
}

function isOnShelfLink(row) {
  return row?.is_on_shelf === true || /(?:已上架|正常在售)/u.test(String(row?.shelf_status_name || ''));
}

function chinaTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}+08:00`
    : text;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return text;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function answerLowestCurrentDiscountPrices(text, data) {
  const q = normalizeText(text);
  if (!/(?:折后价|活动价|促销价)/u.test(q) || !/(?:最低|最便宜|低价)/u.test(q)) return '';
  const models = requestedProductModels(q);
  if (!models.length) return '';
  const sourceRows = asArray(data.storeLinks).length ? asArray(data.storeLinks) : asArray(data.links);
  if (!sourceRows.length) return '';
  const output = ['全部店铺当前在售链接最低折后价（SAR，不含额外优惠券）'];
  let latestPriceAt = '';
  let latestLinkDate = '';
  for (const model of models) {
    const unique = new Map();
    for (const row of sourceRows) {
      if (!rowMatchesProductModel(row, model)) continue;
      const store = String(row?.store_key || '').toUpperCase();
      const skc = String(row?.skc || '').trim();
      if (!store || !skc) continue;
      const key = `${store}\u0000${skc}`;
      const previous = unique.get(key);
      if (!previous || String(row.link_date || '') >= String(previous.link_date || '')) unique.set(key, row);
    }
    const allLinks = [...unique.values()];
    const onShelf = allLinks.filter(isOnShelfLink);
    const priced = [];
    const missing = [];
    for (const row of onShelf) {
      const candidate = activeDiscountCandidates(row)[0];
      latestLinkDate = [latestLinkDate, String(row?.link_date || '').slice(0, 10)].sort().at(-1) || latestLinkDate;
      if (!candidate) {
        missing.push(`${row.store_key}/${row.skc}`);
        continue;
      }
      latestPriceAt = [latestPriceAt, candidate.sourceAt].sort().at(-1) || latestPriceAt;
      priced.push({...candidate, store: String(row.store_key), skc: String(row.skc)});
    }
    priced.sort((left, right) => left.value - right.value || left.store.localeCompare(right.store) || left.skc.localeCompare(right.skc));
    if (!priced.length) {
      output.push(`${model}：在售 ${onShelf.length} 条 / 总链接 ${allLinks.length} 条，当前折后价取价 0 条。${missing.length ? ` 未取价：${missing.join('、')}` : ''}`);
      continue;
    }
    const minimum = priced[0].value;
    const ties = priced.filter(item => Math.abs(item.value - minimum) < 0.005);
    output.push(`${model}：${minimum.toFixed(2)} SAR｜${ties.map(item => `${item.store}/${item.skc}`).join('、')}｜${ties[0].label}｜在售 ${onShelf.length} 条，取价 ${priced.length} 条，未取价 ${missing.length} 条${missing.length ? `（${missing.join('、')}）` : ''}`);
  }
  const priceAt = chinaTimestamp(latestPriceAt);
  if (priceAt || latestLinkDate) output.push(`价格快照：${priceAt || '-'}；链接数据：${latestLinkDate || data.dates?.linkDate || '-'}`);
  output.push('只使用当前已生效的后台折后价/活动价；未把原价、供货价、计划价或历史成交价当成当前折后价。');
  return output.join('\n');
}

function shouldAnswerDeterministicallyFirst(text, policy = {}) {
  if (policy?.isOpsWrite || policy?.needsPublicWeb) return false;
  const q = normalizeText(text);
  if (/为什么|原因|诊断|归因|预测|建议|方案|策略|分析|对比|异常|标题|图片|竞品|关键词|活动|折扣|优惠券/i.test(q)) return false;
  return /销售|销售额|销量|卖了多少|订单|排行|排名|最好|最差|哪个店|哪个品|库存|现货|在途|去化|补货|断货/i.test(q);
}

function answerPolicyFallback(text, data, policy = {}) {
  const q = normalizeText(text);
  const product = findProductSmart(q, data) || policy.targets?.productRefs?.[0] || '';
  const stores = policy.targets?.stores || pickStoresSmart(q);
  const freshness = `BI生成：${data.generatedAt || '-'}；销售源：${data.dates?.salesUpdatedAt || '-'}`;
  if (policy.isOpsWrite) {
    const intents = (policy.intents || []).map(linkOpsIntentLabel).join(' / ') || '运营动作';
    return [
      `已识别为 SHEIN 受控运营动作：${intents}。`,
      `目标：${[stores.length ? `店铺 ${stores.join(',')}` : '', product ? `货号/SKC ${productDisplayName(product, data)}` : ''].filter(Boolean).join('；') || '还需要在任务里补齐具体目标'}`,
      '飞书当前只读，不创建运营任务；请在 BI 自动化运营页生成任务，后续会走预检、确认、审计和回读，不会静默改 SHEIN。',
      freshness,
    ].join('\n');
  }
  if (policy.mode === 'draft_or_public_research_allowed') {
    const baseName = product ? productDisplayName(product, data) : (q.match(/[\u4e00-\u9fa5A-Za-z0-9-]{3,40}/)?.[0] || '该产品');
    if (/标题|title/i.test(q)) {
      return [
        `可以做 ${baseName} 的标题优化。当前安全策略允许参考公开网页/竞品关键词，但只输出草稿，不直接改 SHEIN。`,
        '先给你一版不联网兜底草稿：',
        `1. ${baseName}｜高效实用｜家用便捷款`,
        `2. ${baseName}｜快速省时｜厨房/家居日常必备`,
        `3. ${baseName}｜大容量易操作｜适合沙特家庭使用`,
        '如果需要，我可以在公开网页范围内补充竞品关键词后再给更强的一版。',
        freshness,
      ].join('\n');
    }
    return [
      '这个属于电商运营草稿/公开资料参考类请求，安全策略允许处理。',
      '我可以结合现有 BI 数据和公开网页资料生成标题、卖点、关键词、图片方案或运营建议；不会直接改 SHEIN 后台。',
      freshness,
    ].join('\n');
  }
  return '';
}

async function answerQuestionSmart(text, data, policy = {}, linkOpsTask = null, conversation = null, queryText = text) {
  const routingText = String(queryText || text);
  const discountPriceAnswer = answerLowestCurrentDiscountPrices(routingText, data);
  if (discountPriceAnswer) return discountPriceAnswer;
  const linkFilterAnswer = answerLinkPerformanceFilter(routingText, data);
  if (linkFilterAnswer) return linkFilterAnswer;
  if (shouldAnswerDeterministicallyFirst(routingText, policy)) return answerQuestion(routingText, data);
  const contextDraft = compactSalesContext(routingText, data);
  contextDraft.securityPolicy = {
    decision: policy.decision || '',
    mode: policy.mode || '',
    reason: policy.reason || '',
    needsPublicWeb: !!policy.needsPublicWeb,
    intents: policy.intents || [],
    targets: policy.targets || {},
  };
  if (linkOpsTask) {
    contextDraft.linkOpsTask = {
      id: linkOpsTask.id || '',
      status: linkOpsTask.status || '',
      dryRun: !!linkOpsTask.dryRun,
      intents: linkOpsTask.intents || [],
      targets: linkOpsTask.targets || {},
      note: '这是受控运营任务记录；真实执行仍需链接管理中台/执行器预检和审计。',
    };
  }
  const conversationContext = summarizeConversationForContext(conversation);
  if (conversationContext) contextDraft.conversation = conversationContext;
  const loadMeta = biQueryMetaByData.get(data) || null;
  const sectionFacts = buildBiOpsSectionFacts(routingText, data, loadMeta);
  const context = buildBiOpsQueryContext(contextDraft, {
    question: routingText,
    loadMeta,
    sectionFacts,
    maxBytes: BI_CONTEXT_MAX_BYTES,
  });
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
  const policyFallback = answerPolicyFallback(routingText, data, policy);
  if (policyFallback) return policyFallback;
  return answerQuestion(routingText, data);
}

function shouldAnswerEvent(event) {
  return shouldConsiderEvent(event);
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
  let conversation = await readConversationState(event);
  const policy = classifySafety(event.content || '', event, conversation);
  if (policy.decision === 'ignore') return {ok: true, skipped: true, reason: policy.reason || 'ignored_by_policy'};
  if (policy.blocked) {
    const answer = policy.blockMessage || '这个请求超出了当前 SHEIN 电商运营机器人的安全范围。';
    const sendArgs = [
      'im', '+messages-reply',
      '--as', 'bot',
      '--message-id', event.message_id || event.id,
      '--text', answer,
      '--idempotency-key', `sales-qa-${eventId}`.slice(0, 80),
    ];
    const sent = options.dryRun ? {ok: true, dryRun: true} : await runLark(sendArgs);
    await markHandled(eventId, {
      handledAt: new Date().toISOString(),
      eventId,
      messageId: event.message_id || event.id || '',
      chatType: event.chat_type || '',
      conversationKey: conversation.key || '',
      questionPreview: String(event.content || '').slice(0, 200),
      answer,
      sendOk: sent.ok,
      sendCode: sent.code ?? null,
      safetyPolicy: policy,
      blocked: true,
      stderrTail: String(sent.stderr || '').slice(-500),
    });
    return {ok: sent.ok, eventId, blocked: true, safetyMode: policy.mode, answer, sendCode: sent.code ?? null};
  }
  const effectiveQuestion = buildEffectiveQuestion(event.content || '', conversation);
  const chartQuestion = buildChartQuestion(event.content || '', conversation);
  const data = await readData(`${effectiveQuestion}\n${chartQuestion}`);
  const previousChartKind = conversation.lastChart?.kind || '';
  const chartRevision = isChartRevisionRequest(event.content || '', conversation);
  const chartPlan = await buildControlledChartSpecSmart(chartQuestion, data, conversation);
  let chartSpec = chartPlan.spec;
  if (chartSpec && chartRevision) chartSpec = applyChartRevisionHints(chartSpec, event.content || '');
  const baseAnswer = await answerQuestionSmart(effectiveQuestion, data, policy, null, conversation);
  const linkOpsTask = await createLarkLinkOpsTask({
    command: event.content || '',
    event,
    policy,
    answer: baseAnswer,
    dryRun: !!options.dryRun,
  });
  const taskNote = linkOpsTask
    ? `\n\n运营任务：已${linkOpsTask.dryRun ? '模拟' : ''}加入链接运营任务池 ${linkOpsTask.id}。注意：生产默认飞书只读；只有显式开启 SHEIN_QA_LINK_OPS_TASK_WRITE_ENABLED 时才会从飞书建任务。`
    : '';
  const answer = (chartSpec
    ? `${baseAnswer}\n\n图表：已按当前 BI 数据生成受控图表，图片见下一条。`
    : baseAnswer) + taskNote;
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
  conversation = appendConversationTurn(conversation, event, {policy, answer, chartSpec, chartResult, linkOpsTask, chartSourceQuestion: chartQuestion});
  await writeConversationState(conversation);
  await markHandled(eventId, {
    handledAt: new Date().toISOString(),
    eventId,
    messageId: event.message_id || event.id || '',
    chatType: event.chat_type || '',
    conversationKey: conversation.key || '',
    questionPreview: String(event.content || '').slice(0, 200),
    effectiveQuestionPreview: effectiveQuestion.slice(0, 600),
    answer,
    sendOk: sent.ok,
    sendCode: sent.code ?? null,
    safetyPolicy: policy,
    linkOpsTaskId: linkOpsTask?.id || '',
    linkOpsTaskDryRun: !!linkOpsTask?.dryRun,
    chartKind: chartSpec?.kind || '',
    chartRevision,
    chartIntent: chartPlan.intent || null,
    chartIntentError: chartPlan.intentError || '',
    chartAppliedConstraints: chartSpec?.appliedConstraints || [],
    chartUnappliedConstraints: chartSpec?.unappliedConstraints || [],
    previousChartKind: chartRevision ? previousChartKind : '',
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
    safetyMode: policy.mode,
    linkOpsTaskId: linkOpsTask?.id || '',
    chartKind: chartSpec?.kind || '',
    chartIntentFamily: chartPlan.intent?.chartFamily || '',
    chartAppliedConstraints: chartSpec?.appliedConstraints || [],
    chartUnappliedConstraints: chartSpec?.unappliedConstraints || [],
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
  const queryText = String(process.env.SHEIN_QA_QUERY_TEXT || process.env.SHEIN_QA_SAFETY_TEXT || args.answer);
  const data = await readData(queryText);
  const policy = classifySafety(queryText, {chat_type: 'p2p', message_type: 'text', sender_type: 'user'});
  if (policy.blocked) {
    console.log(policy.blockMessage);
  } else {
    console.log(await answerQuestionSmart(args.answer, data, policy, null, null, queryText));
  }
} else if (args.renderChart) {
  const data = await readData(args.renderChart);
  const {spec} = await buildControlledChartSpecSmart(args.renderChart, data, null);
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
    appliedConstraints: result.spec.appliedConstraints || [],
    unappliedConstraints: result.spec.unappliedConstraints || [],
  }, null, 2));
} else if (args.planChart) {
  const data = await readData(args.planChart);
  const {spec, intent, intentError} = await buildControlledChartSpecSmart(args.planChart, data, null);
  console.log(JSON.stringify({
    ok: Boolean(spec),
    intent,
    intentError,
    spec: spec ? {
      kind: spec.kind,
      title: spec.title,
      subtitle: spec.subtitle,
      metricLabel: spec.metricLabel,
      rows: spec.rows?.length || 0,
      width: spec.width || null,
      labelWidth: spec.labelWidth || null,
      valueWidth: spec.valueWidth || null,
      appliedConstraints: spec.appliedConstraints || [],
      unappliedConstraints: spec.unappliedConstraints || [],
      chartIntent: spec.chartIntent || null,
    } : null,
  }, null, 2));
} else if (args.consume) {
  await consume({dryRun: args.dryRun});
} else {
  console.log('Usage: node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少" | --render-chart "今天店铺销售画图" [--chart-output out.png] | --plan-chart "自然语言作图需求" | --consume');
}
