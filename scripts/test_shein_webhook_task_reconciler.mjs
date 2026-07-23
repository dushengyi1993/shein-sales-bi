#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createSheinWebhookTaskReconciler} from '../lib/shein_webhook_task_reconciler.mjs';

const receipt = {
  id: '41',
  normalized: {
    eventFamily: 'product_audit',
    eventCode: '3001450',
    storeKey: 'TZ',
    productId: 'SPU-1',
    skc: 'SKC-1',
    documentId: 'DOC-1',
    version: 'V-1',
    businessId: 'DOC-1',
    status: '2',
  },
};
const marked = [];
const webhookRepository = {
  listTaskReconciliationReceipts: async () => [receipt],
  getTaskReconciliationReceipt: async id => String(id) === receipt.id ? receipt : null,
  markTaskReconciliation: async (id, outcome) => (marked.push([String(id), outcome]), true),
};
const task = {
  id: 'task-1',
  repositoryRevision: 7,
  ownerUser: 'owner',
  targets: {writeStores: ['TZ']},
  execution: {result: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: 'V-1'}},
};
const updates = [];
const linkOpsRepository = {
  getTaskStore: async () => ({tasks: [task]}),
  updateTask: async (...args) => {
    updates.push(args);
    return {...args[1], repositoryRevision: 8};
  },
};

const reconciler = createSheinWebhookTaskReconciler({
  webhookRepository,
  linkOpsRepository,
  pollMs: 60_000,
});
assert.deepEqual(await reconciler.runBatch(), {processed: 1, failed: 0});
assert.equal(updates.length, 1);
assert.equal(updates[0][0], 'task-1');
assert.equal(updates[0][2].idempotencyKey, 'shein-webhook:41');
assert.equal(updates[0][1].lifecycle.webhookReadbacks[0].receiptId, '41');
assert.deepEqual(marked, [['41', {actionState: 'task_readback_attached', taskId: 'task-1'}]]);

console.log('shein_webhook_task_reconciler: privileged normalized-receipt task readback passed');
