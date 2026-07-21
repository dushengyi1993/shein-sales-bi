import fs from 'node:fs/promises';
import path from 'node:path';

export const BI_OPS_QUERY_CONTEXT_VERSION = 'bi-ops-query-context-v1';

export const BI_OPS_SECTION_KEYS = Object.freeze([
  'homeProfit',
  'homeRankings',
  'rankings',
  'profit',
  'actions',
  'linksData',
  'productSalesDaily',
  'homeTrafficDaily',
  'productTrafficDaily',
  'inventoryTrend',
  'comments',
  'orders',
  'priceScatter',
  'afterSales',
  'rtvData',
  'waybills',
]);

export const DEFAULT_BI_OPS_CONTEXT_MAX_BYTES = 96 * 1024;
export const DEFAULT_BI_OPS_CORE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BI_OPS_SECTION_MAX_BYTES = 32 * 1024 * 1024;

const SECTION_KEY_SET = new Set(BI_OPS_SECTION_KEYS);
const STORE_KEYS = new Set(['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC', 'DSY', 'LGM']);
const RESERVED_SECTION_DATA_KEYS = new Set(['generatedAt', '__sections']);
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Lower-priority data is merged first. A complete rankings shard therefore
// wins over the compact homepage shard when both are explicitly loaded.
const SECTION_PRIORITY = Object.freeze({
  homeRankings: 20,
  rankings: 30,
  homeProfit: 20,
  profit: 30,
});

const SECTION_FACT_KEYS = Object.freeze({
  homeProfit: ['homeProfitSummary'],
  profit: ['profit'],
  actions: ['actions', 'actionDomain'],
  productSalesDaily: ['productSalesDaily'],
  homeTrafficDaily: ['homeTrafficDaily'],
  productTrafficDaily: ['productTrafficDaily'],
  comments: ['comments', 'commentSummary'],
  orders: ['orders'],
  priceScatter: ['priceScatter'],
  afterSales: ['afterSales'],
  rtvData: ['rtvReview', 'rtvTrace'],
  waybills: ['waybills'],
});

