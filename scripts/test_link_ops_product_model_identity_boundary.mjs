#!/usr/bin/env node
process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
const {__testHooks} = await import('./link_ops_hl_openapi_executor.mjs');
const input = {
  product_attribute_list: [{attribute_id: 1000546, attribute_extra_value: 'SK-3065'}],
  skc_list: [{supplier_code: 'old', sku_list: [{supplier_sku: 'old'}]}],
};
const result = __testHooks.applyTargetStandardGoodsSn(input, 'SK-GT-3065蒸汽熨烫机');
const duplicateResult = __testHooks.applyTargetStandardGoodsSn(
  input,
  'SK-GT-3065蒸汽熨烫机',
  {preserveExplicitSupplierSku: true},
);
const duplicatePreparation = __testHooks.taskPublishPreparationOverrides({
  standardGoodsSn: 'SK-GT-3065蒸汽熨烫机',
  notes: {
    supplierSkuPolicy: {
      mode: 'unique-per-link',
      value: 'SK3065-UNIQUE-02',
    },
  },
});
const model = result.payload.product_attribute_list[0].attribute_extra_value;
const supplierCode = result.payload.skc_list[0].supplier_code;
const supplierSku = result.payload.skc_list[0].sku_list[0].supplier_sku;
const checks = [
  {label: 'product model remains pure model', actual: model, expected: 'SK-3065'},
  {label: 'supplier code receives standard goods identity', actual: supplierCode, expected: 'SK-GT-3065蒸汽熨烫机'},
  {label: 'supplier SKU receives standard goods identity', actual: supplierSku, expected: 'SK-GT-3065蒸汽熨烫机'},
  {
    label: 'same-code extra publish preserves explicit unique supplier SKU',
    actual: duplicateResult.payload.skc_list[0].sku_list[0].supplier_sku,
    expected: 'old',
  },
  {
    label: 'same-code extra publish still standardizes supplier code',
    actual: duplicateResult.payload.skc_list[0].supplier_code,
    expected: 'SK-GT-3065蒸汽熨烫机',
  },
  {
    label: 'same-code task policy feeds unique supplier SKU into explicit preparation',
    actual: duplicatePreparation.supplierSku,
    expected: 'SK3065-UNIQUE-02',
  },
];
for (const row of checks) row.pass = row.actual === row.expected;
console.log(JSON.stringify({ok: checks.every(row => row.pass), checks}, null, 2));
if (checks.some(row => !row.pass)) process.exit(1);
