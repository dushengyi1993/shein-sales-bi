const MAX_STORAGE_INVENTORY_DATE_GAP_DAYS = 2;
const PASSED_STORAGE_EVIDENCE_STATUS = 'fresh_quantity_crosscheck_passed';

export function buildSharedStorageCostIndex(bi = {}) {
  const byCanonical = new Map();
  for (const row of bi?.inventoryDepletion?.products || []) {
    const canonical = String(row?.standard_goods_sn || row?.standardGoodsSn || '').trim();
    if (!canonical) continue;
    const matchStatus = String(row?.inventory_match_status || '').trim().toLowerCase();
    if (matchStatus !== 'matched') continue;
    const storageLatestDate = isoDate(row?.et_storage_fee_latest_date);
    const inventorySnapshotDate = operationalInventorySnapshotDate(row);
    if (!datesAreCompatible(storageLatestDate, inventorySnapshotDate)) continue;
    const storageFeeSar = numberOrNull(row?.et_storage_fee_30d_sar);
    const grossSoldQuantity = numberOrNull(row?.gross_sold_quantity);
    const sellableQuantity = firstNonNegative(
      row?.current_sellable_quantity,
      row?.et_loose_sellable_qty,
      row?.estimated_on_hand_quantity,
    );
    const damagedQuantity = nonNegative(row?.et_damaged_qty) ?? 0;
    const physicalQuantity = sellableQuantity === null ? null : sellableQuantity + damagedQuantity;
    if (
      !(storageFeeSar > 0)
      || !(physicalQuantity > 0)
      || grossSoldQuantity === null
      || Math.abs(grossSoldQuantity) > 1e-9
    ) continue;
    const storageUnitCostSar = round4(storageFeeSar / physicalQuantity);
    const evidence = {
      canonical,
      storageUnitCostSar,
      storageFeeSar: round4(storageFeeSar),
      storageCurrentQuantity: round4(physicalQuantity),
      sellableQuantity: round4(sellableQuantity),
      damagedQuantity: round4(damagedQuantity),
      grossSoldQuantity: round4(grossSoldQuantity),
      storageLatestDate,
      inventorySnapshotDate,
      inventoryMatchStatus: matchStatus,
      storageMethod: 'inventory_depletion_unsold_shared_stock',
      source: 'bi.inventoryDepletion.products',
    };
    for (const key of [canonical, row?.match_key].filter(Boolean)) byCanonical.set(compact(key), evidence);
  }
  return byCanonical;
}

export function storageEvidenceBlocksSharedFallback(costInfo = {}) {
  const status = String(costInfo?.storageQuantityEvidenceStatus || '').trim();
  return Boolean(status && status !== PASSED_STORAGE_EVIDENCE_STATUS);
}

export function findSharedStorageCost(index, keys = []) {
  if (!index || typeof index.get !== 'function') return null;
  for (const key of keys) {
    const found = index.get(compact(key));
    if (found) return found;
  }
  return null;
}

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\-_()（）【】\[\]_:：/\\]/g, '').toUpperCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function firstNonNegative(...values) {
  for (const value of values) {
    const number = nonNegative(value);
    if (number !== null) return number;
  }
  return null;
}

function operationalInventorySnapshotDate(row) {
  const policy = String(row?.et_operational_stock_policy || '').toLowerCase();
  const storeDate = isoDate(row?.et_store_snapshot_date);
  const boxDate = isoDate(row?.et_box_snapshot_date);
  if (policy.includes('full_carton')) {
    if (!storeDate || !boxDate) return '';
    return storeDate < boxDate ? storeDate : boxDate;
  }
  return storeDate;
}

function datesAreCompatible(left, right) {
  if (!left || !right) return false;
  const leftMs = Date.parse(`${left}T00:00:00Z`);
  const rightMs = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return false;
  return Math.abs(leftMs - rightMs) / 86_400_000 <= MAX_STORAGE_INVENTORY_DATE_GAP_DAYS;
}

function isoDate(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || '';
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 10000) / 10000 : null;
}