const SECTION_PAYLOAD_KEYS = Object.freeze({
  homeProfit: ['homeProfitSummary'],
  homeRankings: ['rankings'],
  rankings: ['rankings'],
  profit: ['profit'],
  actions: ['actions', 'actionDomain'],
  linksData: ['links', 'storeLinks', 'matrix'],
  productSalesDaily: ['productSalesDaily'],
  homeTrafficDaily: ['homeTrafficDaily'],
  productTrafficDaily: ['productTrafficDaily'],
  inventoryTrend: ['inventoryDepletion'],
  comments: ['comments', 'commentSummary'],
  orders: ['orders'],
  priceScatter: ['priceScatter'],
  afterSales: ['afterSales'],
  rtvData: ['rtvReview', 'rtvTrace'],
  waybills: ['waybills'],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeQuestion(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function safeNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(safeNumber(value) * multiplier) / multiplier;
}

function cloneJson(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function sectionFile(sectionsDir, section) {
  if (!SECTION_KEY_SET.has(section)) throw new Error(`Unsupported BI section: ${section}`);
  const root = path.resolve(sectionsDir);
  const file = path.resolve(root, `${section}.json`);
  if (path.dirname(file) !== root) throw new Error(`Unsafe BI section path: ${section}`);
  return file;
}

async function readJsonBounded(file, maxBytes) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return {ok: false, status: 'missing'};
    return {ok: false, status: 'read_error', detail: String(error?.code || error?.message || 'read error')};
  }
  if (!stat.isFile()) return {ok: false, status: 'not_file'};
  if (stat.size > maxBytes) return {ok: false, status: 'too_large', size: stat.size, maxBytes};
  try {
    const raw = await fs.readFile(file, 'utf8');
    return {
      ok: true,
      value: JSON.parse(raw.replace(/^\uFEFF/, '')),
      size: stat.size,
    };
  } catch (error) {
    return {ok: false, status: error instanceof SyntaxError ? 'invalid_json' : 'read_error', detail: String(error?.message || error).slice(0, 240)};
  }
}

function sectionSourceFreshness(payload, coreGeneratedAt) {
  const candidates = [
    payload,
    payload?.homeProfitSummary,
  ].filter(isPlainObject);
  for (const candidate of candidates) {
    if (candidate.staleSource === true) return {ok: false, status: 'stale_source'};
    const sourceGeneratedAt = String(candidate.sourceGeneratedAt || '');
    if (coreGeneratedAt && sourceGeneratedAt && sourceGeneratedAt !== coreGeneratedAt) {
      return {ok: false, status: 'stale_source', sourceGeneratedAt};
    }
  }
  return {ok: true};
}

function validateSectionPayload(raw, section, coreMeta, options = {}) {
  if (!isPlainObject(raw)) return {ok: false, status: 'invalid_envelope'};
  const envelope = Object.hasOwn(raw, 'data') && (
    Object.hasOwn(raw, 'section') ||
    Object.hasOwn(raw, 'generatedAt') ||
    Object.hasOwn(raw, 'cachedAt') ||
    Object.hasOwn(raw, 'ok')
  );
  if (raw.ok === false || raw.staleSection === true || raw.cacheStale === true) {
    return {ok: false, status: raw.staleSection === true || raw.cacheStale === true ? 'stale_section' : 'invalid_envelope'};
  }
  if (envelope && String(raw.section || '') !== section) return {ok: false, status: 'section_mismatch'};

  const payload = envelope ? raw.data : raw;
  if (!isPlainObject(payload)) return {ok: false, status: 'invalid_payload'};
  const requiredKeys = SECTION_PAYLOAD_KEYS[section] || [];
  if (requiredKeys.length && !requiredKeys.some(key => Object.hasOwn(payload, key))) {
    return {ok: false, status: 'invalid_payload'};
  }
  const sectionGeneratedAt = String(raw.generatedAt || payload.generatedAt || '');
  const coreGeneratedAt = String(coreMeta.generatedAt || '');
  if (coreGeneratedAt && sectionGeneratedAt && sectionGeneratedAt !== coreGeneratedAt) {
    return {ok: false, status: 'stale_generation', generatedAt: sectionGeneratedAt, expectedGeneratedAt: coreGeneratedAt};
  }
  if (coreMeta.mode === 'api' && !sectionGeneratedAt && options.allowUnversionedSections !== true) {
    return {ok: false, status: 'missing_generated_at', expectedGeneratedAt: coreGeneratedAt};
  }
  const sourceFreshness = sectionSourceFreshness(payload, coreGeneratedAt);
  if (!sourceFreshness.ok) return sourceFreshness;
  return {
    ok: true,
    data: payload,
    generatedAt: sectionGeneratedAt,
    envelope,
  };
}

export function classifyBiOpsQuery(question) {
  const text = normalizeQuestion(question);
  const lower = text.toLowerCase();
  const domains = [];
  const add = (name, pattern) => {
    if (pattern.test(lower)) domains.push(name);
  };
  add('links', /链接|\bskc\b|曝光|访客|点击|转化|流量|上架|下架|补链|覆盖|link|traffic|visitor|impression|conversion/iu);
  add('profit', /利润|毛利|净利|成本|仓储费|profit|margin|cost/iu);
  add('comments', /评论|评价|星级|差评|低星|review|comment|rating/iu);
  add('afterSales', /售后|退货|退款|取消|拒收|after.?sales|refund|return/iu);
  add('inventory', /库存|现货|在途|去化|补货|周转|可卖|断货|缺货|仓库|inventory|stock|incoming/iu);
  add('orders', /订单明细|订单列表|成交价|客单价|单价|散点|order detail|unit price|price scatter/iu);
  add('actions', /动作池|待办|优先级|运营动作|action|todo/iu);
  add('waybills', /运单|履约|物流|货代|waybill|fulfillment|logistics/iu);
  add('rtvData', /\brtv\b|退仓|退件轨迹|return to vendor/iu);
  add('sales', /销售|销量|销售额|营收|成交|订单|出单|店铺|货号|商品|产品|排行|排名|\bgmv\b|\bsar\b|sales|revenue|quantity/iu);

  const uniqueDomains = uniq(domains);
  if (!uniqueDomains.length) uniqueDomains.push('sales');
  const fullRankings = /本周|上周|本月|上月|今年|去年|周度|月度|年度|累计|趋势|环比|同比|期间|日期范围|近\s*\d+\s*(?:天|日|周|月)|week|month|year|trend|period|summary/iu.test(lower);
  return {
    domains: uniqueDomains,
    rankingsCandidates: fullRankings ? ['rankings', 'homeRankings'] : ['homeRankings', 'rankings'],
    fullRankings,
  };
}

export function planBiOpsQuerySections(question, options = {}) {
  const intent = classifyBiOpsQuery(question);
  const domains = new Set(intent.domains);
  const groups = [];
  const sections = [];

  if (domains.has('sales') || domains.has('links') || domains.has('profit') || domains.has('afterSales') || domains.has('comments')) {
    groups.push({name: 'rankings', candidates: intent.rankingsCandidates});
  }
  if (domains.has('links')) {
    sections.push('linksData');
    if (/每日|逐日|趋势|按天|daily|trend/iu.test(normalizeQuestion(question))) sections.push('productTrafficDaily');
  }
  if (domains.has('profit')) {
    const detailed = /货号|商品|产品|店铺|明细|成本|仓储|margin|detail|product|store/iu.test(normalizeQuestion(question));
    groups.push({name: 'profit', candidates: detailed ? ['profit', 'homeProfit'] : ['homeProfit', 'profit']});
  }
  if (domains.has('comments')) sections.push('comments');
  if (domains.has('afterSales')) sections.push('afterSales');
  if (domains.has('inventory')) sections.push('inventoryTrend');
  if (domains.has('orders')) sections.push('orders', 'priceScatter');
  if (domains.has('actions')) sections.push('actions');
  if (domains.has('waybills')) sections.push('waybills');
  if (domains.has('rtvData')) sections.push('rtvData');

  const maxAutoSections = finitePositive(options.maxAutoSections, 5);
  return {
    intent,
    groups,
    sections: uniq(sections).slice(0, maxAutoSections),
  };
}

function mergeSectionData(target, source, section, sourceByPath) {
  for (const [key, value] of Object.entries(source || {})) {
    if (RESERVED_SECTION_DATA_KEYS.has(key) || DANGEROUS_OBJECT_KEYS.has(key)) continue;
    if (key === 'rankings' && isPlainObject(value)) {
      const previous = isPlainObject(target.rankings) ? target.rankings : {};
      const safeRankings = Object.fromEntries(Object.entries(value).filter(([child]) => !DANGEROUS_OBJECT_KEYS.has(child)));
      target.rankings = {...previous, ...safeRankings};
      sourceByPath.rankings = section;
      for (const child of Object.keys(safeRankings)) sourceByPath[`rankings.${child}`] = section;
      continue;
    }
    if ((key === 'dates' || key === 'productDisplayNames' || key === 'productAliasSearch') && isPlainObject(value)) {
      const safeValue = Object.fromEntries(Object.entries(value).filter(([child]) => !DANGEROUS_OBJECT_KEYS.has(child)));
      target[key] = {...(isPlainObject(target[key]) ? target[key] : {}), ...safeValue};
    } else {
      target[key] = value;
    }
    sourceByPath[key] = section;
  }
}

function initializeSourceMap(core) {
  const result = {};
  for (const key of Object.keys(core || {})) result[key] = 'core';
  for (const key of Object.keys(core?.rankings || {})) result[`rankings.${key}`] = 'core';
  return result;
}

function synthesizeDailySalesSummary(data, sourceByPath) {
  const rankings = isPlainObject(data.rankings) ? data.rankings : null;
  const rows = Array.isArray(rankings?.dailyStores) ? rankings.dailyStores : [];
  if (!rows.length) return;
  const existing = Array.isArray(rankings.salesSummary) ? rankings.salesSummary : [];
  const existingDates = new Set(existing.filter(row => String(row?.period_key || '') === 'day').map(row => String(row?.end_date || row?.date || '').slice(0, 10)).filter(Boolean));
  const byDate = new Map();
  for (const row of rows) {
    const date = String(row?.date || '').slice(0, 10);
    if (!date || existingDates.has(date)) continue;
    if (!byDate.has(date)) byDate.set(date, {sales_sar: 0, gross_sales_sar: 0, orders: 0, gross_orders: 0, quantity: 0, gross_quantity: 0});
    const total = byDate.get(date);
    total.sales_sar += safeNumber(row.sales_sar);
    total.gross_sales_sar += safeNumber(row.gross_sales_sar ?? row.sales_sar);
    total.orders += safeNumber(row.orders);
    total.gross_orders += safeNumber(row.gross_orders ?? row.orders);
    total.quantity += safeNumber(row.quantity);
    total.gross_quantity += safeNumber(row.gross_quantity ?? row.quantity);
  }
  if (!byDate.size) return;
  const derived = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, total]) => ({
    period_key: 'day',
    period_label: '日',
    period_id: date,
    start_date: date,
    end_date: date,
    sales_sar: rounded(total.sales_sar),
    gross_sales_sar: rounded(total.gross_sales_sar),
    orders: Math.round(total.orders),
    gross_orders: Math.round(total.gross_orders),
    quantity: Math.round(total.quantity),
    gross_quantity: Math.round(total.gross_quantity),
    days: 1,
    derived_from: 'rankings.dailyStores',
  }));
  data.rankings = {...rankings, salesSummary: [...existing, ...derived]};
  const source = sourceByPath['rankings.dailyStores'] || sourceByPath.rankings || 'core';
  sourceByPath['rankings.salesSummary'] = `derived:${source}`;
}

