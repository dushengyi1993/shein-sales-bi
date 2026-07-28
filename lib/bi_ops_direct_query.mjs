import {
  BI_OPS_SECTION_KEYS,
  classifyBiOpsQuery,
} from './bi_ops_query_context.mjs';

export const BI_OPS_DIRECT_QUERY_VERSION = 'bi-ops-direct-query-v1';

const SECTION_SET = new Set(BI_OPS_SECTION_KEYS);
const STORE_KEYS = new Set([
  'DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ',
  'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ', 'JSH', 'TZZ', 'XC', 'DSY', 'LGM',
]);
const STORE_FIELDS = Object.freeze([
  'store_key',
  'storeKey',
  'store_code',
  'storeCode',
  'shop_code',
  'shopCode',
  'source_store_key',
  'sourceStoreKey',
  'target_store_key',
  'targetStoreKey',
]);
const SAFE_CORE_KEYS = Object.freeze([
  'generatedAt',
  'dates',
  'stores',
  'productDisplayNames',
  'productAliasSearch',
  'ownerGroups',
]);
const SECTION_DATA_KEYS = Object.freeze({
  homeProfit: ['homeProfitSummary'],
  homeRankings: ['rankings'],
  rankings: ['rankings'],
  profit: ['profit'],
  actions: ['actions', 'actionDomain'],
  linksData: [
    'links',
    'duplicateLinks',
    'storeLinks',
    'matrix',
    'productStateOverlay',
    'marketingPriceLeads',
  ],
  productState: ['productStateOverlay'],
  productSalesDaily: ['productSalesDaily'],
  homeTrafficDaily: ['homeTrafficDaily'],
  productTrafficDaily: ['productTrafficDaily'],
  inventoryTrend: ['inventoryDepletion'],
  comments: ['comments', 'commentSummary'],
  orders: ['orders'],
  liveSalesToday: ['liveSalesToday'],
  priceScatter: ['priceScatter'],
  afterSales: ['afterSales'],
  rtvData: ['rtvReview', 'rtvTrace'],
  waybills: ['waybills'],
});
const BUSINESS_DATA_ROOTS = new Set([
  'homeProfitSummary',
  'rankings',
  'profit',
  'actions',
  'actionDomain',
  'links',
  'duplicateLinks',
  'storeLinks',
  'matrix',
  'productStateOverlay',
  'productSalesDaily',
  'homeTrafficDaily',
  'productTrafficDaily',
  'comments',
  'commentSummary',
  'orders',
  'liveSalesToday',
  'priceScatter',
  'afterSales',
  'rtvReview',
  'rtvTrace',
  'waybills',
  'marketingPriceLeads',
]);
const GLOBAL_SHARED_ROOTS = new Set([
  'generatedAt',
  'dates',
  'productDisplayNames',
  'productAliasSearch',
  'ownerGroups',
  'inventoryDepletion',
]);
const DROP = Symbol('drop-bi-query-value');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeStore(value) {
  const store = String(value || '').normalize('NFKC').trim().toUpperCase();
  return STORE_KEYS.has(store) ? store : '';
}

function normalizeStoreList(values) {
  const input = Array.isArray(values)
    ? values
    : String(values || '').split(/[,\s，、/]+/);
  if (input.some(value => String(value || '').trim() === '*')) return ['*'];
  return uniq(input.map(normalizeStore).filter(Boolean));
}

function normalizeSectionList(values) {
  const input = Array.isArray(values)
    ? values
    : String(values || '').split(/[,\s，、/]+/);
  const requested = uniq(input.map(value => String(value || '').trim()).filter(Boolean));
  const unsupported = requested.filter(section => !SECTION_SET.has(section));
  if (unsupported.length) {
    const error = new Error(`Unsupported BI query sections: ${unsupported.join(', ')}`);
    error.code = 'BI_QUERY_SECTION_UNSUPPORTED';
    error.sections = unsupported;
    throw error;
  }
  return requested;
}

function addSection(target, section) {
  if (SECTION_SET.has(section) && !target.includes(section)) target.push(section);
}

/**
 * Natural language is used only to select deterministic BI data shards. No
 * model, agent, or answer bot is involved; the calling Codex analyzes the
 * returned rows itself.
 */
