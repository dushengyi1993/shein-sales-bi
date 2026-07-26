import assert from 'node:assert/strict';
import {buildSharedStorageCostIndex, findSharedStorageCost} from '../../lib/marketing_shared_storage_cost.mjs';

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
      },
      {
        standard_goods_sn: 'SOLD-ITEM',
        gross_sold_quantity: 1,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
      },
      {
        standard_goods_sn: 'FALLBACK-STOCK',
        gross_sold_quantity: 0,
        current_sellable_quantity: null,
        et_loose_sellable_qty: 8,
        et_damaged_qty: 2,
        et_storage_fee_30d_sar: 10,
      },
      {
        standard_goods_sn: 'MISSING-SALES',
        gross_sold_quantity: null,
        current_sellable_quantity: 10,
        et_storage_fee_30d_sar: 20,
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
console.log(JSON.stringify({
  ok: true,
  sk13034,
  nullInventoryFallback: true,
  missingSalesFailsClosed: true,
}, null, 2));