async function loadOneSection({sectionsDir, section, coreMeta, maxSectionBytes, allowUnversionedSections}) {
  const file = sectionFile(sectionsDir, section);
  const read = await readJsonBounded(file, maxSectionBytes);
  if (!read.ok) return {section, status: read.status, size: read.size || 0};
  const validated = validateSectionPayload(read.value, section, coreMeta, {allowUnversionedSections});
  if (!validated.ok) {
    return {
      section,
      status: validated.status,
      generatedAt: validated.generatedAt || '',
      expectedGeneratedAt: validated.expectedGeneratedAt || '',
      size: read.size || 0,
    };
  }
  return {
    section,
    status: 'loaded',
    generatedAt: validated.generatedAt || '',
    size: read.size || 0,
    data: validated.data,
  };
}

/**
 * Load the BI core plus only the section shards relevant to one question.
 * Missing, malformed, oversized, or stale sections are reported and skipped;
 * the required core file remains a hard failure.
 */
export async function loadBiOpsQueryData(questionOrOptions, maybeOptions = {}) {
  const options = isPlainObject(questionOrOptions)
    ? questionOrOptions
    : {...maybeOptions, question: questionOrOptions};
  const question = normalizeQuestion(options.question || '');
  const dataPath = path.resolve(options.dataPath || path.join(process.cwd(), 'outputs', 'bi-portal', 'data.json'));
  const sectionsDir = path.resolve(options.sectionsDir || path.join(path.dirname(dataPath), 'sections'));
  const maxCoreBytes = finitePositive(options.maxCoreBytes, DEFAULT_BI_OPS_CORE_MAX_BYTES);
  const maxSectionBytes = finitePositive(options.maxSectionBytes, DEFAULT_BI_OPS_SECTION_MAX_BYTES);

  let core;
  let coreBytes = 0;
  if (isPlainObject(options.coreData)) {
    core = cloneJson(options.coreData);
    coreBytes = jsonBytes(core);
    if (coreBytes > maxCoreBytes) throw new Error(`BI core data exceeds max bytes: ${coreBytes} > ${maxCoreBytes}`);
  } else {
    const read = await readJsonBounded(dataPath, maxCoreBytes);
    if (!read.ok) throw new Error(`Cannot load BI core data (${read.status}): ${dataPath}`);
    if (!isPlainObject(read.value)) throw new Error(`BI core data must be a JSON object: ${dataPath}`);
    core = read.value;
    coreBytes = read.size || 0;
  }

  const coreGeneratedAt = String(core.generatedAt || core.__sections?.generatedAt || '');
  const coreMode = String(core.__sections?.mode || 'legacy').toLowerCase();
  const coreMeta = {generatedAt: coreGeneratedAt, mode: coreMode};
  const declaredSections = Array.isArray(core.__sections?.keys)
    ? core.__sections.keys.filter(section => SECTION_KEY_SET.has(section))
    : [];
  const exactSections = Array.isArray(options.sections)
    ? uniq(options.sections.map(section => String(section || '').trim()).filter(section => SECTION_KEY_SET.has(section)))
    : null;
  const plan = exactSections
    ? {intent: classifyBiOpsQuery(question), groups: [], sections: exactSections}
    : planBiOpsQuerySections(question, options);
  const attempts = [];
  const loaded = [];
  const attempted = new Set();

  const attempt = async section => {
    if (attempted.has(section)) return null;
    attempted.add(section);
    const result = await loadOneSection({
      sectionsDir,
      section,
      coreMeta,
      maxSectionBytes,
      allowUnversionedSections: options.allowUnversionedSections === true,
    });
    attempts.push({
      section: result.section,
      status: result.status,
      generatedAt: result.generatedAt || '',
      expectedGeneratedAt: result.expectedGeneratedAt || '',
      size: result.size || 0,
    });
    if (result.status === 'loaded') loaded.push(result);
    return result;
  };

  for (const group of plan.groups || []) {
    for (const section of group.candidates || []) {
      const result = await attempt(section);
      if (result?.status === 'loaded') break;
    }
  }
  for (const section of plan.sections || []) await attempt(section);

  const sourceByPath = initializeSourceMap(core);
  const data = core;
  const orderedLoaded = [...loaded].sort((a, b) =>
    safeNumber(SECTION_PRIORITY[a.section] || 20) - safeNumber(SECTION_PRIORITY[b.section] || 20)
      || a.section.localeCompare(b.section));
  for (const result of orderedLoaded) mergeSectionData(data, result.data, result.section, sourceByPath);
  synthesizeDailySalesSummary(data, sourceByPath);

  return {
    data,
    meta: {
      version: BI_OPS_QUERY_CONTEXT_VERSION,
      questionIntent: plan.intent,
      coreGeneratedAt,
      coreMode,
      coreBytes,
      declaredSections,
      attemptedSections: attempts,
      loadedSections: orderedLoaded.map(result => result.section),
      sourceByPath,
    },
  };
}

