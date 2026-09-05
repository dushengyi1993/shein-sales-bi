#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT,
  evaluateAdditionalDuplicatePublishOverride,
  normalizeAdditionalDuplicatePublishOverrideInput,
} from '../lib/link_ops_duplicate_publish_override.mjs';
import {isSheinSkc, normalizeSheinSkc, sameSheinSkc} from '../lib/shein_product_identifiers.mjs';

assert.equal(normalizeSheinSkc('SH260607203410692590516'), 'sh260607203410692590516');
assert.equal(isSheinSkc('sh260607203410692590516'), true);
assert.equal(sameSheinSkc('SH260607203410692590516', 'sh260607203410692590516'), true);
for (const invalid of ['sr260607203410692590516', 's123', 'sa1', 's9', 'sh', 'sh1', 'SH123', 'sh1234567']) {
  assert.equal(isSheinSkc(invalid), false, `invalid SKC accepted: ${invalid}`);
  assert.equal(normalizeSheinSkc(invalid), '', `invalid SKC normalized: ${invalid}`);
}

// 1. Backward-compatible normalization with existing fields + new requestId/businessIntent
const input = normalizeAdditionalDuplicatePublishOverrideInput({
  store: 'nm',
  existingSkcs: ['SV260714225544971215796', 'SB260806202334303501938', 'SH260607203410692590516', 'invalid', 'sv260714225544971215796', 'sb260806202334303501938', 'sh260607203410692590516'],
  reason: '再上一次',
  confirmation: 'CONFIRM',
  requestId: 'req-dup-001',
});
assert.deepEqual(input.existingSkcs, ['sv260714225544971215796', 'sb260806202334303501938', 'sh260607203410692590516']);
assert.equal(input.store, 'NM');
assert.equal(input.requestId, 'req-dup-001');

const task = {
  allowDuplicateNewPublish: true,
  duplicatePublishOverride: {
    ...input,
    approvedAt: '2026-07-23T09:00:00.000Z',
    approvedBy: {username: 'owner'},
  },
};

// 2. Exact match passes
const exact = evaluateAdditionalDuplicatePublishOverride(task, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'SB260806202334303501938'},
  {skcName: 'SH260607203410692590516'},
]);
assert.equal(exact.allowed, true);
assert.equal(exact.status, 'authorized_exact_live_duplicate_set');

const stringOwner = evaluateAdditionalDuplicatePublishOverride({
  ...task,
  duplicatePublishOverride: {...task.duplicatePublishOverride, approvedBy: 'owner'},
}, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sb260806202334303501938'},
  {skcName: 'sh260607203410692590516'},
]);
assert.equal(stringOwner.allowed, true);

// 3. A2: Drifted existing links set does NOT invalidate authorization
const driftedSh = evaluateAdditionalDuplicatePublishOverride(task, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sb260806202334303501938'},
  {skcName: 'sh260607203410692590517'},
]);
assert.equal(driftedSh.allowed, true, 'Drifted SKC set must not invalidate user business authorization');
assert.equal(driftedSh.status, 'authorized_additional_link');

// 4. A2: Another task adding a duplicate link does NOT invalidate authorization
const newUnexpectedDuplicate = evaluateAdditionalDuplicatePublishOverride(task, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sb260806202334303501938'},
  {skcName: 'sh260607203410692590516'},
  {skcName: 'sv260723000000000000001'},
]);
assert.equal(newUnexpectedDuplicate.allowed, true, 'New duplicate link from other tasks must not revoke authorization');
assert.equal(newUnexpectedDuplicate.status, 'authorized_additional_link');

// 5. Wrong store fails closed
const wrongStore = evaluateAdditionalDuplicatePublishOverride(task, 'HL', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sb260806202334303501938'},
  {skcName: 'sh260607203410692590516'},
]);
assert.equal(wrongStore.allowed, false);
assert.equal(wrongStore.status, 'store_mismatch');

// 6. Missing owner / unapproved fails closed
const missingOwner = evaluateAdditionalDuplicatePublishOverride({
  ...task,
  duplicatePublishOverride: {...task.duplicatePublishOverride, approvedBy: {}},
}, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sb260806202334303501938'},
  {skcName: 'sh260607203410692590516'},
]);
assert.equal(missingOwner.allowed, false);

console.log('link_ops_duplicate_publish_override: exact task/store/SKC authorization passed');
