import crypto from 'node:crypto';
import {normalizeGoodsSnDetailed} from './product_sku_normalizer.mjs';

export const INVENTORY_OVERWRITE_COMPUTATION_VERSION = 'ordinary-plus-temporary/v2';
export const INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION = 'locked-only/v1';
export const INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE = '2026-08-22';

function nonNegativeInteger(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function canonicalInventoryKey(value) {
  const text = String(value || '').normalize('NFKC').toUpperCase();
  const match = text.match(/[A-Z]+[\s_-]*\d+(?:[\s_-]*\d+)*/);
  return match ? match[0].replace(/[^A-Z0-9]/g, '') : '';
}

/**
 * Identity key for canonical inventory evidence comparisons. Reuses the
 * product SKU normalizer's explicit alias merge (config/product_aliases.json),
 * so e.g. OpenAPI supplierCode `SK-3065蒸汽熨烫机` and links standard_goods_sn
 * `SK-GT-3065蒸汽熨烫机` resolve to the same canonical and no longer trip a
 * false `canonicalInventoryKey` mismatch (SK3065 vs SKGT3065). Empty or
 * ignored values resolve to '' so callers still fail closed.
 */
export function resolveInventoryIdentityKey(value) {
  return normalizeGoodsSnDetailed(value).canonical;
}

export function stableInventoryHash(value) {
  const stable = input => {
    if (Array.isArray(input)) return input.map(stable);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function buildDailyInventoryPlanHashPayload(plan = {}) {
  return {
    schemaVersion: plan.schemaVersion,
    date: plan.date,
    ...(plan.commandId ? {commandId: plan.commandId} : {}),
    policyVersion: plan.policyVersion,
    actionable: plan.actionable,
    lowEtAllocations: plan.lowEtAllocations,
    detailRefreshTargets: Array.isArray(plan.detailRefreshTargets) ? plan.detailRefreshTargets : [],
    etFactSource: plan.etFactSource ?? null,
    sourceEvidence: Array.isArray(plan.sourceEvidence)
      ? plan.sourceEvidence.map(({
        ageHours: _ageHours,
        manifestAgeSeconds: _manifestAgeSeconds,
        endpointAgeSeconds: _endpointAgeSeconds,
        ...evidence
      }) => evidence)
      : [],
  };
}

export function resolveInventoryShelfStatus(metrics = {}, fallbackStatusCode = '') {
  const statusName = String(
    metrics?.shelf_status_name
    ?? metrics?.shelfStatusName
    ?? '',
  ).trim();
  const visibleStatuses = String(
    metrics?.visible_shelf_statuses
    ?? metrics?.visibleShelfStatuses
    ?? '',
  ).trim();
  let code = '';
  let hasFourStateEvidence = false;
  if (metrics?.is_out_shelf === true || metrics?.isOutShelf === true || /已下架|OUT_SHELF/i.test(`${statusName} ${visibleStatuses}`)) {
    code = '4';
    hasFourStateEvidence = true;
  } else if (metrics?.is_wait_shelf === true || metrics?.isWaitShelf === true || /待上架|WAIT_SHELF/i.test(`${statusName} ${visibleStatuses}`)) {
    code = '2';
    hasFourStateEvidence = true;
  } else if (metrics?.is_sold_out === true || metrics?.isSoldOut === true || /已售罄|SOLD_OUT/i.test(`${statusName} ${visibleStatuses}`)) {
    code = '3';
    hasFourStateEvidence = true;
  } else if (metrics?.is_on_shelf === true || metrics?.isOnShelf === true || /已上架|ON_SHELF/i.test(`${statusName} ${visibleStatuses}`)) {
    code = '1';
    hasFourStateEvidence = true;
  }
  else code = String(fallbackStatusCode || '');
  return {
    code,
    name: ({'1': '已上架', '2': '待上架', '3': '已售罄', '4': '已下架'})[code] || statusName || '未知',
    source: hasFourStateEvidence ? 'linksData_four_state' : 'openapi_fallback',
  };
}

function resolveSingleAliasField(raw, aliases = [], fieldName = 'field') {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`INVENTORY_RAW_INVALID: expected object for ${fieldName}`);
  }
  let resolved = null;
  let resolvedKey = null;
  for (const key of aliases) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const rawVal = raw[key];
    if (rawVal === undefined || rawVal === null || rawVal === '') continue;
    const val = nonNegativeInteger(rawVal);
    if (val === null) {
      throw new Error(`INVENTORY_RAW_FIELD_INVALID: field ${key} must be a non-negative integer`);
    }
    if (resolved !== null && resolved !== val) {
      throw new Error(`INVENTORY_RAW_FIELD_CONFLICT: conflicting values for ${fieldName}: ${resolvedKey}=${resolved} vs ${key}=${val}`);
    }
    resolved = val;
    resolvedKey = key;
  }
  if (resolved === null) {
    throw new Error(`INVENTORY_RAW_FIELD_MISSING: missing required field for ${fieldName}`);
  }
  return resolved;
}

