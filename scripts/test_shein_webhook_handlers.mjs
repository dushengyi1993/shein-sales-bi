#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createSheinWebhookEventProcessor, humanizeSheinWebhookEvent} from '../lib/shein_webhook_handlers.mjs';

const gates = [];
const productStateCalls = [];
const currentGates = new Map();
const updates = [];
const productContextCalls = [];
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
}, getProductBusinessContext: async input => {
  productContextCalls.push(input);
  return {
    storeKey: input.storeKey,
    skc: input.skc,
    supplierCode: input.skc === 'SKC-DOWN' ? 'S1810电热水壶' : '测试货号',
    productName: input.skc === 'SKC-DOWN' ? 'S1810电热水壶' : '测试商品',
    variantName: input.skc === 'SKC-DOWN' ? '英规插(220-240V)' : '',
    firstShelfTime: '2026-04-27 15:07:18',
    sales: {units7d: 1, grossSales7dSar: 57.46, units30d: 13, grossSales30dSar: 746.53, unitsLifetime: 20, grossSalesLifetimeSar: 1153.91, lastSaleDate: '2026-07-16'},
  };
}, applyProductState: async input => {
  productStateCalls.push(input);
  return true;
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

const shelfOutcome = await processor.process({
  ...base,
  id: 20,
  severity: {severity: 'P0', notifyFeishu: true},
  normalized: {
    eventFamily: 'product_shelves', eventCode: '3000848', eventLabel: '商品上下架通知',
    storeKey: 'AA', skc: 'SKC-DOWN', businessId: 'SKC-DOWN', action: 'off_shelf',
    eventTime: '1784605591827', receivedAt: '2026-07-21T03:46:32.789Z',
    shelfChanges: [{site: 'shein-sa', shelfState: '0', firstShelfTime: '2026-04-27 15:07:18', recycleState: '1'}],
  },
  payload: {skcName: 'SKC-DOWN'},
});
assert.equal(shelfOutcome.title, 'AA 店：S1810电热水壶被下架');
assert.match(shelfOutcome.summary, /货号：S1810电热水壶/);
assert.match(shelfOutcome.summary, /上架时间：2026-04-27 15:07（已上架 85 天）/);
assert.match(shelfOutcome.summary, /近7天 1 件 \/ 57\.46 SAR/);
assert.match(shelfOutcome.summary, /近30天 13 件 \/ 746\.53 SAR/);
assert.match(shelfOutcome.summary, /累计 20 件 \/ 1,153\.91 SAR/);
assert.doesNotMatch(shelfOutcome.summary, /款式：|英规插/);
assert.doesNotMatch(shelfOutcome.summary, /下架人：/);
assert.doesNotMatch(shelfOutcome.summary, /下架原因：/);
assert.doesNotMatch(shelfOutcome.summary, /合并说明|\d+ 条站点变化/);
assert.doesNotMatch(shelfOutcome.summary, /回收站/);
assert.equal(shelfOutcome.normalized.productContextStatus, 'resolved');
assert.equal(shelfOutcome.normalized.productState.applied, true);
assert.ok(productContextCalls.some(call => call.skc === 'SKC-DOWN'));
assert.equal(productStateCalls.length, 1);
assert.deepEqual(productStateCalls[0], {
  receiptId: 20,
  storeKey: 'AA',
  skc: 'SKC-DOWN',
  eventFamily: 'product_shelves',
  action: 'off_shelf',
  status: undefined,
  sourceEventOrder: '1784605591827000',
  eventAt: '2026-07-21T03:46:31.827Z',
  productContext: {
    storeKey: 'AA',
    skc: 'SKC-DOWN',
    supplierCode: 'S1810电热水壶',
    productName: 'S1810电热水壶',
    variantName: '英规插(220-240V)',
    firstShelfTime: '2026-04-27 15:07:18',
    sales: {units7d: 1, grossSales7dSar: 57.46, units30d: 13, grossSales30dSar: 746.53, unitsLifetime: 20, grossSalesLifetimeSar: 1153.91, lastSaleDate: '2026-07-16'},
  },
});

const stateReadbackCalls = [];
const pendingProcessor = createSheinWebhookEventProcessor({
  webhookRepository: {
    ...webhookRepository,
    getProductBusinessContext: async () => null,
  },
  productAuditContextProvider: {
    getProductState: async input => {
      stateReadbackCalls.push(input);
      return {
        source: 'shein_product_search+shein_spu_info',
        storeKey: input.storeKey,
        skc: input.skc,
        spu: 'SPU-WAIT',
        supplierCode: 'SK-04031胶囊咖啡机',
        shelfStatusCode: '2',
        shelfStatusName: '待上架',
        action: 'wait_shelf',
      };
    },
  },
});
const pendingOutcome = await pendingProcessor.process({
  ...base,
  id: 201,
  severity: {severity: 'P3', notifyFeishu: false},
  normalized: {
    eventFamily: 'product_shelves', eventCode: '3000848', eventLabel: '商品上下架通知',
    storeKey: 'ZL', skc: 'sv260723145349087891523', businessId: 'sv260723145349087891523',
    action: 'not_on_shelf', eventTime: '1784887354445', receivedAt: '2026-07-24T10:02:35.755Z',
    shelfChanges: [{site: 'shein-sa', shelfState: '0', firstShelfTime: '', lastShelfTime: '', recycleState: '1'}],
  },
  payload: {},
});
assert.equal(pendingOutcome.title, 'ZL 店：SK-04031胶囊咖啡机上下架状态已更新');
assert.match(pendingOutcome.summary, /没有发现实际下架证据，无需告警/);
assert.doesNotMatch(pendingOutcome.summary, /1970|2018|回收站|被下架/);
assert.equal(pendingOutcome.normalized.productContextStatus, 'resolved');
assert.equal(pendingOutcome.normalized.productStateReadbackStatus, 'resolved');
assert.deepEqual(stateReadbackCalls, [{storeKey: 'ZL', skc: 'sv260723145349087891523'}]);
assert.equal(productStateCalls.length, 2, 'an exact pending-state readback must update the product list');
assert.deepEqual(productStateCalls[1], {
  receiptId: 201,
  storeKey: 'ZL',
  skc: 'sv260723145349087891523',
  eventFamily: 'product_shelves',
  action: 'wait_shelf',
  status: undefined,
  sourceEventOrder: '1784887354445000',
  eventAt: '2026-07-24T10:02:34.445Z',
  productContext: {
    supplierCode: 'SK-04031胶囊咖啡机',
    spu: 'SPU-WAIT',
  },
});

const rrpApproved = await pendingProcessor.process({
  ...base,
  id: 202,
  severity: {severity: 'P3', notifyFeishu: false},
  normalized: {
    eventFamily: 'rrp_review', eventCode: '3001792', eventLabel: '建议零售价审核状态更新',
    storeKey: 'ZL', skc: 'SKC-RRP', businessId: 'SKC-RRP',
    auditState: '2', status: '2', eventTime: '1784887355445', receivedAt: '2026-07-24T10:02:36.755Z',
  },
  payload: {},
});
assert.equal(rrpApproved.normalized.productStateReadbackStatus, 'resolved');
assert.equal(productStateCalls.length, 3, 'an approved RRP event must trigger exact product-state readback');
assert.equal(productStateCalls[2].eventFamily, 'rrp_review');
assert.equal(productStateCalls[2].action, 'wait_shelf');

const shelfCopyWithPlatformDetails = humanizeSheinWebhookEvent({
  eventFamily: 'product_shelves', storeKey: 'AA', skc: 'SKC-DOWN', action: 'off_shelf',
  eventTime: '1784605591827', shelfOperator: '运营甲', shelfReason: '重复商品',
}, {severity: 'P0'});
assert.match(shelfCopyWithPlatformDetails.summary, /下架人：运营甲/);
assert.match(shelfCopyWithPlatformDetails.summary, /下架原因：重复商品/);

const auditLookupCalls = [];
const auditProcessor = createSheinWebhookEventProcessor({
  webhookRepository,
  productAuditContextProvider: {
    getAuditContext: async input => {
      auditLookupCalls.push(input);
      return {
        skc: input.skc,
        supplierCode: '(全)KJ-102三明治机和早餐机',
        failureReason: input.auditFailureReason,
        appealCount: 4,
        merchantOffer: {min: 106, max: 106, currency: 'SAR'},
        platformSuggested: {min: 70.79, max: 70.79, currency: 'SAR'},
      };
    },
  },
});
const auditOutcome = await auditProcessor.process({
  ...base,
  id: 21,
  severity: {severity: 'P0', notifyFeishu: true},
  normalized: {
    eventFamily: 'product_audit', eventCode: '3001450', eventLabel: '审核',
    storeKey: 'TZ', skc: 'sv260714225651130014631', businessId: 'SPMPA4202607143661962',
    auditFailureReason: '议价失败:商家操作-不接受议价;拒绝议价',
  },
  payload: {},
});
assert.equal(auditOutcome.title, 'TZ 店：(全)KJ-102三明治机和早餐机审核未通过');
assert.match(auditOutcome.summary, /货号：\(全\)KJ-102三明治机和早餐机/);
assert.match(auditOutcome.summary, /链接：sv260714225651130014631/);
assert.match(auditOutcome.summary, /失败原因：议价失败：商家操作-不接受议价；拒绝议价/);
assert.match(auditOutcome.summary, /我方申报价：106\.00 SAR/);
assert.match(auditOutcome.summary, /平台建议价：70\.79 SAR/);
assert.match(auditOutcome.summary, /剩余议价次数：4/);
assert.doesNotMatch(auditOutcome.summary, /款式：|平台未提供/);
assert.equal(auditOutcome.normalized.auditContextStatus, 'resolved');
assert.equal(auditLookupCalls.length, 1);
assert.equal(auditLookupCalls[0].productId, '');
assert.equal(auditLookupCalls[0].version, '');

const unavailableAuditProcessor = createSheinWebhookEventProcessor({
  webhookRepository,
  productAuditContextProvider: {getAuditContext: async () => { throw new Error('temporary read failure'); }},
});
const unavailableAudit = await unavailableAuditProcessor.process({
  ...base,
  id: 22,
  severity: {severity: 'P0', notifyFeishu: true},
  normalized: {
    eventFamily: 'product_audit', storeKey: 'TZ', skc: 'SKC-FAIL',
    auditFailureReason: '资料审核失败：缺少电压',
  },
  payload: {},
});
assert.match(unavailableAudit.summary, /失败原因：资料审核失败：缺少电压/);
assert.equal(unavailableAudit.normalized.auditContextStatus, 'unavailable');

const logisticsCopy = humanizeSheinWebhookEvent({
  eventFamily: 'logistics_order',
  storeKey: 'TZ',
  placeRequestId: '2509033332639749',
  deliveryNo: 'GU2509025285251076',
  eventTime: '1756879655633',
}, {severity: 'P3'});
assert.equal(logisticsCopy.title, 'TZ 店：SHEIN 物流单已创建');
assert.match(logisticsCopy.summary, /下单编号：2509033332639749/);
assert.match(logisticsCopy.summary, /运单包裹号：GU2509025285251076/);
assert.doesNotMatch(logisticsCopy.summary, /状态已更新|3001461|P3/);

const rrpRejected = humanizeSheinWebhookEvent({
  eventFamily: 'rrp_review',
  storeKey: 'TZ',
  skc: 'sc260414201529947197009',
  auditState: '3',
  status: '3',
  eventTime: '2026-06-02 21:46:25',
  productContext: {supplierCode: 'SK-999食品料理机', productName: 'SK-999食品料理机'},
}, {severity: 'P1'});
assert.equal(rrpRejected.title, 'TZ 店：SK-999食品料理机建议零售价审核未通过');
assert.match(rrpRejected.summary, /货号：SK-999食品料理机/);
assert.match(rrpRejected.summary, /审核结果：审核未通过/);
assert.match(rrpRejected.summary, /修正建议零售价资料后重新提交/);

const rrpExpiring = humanizeSheinWebhookEvent({
  eventFamily: 'rrp_validity',
  storeKey: 'TZ',
  skc: 'sc260414201529947197009',
  status: 'EXPIRING_SOON',
  rrpEndEffectiveDate: '2026-07-27 23:59:59',
  productContext: {supplierCode: 'SK-999食品料理机'},
}, {severity: 'P1'});
assert.equal(rrpExpiring.title, 'TZ 店：SK-999食品料理机建议零售价即将到期');
assert.match(rrpExpiring.summary, /有效期至：2026-07-27 23:59/);
assert.match(rrpExpiring.summary, /7 天内到期/);

const productResult = await processor.process({...base, normalized: {eventFamily: 'product_audit', eventCode: '3001450', eventLabel: '审核', storeKey: 'AA', productId: 'SPU-1', skc: 'SKC-1', businessId: 'DOC-1'}, payload: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: '7'}});
assert.equal(productResult.actionState, 'task_readback_attached');
assert.equal(updates.length, 1);
assert.equal(updates[0][2].expectedRevision, 3);
task.lifecycle = {webhookReadbacks: [{receiptId: 1}]};
const replayedProduct = await processor.process({...base, normalized: {eventFamily: 'product_audit', eventCode: '3001450', eventLabel: '审核', storeKey: 'AA', productId: 'SPU-1', skc: 'SKC-1', businessId: 'DOC-1'}, payload: {spuName: 'SPU-1', skcName: 'SKC-1', documentSn: 'DOC-1', version: '7'}});
assert.equal(replayedProduct.replayed, true);
assert.equal(updates.length, 1, 'receipt replay must not produce a second task revision');
const singleSkcDelete = await processor.process({
  ...base,
  id: 99,
  idempotencyKey: 'b'.repeat(64),
  severity: {severity: 'P0', notifyFeishu: true},
  normalized: {
    eventFamily: 'product_delete_audit',
    eventCode: '3001903',
    storeKey: 'AA',
    skc: 'SKC-1',
    businessId: 'SKC-1',
    status: '2',
  },
  payload: {},
});
assert.equal(singleSkcDelete.actionState, 'task_readback_attached', 'store + exact SKC may attach when the task match is unique');
assert.equal(updates.length, 2);

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
