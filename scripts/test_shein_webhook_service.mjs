#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createSheinWebhookService, createWebhookPgScriptExecutor, resolveIncomingWebhookEventCode, webhookAlertIdempotencyKey, webhookSeverityCode} from './serve_shein_webhook.mjs';

assert.equal(webhookSeverityCode({severity: 'P0'}), 'P0');
assert.equal(webhookSeverityCode({severity: {severity: 'P0', notifyFeishu: true}}), 'P0');
assert.equal(webhookSeverityCode({severity: {severity: 'P3'}}), 'P3');
assert.equal(resolveIncomingWebhookEventCode('product_document_receive_status_notice'), '3000910');
assert.equal(resolveIncomingWebhookEventCode('/product_document_receive_status_notice'), '3000910');
assert.equal(resolveIncomingWebhookEventCode('3000910'), '3000910');
assert.equal(resolveIncomingWebhookEventCode('unknown_event'), '');
const authorizationAlert = {eventCode: '3001503', storeKey: 'AA', receivedAt: '2026-07-19T00:01:00.000Z', normalized: {eventFamily: 'authorization', status: '1', businessId: 'supplier-1'}};
assert.equal(webhookAlertIdempotencyKey(authorizationAlert), webhookAlertIdempotencyKey({...authorizationAlert, idempotencyKey: 'different', receivedAt: '2026-07-19T00:09:59.000Z'}), 're-signed authorization retries in one time bucket must not spam Feishu');
assert.notEqual(webhookAlertIdempotencyKey(authorizationAlert), webhookAlertIdempotencyKey({...authorizationAlert, receivedAt: '2026-07-19T00:11:00.000Z'}), 'a later authorization occurrence may alert again');

const secret = 'app-secret-key';
const callbackPath = '/api/shein/webhook/v1/events';
function encrypt(payload) {
  const key = Buffer.alloc(16); Buffer.from(secret).copy(key);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('space-station-default-iv').subarray(0, 16));
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
}
function signature(timestamp, randomKey = 'abc12') {
  const canonical = `app-1&${timestamp}&${callbackPath}`;
  const hex = crypto.createHmac('sha256', `${secret}${randomKey}`).update(canonical).digest('hex');
  return `${randomKey}${Buffer.from(hex).toString('base64')}`;
}

const stored = [];
const repository = {storeReceipt: async input => (stored.push(input), {receipt: {id: stored.length}, duplicate: stored.length > 1})};
const registry = {resolve: headers => {
  if (headers['x-lt-appid'] !== 'app-1' || headers['x-lt-openkeyid'] !== 'open-1') throw new Error('Unknown webhook app id');
  return {appId: 'app-1', appSecretKey: secret, openKeyId: 'open-1', storeKey: 'AA'};
}};
const service = createSheinWebhookService({repository, credentialRegistry: registry, workerEnabled: false, callbackPath, now: () => 1_700_000_000_000, logger: {warn() {}, error() {}}});
const address = await service.start({host: '127.0.0.1', port: 0});
const timestamp = '1700000000000';
const eventData = encrypt({orderNo: 'O-1', changeTime: '2026-07-19 12:00:00'});
const headers = {'content-type': 'application/json', 'x-lt-appid': 'app-1', 'x-lt-openkeyid': 'open-1', 'x-lt-eventcode': 'order_push_notice', 'x-lt-timestamp': timestamp, 'x-lt-signature': signature(timestamp)};
const url = `http://127.0.0.1:${address.port}${callbackPath}`;
const ok = await fetch(url, {method: 'POST', headers, body: JSON.stringify({eventData})});
assert.equal(ok.status, 200);
assert.equal((await ok.json()).ok, true);
assert.equal(stored.length, 1);
assert.equal(stored[0].storeKey, 'AA');
assert.equal(stored[0].eventCode, '3001442');
assert.equal(stored[0].normalized.orderId, 'O-1');
assert.equal(stored[0].severity, 'P3');
assert.equal('appSecretKey' in stored[0], false);
assert.equal(stored[0].eventData, eventData);
assert.equal('decryptedPayload' in stored[0], false, 'ingress must persist ciphertext, never plaintext');
assert.ok(stored[0].statementTimeoutMs <= 800, 'receipt insert must carry a bounded PostgreSQL statement timeout');

