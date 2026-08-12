#!/usr/bin/env node
/**
 * Deterministic tests for alias-aware canonical inventory identity comparison
 * (2026-08-12 YJ incident: OpenAPI supplierCode `SK-3065蒸汽熨烫机` vs links
 * standard_goods_sn `SK-GT-3065蒸汽熨烫机` must NOT be a canonical conflict).
 *
 * Pins: alias-equivalent evidence passes; genuinely different codes still fail
 * closed; stripped/unresolvable keys still fail closed (no relaxation); the
 * SPU/SKC/SKU gates in assertCurrentInventoryListingIdentity are unchanged.
 */
import assert from 'node:assert/strict';
import {
  assertCurrentInventoryListingIdentity,
  resolveInventoryIdentityKey,
} from '../lib/inventory_replenishment_policy.mjs';

const INCIDENT_SPU = 'v2606281958253718';
const INCIDENT_SKC = 'sv260628195825371800298';

// 1. explicit alias merge: SK-3065* resolves to the SK-GT-3065 canonical.
assert.equal(resolveInventoryIdentityKey('SK-3065蒸汽熨烫机'), 'SK-GT-3065蒸汽熨烫机');
assert.equal(resolveInventoryIdentityKey('SK-3065'), 'SK-GT-3065蒸汽熨烫机');
assert.equal(resolveInventoryIdentityKey('SK-GT-3065蒸汽熨烫机'), 'SK-GT-3065蒸汽熨烫机');
assert.equal(resolveInventoryIdentityKey(''), '');
assert.equal(resolveInventoryIdentityKey('报废'), '', 'ignored aliases must resolve to empty and fail closed');

// 2. incident pair: links standard_goods_sn (expected) vs live OpenAPI
// supplierCode (live) is alias-equivalent and must pass the identity guard.
assert.deepEqual(assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-3065蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC],
}), {matchKey: 'SK-GT-3065蒸汽熨烫机', skuCode: INCIDENT_SKC});

// 3. reversed argument order (OpenAPI side as expected) also passes.
assert.deepEqual(assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-GT-3065蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC],
}), {matchKey: 'SK-GT-3065蒸汽熨烫机', skuCode: INCIDENT_SKC});

// 4. a genuinely different model code still fails closed.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-09999其他产品',
  liveSkuCodes: [INCIDENT_SKC],
}), /canonical identity changed/);

// 5. a stripped, unresolvable key still fails closed: alias merge must never
// turn SKGT3065 into proof of identity.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SKGT3065',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-3065蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC],
}), /canonical identity changed/);

// 6. missing live supplier code fails closed.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: '',
  liveSkuCodes: [INCIDENT_SKC],
}), /canonical identity changed/);

// 7. SKU gates are unchanged: cardinality change still throws.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-3065蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC, 'sku-2'],
}), /cardinality changed/);

// 8. SKU gate unchanged: a different live SKU code still throws.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: 'sku-other',
  liveSupplierCode: 'SK-3065蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC],
}), /SKU mapping or cardinality changed/);

// 9. alias-aware comparison must not relax a real 3065-vs-11004 conflict.
assert.throws(() => assertCurrentInventoryListingIdentity({
  expectedMatchKey: 'SK-GT-3065蒸汽熨烫机',
  expectedSkuCode: INCIDENT_SKC,
  liveSupplierCode: 'SK-11004蒸汽熨烫机',
  liveSkuCodes: [INCIDENT_SKC],
}), /canonical identity changed/);

console.log(JSON.stringify({ok: true, tests: [
  'alias-merge-resolves-sk3065',
  'incident-pair-passes',
  'reversed-pair-passes',
  'real-different-code-conflicts',
  'stripped-key-fails-closed',
  'missing-live-code-fails-closed',
  'sku-cardinality-gate-unchanged',
  'sku-code-gate-unchanged',
  'different-model-conflicts',
]}, null, 2));