function queryHints(question, data) {
  const text = normalizeQuestion(question);
  const upper = text.toUpperCase();
  const stores = [...STORE_KEYS].filter(store => new RegExp(`(^|[^A-Z0-9])${store}([^A-Z0-9]|$)`).test(upper));
  const products = uniq([...upper.matchAll(/[A-Z]{1,8}(?:[-_ ]?[A-Z0-9]{1,8})*[-_ ]?\d{2,8}[A-Z0-9-]*/g)].map(match => match[0].replace(/\s+/g, '-'))).slice(0, 8);
  const explicitDates = [...text.matchAll(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/g)].map(match => {
    const parts = match[0].match(/\d+/g) || [];
    return parts.length >= 3 ? `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}` : '';
  }).filter(Boolean);
  const latestDate = String(data?.dates?.salesDate || data?.dates?.businessDate || data?.dates?.linkDate || '').slice(0, 10);
  return {text, upper, stores, products, dates: uniq([...explicitDates, latestDate]).filter(Boolean)};
}

function rowSearchText(row) {
  if (!isPlainObject(row)) return String(row || '').toUpperCase();
  return Object.entries(row).slice(0, 80).map(([key, value]) => {
    if (value === null || value === undefined || typeof value === 'object') return key;
    return `${key}:${String(value).slice(0, 240)}`;
  }).join('|').toUpperCase();
}