export function planBiOpsDirectQuerySections(question, options = {}) {
  const explicit = normalizeSectionList(options.sections || []);
  const text = normalizeText(question);
  const intent = classifyBiOpsQuery(text);
  if (explicit.length) {
    if (explicit.length > 8) {
      const error = new Error('A direct BI query can load at most 8 sections');
      error.code = 'BI_QUERY_TOO_MANY_SECTIONS';
      error.sections = explicit;
      throw error;
    }
    return {
      version: BI_OPS_DIRECT_QUERY_VERSION,
      mode: 'explicit',
      intent,
      sections: explicit,
    };
  }

  const domains = new Set(intent.domains || []);
  if (/价格|售价|原价|折后价|活动价|促销价|供货价|链接|\bskc\b|上架|下架|待上架|回收站|审核|商品状态|price|link|shelf|audit/iu.test(text)) {
    domains.add('links');
  }
  if (/订单(?:明细|列表|状态|取消|待揽收|待发货)|\bGS[HO][A-Z0-9-]{6,}\b|order detail|order status/iu.test(text)) {
    domains.add('orders');
  }
  const sections = [];
  const realtime = /实时|刚刚|当前|现在|今天|今日|本日|截至现在|live|real.?time|today/iu.test(text);
  const dailyTrend = /每日|逐日|按天|趋势|近\s*\d+\s*(?:天|日)|daily|trend/iu.test(text);
  const specialized = [...domains].some(domain => domain !== 'sales');
  const needsRankings = domains.has('sales') && (
    !specialized
    || /销售额|营收|成交额|总销量|净销量|订单数|排行|排名|哪个店|哪个品|卖了多少|gmv|revenue|ranking/iu.test(text)
  );

  if (needsRankings) addSection(sections, 'rankings');
  if (domains.has('links')) {
    addSection(sections, 'linksData');
    addSection(sections, 'productState');
    if (dailyTrend && /曝光|访客|点击|转化|流量|traffic|visitor|impression|conversion/iu.test(text)) {
      addSection(sections, 'productTrafficDaily');
    }
  }
  if (domains.has('profit')) addSection(sections, 'profit');
  if (domains.has('comments')) addSection(sections, 'comments');
  if (domains.has('afterSales')) addSection(sections, 'afterSales');
  if (domains.has('inventory')) addSection(sections, 'inventoryTrend');
  if (domains.has('orders')) {
    addSection(sections, 'orders');
    addSection(sections, 'priceScatter');
  }
  if (domains.has('actions')) addSection(sections, 'actions');
  if (domains.has('waybills')) addSection(sections, 'waybills');
  if (domains.has('rtvData')) addSection(sections, 'rtvData');
  if (dailyTrend && domains.has('sales') && /货号|商品|产品|sku|product/iu.test(text)) {
    addSection(sections, 'productSalesDaily');
  }
  if (realtime && [...domains].some(domain => ['sales', 'profit', 'orders', 'afterSales'].includes(domain))) {
    addSection(sections, 'liveSalesToday');
  }
  if (!sections.length) addSection(sections, 'rankings');

  return {
    version: BI_OPS_DIRECT_QUERY_VERSION,
    mode: 'automatic',
    intent: {...intent, domains: [...domains]},
    sections: sections.slice(0, 8),
  };
}

export function selectBiOpsDirectQueryData(data, sections) {
  const source = isPlainObject(data) ? data : {};
  const selectedSections = normalizeSectionList(sections || []);
  const selected = {};
  for (const key of SAFE_CORE_KEYS) {
    if (source[key] !== undefined) selected[key] = source[key];
  }
  for (const section of selectedSections) {
    for (const key of SECTION_DATA_KEYS[section] || []) {
      if (source[key] !== undefined) selected[key] = source[key];
    }
  }
  return selected;
}

function rowStores(row) {
  if (!isPlainObject(row)) return [];
  const stores = [];
  for (const field of STORE_FIELDS) {
    const value = row[field];
    if (Array.isArray(value)) {
      stores.push(...value.map(normalizeStore).filter(Boolean));
      continue;
    }
    const normalized = normalizeStore(value);
    if (normalized) stores.push(normalized);
  }
  return uniq(stores);
}

function effectiveQueryStores(readStores, requestedStores) {
  const allowed = normalizeStoreList(readStores);
  const requested = normalizeStoreList(requestedStores);
  const global = allowed.includes('*');
  if (requested.includes('*')) {
    if (!global) {
      const error = new Error('Current BI account cannot query all stores');
      error.code = 'BI_QUERY_STORE_FORBIDDEN';
      error.allowedStores = allowed;
      throw error;
    }
    return {stores: ['*'], global: true, explicitlyScoped: false};
  }
  if (requested.length) {
    const denied = global ? [] : requested.filter(store => !allowed.includes(store));
    if (denied.length) {
      const error = new Error(`Current BI account cannot read stores: ${denied.join(', ')}`);
      error.code = 'BI_QUERY_STORE_FORBIDDEN';
      error.deniedStores = denied;
      error.allowedStores = allowed;
      throw error;
    }
    return {stores: requested, global: false, explicitlyScoped: true};
  }
  if (global) return {stores: ['*'], global: true, explicitlyScoped: false};
  return {stores: allowed, global: false, explicitlyScoped: false};
}

