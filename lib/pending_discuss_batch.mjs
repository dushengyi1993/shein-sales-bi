import crypto from 'node:crypto';
import {normalizeGoodsSnDetailed} from './product_sku_normalizer.mjs';

export const PENDING_DISCUSS_SCHEMA_VERSION = 'pending-discuss-batch/v1';
export const PENDING_DISCUSS_PREFLIGHT_SCHEMA_VERSION = 'pending-discuss-preflight/v1';
export const PENDING_DISCUSS_CONFIRM_TEXT = 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE';
export const PENDING_DISCUSS_SAFE_WRITE_OPERATION = 'process_pending_discuss';
export const PENDING_DISCUSS_QUERY_ENDPOINT = '/open-api/goods/discuss/query-discuss-list';
export const PENDING_DISCUSS_PROCESS_ENDPOINT = '/open-api/goods/discuss/process-discuss';

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('canonical JSON rejects invalid Date');
    return value.toISOString();
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON rejects ${typeof value}`);
  if (seen.has(value)) throw new TypeError('canonical JSON rejects circular values');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonicalize(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical JSON requires plain objects');
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key], seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export function businessDateShanghai(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new TypeError('invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function finiteNumber(value) {
  if (value === '' || value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function normalizeStoreKey(value) {
  return text(value).toUpperCase();
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function latestHistory(costPriceHistories) {
  const rows = Array.isArray(costPriceHistories) ? costPriceHistories : [];
  let latest = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const serialNumber = integer(row.serialNumber);
    const candidate = {
      serialNumber,
      costPrice: finiteNumber(row.costPrice),
      currency: text(row.currency),
      index,
    };
    if (!latest) latest = candidate;
    else if ((candidate.serialNumber ?? -1) > (latest.serialNumber ?? -1)) latest = candidate;
    else if ((candidate.serialNumber ?? -1) === (latest.serialNumber ?? -1) && candidate.index > latest.index) latest = candidate;
  }
  if (!latest) return null;
  return {serialNumber: latest.serialNumber, costPrice: latest.costPrice, currency: latest.currency};
}

function normalizeSkuCostPrice(row) {
  const latest = row?.latestHistory && typeof row.latestHistory === 'object'
    ? {
        serialNumber: integer(row.latestHistory.serialNumber),
        costPrice: finiteNumber(row.latestHistory.costPrice),
        currency: text(row.latestHistory.currency),
      }
    : latestHistory(row?.costPriceHistories);
  return {
    skuCode: text(row?.skuCode),
    suggestCostPrice: finiteNumber(row?.suggestCostPrice),
    suggestCostCurrency: text(row?.suggestCostCurrency),
    latestCostPrice: finiteNumber(row?.latestCostPrice),
    latestHistory: latest,
  };
}

export function extractDiscussPage(apiData) {
  const candidates = [
    apiData?.info,
    apiData?.data?.info,
    apiData?.data,
    apiData,
  ].filter(value => value && typeof value === 'object');
  for (const root of candidates) {
    const nested = root?.data && !Array.isArray(root.data) && typeof root.data === 'object' ? root.data : null;
    const rows = [root.data, root.records, root.list, nested?.records, nested?.list, nested?.data]
      .find(value => Array.isArray(value));
    if (!rows) continue;
    const totalValue = [root.count, root.total, root.totalCount, nested?.count, nested?.total, nested?.totalCount]
      .find(value => finiteNumber(value) !== null);
    return {rows, total: totalValue === undefined ? null : integer(totalValue)};
  }
  return {rows: [], total: null};
}

export function normalizePendingDiscussRow(storeKey, row) {
  const normalizedStoreKey = normalizeStoreKey(storeKey || row?.storeKey);
  const discussSn = text(row?.discussSn);
  if (!normalizedStoreKey) throw new Error('pending discuss row is missing storeKey');
  if (!discussSn) throw new Error(`${normalizedStoreKey} pending discuss row is missing discussSn`);
  const supplierCode = text(row?.supplierCode);
  const productTitle = text(row?.productTitle);
  const canonicalDetail = normalizeGoodsSnDetailed(supplierCode, {goodsTitle: productTitle});
  const canonicalGoodsSn = text(canonicalDetail?.canonical || supplierCode);
  const skuCostPrices = (Array.isArray(row?.skuCostPrices) ? row.skuCostPrices : [])
    .map(normalizeSkuCostPrice)
    .sort((left, right) => left.skuCode.localeCompare(right.skuCode) || stableStringify(left).localeCompare(stableStringify(right)));
  return {
    storeKey: normalizedStoreKey,
    discussSn,
    discussStatus: integer(row?.discussStatus),
    discussType: integer(row?.discussType),
    supplierCode,
    canonicalGoodsSn,
    skcName: text(row?.skcName),
    spuName: text(row?.spuName),
    productTitle,
    reason: text(row?.reason),
    appealReason: text(row?.appealReason),
    appealCount: integer(row?.appealCount),
    serialNumber: integer(row?.serialNumber),
    skuCostPrices,
  };
}

export function pendingDiscussKey(row) {
  return `${normalizeStoreKey(row?.storeKey)}::${text(row?.discussSn)}`;
}

function sanitizeStoreResult(result) {
  const storeKey = normalizeStoreKey(result?.storeKey);
  const rows = (Array.isArray(result?.rows) ? result.rows : [])
    .map(row => normalizePendingDiscussRow(storeKey, row))
    .sort((left, right) => pendingDiscussKey(left).localeCompare(pendingDiscussKey(right)));
  return {
    storeKey,
    ok: result?.ok === true,
    rows,
    rowCount: rows.length,
    pages: integer(result?.pages) ?? 0,
    attempts: integer(result?.attempts) ?? 0,
    identity: result?.identity?.ok === true
      ? {ok: true, match: result.identity.match === 'merchant_only' ? 'merchant_only' : 'full'}
      : result?.identity ? {ok: false} : null,
    error: result?.error ? redactError(result.error) : null,
  };
}

function summarizeCanonicalRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.canonicalGoodsSn || row.supplierCode || '(missing)';
    if (!groups.has(key)) groups.set(key, {canonicalGoodsSn: key, rowCount: 0, stores: new Set(), reasons: new Set(), appealCounts: new Set(), prices: new Map()});
    const group = groups.get(key);
    group.rowCount += 1;
    group.stores.add(row.storeKey);
    for (const reason of [row.appealReason, row.reason]) if (reason) group.reasons.add(reason);
    if (row.appealCount !== null) group.appealCounts.add(row.appealCount);
    for (const sku of row.skuCostPrices) {
      if (sku.suggestCostPrice === null) continue;
      const currency = sku.suggestCostCurrency || '';
      if (!group.prices.has(currency)) group.prices.set(currency, new Set());
      group.prices.get(currency).add(sku.suggestCostPrice);
    }
  }
  return [...groups.values()].map(group => ({
    canonicalGoodsSn: group.canonicalGoodsSn,
    rowCount: group.rowCount,
    stores: sortedUnique(group.stores),
    suggestedPrices: [...group.prices.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, prices]) => {
      const values = [...prices].sort((left, right) => left - right);
      return {currency, min: values[0], max: values.at(-1), values};
    }),
    reasons: sortedUnique(group.reasons),
    appealCounts: [...group.appealCounts].sort((left, right) => left - right),
  })).sort((left, right) => left.canonicalGoodsSn.localeCompare(right.canonicalGoodsSn));
}

export function buildScanDocument({businessDate, expectedStores, storeResults, generatedAt = new Date().toISOString()}) {
  const expected = sortedUnique((expectedStores || []).map(normalizeStoreKey).filter(Boolean));
  const results = (storeResults || []).map(sanitizeStoreResult).sort((left, right) => left.storeKey.localeCompare(right.storeKey));
  const resultKeys = results.map(result => result.storeKey);
  const duplicateStoreResults = resultKeys.filter((key, index) => resultKeys.indexOf(key) !== index);
  const expectedSet = new Set(expected);
  const resultMap = new Map(results.map(result => [result.storeKey, result]));
  const missingStores = expected.filter(storeKey => !resultMap.has(storeKey));
  const unexpectedStores = resultKeys.filter(storeKey => !expectedSet.has(storeKey));
  const succeededStores = expected.filter(storeKey => resultMap.get(storeKey)?.ok === true);
  const failedStores = expected.filter(storeKey => resultMap.has(storeKey) && resultMap.get(storeKey)?.ok !== true);
  const rows = results.filter(result => expectedSet.has(result.storeKey) && result.ok).flatMap(result => result.rows)
    .sort((left, right) => pendingDiscussKey(left).localeCompare(pendingDiscussKey(right)));
  const seen = new Set();
  const duplicateKeys = [];
  for (const row of rows) {
    const key = pendingDiscussKey(row);
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
  }
  const coverage = {
    expectedStores: expected,
    expectedCount: expected.length,
    succeededStores,
    succeededCount: succeededStores.length,
    failedStores,
    missingStores,
    unexpectedStores: sortedUnique(unexpectedStores),
  };
  const blockers = [];
  if (!expected.length) blockers.push({code: 'NO_EXPECTED_STORES', message: 'stores config has no enabled stores'});
  if (missingStores.length) blockers.push({code: 'STORE_COVERAGE_MISSING', message: `missing stores: ${missingStores.join(',')}`});
  if (failedStores.length) blockers.push({code: 'STORE_QUERY_FAILED', message: `failed stores: ${failedStores.join(',')}`});
  if (unexpectedStores.length) blockers.push({code: 'STORE_COVERAGE_UNEXPECTED', message: `unexpected stores: ${sortedUnique(unexpectedStores).join(',')}`});
  if (duplicateStoreResults.length) blockers.push({code: 'DUPLICATE_STORE_RESULT', message: `duplicate store results: ${sortedUnique(duplicateStoreResults).join(',')}`});
  if (duplicateKeys.length) blockers.push({code: 'DUPLICATE_DISCUSS_KEY', message: `duplicate keys: ${sortedUnique(duplicateKeys).join(',')}`});
  const binding = {
    schemaVersion: PENDING_DISCUSS_SCHEMA_VERSION,
    businessDate,
    generatedAt,
    coverage,
    stores: results,
    rows,
    duplicateKeys: sortedUnique(duplicateKeys),
  };
  return {
    ...binding,
    ok: blockers.length === 0,
    rowCount: rows.length,
    summary: summarizeCanonicalRows(rows),
    blockers,
    scanHash: sha256Json(binding),
  };
}

export function buildProcessPayload(action, discussSn) {
  const normalizedAction = text(action).toLowerCase();
  if (!['accept', 'reject'].includes(normalizedAction)) throw new Error(`unsupported pending discuss action: ${action}`);
  const normalizedDiscussSn = text(discussSn);
  if (!normalizedDiscussSn) throw new Error('discussSn is required');
  return {confirmInfos: [{discussAuditType: normalizedAction === 'accept' ? '1' : '2', discussSn: normalizedDiscussSn}]};
}

function normalizeSourceHashes(sourceHashes) {
  const output = {};
  for (const key of Object.keys(sourceHashes || {}).sort()) {
    const value = text(sourceHashes[key]);
    if (!value) throw new Error(`source hash is missing: ${key}`);
    output[key] = value;
  }
  if (!Object.keys(output).length) throw new Error('sourceHashes must not be empty');
  return output;
}

function normalizeDecisionCanonical(value) {
  const raw = text(value);
  if (!raw) throw new Error('decision canonicalGoodsSn is required');
  return text(normalizeGoodsSnDetailed(raw)?.canonical || raw);
}

function hasOwn(value, key) {
  return value !== null && value !== undefined
    && Object.prototype.hasOwnProperty.call(Object(value), key);
}

function decisionHasStore(decision) {
  return hasOwn(decision, 'storeKey');
}

function normalizeDecisionStoreKey(decision, canonicalGoodsSn, expectedStoreKeys) {
  if (!decisionHasStore(decision)) return null;
  const storeKey = normalizeStoreKey(decision?.storeKey);
  if (!storeKey) throw new Error(`decision storeKey is empty for ${canonicalGoodsSn}`);
  if (!expectedStoreKeys.has(storeKey)) {
    throw new Error(`decision storeKey is invalid or not in fresh scan for ${canonicalGoodsSn}: ${storeKey}`);
  }
  return storeKey;
}

function compareDecisions(left, right) {
  return left.canonicalGoodsSn.localeCompare(right.canonicalGoodsSn)
    || (decisionHasStore(left) ? 1 : 0) - (decisionHasStore(right) ? 1 : 0)
    || text(left.storeKey).localeCompare(text(right.storeKey))
    || left.action.localeCompare(right.action);
}

function decisionScopeLabel(decision) {
  return decisionHasStore(decision) ? `storeKey=${decision.storeKey}` : 'global';
}

function decisionMatchesRow(decision, row) {
  return row.canonicalGoodsSn === decision.canonicalGoodsSn
    && (!decisionHasStore(decision) || row.storeKey === decision.storeKey);
}

function compareItems(left, right) {
  return text(left?.storeKey).localeCompare(text(right?.storeKey))
    || text(left?.discussSn).localeCompare(text(right?.discussSn))
    || text(left?.itemHash).localeCompare(text(right?.itemHash));
}

function lockedItemBinding(item) {
  return {lockedRow: item.lockedRow, action: item.action, payload: item.payload};
}

function storePayloadBinding(store) {
  return {
    storeKey: store.storeKey,
    items: [...store.items].sort(compareItems).map(item => ({itemHash: item.itemHash, payload: item.payload})),
  };
}

export function preflightBatchBinding(preflight) {
  const stores = (Array.isArray(preflight?.stores) ? preflight.stores : []).map(store => ({
    storeKey: store.storeKey,
    payloadHash: store.payloadHash,
    itemHashes: (Array.isArray(store.items) ? store.items : []).map(item => item.itemHash),
  })).sort((left, right) => String(left.storeKey).localeCompare(String(right.storeKey)));
  return {
    schemaVersion: preflight?.schemaVersion,
    businessDate: preflight?.businessDate,
    generatedAt: preflight?.generatedAt,
    expiresAt: preflight?.expiresAt,
    stores,
  };
}

export function buildPreflightDocument({scan, decisions, sourceHashes, generatedAt = new Date().toISOString(), expiresAt}) {
  if (!scan?.ok) throw new Error('fresh scan is not complete; preflight is blocked');
  if (scan.schemaVersion !== PENDING_DISCUSS_SCHEMA_VERSION) throw new Error('unsupported scan schema');
  if (decisions?.schemaVersion !== 1) throw new Error('decisions schemaVersion must be 1');
  if (text(decisions.businessDate) !== text(scan.businessDate)) throw new Error('decisions businessDate does not match fresh scan');
  const generatedTime = new Date(generatedAt);
  const expiresTime = new Date(expiresAt || generatedTime.getTime() + 15 * 60_000);
  if (Number.isNaN(generatedTime.getTime()) || Number.isNaN(expiresTime.getTime()) || expiresTime <= generatedTime) throw new Error('invalid preflight validity window');
  const expectedStoreKeys = new Set((scan.coverage?.expectedStores || [])
    .map(normalizeStoreKey)
    .filter(Boolean));
  const decisionsByCanonical = new Map();
  const scopesByCanonical = new Map();
  const canonicalDecisions = [];
  for (const decision of Array.isArray(decisions.decisions) ? decisions.decisions : []) {
    const canonicalGoodsSn = normalizeDecisionCanonical(decision?.canonicalGoodsSn);
    const action = text(decision?.action).toLowerCase();
    if (!['accept', 'reject'].includes(action)) throw new Error(`unsupported action for ${canonicalGoodsSn}: ${decision?.action}`);
    const storeKey = normalizeDecisionStoreKey(decision, canonicalGoodsSn, expectedStoreKeys);
    const canonicalDecision = storeKey
      ? {canonicalGoodsSn, storeKey, action}
      : {canonicalGoodsSn, action};
    const scope = scopesByCanonical.get(canonicalGoodsSn) || {global: false, stores: new Set()};
    if (decisionHasStore(canonicalDecision)) {
      if (scope.global) throw new Error(`global and store-scoped decisions cannot be mixed for ${canonicalGoodsSn}`);
      if (scope.stores.has(storeKey)) throw new Error(`duplicate or conflicting decision for ${canonicalGoodsSn} storeKey=${storeKey}`);
      scope.stores.add(storeKey);
    } else {
      if (scope.global) throw new Error(`duplicate or conflicting decision for ${canonicalGoodsSn}`);
      if (scope.stores.size) throw new Error(`global and store-scoped decisions cannot be mixed for ${canonicalGoodsSn}`);
      scope.global = true;
    }
    scopesByCanonical.set(canonicalGoodsSn, scope);
    const rules = decisionsByCanonical.get(canonicalGoodsSn) || [];
    rules.push(canonicalDecision);
    decisionsByCanonical.set(canonicalGoodsSn, rules);
    canonicalDecisions.push(canonicalDecision);
  }
  canonicalDecisions.sort(compareDecisions);
  if (!canonicalDecisions.length) throw new Error('decisions list is empty');
  const pendingRows = scan.rows.filter(row => row.discussStatus === 1);
  for (const decision of canonicalDecisions) {
    const matches = pendingRows.filter(row => decisionMatchesRow(decision, row));
    if (!matches.length) {
      const scopeLabel = decisionHasStore(decision) ? ` ${decisionScopeLabel(decision)}` : '';
      throw new Error(`decision matched no current pending rows: ${decision.canonicalGoodsSn}${scopeLabel}`);
    }
  }
  const matchedPendingKeys = new Set();
  const items = pendingRows
    .map(row => {
      const lockedRow = normalizePendingDiscussRow(row.storeKey, row);
      const matchingDecisions = (decisionsByCanonical.get(lockedRow.canonicalGoodsSn) || [])
        .filter(decision => decisionMatchesRow(decision, lockedRow));
      if (matchingDecisions.length > 1) {
        throw new Error(`overlapping decisions matched ${lockedRow.storeKey} ${lockedRow.canonicalGoodsSn}`);
      }
      const decision = matchingDecisions[0];
      if (!decision) return null;
      matchedPendingKeys.add(pendingDiscussKey(lockedRow));
      const action = decision.action;
      if (action === 'accept') {
        if (!lockedRow.skuCostPrices.length) throw new Error(`accept price evidence is empty: ${lockedRow.storeKey} ${lockedRow.discussSn}`);
        const seenSkuCodes = new Set();
        for (const sku of lockedRow.skuCostPrices) {
          if (!sku.skuCode || sku.suggestCostPrice === null || !sku.suggestCostCurrency) {
            throw new Error(`accept price evidence is incomplete: ${lockedRow.storeKey} ${lockedRow.discussSn}`);
          }
          if (seenSkuCodes.has(sku.skuCode)) throw new Error(`accept price evidence has duplicate SKU: ${lockedRow.storeKey} ${lockedRow.discussSn} ${sku.skuCode}`);
          seenSkuCodes.add(sku.skuCode);
        }
      }
      const payload = buildProcessPayload(action, lockedRow.discussSn);
      const item = {storeKey: lockedRow.storeKey, discussSn: lockedRow.discussSn, lockedRow, action, payload};
      return {...item, itemHash: sha256Json(lockedItemBinding(item))};
    })
    .filter(Boolean)
    .sort(compareItems);
  const stores = [];
  for (const storeKey of sortedUnique(items.map(item => item.storeKey))) {
    const store = {storeKey, items: items.filter(item => item.storeKey === storeKey)};
    stores.push({...store, payloadHash: sha256Json(storePayloadBinding(store))});
  }
  const normalizedHashes = normalizeSourceHashes(sourceHashes);
  const canonicalDecisionDocument = {schemaVersion: 1, businessDate: scan.businessDate, decisions: canonicalDecisions};
  const preflight = {
    schemaVersion: PENDING_DISCUSS_PREFLIGHT_SCHEMA_VERSION,
    ok: true,
    businessDate: scan.businessDate,
    generatedAt: generatedTime.toISOString(),
    expiresAt: expiresTime.toISOString(),
    scanHash: scan.scanHash,
    decisionsHash: sha256Json(canonicalDecisionDocument),
    sourceHashes: normalizedHashes,
    decisionCount: canonicalDecisions.length,
    itemCount: items.length,
    unmatchedPendingCount: pendingRows.filter(row => !matchedPendingKeys.has(pendingDiscussKey(row))).length,
    decisions: canonicalDecisions,
    stores,
  };
  return {...preflight, batchHash: sha256Json(preflightBatchBinding(preflight))};
}

export function recomputePreflightBatchHash(preflight) {
  return sha256Json(preflightBatchBinding(preflight));
}

function blocker(code, message) {
  return {code, message};
}

export function verifyPreflightDocument(preflight, {businessDate, now = new Date(), sourceHashes, batchHash} = {}) {
  const blockers = [];
  if (preflight?.schemaVersion !== PENDING_DISCUSS_PREFLIGHT_SCHEMA_VERSION) blockers.push(blocker('PREFLIGHT_SCHEMA_MISMATCH', 'unsupported preflight schema'));
  if (preflight?.ok !== true) blockers.push(blocker('PREFLIGHT_NOT_OK', 'preflight is not marked ok'));
  if (businessDate && preflight?.businessDate !== businessDate) blockers.push(blocker('BUSINESS_DATE_DRIFT', `preflight=${preflight?.businessDate || '-'} current=${businessDate}`));
  const currentTime = now instanceof Date ? now : new Date(now);
  const expiry = new Date(preflight?.expiresAt || '');
  if (Number.isNaN(currentTime.getTime()) || Number.isNaN(expiry.getTime()) || currentTime >= expiry) blockers.push(blocker('PREFLIGHT_EXPIRED', `preflight expired at ${preflight?.expiresAt || '-'}`));
  try {
    if (sourceHashes) {
      const normalizedCurrent = normalizeSourceHashes(sourceHashes);
      const normalizedPreflight = preflight?.sourceHashes || {};
      const mismatchedKeys = [];
      for (const [k, v] of Object.entries(normalizedCurrent)) {
        if (normalizedPreflight[k] !== v) mismatchedKeys.push(k);
      }
      for (const k of Object.keys(normalizedPreflight)) {
        if (!normalizedCurrent[k]) mismatchedKeys.push(k);
      }
      if (mismatchedKeys.length) {
        blockers.push(blocker('SOURCE_HASH_DRIFT', `source/schema/config hashes changed after preflight: ${[...new Set(mismatchedKeys)].join(', ')}`));
      }
    }
  } catch (error) {
    blockers.push(blocker('SOURCE_HASH_INVALID', error.message));
  }
  const stores = Array.isArray(preflight?.stores) ? preflight.stores : [];
  for (const store of stores) {
    for (const item of Array.isArray(store?.items) ? store.items : []) {
      let expected = '';
      try {
        expected = sha256Json(lockedItemBinding(item));
        const expectedPayload = buildProcessPayload(item.action, item.discussSn);
        if (stableStringify(expectedPayload) !== stableStringify(item.payload)) blockers.push(blocker('ITEM_PAYLOAD_DRIFT', `${store.storeKey} ${item.discussSn} payload does not match action`));
      } catch (error) {
        blockers.push(blocker('ITEM_BINDING_INVALID', `${store.storeKey || '-'} ${item?.discussSn || '-'}: ${error.message}`));
      }
      if (!item?.itemHash || item.itemHash !== expected) blockers.push(blocker('ITEM_HASH_DRIFT', `${store.storeKey || '-'} ${item?.discussSn || '-'} itemHash mismatch`));
    }
    try {
      const expectedStoreHash = sha256Json(storePayloadBinding(store));
      if (!store?.payloadHash || store.payloadHash !== expectedStoreHash) blockers.push(blocker('STORE_PAYLOAD_HASH_DRIFT', `${store?.storeKey || '-'} payloadHash mismatch`));
    } catch (error) {
      blockers.push(blocker('STORE_BINDING_INVALID', `${store?.storeKey || '-'}: ${error.message}`));
    }
  }
  try {
    const recomputed = recomputePreflightBatchHash(preflight);
    if (!preflight?.batchHash || preflight.batchHash !== recomputed) blockers.push(blocker('BATCH_HASH_DRIFT', 'stored batchHash does not match preflight contents'));
    if (batchHash) {
      const normalizedConfirmed = String(batchHash).trim();
      if (normalizedConfirmed && normalizedConfirmed !== preflight?.batchHash) {
        blockers.push(blocker('BATCH_HASH_CONFIRMATION_MISMATCH', 'confirmed batchHash does not match preflight'));
      }
    }
  } catch (error) {
    blockers.push(blocker('BATCH_BINDING_INVALID', error.message));
  }
  return {ok: blockers.length === 0, blockers};
}

export function verifyLockedItem(lockedItem, currentRow) {
  const blockers = [];
  let current = null;
  try {
    current = normalizePendingDiscussRow(lockedItem?.storeKey || lockedItem?.lockedRow?.storeKey, currentRow);
  } catch (error) {
    return {ok: false, blockers: [blocker('CURRENT_ROW_INVALID', error.message)], current: null};
  }
  if (current.discussStatus !== 1) blockers.push(blocker('DISCUSS_STATUS_DRIFT', `expected 1, got ${current.discussStatus}`));
  if (pendingDiscussKey(current) !== pendingDiscussKey(lockedItem?.lockedRow || lockedItem)) blockers.push(blocker('DISCUSS_IDENTITY_DRIFT', 'storeKey/discussSn changed'));
  if (stableStringify(current) !== stableStringify(lockedItem?.lockedRow)) blockers.push(blocker('DISCUSS_OBJECT_DRIFT', 'locked pending discuss fields changed'));
  try {
    const currentHash = sha256Json({lockedRow: current, action: lockedItem.action, payload: lockedItem.payload});
    if (currentHash !== lockedItem.itemHash) blockers.push(blocker('ITEM_HASH_DRIFT', 'current item does not match locked itemHash'));
  } catch (error) {
    blockers.push(blocker('ITEM_HASH_INVALID', error.message));
  }
  return {ok: blockers.length === 0, blockers, current};
}

function numbersEqual(left, right) {
  return left !== null && right !== null && Math.abs(Number(left) - Number(right)) <= 1e-9;
}

export function verifyTerminalItem(lockedItem, terminalRow) {
  const blockers = [];
  let terminal = null;
  try {
    terminal = normalizePendingDiscussRow(lockedItem?.storeKey || lockedItem?.lockedRow?.storeKey, terminalRow);
  } catch (error) {
    return {ok: false, blockers: [blocker('TERMINAL_ROW_INVALID', error.message)], terminal: null};
  }
  const expectedStatus = lockedItem?.action === 'accept' ? 3 : lockedItem?.action === 'reject' ? 4 : null;
  if (expectedStatus === null) blockers.push(blocker('TERMINAL_ACTION_INVALID', `unsupported action: ${lockedItem?.action}`));
  else if (terminal.discussStatus !== expectedStatus) blockers.push(blocker('TERMINAL_STATUS_MISMATCH', `expected ${expectedStatus}, got ${terminal.discussStatus}`));
  const lockedRow = lockedItem?.lockedRow || {};
  if (pendingDiscussKey(terminal) !== pendingDiscussKey(lockedRow)) blockers.push(blocker('TERMINAL_IDENTITY_DRIFT', 'terminal storeKey/discussSn changed'));
  for (const field of ['supplierCode', 'canonicalGoodsSn', 'skcName', 'spuName']) {
    if (terminal[field] !== lockedRow[field]) blockers.push(blocker('TERMINAL_OBJECT_DRIFT', `${field} changed`));
  }
  if (lockedItem?.action === 'accept') {
    const expectedSkus = lockedRow.skuCostPrices || [];
    if (!expectedSkus.length) blockers.push(blocker('ACCEPTED_PRICE_UNVERIFIED', 'locked accept item has no SKU price evidence'));
    for (const expectedSku of expectedSkus) {
      const actualSku = terminal.skuCostPrices.find(row => row.skuCode === expectedSku.skuCode);
      if (!actualSku) {
        blockers.push(blocker('ACCEPTED_PRICE_UNVERIFIED', `missing terminal SKU ${expectedSku.skuCode || '(blank)'}`));
        continue;
      }
      const expectedPrice = expectedSku.suggestCostPrice;
      const expectedCurrency = expectedSku.suggestCostCurrency;
      const historyProves = numbersEqual(actualSku.latestHistory?.costPrice, expectedPrice)
        && text(actualSku.latestHistory?.currency) === expectedCurrency;
      const latestProves = numbersEqual(actualSku.latestCostPrice, expectedPrice)
        && text(actualSku.suggestCostCurrency) === expectedCurrency;
      if (!historyProves && !latestProves) blockers.push(blocker('ACCEPTED_PRICE_UNVERIFIED', `SKU ${expectedSku.skuCode || '(blank)'} terminal price/currency not proven`));
    }
  }
  return {ok: blockers.length === 0, blockers, terminal};
}

export function isRetryableReadFailure({status, code, message, error} = {}) {
  const httpStatus = Number(status || error?.status || error?.statusCode || 0);
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) return true;
  const combined = `${code || ''} ${message || ''} ${error?.code || ''} ${error?.message || ''}`;
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|timed?\s*out|timeout|temporar(?:y|ily)|rate.?limit|too many requests|限流|稍后重试|服务繁忙|504|503|502/i.test(combined);
}

function redactText(value) {
  return text(value)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(openKeyId|secretKey|signature|token|cookie|password)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, '[REDACTED]')
    .slice(0, 1000);
}

export function redactError(error) {
  if (typeof error === 'string') return {code: '', message: redactText(error)};
  return {
    code: redactText(error?.code || '').slice(0, 100),
    message: redactText(error?.message || String(error || 'unknown error')),
  };
}