export function normalizeInventoryOccupancy(raw = {}) {
  const total = resolveSingleAliasField(raw, [
    'totalInventoryQuantity', 'total_inventory_quantity',
    'inventoryQuantity', 'inventory_quantity'
  ], 'totalInventoryQuantity');

  const usable = resolveSingleAliasField(raw, [
    'totalUsableInventory', 'total_usable_inventory',
    'usableInventory', 'usable_inventory'
  ], 'totalUsableInventory');

  const locked = resolveSingleAliasField(raw, [
    'totalLockedQuantity', 'total_locked_quantity',
    'lockedQuantity', 'locked_quantity',
    'lockedInventory', 'locked_inventory'
  ], 'totalLockedQuantity');

  const tempLocked = resolveSingleAliasField(raw, [
    'totalTempLockQuantity', 'total_temp_lock_quantity',
    'tempLockQuantity', 'temp_lock_quantity',
    'temporaryInventoryQuantity', 'temporary_inventory_quantity',
    'temporaryLockedQuantity', 'temporary_locked_quantity'
  ], 'temporaryInventoryQuantity');

  if (total !== usable + locked + tempLocked) {
    throw new Error(`INVENTORY_CONSERVATION_MISMATCH: total ${total} != usable ${usable} + locked ${locked} + tempLocked ${tempLocked}`);
  }

  return {
    totalInventoryQuantity: total,
    totalUsableInventory: usable,
    totalLockedQuantity: locked,
    temporaryInventoryQuantity: tempLocked,
  };
}

export function computeInventoryOverwriteQuantity(targetUsableInventory, stockRow = {}, version = INVENTORY_OVERWRITE_COMPUTATION_VERSION) {
  const target = finiteNumber(targetUsableInventory);
  if (!Number.isInteger(target) || target < 0) throw new Error(`Invalid target usable inventory: ${targetUsableInventory}`);
  if (version === INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION) {
    const locked = Math.max(0, finiteNumber(stockRow?.totalLockedQuantity) || 0);
    return target + locked;
  }
  if (version === INVENTORY_OVERWRITE_COMPUTATION_VERSION) {
    const normalized = normalizeInventoryOccupancy(stockRow);
    return target + normalized.totalLockedQuantity + normalized.temporaryInventoryQuantity;
  }
  throw new Error(`Unsupported inventory overwrite computation version: ${version}`);
}

export function computeLegacyInventoryOverwriteQuantity(targetUsableInventory, stockRow = {}) {
  const target = finiteNumber(targetUsableInventory);
  if (!Number.isInteger(target) || target < 0) throw new Error(`Invalid target usable inventory: ${targetUsableInventory}`);
  const total = Math.max(0, finiteNumber(stockRow.totalInventoryQuantity) || 0);
  const usable = Math.max(0, finiteNumber(stockRow.totalUsableInventory) || 0);
  const locked = Math.max(0, finiteNumber(stockRow.totalLockedQuantity) || 0);
  return target + Math.max(locked, total - usable);
}

