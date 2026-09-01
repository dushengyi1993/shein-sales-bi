import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildSharedStorageCostIndex,
  findSharedStorageCost,
  storageMethodForEvidence,
  storageEvidenceBlocksSharedFallback,
} from '../../lib/marketing_shared_storage_cost.mjs';

const bi = {
  inventoryDepletion: {
    products: [
      {
        standard_goods_sn: 'SK-13034杆式吸尘器',
        match_key: 'SK13034',
        gross_sold_quantity: 0,
        current_sellable_quantity: 107,
        et_damaged_qty: 13,
        et_storage_fee_30d_sar: 105.5190077075,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-20',
        inventory_match_status: 'matched',
        et_operational_stock_policy: '09_loose_only',
      },
      {
        standard_goods_sn: 'SOLD-ITEM',
        gross_sold_quantity: 1,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-20',
        inventory_match_status: 'matched',
        et_operational_stock_policy: '09_loose_only',
      },
      {
        standard_goods_sn: 'FALLBACK-STOCK',
        gross_sold_quantity: 0,
        current_sellable_quantity: null,
        et_loose_sellable_qty: 8,
        et_damaged_qty: 2,
        et_storage_fee_30d_sar: 10,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-20',
        inventory_match_status: 'matched',
        et_operational_stock_policy: '09_loose_only',
      },
      {
        standard_goods_sn: 'MISSING-SALES',
        gross_sold_quantity: null,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-20',
        inventory_match_status: 'matched',
        et_operational_stock_policy: '09_loose_only',
      },
      {
        standard_goods_sn: 'STALE-UNSOLD',
        gross_sold_quantity: 0,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-10',
        inventory_match_status: 'matched',
        et_operational_stock_policy: '09_loose_only',
      },
      {
        standard_goods_sn: 'UNMATCHED-UNSOLD',
        gross_sold_quantity: 0,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
        et_storage_fee_latest_date: '2026-07-20',
        et_store_snapshot_date: '2026-07-20',
        inventory_match_status: 'not_matched',
        et_operational_stock_policy: '09_loose_only',
      },
    ],
  },
};

const index = buildSharedStorageCostIndex(bi);
const sk13034 = findSharedStorageCost(index, ['SK-13034杆式吸尘器']);
assert.equal(sk13034.storageUnitCostSar, 0.8793);
assert.equal(sk13034.storageCurrentQuantity, 120);
assert.equal(sk13034.storageMethod, 'inventory_depletion_unsold_shared_stock');
assert.equal(findSharedStorageCost(index, ['SOLD-ITEM']), null);
assert.equal(findSharedStorageCost(index, ['FALLBACK-STOCK']).storageUnitCostSar, 1);
assert.equal(findSharedStorageCost(index, ['MISSING-SALES']), null);
assert.equal(findSharedStorageCost(index, ['STALE-UNSOLD']), null);
assert.equal(findSharedStorageCost(index, ['UNMATCHED-UNSOLD']), null);
assert.equal(storageEvidenceBlocksSharedFallback({storageQuantityEvidenceStatus: 'fresh_quantity_crosscheck_passed'}), false);
assert.equal(storageEvidenceBlocksSharedFallback({
  storageUnitCostSar: 2.2078,
  storageQuantityEvidenceStatus: 'inventory_storage_quantity_mismatch',
}), true, 'an explicit mismatch must still block shared fallback even when direct billing evidence exists');
assert.equal(storageEvidenceBlocksSharedFallback({}), false, 'old maps without evidence status remain backward compatible');
const mismatchStorageMethod = storageMethodForEvidence({
  storageUnitCostSar: 2.2078,
  storageQuantityEvidenceStatus: 'inventory_storage_quantity_mismatch',
  baseMethod: 'download_detail',
});
assert.match(mismatchStorageMethod, /billing_unit_cost/);
assert.match(mismatchStorageMethod, /crosscheck_warning/);
assert.doesNotMatch(mismatchStorageMethod, /blocked|missing/i);
assert.equal(storageMethodForEvidence({
  storageQuantityEvidenceStatus: 'inventory_storage_quantity_mismatch',
  baseMethod: 'download_detail',
}), 'missing', 'a missing direct billed unit must remain fail-closed');
for (const file of [
  'scripts/marketing/build_marketing_sku_approval.mjs',
  'scripts/marketing/export_marketing_stack_review.mjs',
]) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /storageEvidenceBlocked \? null : findSharedStorageCost/,
    `${file} must not bypass an explicit storage evidence conflict through shared fallback`);
  assert.match(source, /storageMethodForEvidence\(/,
    `${file} must label a direct billed unit plus crosscheck conflict as a warning`);
  assert.match(source, /数量差异提示/,
    `${file} must retain a readable quantity-difference warning`);
}
console.log(JSON.stringify({
  ok: true,
  sk13034,
  nullInventoryFallback: true,
  missingSalesFailsClosed: true,
}, null, 2));
