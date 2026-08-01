import crypto from 'node:crypto';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function canonicalInventoryKey(value) {
  return String(value || '')
    .split(/[^\x00-\x7F]/, 1)[0]
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

export function stableInventoryHash(value) {
  const stable = input => {
    if (Array.isArray(input)) return input.map(stable);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function computeInventoryOverwriteQuantity(targetUsableInventory, stockRow = {}) {
  const target = finiteNumber(targetUsableInventory);
  if (!Number.isInteger(target) || target <= 0) throw new Error(`Invalid target usable inventory: ${targetUsableInventory}`);
  const total = Math.max(0, finiteNumber(stockRow.totalInventoryQuantity) || 0);
  const usable = Math.max(0, finiteNumber(stockRow.totalUsableInventory) || 0);
  const locked = Math.max(0, finiteNumber(stockRow.totalLockedQuantity) || 0);
  const unavailable = Math.max(locked, total - usable);
  return Math.max(total, target + unavailable);
}

export function classifyEtInventoryAlert(row = {}, policy = {}) {
  const quantity = finiteNumber(row.current_sellable_quantity ?? row.et_estimated_available_qty);
  const days = finiteNumber(row.days_of_supply_on_hand);
  const criticalDays = Number(policy?.etAlerts?.criticalDaysOfSupply ?? 7);
  const warningDays = Number(policy?.etAlerts?.warningDaysOfSupply ?? 14);
  const lowQuantity = Number(policy?.etAlerts?.lowQuantity ?? 20);
  const replenishmentDays = Number(policy?.etAlerts?.replenishmentDaysOfSupply ?? 90);
  if (quantity === null) return {severity: 'unknown', reason: 'missing_current_sellable_quantity'};
  if (quantity <= 0) return {severity: 'critical', reason: 'et_out_of_stock'};
  if (days !== null && days <= criticalDays) return {severity: 'critical', reason: 'et_days_of_supply_critical'};
  if (days !== null && days <= warningDays) return {severity: 'warning', reason: 'et_days_of_supply_warning'};
  if (quantity <= lowQuantity) return {severity: 'warning', reason: 'et_quantity_needs_manual_allocation'};
  if (days !== null && days < replenishmentDays) return {severity: 'replenishment', reason: 'et_days_of_supply_below_three_months'};
  return {severity: 'ok', reason: 'sufficient'};
}

export function decideDailyInventoryReplenishment({
  onShelf,
  shelfStatusCode,
  otherStoreOnShelfWithStock,
  skuCount,
  platformUsableInventory,
  etSellableInventory,
  etSnapshotCurrentDay,
  policy,
} = {}) {
  const trigger = Number(policy?.triggerUsableInventoryAtOrBelow ?? 20);
  const target = Number(policy?.targetUsableInventory ?? 100);
  const minimumEt = Number(policy?.minimumEtSellableForVirtualTopUp ?? 21);
  const status = String(shelfStatusCode ?? (onShelf === true ? '1' : ''));
  const eligibleStatuses = new Set((policy?.eligibleShelfStatusCodes || ['1']).map(String));
  const platform = finiteNumber(platformUsableInventory);
  const et = finiteNumber(etSellableInventory);
  if (!eligibleStatuses.has(status)) return {action: 'skip', reason: 'shelf_status_not_eligible'};
  if (
    status === '3'
    && policy?.soldOutRequiresOtherStoreOnShelfWithStock !== false
    && otherStoreOnShelfWithStock !== true
  ) {
    return {action: 'skip', reason: 'sold_out_without_other_store_selling'};
  }
  if (policy?.requireExactlyOneSku !== false && Number(skuCount) !== 1) return {action: 'block', reason: 'sku_count_not_one'};
  if (platform === null) return {action: 'block', reason: 'missing_platform_inventory'};
  if (platform > trigger) return {action: 'skip', reason: 'platform_inventory_above_trigger'};
  if (policy?.requireCurrentDayEtSnapshot !== false && etSnapshotCurrentDay !== true) {
    return {action: 'block', reason: 'et_snapshot_not_current_day'};
  }
  if (et === null) return {action: 'block', reason: 'missing_et_inventory'};
  if (et < minimumEt) return {action: 'alert', reason: 'et_quantity_needs_manual_allocation', etSellableInventory: et};
  const boundedTarget = Math.min(target, Math.floor(et));
  return {
    action: 'top_up',
    reason: boundedTarget < target ? 'platform_low_top_up_to_et_sellable' : 'platform_low_top_up_to_policy_target',
    targetUsableInventory: boundedTarget,
    etSellableInventory: et,
  };
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
    return {mode, payloadHash: String(payloadHash).toLowerCase(), storeScope: execution.storeScope};
  }
  if (mode !== 'automatic') throw new Error(`Unsupported inventory execution mode: ${mode}`);
  const automatic = execution.automaticExecution || {};
  if (automatic.enabled !== true) throw new Error('Daily inventory replenishment automation is disabled');
  if (!automatic.authorizationId || authorizationId !== automatic.authorizationId) throw new Error('Inventory authorization id mismatch');
  if (context !== automatic.allowedContext) throw new Error(`Inventory automation context is not authorized: ${context || '(empty)'}`);
  return {
    mode,
    authorizationId,
    context,
    payloadHash: String(payloadHash).toLowerCase(),
    storeScope: execution.storeScope,
  };
}