export function rankInventoryExposureRows(rows = []) {
  return [...rows].sort((a, b) => (
    Number(b.c7Exposure || 0) - Number(a.c7Exposure || 0)
    || Number(b.c7GoodsVisitors || 0) - Number(a.c7GoodsVisitors || 0)
    || Number(b.c7SaleCount || 0) - Number(a.c7SaleCount || 0)
    || String(a.storeKey || '').localeCompare(String(b.storeKey || ''))
    || String(a.skc || '').localeCompare(String(b.skc || ''))
  ));
}

export function allocateLowEtInventory(rows = [], etSellableInventory, policy = {}) {
  const et = finiteNumber(etSellableInventory);
  const limit = Number(policy?.lowEtAllocation?.topExposureLinkCount ?? 5);
  if (!Number.isInteger(et) || et < 0) throw new Error(`Invalid ET allocation inventory: ${etSellableInventory}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Invalid top exposure link count: ${limit}`);
  if (et === 0) return rows.map(row => ({
    ...row, exposureRank: null, isTopExposureLink: false, targetUsableInventory: 0,
    allocationMethod: 'et_zero_no_ranking_required',
  }));
  if (rows.some(row => finiteNumber(row.c7Exposure) === null)) {
    throw new Error('Low ET allocation requires complete 7-day exposure evidence');
  }
  const ranked = rankInventoryExposureRows(rows);
  const top = ranked.slice(0, Math.min(limit, ranked.length));
  const base = top.length ? Math.floor(et / top.length) : 0;
  const remainder = top.length ? et % top.length : 0;
  const targets = new Map(top.map((row, index) => [
    `${row.storeKey}::${row.skc}`,
    base + (index < remainder ? 1 : 0),
  ]));
  // Missing tie-break evidence is acceptable only when every possible order
  // gives the affected links the same inventory target. Keep missing facts null.
  for (let i = 0; i < ranked.length; i += 1) for (let j = i + 1; j < ranked.length; j += 1) {
    const a = ranked[i], b = ranked[j];
    if (Number(a.c7Exposure) !== Number(b.c7Exposure)) continue;
    const visitorsA = finiteNumber(a.c7GoodsVisitors), visitorsB = finiteNumber(b.c7GoodsVisitors);
    const visitorsMissing = visitorsA === null || visitorsB === null;
    const salesMissing = finiteNumber(a.c7SaleCount) === null || finiteNumber(b.c7SaleCount) === null;
    const orderUnknown = visitorsMissing || (visitorsA === visitorsB && salesMissing);
    if (orderUnknown && (targets.get(`${a.storeKey}::${a.skc}`) || 0) !== (targets.get(`${b.storeKey}::${b.skc}`) || 0)) {
      throw new Error('Low ET allocation needs missing tie-break evidence because it changes inventory targets');
    }
  }
  return ranked.map((row, index) => ({
    ...row,
    exposureRank: index + 1,
    isTopExposureLink: index < top.length,
    targetUsableInventory: targets.get(`${row.storeKey}::${row.skc}`) || 0,
    allocationMethod: 'equal_integer_remainder_to_higher_exposure',
  }));
}

export function classifyEtInventoryAlert(row = {}, policy = {}) {
  const quantity = finiteNumber(row.current_sellable_quantity ?? row.et_estimated_available_qty);
  const days = finiteNumber(row.days_of_supply_on_hand);
  const criticalDays = Number(policy?.etAlerts?.criticalDaysOfSupply ?? 7);
  const warningDays = Number(policy?.etAlerts?.warningDaysOfSupply ?? 14);
  const lowQuantity = Number(policy?.etAlerts?.lowQuantity ?? 10);
  const replenishmentDays = Number(policy?.etAlerts?.replenishmentDaysOfSupply ?? 120);
  if (quantity === null) return {severity: 'unknown', reason: 'missing_current_sellable_quantity'};
  if (quantity <= 0) return {severity: 'critical', reason: 'et_out_of_stock'};
  if (days !== null && days <= criticalDays) return {severity: 'critical', reason: 'et_days_of_supply_critical'};
  if (days !== null && days <= warningDays) return {severity: 'warning', reason: 'et_days_of_supply_warning'};
  if (quantity <= lowQuantity) return {severity: 'warning', reason: 'et_quantity_needs_manual_allocation'};
  if (days !== null && days < replenishmentDays) return {severity: 'replenishment', reason: 'et_days_of_supply_below_replenishment_threshold'};
  return {severity: 'ok', reason: 'sufficient'};
}