function relevantArraySample(rows, hints, limit = 24) {
  return rows.map((row, index) => {
    const search = rowSearchText(row);
    let score = 0;
    if (hints.stores.some(store => new RegExp(`(^|[^A-Z0-9])${store}([^A-Z0-9]|$)`).test(search))) score += 10_000;
    if (hints.products.some(product => search.includes(product))) score += 20_000;
    for (let dateIndex = 0; dateIndex < hints.dates.length; dateIndex++) {
      if (!search.includes(hints.dates[dateIndex])) continue;
      score += dateIndex === 0 ? 4_000 : 2_000;
      break;
    }
    return {row, index, score};
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(item => item.row);
}

function sampleSectionValue(value, hints, depth = 0) {
  if (depth >= 4) return null;
  if (Array.isArray(value)) return relevantArraySample(value, hints, depth === 0 ? 24 : 16).map(item => sampleSectionValue(item, hints, depth + 1));
  if (!isPlainObject(value)) {
    if (typeof value === 'string') return value.slice(0, 1200);
    return value;
  }
  const entries = Object.entries(value)
    .filter(([key]) => !['run', 'stderrTail'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 40);
  return Object.fromEntries(entries.map(([key, child]) => [key, sampleSectionValue(child, hints, depth + 1)]));
}

/** Build bounded facts from non-ranking shards that the legacy sales compactor does not know about. */
export function buildBiOpsSectionFacts(question, data, loadMeta) {
  if (!isPlainObject(data) || !isPlainObject(loadMeta)) return {};
  const hints = queryHints(question, data);
  const facts = {};
  for (const section of loadMeta.loadedSections || []) {
    const keys = SECTION_FACT_KEYS[section] || [];
    if (!keys.length) continue;
    const values = {};
    for (const key of keys) {
      if (data[key] === undefined) continue;
      values[key] = sampleSectionValue(data[key], hints);
    }
    if (Object.keys(values).length) facts[section] = values;
  }
  return facts;
}

function availabilityFromMeta(meta) {
  if (!isPlainObject(meta)) return null;
  const issues = (meta.attemptedSections || [])
    .filter(item => item.status !== 'loaded')
    .map(item => ({section: item.section, status: item.status}));
  const sourceKeys = [
    'rankings.salesSummary',
    'rankings.dailyStores',
    'rankings.dailyProducts',
    'rankings.dailyStoreProducts',
    'links',
    'storeLinks',
    'matrix',
    'profit',
    'homeProfitSummary',
    'comments',
    'afterSales',
    'orders',
  ];
  const sources = Object.fromEntries(sourceKeys.filter(key => meta.sourceByPath?.[key]).map(key => [key, meta.sourceByPath[key]]));
  return {
    coreGeneratedAt: meta.coreGeneratedAt || '',
    coreMode: meta.coreMode || '',
    loadedSections: [...(meta.loadedSections || [])],
    sectionIssues: issues,
    sources,
    priorityRule: 'matching-generation section > core; rankings > homeRankings',
  };
}

function canonicalize(value, options, stats, pathParts = []) {
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length <= options.stringLimit) return value;
    stats.truncatedStrings += 1;
    return `${value.slice(0, Math.max(0, options.stringLimit - 1))}…`;
  }
  if (Array.isArray(value)) {
    const pathKey = pathParts.join('.');
    const configured = options.pathArrayLimits[pathKey];
    const limit = Math.max(0, Math.min(options.arrayLimit, Number.isFinite(configured) ? configured : options.arrayLimit));
    if (value.length > limit) stats.omittedArrayItems += value.length - limit;
    return value.slice(0, limit).map((item, index) => canonicalize(item, options, stats, [...pathParts, String(index)]));
  }
  if (!isPlainObject(value)) return String(value);
  const result = {};
  for (const key of Object.keys(value).filter(key => !DANGEROUS_OBJECT_KEYS.has(key)).sort()) {
    result[key] = canonicalize(value[key], options, stats, [...pathParts, key]);
  }
  return result;
}

const CONTEXT_ARRAY_LIMITS = Object.freeze({
  salesSummary: 16,
  storeTop: 16,
  productTop: 16,
  storeProductTop: 24,
  links: 30,
  coverage: 24,
  'inventory.products': 18,
  'inventory.batches': 12,
  'inventory.platformStockAlerts': 12,
  'conversation.turns': 12,
  'dataAvailability.loadedSections': 12,
  'dataAvailability.sectionIssues': 12,
});

function canonicalCandidate(base, maxBytes, originalBytes, arrayLimit, stringLimit) {
  const stats = {omittedArrayItems: 0, truncatedStrings: 0};
  const candidate = canonicalize(base, {arrayLimit, stringLimit, pathArrayLimits: CONTEXT_ARRAY_LIMITS}, stats);
  candidate.contextPolicy = {
    version: BI_OPS_QUERY_CONTEXT_VERSION,
    deterministic: true,
    maxBytes,
    originalBytes,
    truncated: originalBytes > maxBytes || stats.omittedArrayItems > 0 || stats.truncatedStrings > 0,
    omittedArrayItems: stats.omittedArrayItems,
    truncatedStrings: stats.truncatedStrings,
  };
  const stable = canonicalize(candidate, {arrayLimit: Number.MAX_SAFE_INTEGER, stringLimit: Number.MAX_SAFE_INTEGER, pathArrayLimits: {}}, {omittedArrayItems: 0, truncatedStrings: 0});
  return {context: stable, bytes: jsonBytes(stable)};
}

/**
 * Canonicalize and size-bound the final model context. Array order is retained,
 * object keys are sorted, and the same input always yields byte-identical JSON.
 */
export function buildBiOpsQueryContext(baseContext, options = {}) {
  const maxBytes = finitePositive(options.maxBytes, DEFAULT_BI_OPS_CONTEXT_MAX_BYTES);
  const base = isPlainObject(baseContext) ? cloneJson(baseContext) : {};
  const availability = availabilityFromMeta(options.loadMeta);
  if (availability) base.dataAvailability = availability;
  const sectionFacts = isPlainObject(options.sectionFacts) ? options.sectionFacts : {};
  if (Object.keys(sectionFacts).length) base.sectionFacts = cloneJson(sectionFacts);
  delete base.contextPolicy;

  let originalBytes;
  try {
    originalBytes = jsonBytes(base);
  } catch {
    originalBytes = maxBytes + 1;
  }

  for (const stringLimit of [2000, 1200, 800, 480, 240, 120]) {
    for (const arrayLimit of [40, 32, 24, 16, 12, 8, 4, 2, 1, 0]) {
      const candidate = canonicalCandidate(base, maxBytes, originalBytes, arrayLimit, stringLimit);
      if (candidate.bytes <= maxBytes) return candidate.context;
    }
  }

  const minimalKeys = ['dataFreshness', 'detected', 'dataAvailability', 'securityPolicy'];
  const minimal = Object.fromEntries(minimalKeys.filter(key => base[key] !== undefined).map(key => [key, base[key]]));
  for (const key of [...minimalKeys].reverse()) {
    const candidate = canonicalCandidate(minimal, maxBytes, originalBytes, 0, 80);
    if (candidate.bytes <= maxBytes) return candidate.context;
    delete minimal[key];
  }
  const policyOnly = canonicalCandidate({}, maxBytes, originalBytes, 0, 40);
  return policyOnly.bytes <= maxBytes ? policyOnly.context : {};
}

export const finalizeBiOpsQueryContext = buildBiOpsQueryContext;

export function serializeBiOpsQueryContext(context) {
  return JSON.stringify(canonicalize(context, {
    arrayLimit: Number.MAX_SAFE_INTEGER,
    stringLimit: Number.MAX_SAFE_INTEGER,
    pathArrayLimits: {},
  }, {omittedArrayItems: 0, truncatedStrings: 0}));
}
