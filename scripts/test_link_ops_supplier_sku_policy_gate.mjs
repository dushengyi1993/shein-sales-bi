import assert from 'node:assert/strict';

process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');
const {buildProtectedDestinationProjection} = __testHooks;

// ZL lot_20260914125729_f72feff6 / CX lot_20260914130359_b176de60: the owner
// gave an explicit Seller SKU for an additional link of an existing 标准货号,
// but prepare-publish still answered 409 because the destination projection
// accepted only the explicit value while the task payload still carried the
// normalised 标准货号 from the source snapshot. The pre-override value must be
// accepted exactly when the structured unique-per-link policy is declared.

let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };

const STANDARD_GOODS_SN = 'SM-505A电动缝纫机';
const UNIQUE_SKU = 'SM-505A电动缝纫机-260915-N01';

const snapshotPayload = () => ({
  skc_list: [{
    supplier_code: STANDARD_GOODS_SN,
    sku_list: [{supplier_sku: STANDARD_GOODS_SN}],
  }],
});
const taskWithPolicy = (value = UNIQUE_SKU) => ({
  publishPreparation: {targetStore: 'ZL', standardGoodsSn: STANDARD_GOODS_SN, supplierSku: value},
  notes: {supplierSkuPolicy: {mode: 'unique-per-link', value}},
});
const taskWithoutPolicy = () => ({
  publishPreparation: {targetStore: 'ZL', standardGoodsSn: STANDARD_GOODS_SN, supplierSku: UNIQUE_SKU},
});

// 1. The reported failure: policy + explicit SKU + snapshot 货号 must project.
const projected = buildProtectedDestinationProjection(taskWithPolicy(), snapshotPayload(), 'ZL');
assert.equal(projected.protectedFields.supplierSku, UNIQUE_SKU);
assert.equal(projected.protectedFields.standardGoodsSn, STANDARD_GOODS_SN);
ok('unique-per-link policy accepts the snapshot 标准货号 and projects the explicit Seller SKU');

// 2. An idempotent retry whose payload already carries the explicit value works.
const alreadyApplied = snapshotPayload();
alreadyApplied.skc_list[0].sku_list[0].supplier_sku = UNIQUE_SKU;
assert.equal(buildProtectedDestinationProjection(taskWithPolicy(), alreadyApplied, 'ZL').protectedFields.supplierSku, UNIQUE_SKU);
ok('a retry whose payload already carries the explicit Seller SKU still projects');

// 3. Fail-closed is preserved: without the policy the explicit value alone is
//    still an unexplained Seller SKU.
assert.throws(() => buildProtectedDestinationProjection(taskWithoutPolicy(), snapshotPayload(), 'ZL'),
  /supplierSku has no matching structured preparation lock/);
ok('without the unique-per-link policy an explicit Seller SKU is still refused');

// 4. Fail-closed is preserved: an unrelated Seller SKU is refused even under
//    the policy.
const unrelated = snapshotPayload();
unrelated.skc_list[0].sku_list[0].supplier_sku = 'SOME-OTHER-SKU';
assert.throws(() => buildProtectedDestinationProjection(taskWithPolicy(), unrelated, 'ZL'),
  /supplierSku has no matching structured preparation lock/);
ok('an unrelated Seller SKU is refused even under the policy');

// 5. The 标准货号 is never rewritten into the Seller SKU by the projection.
assert.notEqual(projected.protectedFields.supplierSku, projected.protectedFields.standardGoodsSn);
ok('supplier_code/standardGoodsSn and the Seller SKU stay separate');

console.log(JSON.stringify({ok: true, checks}, null, 2));