export function decideDailyInventoryReplenishment({
  onShelf,
  shelfStatusCode,
  sameStoreOnShelfLinkExists,
  skuCount,
  platformUsableInventory,
  etSellableInventory,
  etSnapshotCurrentDay,
  c7SaleCount,
  operationMode = 'daily',
  policy,
} = {}) {
  const trigger = Number(policy?.triggerUsableInventoryAtOrBelow ?? 20);
  const target = Number(policy?.targetUsableInventory ?? 100);
  const minimumEt = Number(policy?.minimumEtSellableForVirtualTopUp ?? 11);
  const lowEtThreshold = Number(policy?.lowEtAllocationAtOrBelow ?? 10);
  const scarcityTarget = Number(policy?.recentSaleScarcity?.targetUsableInventory ?? 10);
  const scarcityRefillBelow = Number(policy?.recentSaleScarcity?.refillWhenBelow ?? 5);
  const scarcityCapAbove = Number(policy?.recentSaleScarcity?.capWhenAbove ?? 10);
  const minimumSaleCount = Number(policy?.recentSaleScarcity?.minimumSaleCount ?? 1);
  const status = String(shelfStatusCode ?? (onShelf === true ? '1' : ''));
  const eligibleStatuses = new Set((policy?.eligibleShelfStatusCodes || ['1']).map(String));
  const platform = finiteNumber(platformUsableInventory);
  const et = finiteNumber(etSellableInventory);
  const sales7d = finiteNumber(c7SaleCount);
  if (!eligibleStatuses.has(status)) return {action: 'skip', reason: 'shelf_status_not_eligible'};
  if (
    status === String(policy?.soldOutShelfStatusCode ?? '3')
    && policy?.ignoreSoldOutWhenSameStoreHasOnShelfCanonical !== false
    && sameStoreOnShelfLinkExists === true
  ) {
    return {action: 'skip', reason: 'sold_out_has_same_store_on_shelf_link'};
  }
  if (policy?.requireExactlyOneSku !== false && Number(skuCount) !== 1) return {action: 'block', reason: 'sku_count_not_one'};
  if (platform === null) return {action: 'block', reason: 'missing_platform_inventory'};
  if (policy?.requireCurrentDayEtSnapshot !== false && etSnapshotCurrentDay !== true) {
    return {action: 'block', reason: 'et_snapshot_not_current_day'};
  }
  if (et === null) return {action: 'block', reason: 'missing_et_inventory'};
  if (operationMode === 'et_low_inventory_safety' && et >= 0 && et <= lowEtThreshold) {
    return {action: 'allocate', reason: 'et_quantity_requires_top_exposure_allocation', etSellableInventory: et};
  }
  if (sales7d === null) return {action: 'block', reason: 'missing_c7_sale_count'};
  if (et <= lowEtThreshold) {
    return {action: 'allocate', reason: 'et_quantity_requires_top_exposure_allocation', etSellableInventory: et};
  }
  if (et < minimumEt) return {action: 'block', reason: 'virtual_top_up_threshold_misconfigured', etSellableInventory: et};
  if (sales7d >= minimumSaleCount) {
    if (platform > scarcityCapAbove || platform < scarcityRefillBelow) {
      return {
        action: 'set_exact',
        reason: platform > scarcityCapAbove
          ? 'recent_sale_scarcity_cap_to_ten'
          : 'recent_sale_scarcity_refill_to_ten',
        targetUsableInventory: scarcityTarget,
        etSellableInventory: et,
      };
    }
    return {
      action: 'skip',
      reason: 'recent_sale_scarcity_inventory_within_band',
      targetUsableInventory: platform,
      etSellableInventory: et,
    };
  }
  if (platform > trigger) return {action: 'skip', reason: 'platform_inventory_above_trigger'};
  const boundedTarget = Math.min(target, Math.floor(et));
  return {
    action: 'set_exact',
    reason: boundedTarget < target ? 'platform_low_top_up_to_et_sellable' : 'platform_low_top_up_to_policy_target',
    targetUsableInventory: boundedTarget,
    etSellableInventory: et,
  };
}

