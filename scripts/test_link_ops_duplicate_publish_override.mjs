#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT,
  evaluateAdditionalDuplicatePublishOverride,
  normalizeAdditionalDuplicatePublishOverrideInput,
} from '../lib/link_ops_duplicate_publish_override.mjs';

const input = normalizeAdditionalDuplicatePublishOverrideInput({
  store: 'nm',
  existingSkcs: ['SV260714225544971215796', 'invalid', 'sv260714225544971215796'],
  reason: '旧链接议价成功并保留，本任务明确额外新增一条。',
  confirmation: ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT,
});
assert.deepEqual(input.existingSkcs, ['sv260714225544971215796']);
assert.equal(input.store, 'NM');

const task = {
  allowDuplicateNewPublish: true,
  duplicatePublishOverride: {
    ...input,
    approvedAt: '2026-07-23T09:00:00.000Z',
    approvedBy: {username: 'owner'},
  },
};
const exact = evaluateAdditionalDuplicatePublishOverride(task, 'NM', [{skcName: 'sv260714225544971215796'}]);
assert.equal(exact.allowed, true);
assert.equal(exact.status, 'authorized_exact_live_duplicate_set');

const stringOwner = evaluateAdditionalDuplicatePublishOverride({
  ...task,
  duplicatePublishOverride: {...task.duplicatePublishOverride, approvedBy: 'owner'},
}, 'NM', [{skcName: 'sv260714225544971215796'}]);
assert.equal(stringOwner.allowed, true);

const newUnexpectedDuplicate = evaluateAdditionalDuplicatePublishOverride(task, 'NM', [
  {skcName: 'sv260714225544971215796'},
  {skcName: 'sv260723000000000000001'},
]);
assert.equal(newUnexpectedDuplicate.allowed, false);
assert.equal(newUnexpectedDuplicate.status, 'authorization_mismatch');

const wrongStore = evaluateAdditionalDuplicatePublishOverride(task, 'HL', [{skcName: 'sv260714225544971215796'}]);
assert.equal(wrongStore.allowed, false);

const missingOwner = evaluateAdditionalDuplicatePublishOverride({
  ...task,
  duplicatePublishOverride: {...task.duplicatePublishOverride, approvedBy: {}},
}, 'NM', [{skcName: 'sv260714225544971215796'}]);
assert.equal(missingOwner.allowed, false);

console.log('link_ops_duplicate_publish_override: exact task/store/SKC authorization passed');