const bad = await fetch(url, {method: 'POST', headers: {...headers, 'x-lt-signature': 'wrong'}, body: JSON.stringify({eventData})});
assert.equal(bad.status, 401);
assert.equal(stored.length, 1);
const query = await fetch(`${url}?bad=1`, {method: 'POST', headers, body: JSON.stringify({eventData})});
assert.equal(query.status, 404);
const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
assert.equal((await health.json()).service, 'shein-webhook');
await service.stop();

const deadlineRepository = {storeReceipt: async () => new Promise(() => {})};
const deadlineService = createSheinWebhookService({
  repository: deadlineRepository,
  credentialRegistry: registry,
  workerEnabled: false,
  callbackPath,
  ingressBudgetMs: 250,
  now: () => 1_700_000_000_000,
  logger: {warn() {}, error() {}},
});
const deadlineAddress = await deadlineService.start({host: '127.0.0.1', port: 0});
const deadlineStartedAt = Date.now();
const deadlineResponse = await fetch(`http://127.0.0.1:${deadlineAddress.port}${callbackPath}`, {method: 'POST', headers, body: JSON.stringify({eventData})});
const deadlineElapsed = Date.now() - deadlineStartedAt;
assert.equal(deadlineResponse.status, 503);
assert.ok(deadlineElapsed < 1_000, `deadline response took ${deadlineElapsed}ms`);
await deadlineService.stop();

const pgCalls = [];
const pgExecutor = createWebhookPgScriptExecutor({pool: {query: async sql => (pgCalls.push(sql), {rows: [{result: '{"headers":1}'}]})}});
const pgResult = await pgExecutor({}, 'SELECT 1');
assert.equal(pgCalls[0], 'SELECT 1');
assert.match(pgResult.stdout, /\{"headers":1\}/);

const rollbackCalls = [];
const failingPgExecutor = createWebhookPgScriptExecutor({pool: {query: async sql => {
  rollbackCalls.push(sql);
  if (sql !== 'ROLLBACK') throw new Error('targeted SQL failed');
  return {rows: []};
}}});
await assert.rejects(() => failingPgExecutor({}, 'BEGIN; SELECT broken; COMMIT;'), /targeted SQL failed/);
assert.deepEqual(rollbackCalls, ['BEGIN; SELECT broken; COMMIT;', 'ROLLBACK']);

const workerCalls = [];
let claim = {
  id: '9', idempotencyKey: 'c'.repeat(64), eventCode: '3001503', storeKey: 'AA', attempt: 1,
  appId: 'app-1', openKeyId: 'open-1', eventData: encrypt({type: 6}),
  cipherHash: crypto.createHash('sha256').update(encrypt({type: 6}), 'utf8').digest('hex'),
  severity: 'P0', alertedAt: null, receivedAt: '2026-07-19T00:00:00.000Z',
  normalized: {eventCode: '3001503', eventFamily: 'authorization', eventLabel: '授权关系变更', storeKey: 'AA', severityReason: 'authorization_exception'},
};
const workerRepository = {
  storeReceipt: async () => ({receipt: {}, duplicate: false}),
  claimNext: async input => (workerCalls.push(['claim', input]), claim),
  renew: async () => {},
  markAlerted: async (id, input) => workerCalls.push(['alerted', id, input]),
  markProcessed: async (id, input) => workerCalls.push(['processed', id, input]),
  release: async (id, input) => workerCalls.push(['released', id, input]),
};
const worker = createSheinWebhookService({
  repository: workerRepository,
  credentialRegistry: registry,
  eventProcessor: {process: async receipt => (workerCalls.push(['gate-processed', receipt.id]), {title: 'AA 授权异常', summary: '请处理', businessKey: receipt.normalized.businessId || '', actionState: 'authorization_gate_blocked'})},
  notifier: {notify: async input => workerCalls.push(['notify', input.receipt.id, input.outcome])},
  workerEnabled: false,
  workerId: 'worker-test',
  logger: {warn() {}, error() {}},
});
await worker.processOne();
assert.equal(workerCalls.find(row => row[0] === 'notify')?.[1], '9');
assert.equal(workerCalls.find(row => row[0] === 'notify')?.[2]?.title, 'AA 店：店铺授权需要处理');
assert.match(workerCalls.find(row => row[0] === 'notify')?.[2]?.summary || '', /系统已暂停该店的自动操作/);
assert.doesNotMatch(JSON.stringify(workerCalls.find(row => row[0] === 'notify')?.[2] || {}), /P0|3001503|authorization_exception|状态/);
assert.equal(workerCalls.find(row => row[0] === 'alerted')?.[2]?.workerId, 'worker-test');
assert.equal(workerCalls.find(row => row[0] === 'processed')?.[2]?.workerId, 'worker-test');
assert.ok(workerCalls.findIndex(row => row[0] === 'gate-processed') < workerCalls.findIndex(row => row[0] === 'notify'), 'risk gate must close before Feishu notification starts');

