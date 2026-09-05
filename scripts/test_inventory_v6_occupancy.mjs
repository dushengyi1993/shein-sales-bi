import assert from 'node:assert/strict';
import {
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION,
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  computeLegacyInventoryOverwriteQuantity,
  normalizeInventoryOccupancy,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

// 1. Computation version check
assert.equal(INVENTORY_OVERWRITE_COMPUTATION_VERSION, 'ordinary-plus-temporary/v2');
assert.equal(INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION, 'locked-only/v1');

// 2. buildDailyInventoryPlanHashPayload byte-compatibility with / without commandId
const basePlan = {
  schemaVersion: 'daily-inventory-plan/v1',
  date: '2026-09-05',
  policyVersion: '2026-09-05.1',
  actionable: [],
  lowEtAllocations: [],
  detailRefreshTargets: [],
  etFactSource: null,
  sourceEvidence: [],
};

const payloadWithoutCommandId = buildDailyInventoryPlanHashPayload(basePlan);
assert.equal('commandId' in payloadWithoutCommandId, false);

const payloadWithCommandId = buildDailyInventoryPlanHashPayload({
  ...basePlan,
  commandId: 'morning:2026-09-05',
});
assert.equal(payloadWithCommandId.commandId, 'morning:2026-09-05');
assert.notEqual(stableInventoryHash(payloadWithoutCommandId), stableInventoryHash(payloadWithCommandId));

// 3. Normalization & calculation tests: Real sample coverage
// Sample 1: 0 locks (Total = 10, usable = 10, locked = 0, temp = 0)
const zeroSample = {
  totalInventoryQuantity: 10,
  totalUsableInventory: 10,
  totalLockedQuantity: 0,
  totalTempLockQuantity: 0,
};
const normZero = normalizeInventoryOccupancy(zeroSample);
assert.deepEqual(normZero, {
  totalInventoryQuantity: 10,
  totalUsableInventory: 10,
  totalLockedQuantity: 0,
  temporaryInventoryQuantity: 0,
});
assert.equal(computeInventoryOverwriteQuantity(10, zeroSample), 10);
assert.equal(computeInventoryOverwriteQuantity(100, zeroSample), 100);

// Sample 2: Ordinary locks only (CX 100/99/1/0)
const cxSample = {
  totalInventoryQuantity: 100,
  totalUsableInventory: 99,
  totalLockedQuantity: 1,
  totalTempLockQuantity: 0,
};
const normCx = normalizeInventoryOccupancy(cxSample);
assert.deepEqual(normCx, {
  totalInventoryQuantity: 100,
  totalUsableInventory: 99,
  totalLockedQuantity: 1,
  temporaryInventoryQuantity: 0,
});
assert.equal(computeInventoryOverwriteQuantity(10, cxSample), 11);
assert.equal(computeInventoryOverwriteQuantity(100, cxSample), 101);

// Sample 3: Temporary locks only (DX 8/7/0/1)
const dxSample = {
  totalInventoryQuantity: 8,
  totalUsableInventory: 7,
  totalLockedQuantity: 0,
  totalTempLockQuantity: 1,
};
const normDx = normalizeInventoryOccupancy(dxSample);
assert.deepEqual(normDx, {
  totalInventoryQuantity: 8,
  totalUsableInventory: 7,
  totalLockedQuantity: 0,
  temporaryInventoryQuantity: 1,
});
assert.equal(computeInventoryOverwriteQuantity(10, dxSample), 11);

// Sample 4: Both ordinary and temporary locks (NM 10/8/0/2, plus synthesized ordinary 1 + temp 2)
const nmSample = {
  totalInventoryQuantity: 10,
  totalUsableInventory: 8,
  totalLockedQuantity: 0,
  totalTempLockQuantity: 2,
};
assert.equal(computeInventoryOverwriteQuantity(10, nmSample), 12);

const bothSample = {
  totalInventoryQuantity: 50,
  totalUsableInventory: 45,
  totalLockedQuantity: 3,
  temporaryInventoryQuantity: 2,
};
const normBoth = normalizeInventoryOccupancy(bothSample);
assert.deepEqual(normBoth, {
  totalInventoryQuantity: 50,
  totalUsableInventory: 45,
  totalLockedQuantity: 3,
  temporaryInventoryQuantity: 2,
});
assert.equal(computeInventoryOverwriteQuantity(10, bothSample), 15);

// Sample 5: Warehouse fields / aliases compatibility
const warehouseSample = {
  inventoryQuantity: 25,
  usableInventory: 20,
  lockedQuantity: 2,
  tempLockQuantity: 3,
};
const normWarehouse = normalizeInventoryOccupancy(warehouseSample);
assert.deepEqual(normWarehouse, {
  totalInventoryQuantity: 25,
  totalUsableInventory: 20,
  totalLockedQuantity: 2,
  temporaryInventoryQuantity: 3,
});
assert.equal(computeInventoryOverwriteQuantity(10, warehouseSample), 15);

// Sample 6: Occupancy change (same target, dynamic overwrite response)
const beforeOccChange = {
  totalInventoryQuantity: 10,
  totalUsableInventory: 9,
  totalLockedQuantity: 1,
  totalTempLockQuantity: 0,
};
const afterOccChange = {
  totalInventoryQuantity: 10,
  totalUsableInventory: 7,
  totalLockedQuantity: 1,
  totalTempLockQuantity: 2,
};
assert.equal(computeInventoryOverwriteQuantity(10, beforeOccChange), 11);
assert.equal(computeInventoryOverwriteQuantity(10, afterOccChange), 13);

// Sample 7: Missing fields must fail closed (do NOT default to 0)
assert.throws(() => {
  normalizeInventoryOccupancy({
    totalInventoryQuantity: 10,
    totalUsableInventory: 10,
    totalLockedQuantity: 0,
  });
}, /INVENTORY_RAW_FIELD_MISSING/);

assert.throws(() => {
  computeInventoryOverwriteQuantity(10, {
    totalInventoryQuantity: 10,
    totalUsableInventory: 10,
    totalTempLockQuantity: 0,
  });
}, /INVENTORY_RAW_FIELD_MISSING/);

// Sample 8: Field conservation mismatch must fail closed (total != usable + locked + temp)
assert.throws(() => {
  normalizeInventoryOccupancy({
    totalInventoryQuantity: 10,
    totalUsableInventory: 8,
    totalLockedQuantity: 1,
    totalTempLockQuantity: 0,
  });
}, /INVENTORY_CONSERVATION_MISMATCH/);

// Sample 9: Conflicting alias values must fail closed
assert.throws(() => {
  normalizeInventoryOccupancy({
    totalInventoryQuantity: 10,
    totalUsableInventory: 7,
    totalLockedQuantity: 1,
    totalTempLockQuantity: 2,
    tempLockQuantity: 1,
  });
}, /INVENTORY_RAW_FIELD_CONFLICT/);

// Sample 10: Null alias with valid alias does not conflict, but only-null fails closed
assert.deepEqual(normalizeInventoryOccupancy({
  totalInventoryQuantity: 10,
  totalUsableInventory: 8,
  totalLockedQuantity: 1,
  totalTempLockQuantity: 1,
  temporaryInventoryQuantity: null,
}), {
  totalInventoryQuantity: 10,
  totalUsableInventory: 8,
  totalLockedQuantity: 1,
  temporaryInventoryQuantity: 1,
});

assert.throws(() => {
  normalizeInventoryOccupancy({
    totalInventoryQuantity: 10,
    totalUsableInventory: 8,
    totalLockedQuantity: 1,
    totalTempLockQuantity: null,
    temporaryInventoryQuantity: null,
  });
}, /INVENTORY_RAW_FIELD_MISSING/);

// Sample 11: Boolean, array, whitespace string rejection
for (const badValue of [true, false, [], [0], ' ', '  ', '12a', '-1', 1.5, {}]) {
  assert.throws(() => {
    normalizeInventoryOccupancy({
      totalInventoryQuantity: 10,
      totalUsableInventory: 10,
      totalLockedQuantity: 0,
      totalTempLockQuantity: badValue,
    });
  }, /INVENTORY_RAW_FIELD_INVALID/);
}

// Sample 12: Backward compatibility with legacy locked-only version
const legacyRow = {
  totalLockedQuantity: 4,
};
assert.equal(
  computeInventoryOverwriteQuantity(10, legacyRow, INVENTORY_LEGACY_LOCKED_ONLY_COMPUTATION_VERSION),
  14
);

// Sample 13: Unknown computation version explicitly rejected
assert.throws(() => {
  computeInventoryOverwriteQuantity(10, zeroSample, 'unknown-version/v99');
}, /Unsupported inventory overwrite computation version: unknown-version\/v99/);

console.log('ALL_OCCUPANCY_TESTS_PASSED');
