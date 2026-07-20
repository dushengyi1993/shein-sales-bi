#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createSheinWebhookEventProcessor, humanizeSheinWebhookEvent} from '../lib/shein_webhook_handlers.mjs';

const gates = [];
const currentGates = new Map();
const updates = [];
const webhookRepository = {upsertStoreGate: async gate => {
  const key = `${gate.storeKey}:${gate.gateType}`;
  const current = currentGates.get(key);
  const incomingOrdered = gate.sourceEventOrder !== null && gate.sourceEventOrder !== undefined;
  const currentOrdered = current?.sourceEventOrder !== null && current?.sourceEventOrder !== undefined;
  const applied = !current
    || (!incomingOrdered && gate.state === 'blocked')
    || (incomingOrdered && !currentOrdered && (gate.gateType !== 'quota' || gate.state === 'blocked' || current.state !== 'blocked'))
    || (incomingOrdered && currentOrdered && (BigInt(gate.sourceEventOrder) > BigInt(current.sourceEventOrder)
      || (BigInt(gate.sourceEventOrder) === BigInt(current.sourceEventOrder) && Number(gate.sourceReceiptId) >= Number(current.sourceReceiptId))))
    || (!incomingOrdered && !currentOrdered && gate.gateType !== 'quota' && Number(gate.sourceReceiptId) >= Number(current.sourceReceiptId));
  const result = applied ? {...gate, applied} : {...current, applied: false};
  if (applied) currentGates.set(key, {...gate});
  gates.push({...gate, applied});
  return result;
}};
const task = {
  id: 'task-1', repositoryRevision: 3, ownerUser: 'owner',
  targets: {writeStores: ['AA']},
  execution: {result: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: '7'}},
};
const linkOpsRepository = {
  getTaskStore: async () => ({tasks: [task]}),
  updateTask: async (...args) => updates.push(args),
};
const syncCalls = [];
const processor = createSheinWebhookEventProcessor({
  webhookRepository,
  linkOpsRepository,
  orderReturnSync: {
    syncOrder: async input => (syncCalls.push(['order', input]), {ok: true}),
    syncReturn: async input => (syncCalls.push(['return', input]), {ok: true}),
  },
});

const base = {id: 1, idempotencyKey: 'a'.repeat(64), severity: {severity: 'P3', notifyFeishu: false}};
const appScoped = await processor.process({...base, normalized: {appScopedOnly: true, eventFamily: 'authorization', eventCode: '3001503', eventLabel: '授权', storeKey: 'AA'}, payload: {type: 6}});
assert.equal(appScoped.actionState, 'app_scoped_event_recorded');
assert.equal(gates.length, 0, 'an app-only validation delivery must not change store gates');
assert.equal(syncCalls.length, 0, 'an app-only validation delivery must not sync orders or returns');
const orderOutcome = await processor.process({...base, normalized: {eventFamily: 'order', eventCode: '3001442', eventLabel: '订单', storeKey: 'AA', orderId: 'O-1', businessId: 'O-1', status: '4'}, payload: {orderNo: 'O-1'}});
assert.equal(orderOutcome.actionState, 'order_warehouse_synced');
assert.equal(orderOutcome.title, 'AA 店：订单已同步');
assert.equal(orderOutcome.summary, '订单 O-1 已同步到 BI，无需人工处理。');
assert.doesNotMatch(`${orderOutcome.title}\n${orderOutcome.summary}`, /P3|3001442|状态 4|normal_or_non_alerting_event|order_warehouse_synced/);
assert.equal((await processor.process({...base, normalized: {eventFamily: 'return', eventCode: '3000914', eventLabel: '退货', storeKey: 'AA', returnId: 'R-1', businessId: 'R-1'}, payload: {returnOrderNo: 'R-1'}})).actionState, 'return_warehouse_synced');
assert.deepEqual(syncCalls, [
  ['order', {storeKey: 'AA', orderNo: 'O-1'}],
  ['return', {storeKey: 'AA', returnOrderNo: 'R-1'}],
]);

const authorizationCopy = humanizeSheinWebhookEvent(
  {eventFamily: 'authorization', storeKey: 'AA', businessId: 'internal-1', status: '6'},
  {severity: 'P0', reason: 'authorization_exception'},
);
assert.equal(authorizationCopy.title, 'AA 店：店铺授权需要处理');
assert.match(authorizationCopy.summary, /系统已暂停该店的自动操作/);
assert.match(authorizationCopy.summary, /请重新检查并恢复授权/);
assert.doesNotMatch(`${authorizationCopy.title}\n${authorizationCopy.summary}`, /P0|status|状态 6|authorization_exception|OpenAPI/);

const productResult = await processor.process({...base, normalized: {eventFamily: 'product_audit', eventCode: '3001450', eventLabel: '审核', storeKey: 'AA', productId: 'SPU-1', skc: 'SKC-1', businessId: 'DOC-1'}, payload: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: '7'}});
assert.equal(productResult.actionState, 'task_readback_attached');
assert.equal(updates.length, 1);
assert.equal(updates[0][2].expectedRevision, 3);
task.lifecycle = {webhookReadbacks: [{receiptId: 1}]};
const replayedProduct = await processor.process({...base, normalized: {eventFamily: 'product_audit', eventCode: '3001450', eventLabel: '审核', storeKey: 'AA', productId: 'SPU-1', skc: 'SKC-1', businessId: 'DOC-1'}, payload: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: '7'}});
assert.equal(replayedProduct.replayed, true);
assert.equal(updates.length, 1, 'receipt replay must not produce a second task revision');

await processor.process({...base, id: 2, normalized: {eventFamily: 'authorization', eventCode: '3001503', eventLabel: '授权', storeKey: 'AA'}, payload: {type: 6}});
await processor.process({...base, id: 3, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 0, eventTime: '1700000000000'}, payload: {quota: 0}});
await processor.process({...base, id: 4, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 12, eventTime: '1700000001000'}, payload: {quota: 12}});
await processor.process({...base, id: 5, normalized: {eventFamily: 'compliance', eventCode: '3001104', eventLabel: '合规', storeKey: 'AA'}, payload: {required: false}});
assert.deepEqual(gates.map(g => [g.gateType, g.state]), [['authorization', 'blocked'], ['quota', 'blocked'], ['quota', 'open']]);

const newestZero = await processor.process({...base, id: 10, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 0, eventTime: '1700000003000'}, payload: {quota: 0}});
const stalePositive = await processor.process({...base, id: 11, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 12, eventTime: '1700000002000'}, payload: {quota: 12}});
assert.equal(newestZero.actionState, 'quota_gate_blocked');
assert.equal(stalePositive.actionState, 'quota_gate_stale_ignored');
assert.equal(currentGates.get('AA:quota').state, 'blocked', 'a later-delivered but older positive quota event must not reopen a newer zero gate');
const unorderedZero = await processor.process({...base, id: 12, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 0, eventTime: ''}, payload: {quota: 0}});
const uncertainPositive = await processor.process({...base, id: 13, normalized: {eventFamily: 'quota', eventCode: '3001061', eventLabel: '额度', storeKey: 'AA', quota: 12, eventTime: '1700000004000'}, payload: {quota: 12}});
assert.equal(unorderedZero.actionState, 'quota_gate_blocked', 'missing event order must still close a zero-quota gate');
assert.equal(uncertainPositive.actionState, 'quota_gate_stale_ignored', 'an ordered positive event cannot automatically clear an unordered zero-quota risk');
assert.equal(currentGates.get('AA:quota').state, 'blocked');

console.log('shein_webhook_handlers: product, order/return and risk gates passed');