const appScopedCalls = [];
const appScopedWorker = createSheinWebhookService({
  repository: {
    ...workerRepository,
    claimNext: async () => ({
      ...claim,
      id: '90',
      attempt: 1,
      severity: 'P3',
      alertedAt: null,
      normalized: {appScopedOnly: true, deliveryScope: 'subscription_validation'},
    }),
    markProcessed: async (id, input) => appScopedCalls.push(['processed', id, input]),
  },
  credentialRegistry: registry,
  eventProcessor: {process: async receipt => {
    appScopedCalls.push(['process', receipt]);
    return {title: 'AA Webhook 应用级验证', summary: 'no-op', businessKey: '', actionState: 'app_scoped_event_recorded'};
  }},
  notifier: {notify: async () => appScopedCalls.push(['notify'])},
  workerEnabled: false,
  workerId: 'worker-test',
  logger: {warn() {}, error() {}},
});
await appScopedWorker.processOne();
const scopedWorkItem = appScopedCalls.find(row => row[0] === 'process')?.[1];
assert.equal(scopedWorkItem?.normalized?.appScopedOnly, true, 'worker must preserve the persisted app-only quarantine marker');
assert.equal(scopedWorkItem?.normalized?.deliveryScope, 'subscription_validation');
assert.equal(scopedWorkItem?.severity?.severity, 'P3');
assert.equal(appScopedCalls.some(row => row[0] === 'notify'), false, 'quarantined validation deliveries must never alert');
assert.equal(appScopedCalls.find(row => row[0] === 'processed')?.[2]?.normalized?.appScopedOnly, true);

claim = {...claim, id: '10', severity: 'P3', attempt: 2};
const failingWorker = createSheinWebhookService({
  repository: workerRepository,
  credentialRegistry: registry,
  eventProcessor: {process: async () => { throw new Error('transient'); }},
  workerEnabled: false,
  workerId: 'worker-test',
  logger: {warn() {}, error() {}},
});
await failingWorker.processOne();
const released = workerCalls.find(row => row[0] === 'released' && row[1] === '10');
assert.equal(released?.[2]?.workerId, 'worker-test');
assert.equal(released?.[2]?.status, 'retry');

claim = {...claim, id: '11', severity: 'P0', alertedAt: null, attempt: 1};
let processedDespiteNotifierFailure = false;
const failingNotifierWorker = createSheinWebhookService({
  repository: workerRepository,
  credentialRegistry: registry,
  eventProcessor: {process: async () => {
    processedDespiteNotifierFailure = true;
    return {title: 'AA 授权异常', summary: '闸门已关闭', businessKey: '', actionState: 'authorization_gate_blocked'};
  }},
  notifier: {notify: async () => { throw new Error('lark unavailable'); }},
  workerEnabled: false,
  workerId: 'worker-test',
  logger: {warn() {}, error() {}},
});
await failingNotifierWorker.processOne();
assert.equal(processedDespiteNotifierFailure, true, 'P0 business gate must still run when Feishu is unavailable');
assert.equal(workerCalls.find(row => row[0] === 'released' && row[1] === '11')?.[2]?.status, 'retry');

console.log('shein_webhook_service: durable ingress, leased completion, P0 alert and retry passed');