export function assertCurrentInventoryListingIdentity({
  expectedMatchKey,
  expectedSkuCode,
  liveSupplierCode,
  liveSkuCodes,
} = {}) {
  const expectedCanonical = resolveInventoryIdentityKey(expectedMatchKey);
  const currentCanonical = resolveInventoryIdentityKey(liveSupplierCode);
  const currentSkuCodes = [...new Set((Array.isArray(liveSkuCodes) ? liveSkuCodes : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))].sort();
  if (!expectedCanonical || currentCanonical !== expectedCanonical) {
    throw new Error('canonical identity changed or is unavailable');
  }
  if (currentSkuCodes.length !== 1 || currentSkuCodes[0] !== String(expectedSkuCode || '')) {
    throw new Error('SKU mapping or cardinality changed');
  }
  return {matchKey: currentCanonical, skuCode: currentSkuCodes[0]};
}

export function assertDailyInventoryExecutionAuthorization({
  policy,
  mode = 'manual_review',
  context,
  authorizationId,
  payloadHash,
  confirmHash,
} = {}) {
  const execution = policy?.execution || {};
  if (execution.storeScope !== 'all_enabled_stores') throw new Error('Inventory execution store scope is not authorized');
  if (execution.perRunPayloadHashRequired !== true || !/^[a-f0-9]{64}$/i.test(String(payloadHash || ''))) {
    throw new Error('Exact per-run inventory payload hash is required');
  }
  if (String(confirmHash || '').toLowerCase() !== String(payloadHash || '').toLowerCase()) {
    throw new Error(`Execute requires --confirm-hash ${payloadHash}`);
  }
  if (mode === 'manual_review') {
    if (execution.mode !== 'manual_review' || execution.perRunUserConfirmationRequired !== true) {
      throw new Error('Manual reviewed inventory execution is not enabled');
    }
    const normalizedPayloadHash = String(payloadHash).toLowerCase();
    return {
      mode,
      authorizationId: stableInventoryHash({
        kind: 'manual_review_inventory_execution',
        payloadHash: normalizedPayloadHash,
        storeScope: execution.storeScope,
      }),
      payloadHash: normalizedPayloadHash,
      storeScope: execution.storeScope,
    };
  }
  if (mode !== 'automatic') throw new Error(`Unsupported inventory execution mode: ${mode}`);
  if (execution.mode !== 'automatic' || execution.perRunUserConfirmationRequired !== false) {
    throw new Error('Automatic inventory execution is not enabled by the active execution policy');
  }
  const automatic = execution.automaticExecution || {};
  if (automatic.enabled !== true) throw new Error('Daily inventory replenishment automation is disabled');
  const authorizationByContext = automatic.authorizationByContext && typeof automatic.authorizationByContext === 'object'
    ? automatic.authorizationByContext
    : {};
  const allowedContexts = new Set([
    ...(Array.isArray(automatic.allowedContexts) ? automatic.allowedContexts : []).map(String),
    ...(automatic.allowedContext ? [String(automatic.allowedContext)] : []),
  ]);
  if (!allowedContexts.has(context)) throw new Error(`Inventory automation context is not authorized: ${context || '(empty)'}`);
  const expectedAuthorizationId = authorizationByContext[context]
    || (context === automatic.allowedContext ? automatic.authorizationId : '');
  if (!expectedAuthorizationId || authorizationId !== expectedAuthorizationId) throw new Error('Inventory authorization id mismatch');
  return {
    mode,
    authorizationId,
    context,
    payloadHash: String(payloadHash).toLowerCase(),
    storeScope: execution.storeScope,
  };
}