function projectScopedValue(value, context) {
  if (Array.isArray(value)) {
    if (
      !context.inheritedStoreScope
      && BUSINESS_DATA_ROOTS.has(context.root)
      && value.length
      && value.every(item => !isPlainObject(item))
    ) {
      context.stats.omittedUnscopedAggregateFields += 1;
      return [];
    }
    const output = [];
    for (const item of value) {
      if (isPlainObject(item)) {
        const stores = rowStores(item);
        if (stores.length && !stores.some(store => context.allowed.has(store))) {
          context.stats.omittedUnauthorizedRows += 1;
          continue;
        }
        if (
          !stores.length
          && !context.inheritedStoreScope
          && BUSINESS_DATA_ROOTS.has(context.root)
        ) {
          context.stats.omittedUnscopedAggregateRows += 1;
          continue;
        }
        const projected = projectScopedValue(item, {
          ...context,
          inheritedStoreScope: context.inheritedStoreScope || stores.length > 0,
        });
        if (projected !== DROP) output.push(projected);
        continue;
      }
      const projected = projectScopedValue(item, context);
      if (projected !== DROP) output.push(projected);
    }
    return output;
  }
  if (!isPlainObject(value)) return value;

  const stores = rowStores(value);
  if (stores.length && !stores.some(store => context.allowed.has(store))) {
    context.stats.omittedUnauthorizedRows += 1;
    return DROP;
  }
  const inheritedStoreScope = context.inheritedStoreScope || stores.length > 0;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const storeKey = normalizeStore(key);
    if (storeKey && !context.allowed.has(storeKey)) {
      context.stats.omittedStoreKeys += 1;
      continue;
    }
    if (
      !inheritedStoreScope
      && BUSINESS_DATA_ROOTS.has(context.root)
      && (child === null || typeof child !== 'object')
    ) {
      context.stats.omittedUnscopedAggregateFields += 1;
      continue;
    }
    const projected = projectScopedValue(child, {
      ...context,
      inheritedStoreScope,
      path: [...context.path, key],
    });
    if (projected !== DROP) output[key] = projected;
  }
  return output;
}

export function scopeBiOpsDirectQueryData(data, options = {}) {
  const scope = effectiveQueryStores(options.readStores || [], options.requestedStores || []);
  const stats = {
    omittedUnauthorizedRows: 0,
    omittedUnscopedAggregateRows: 0,
    omittedUnscopedAggregateFields: 0,
    omittedStoreKeys: 0,
  };
  if (scope.global) {
    return {
      data,
      scope: {
        mode: 'all_stores',
        stores: ['*'],
        explicitlyScoped: false,
        ...stats,
      },
    };
  }

  const allowed = new Set(scope.stores);
  const projected = {};
  for (const [key, value] of Object.entries(isPlainObject(data) ? data : {})) {
    const result = GLOBAL_SHARED_ROOTS.has(key)
      ? value
      : projectScopedValue(value, {
          allowed,
          root: key,
          path: [key],
          inheritedStoreScope: false,
          stats,
        });
    if (result !== DROP) projected[key] = result;
  }
  return {
    data: projected,
    scope: {
      mode: 'selected_stores',
      stores: scope.stores,
      explicitlyScoped: scope.explicitlyScoped,
      ...stats,
    },
  };
}

function collectArrayCounts(value, path = [], output = {}, budget = {remaining: 160}) {
  if (budget.remaining <= 0) return output;
  if (Array.isArray(value)) {
    const key = path.join('.');
    if (key) {
      output[key] = value.length;
      budget.remaining -= 1;
    }
    for (const item of value.slice(0, 4)) {
      if (isPlainObject(item)) collectArrayCounts(item, path, output, budget);
      if (budget.remaining <= 0) break;
    }
    return output;
  }
  if (!isPlainObject(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    collectArrayCounts(child, [...path, key], output, budget);
    if (budget.remaining <= 0) break;
  }
  return output;
}

export function buildBiOpsDirectQueryResponse(options = {}) {
  const question = normalizeText(options.question);
  const sections = normalizeSectionList(options.sections || []);
  const selected = selectBiOpsDirectQueryData(options.data, sections);
  const scoped = scopeBiOpsDirectQueryData(selected, {
    readStores: options.readStores || [],
    requestedStores: options.requestedStores || [],
  });
  const meta = isPlainObject(options.meta) ? options.meta : {};
  const attempted = Array.isArray(meta.attemptedSections) ? meta.attemptedSections : [];
  const issues = attempted
    .filter(item => item?.status !== 'loaded')
    .map(item => ({
      section: String(item?.section || ''),
      status: String(item?.status || ''),
      expectedGeneratedAt: String(item?.expectedGeneratedAt || ''),
      generatedAt: String(item?.generatedAt || ''),
    }));
  return {
    ok: issues.length === 0 && sections.every(section => (meta.loadedSections || []).includes(section)),
    version: BI_OPS_DIRECT_QUERY_VERSION,
    mode: 'direct-bi-data',
    readOnly: true,
    aiInvoked: false,
    question,
    generatedAt: String(scoped.data?.generatedAt || meta.coreGeneratedAt || ''),
    salesUpdatedAt: String(scoped.data?.dates?.salesUpdatedAt || ''),
    linkUpdatedAt: String(scoped.data?.dates?.linkUpdatedAt || ''),
    sections: {
      requested: sections,
      loaded: [...(meta.loadedSections || [])],
      issues,
      sourceByPath: isPlainObject(meta.sourceByPath) ? meta.sourceByPath : {},
    },
    scope: scoped.scope,
    rowCounts: collectArrayCounts(scoped.data),
    data: scoped.data,
  };
}
