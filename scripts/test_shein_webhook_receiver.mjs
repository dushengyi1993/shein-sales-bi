#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  DEFAULT_WEBHOOK_SIGNATURE_STRATEGY,
  classifyWebhookSeverity,
  computeWebhookIdempotencyKey,
  createHmacSha256SignatureStrategy,
  decryptWebhookEventData,
  extractWebhookEventData,
  normalizeWebhookBusinessEvent,
  normalizeWebhookHeaders,
  projectWebhookEventForFrontend,
  SUPPORTED_WEBHOOK_EVENTS,
  unpackWebhookPayload,
  verifyWebhookSignature,
} from '../lib/shein_webhook_receiver.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}\n${error.stack}`); process.exitCode = 1; }
}
function throws(fn, pattern) { assert.throws(fn, pattern); }
function encrypt(payload, secret) {
  const key = Buffer.alloc(16); Buffer.from(secret).copy(key);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('space-station-default-iv').subarray(0, 16));
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
}
function headers(timestamp = '1700000000000') {
  return {'X-LT-OpenKeyId': 'open-1', 'x-lt-eventCode': '3001450', 'x-lt-appid': 'app-1', 'x-lt-timestamp': timestamp, 'x-lt-signature': 'placeholder'};
}
function officialSignature({appSecret, openKey, timestamp, requestPath, randomKey = 'r4nd0'}) {
  const signString = `${openKey}&${timestamp}&${requestPath}`;
  const hex = crypto.createHmac('sha256', `${appSecret}${randomKey}`).update(signString, 'utf8').digest('hex');
  return `${randomKey}${Buffer.from(hex, 'utf8').toString('base64')}`;
}
const canonical = ({headers: h, eventData}) => `${h['x-lt-appid']}|${h['x-lt-openkeyid']}|${h['x-lt-eventcode']}|${h['x-lt-timestamp']}|${eventData}`;
const hmac = createHmacSha256SignatureStrategy();

test('normalizes plain, array, and Headers input', () => {
  assert.deepEqual(normalizeWebhookHeaders({'X-LT-AppId': 'a', 'x-lt-openKeyId': ['one', 'two']}), {'x-lt-appid': 'a', 'x-lt-openkeyid': 'one, two'});
  assert.equal(normalizeWebhookHeaders(new Headers({'X-Test': 'yes'}))['x-test'], 'yes');
});
test('extracts eventData from multipart, JSON, and urlencoded bodies', () => {
  const boundary = 'AaB03x';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="eventData"\r\n\r\nabc+/=\r\n--${boundary}--\r\n`;
  assert.equal(extractWebhookEventData({contentType: `multipart/form-data; boundary=${boundary}`, rawBody: body}), 'abc+/=');
  assert.equal(extractWebhookEventData({contentType: 'application/json; charset=utf-8', rawBody: '{"eventData":"json"}'}), 'json');
  assert.equal(extractWebhookEventData({contentType: 'application/x-www-form-urlencoded', rawBody: 'eventData=url%2Bdata'}), 'url+data');
});
test('rejects unknown, oversized, duplicate, and malformed eventData bodies', () => {
  throws(() => extractWebhookEventData({contentType: 'text/plain', rawBody: 'x'}), /unsupported/);
  throws(() => extractWebhookEventData({contentType: 'application/json', rawBody: '{"eventData":"x"}', maxBodyBytes: 2}), /exceeds/);
  throws(() => extractWebhookEventData({contentType: 'application/x-www-form-urlencoded', rawBody: 'eventData=a&eventData=b'}), /exactly once/);
  throws(() => extractWebhookEventData({contentType: 'multipart/form-data', rawBody: 'broken'}), /boundary/);
});
test('accepts a valid injected HMAC strategy and rejects invalid signatures', () => {
  const eventData = 'ciphertext'; const h = headers();
  h['x-lt-signature'] = crypto.createHmac('sha256', 'app-secret').update(canonical({headers: normalizeWebhookHeaders(h), eventData})).digest('hex');
  const verified = verifyWebhookSignature({headers: h, eventData, appSecretKey: 'app-secret', requestPath: '/test', nowMs: 1700000000001, canonical, signatureStrategy: hmac});
  assert.equal(verified.ok, true); assert.equal(verified.reason, 'verified');
  assert.equal(verifyWebhookSignature({headers: {...h, 'x-lt-signature': 'bad'}, eventData, appSecretKey: 'app-secret', requestPath: '/test', nowMs: 1700000000001, canonical, signatureStrategy: hmac}).reason, 'signature_mismatch');
});
test('verifies the official signature formula, appid precedence, fallback, and path rejection', () => {
  const h = headers();
  h['x-lt-signature'] = officialSignature({appSecret: 'app-secret', openKey: 'app-1', timestamp: h['x-lt-timestamp'], requestPath: '/product_document_audit_status_notice'});
  assert.equal(verifyWebhookSignature({headers: h, eventData: 'cipher', appSecretKey: 'app-secret', requestPath: '/product_document_audit_status_notice', nowMs: 1700000000001}).ok, true);
  const fallback = headers(); delete fallback['x-lt-appid'];
  fallback['x-lt-signature'] = officialSignature({appSecret: 'app-secret', openKey: 'open-1', timestamp: fallback['x-lt-timestamp'], requestPath: '/callback'});
  assert.equal(verifyWebhookSignature({headers: fallback, eventData: 'cipher', appSecretKey: 'app-secret', requestPath: '/callback', nowMs: 1700000000001}).ok, true);
  assert.equal(verifyWebhookSignature({headers: h, eventData: 'cipher', appSecretKey: 'app-secret', requestPath: '/callback?bad=1', nowMs: 1700000000001}).reason, 'canonicalization_failed');
});
test('rejects invalid default signatures and expired timestamps', () => {
  assert.equal(verifyWebhookSignature({headers: headers(), eventData: 'cipher', appSecretKey: 'x', requestPath: '/callback', nowMs: 1700000000000, signatureStrategy: DEFAULT_WEBHOOK_SIGNATURE_STRATEGY}).reason, 'signature_mismatch');
  assert.equal(verifyWebhookSignature({headers: headers('1699990000000'), eventData: 'cipher', appSecretKey: 'x', requestPath: '/callback', nowMs: 1700000000000, canonical, signatureStrategy: hmac}).reason, 'timestamp_outside_allowed_skew');
});
test('AES decrypts eventData and rejects invalid ciphertext', () => {
  const encrypted = encrypt({spuName: 'SPU-1', status: 'PASS'}, 'app-secret-key');
  assert.deepEqual(decryptWebhookEventData(encrypted, 'app-secret-key'), {spuName: 'SPU-1', status: 'PASS'});
  throws(() => decryptWebhookEventData('not base64!', 'app-secret-key'), /base64/);
});
test('restricted embedded data unpacking accepts official wrappers and rejects limit bypasses', () => {
  assert.deepEqual(unpackWebhookPayload({data: '{"availableLimit":2}'}).data, {availableLimit: 2});
  assert.deepEqual(unpackWebhookPayload('{"skc":"SKC-1"}'), {skc: 'SKC-1'});
  throws(() => unpackWebhookPayload({data: '{"data":"{\\"data\\":\\"{}\\"}"}'}, {maxDepth: 1}), /exceeds 1 levels/);
  throws(() => unpackWebhookPayload({data: `{"x":"${'x'.repeat(20)}"}`}, {maxBytes: 10}), /exceeds 10 bytes/);
  throws(() => unpackWebhookPayload({data: '{"data":"{}"}'}, {maxObjects: 1}), /exceeds 1 objects/);
});
test('idempotency key ignores delivery timestamp and ciphertext but retains business state and time', () => {
  const h = headers();
  const payload = {document_sn: 'DOC-1', audit_state: 2, audit_time: '2026-07-19 10:00:00'};
  const one = computeWebhookIdempotencyKey({headers: h, eventCode: '3001450', eventData: 'cipher-one', payload});
  const two = computeWebhookIdempotencyKey({headers: {...h, 'x-lt-timestamp': '1700000009999'}, eventCode: '3001450', eventData: 'cipher-two', payload: {audit_time: '2026-07-19 10:00:00', audit_state: 2, document_sn: 'DOC-1'}});
  assert.equal(one, two);
  assert.notEqual(one, computeWebhookIdempotencyKey({headers: h, eventCode: '3001450', payload: {...payload, audit_state: 3}}));
  assert.notEqual(one, computeWebhookIdempotencyKey({headers: h, eventCode: '3001450', payload: {...payload, audit_time: '2026-07-19 10:01:00'}}));
});
test('authorization events without intrinsic event time use signed delivery timestamp as occurrence', () => {
  const h = headers();
  const payload = {status: '1', type: '1', supplierId: '22043644'};
  const first = computeWebhookIdempotencyKey({headers: h, eventCode: '3001503', payload});
  const sameDelivery = computeWebhookIdempotencyKey({headers: {...h}, eventCode: '3001503', payload: {...payload}});
  const laterOccurrence = computeWebhookIdempotencyKey({headers: {...h, 'x-lt-timestamp': '1700000009999'}, eventCode: '3001503', payload});
  assert.equal(first, sameDelivery, 'an exact authorization retry must remain idempotent');
  assert.notEqual(first, laterOccurrence, 'a later identical authorization transition must be queued again');
});
const officialFixtures = Object.freeze({
  '3000910': {severity: 'P3', fields: {productId: 's23121872106', documentId: 'SPMPA320231218041879', skc: 'ss2312187210636233', sku: 'I41y8oidji5y', receivedSuccess: 'true', version: 'SPMP231218173254739'}},
  '3001450': {severity: 'P3', fields: {documentId: 'SPMPA420231215003106', auditState: '2', version: 'SPMP231215009184753', eventTime: '2023-12-18 11:46:43'}},
  '3001449': {severity: 'P3', fields: {documentId: 'SPMPA420231215003106', auditState: '2', version: 'SPMP231215009184753', eventTime: '2023-12-18 11:46:43'}},
  '3000848': {severity: 'P3', fields: {skc: 'swdress23210526603', status: '0', action: 'not_on_shelf', eventTime: '1735564506057', shelfStates: ['0'], shelfChanges: [{site: 'shein-il', shelfState: '0', firstShelfTime: '', lastShelfTime: '', recycleState: '1'}]}},
  '3001903': {severity: 'P0', fields: {skc: 'sd260625185879185501303', status: '3', eventTime: '2026-06-30 14:20:53'}},
  '3001442': {severity: 'P3', fields: {orderId: 'GSHND026A000YW2', status: '1', eventTime: '1706769529786'}},
  '3000914': {severity: 'P3', fields: {returnId: 'ND67E08VAR', eventTime: '1706771656710'}},
  '3001503': {severity: 'P0', fields: {status: '1', authType: '1', supplierId: '22043644'}},
  '3001061': {severity: 'P0', fields: {availableLimit: 0, supplierId: '5511473', eventTime: '2593111773260075'}},
  '3001104': {severity: 'P0', fields: {skc: 'sr25050899111321041', complianceTypeId: 3, complianceRequired: '1', complianceMissing: '1', eventTime: '2025-05-08 11:23:08'}},
  '3001461': {severity: 'P3', fields: {deliveryNo: 'GU2509025285251076', placeRequestId: '2509033332639749', businessId: '2509033332639749', eventTime: '1756879655633'}},
  '3001792': {severity: 'P3', fields: {skc: 'sc260414201529947197009', auditState: '2', status: '2', eventTime: '2026-06-02 21:46:25'}},
  '3001793': {severity: 'P3', fields: {skc: 'sc260414201529947197009', rrpEndEffectiveDate: '9999-12-31 23:59:59', status: 'ACTIVE'}},
});
test('normalizes all thirteen subscribed official fixtures with P0/P1/P3 policy', () => {
  for (const [eventCode, expected] of Object.entries(officialFixtures)) {
    const fixture = JSON.parse(readFileSync(new URL(`./fixtures/shein_webhook_official/${eventCode}.json`, import.meta.url), 'utf8'));
    const normalized = normalizeWebhookBusinessEvent({eventCode, payload: fixture, receivedAt: '2026-07-24T00:00:00.000Z'});
    assert.equal(classifyWebhookSeverity({normalizedEvent: normalized}).severity, expected.severity, eventCode);
    for (const [field, value] of Object.entries(expected.fields)) assert.deepEqual(normalized[field], value, `${eventCode}.${field}`);
  }
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000804', payload: {status: 'abnormal'}})}).severity, 'P1');
});
test('normalizes first-batch product receipt/audits/shelves/delete audit and P0 cases', () => {
  const receipt = normalizeWebhookBusinessEvent({eventCode: '3000910', payload: {spuName: 'SPU-1', status: 'RECEIVED'}});
  assert.equal(receipt.eventFamily, 'product_receive');
  const audit = normalizeWebhookBusinessEvent({eventCode: '3001450', payload: {spuName: 'SPU-1', auditStatus: 'REJECTED'}});
  assert.equal(classifyWebhookSeverity({normalizedEvent: audit}).severity, 'P0');
  const allChannels = normalizeWebhookBusinessEvent({eventCode: '3001449', payload: {spuName: 'SPU-1', auditStatus: 'PASS'}});
  assert.equal(allChannels.eventFamily, 'product_audit_all_channels');
  const shelves = normalizeWebhookBusinessEvent({eventCode: '3000848', payload: {spuName: 'SPU-1', operationType: 'OFF_SHELF'}});
  assert.equal(classifyWebhookSeverity({normalizedEvent: shelves}).reason, 'unexpected_product_removal');
  const neverShelved = normalizeWebhookBusinessEvent({eventCode: '3000848', payload: {
    skcName: 'SKC-PENDING',
    shelfChangeInfos: [{siteChangeInfos: [{
      site: 'shein-sa', shelfState: 0,
      firstShelfTime: '1970-01-01 08:00:01',
      lastShelfTime: '2018-08-28 00:00:00',
      recycleState: 1,
    }]}],
  }});
  assert.equal(neverShelved.action, 'not_on_shelf');
  assert.equal(classifyWebhookSeverity({normalizedEvent: neverShelved}).severity, 'P3');
  assert.equal(classifyWebhookSeverity({normalizedEvent: neverShelved}).notifyFeishu, false);
  assert.equal(classifyWebhookSeverity({normalizedEvent: neverShelved}).reason, 'not_on_shelf_without_prior_live_evidence');
  assert.equal(neverShelved.shelfChanges[0].firstShelfTime, '');
  assert.equal(neverShelved.shelfChanges[0].lastShelfTime, '');
  const knownLiveBefore = {
    ...neverShelved,
    productContext: {
      firstShelfTime: '2026-06-11 13:35:00',
      lastKnownShelfStatus: '已上架',
      sales: {unitsLifetime: 2},
    },
  };
  assert.equal(classifyWebhookSeverity({normalizedEvent: knownLiveBefore}).severity, 'P0');
  assert.equal(classifyWebhookSeverity({normalizedEvent: knownLiveBefore}).reason, 'unexpected_product_removal');
  const detailedShelf = normalizeWebhookBusinessEvent({eventCode: '3000848', payload: {
    skcName: 'SKC-1', updateTime: 1784605591827, offShelfReason: '重复商品', operatorName: '运营甲',
    shelfChangeInfos: [{siteChangeInfos: [{site: 'shein-sa', shelfState: 0, firstShelfTime: '2026-04-27 15:07:18', lastShelfTime: '2026-04-27 15:07:18', recycleState: 1}]}],
  }});
  assert.equal(detailedShelf.shelfReason, '重复商品');
  assert.equal(detailedShelf.shelfOperator, '运营甲');
  assert.deepEqual(detailedShelf.shelfChanges, [{site: 'shein-sa', shelfState: '0', firstShelfTime: '2026-04-27 15:07:18', lastShelfTime: '2026-04-27 15:07:18', recycleState: '1'}]);
  const deleteAudit = normalizeWebhookBusinessEvent({eventCode: '3001450', payload: {documentType: 'DELETE', auditStatus: 'REJECTED'}});
  assert.equal(deleteAudit.action, 'delete_audit');
});
test('normalizes order, return, authorization, quota, and compliance classification', () => {
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001442', payload: {orderNo: 'O-1', status: 'PAID'}})}).notifyFeishu, false);
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000914', payload: {returnOrderNo: 'R-1', status: 'OPEN'}})}).notifyFeishu, false);
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001503', payload: {authorizationStatus: 'REVOKED'}})}).severity, 'P0');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001061', payload: {quota: 0}})}).severity, 'P0');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001104', payload: {complianceStatus: 'EXPIRED'}})}).severity, 'P0');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001104', payload: {isRequired: 0, isMiss: 1}})}).severity, 'P3');
  const inactiveCompliance = normalizeWebhookBusinessEvent({
    eventCode: '3001104',
    payload: {skc: 'SW-OLD', complianceTypeId: 3, isRequired: 1, isMiss: 1},
  });
  const inactiveClassification = classifyWebhookSeverity({normalizedEvent: {
    ...inactiveCompliance,
    productContextStatus: 'not_found',
    productIdentityStatus: 'not_found',
  }});
  assert.equal(inactiveClassification.severity, 'P1');
  assert.equal(inactiveClassification.notifyFeishu, false);
  assert.equal(inactiveClassification.reason, 'required_compliance_for_inactive_product');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001903', payload: {skc_name: 'SKC-DELETE', status: 2}})}).reason, 'unexpected_product_removal');
});
test('keeps routine platform flow quiet while surfacing business-impacting changes', () => {
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000910', payload: {receivedSuccess: true}})}).severity, 'P3');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000910', payload: {receivedSuccess: false}})}).severity, 'P1');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000912', payload: {status: 'APPROVED'}})}).severity, 'P3');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000912', payload: {status: 'REJECTED'}})}).severity, 'P1');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001792', payload: {status: 'APPROVED'}})}).severity, 'P3');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001792', payload: {status: 'REJECTED'}})}).severity, 'P1');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001793', payload: {status: 'ACTIVE'}})}).severity, 'P3');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3001793', payload: {status: 'EXPIRED'}})}).severity, 'P1');
  assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({
    eventCode: '3001793',
    payload: {skc_name: 'SKC-RRP', end_effective_date: '2026-07-27 23:59:59'},
    receivedAt: '2026-07-24T00:00:00.000Z',
  })}).severity, 'P1');
  assert.equal(normalizeWebhookBusinessEvent({
    eventCode: '3001793',
    payload: {skc_name: 'SKC-RRP', end_effective_date: '2026-07-23 23:59:59'},
    receivedAt: '2026-07-24T00:00:00.000Z',
  }).status, 'EXPIRED');
  for (const eventCode of ['3001435', '3001441', '3001744', '3001801']) {
    assert.equal(classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode, payload: {status: 'UPDATED'}})}).severity, 'P1', eventCode);
  }
});
test('every supported official event can be normalized and classified', () => {
  assert.equal(SUPPORTED_WEBHOOK_EVENTS.length, 23);
  const successfulSeverity = {
    product_audit: 'P3', product_receive: 'P3', product_audit_all_channels: 'P3', product_shelves: 'P3', quota: 'P3',
    price_abnormal: 'P1', price_audit: 'P3', rrp_review: 'P3', rrp_validity: 'P3', compliance: 'P3',
    inventory_warning: 'P1', out_of_stock: 'P1', order: 'P3', return: 'P3', invoice: 'P3', logistics_order: 'P3',
    purchase_order: 'P1', delivery: 'P1', purchase_return_application: 'P1', logistics_forecast: 'P3', purchase_return: 'P1',
    authorization: 'P0', product_delete_audit: 'P3',
  };
  for (const event of SUPPORTED_WEBHOOK_EVENTS) {
    const normalized = normalizeWebhookBusinessEvent({eventCode: event.eventCode, eventPath: event.eventPath, payload: {status: 'SUCCESS'}});
    assert.equal(normalized.eventFamily, event.family, event.eventCode);
    assert.equal(classifyWebhookSeverity({normalizedEvent: normalized}).severity, successfulSeverity[event.family], event.eventCode);
  }
});
test('normalizes official snake_case payload fields and keeps P1 out of Feishu', () => {
  const audit = normalizeWebhookBusinessEvent({eventCode: '3001903', payload: {skc_name: 'SKC-1', status: '3', document_sn: 'DOC-1'}});
  assert.equal(audit.eventFamily, 'product_delete_audit');
  assert.equal(audit.skc, 'SKC-1');
  assert.equal(audit.documentId, 'DOC-1');
  assert.equal(classifyWebhookSeverity({normalizedEvent: audit}).severity, 'P0');
  const price = classifyWebhookSeverity({normalizedEvent: normalizeWebhookBusinessEvent({eventCode: '3000804', payload: {status: 'abnormal'}})});
  assert.equal(price.severity, 'P1');
  assert.equal(price.notifyFeishu, false);
});
test('frontend projection does not expose raw payload or sensitive fields', () => {
  const normalized = normalizeWebhookBusinessEvent({eventCode: '3001442', payload: {orderNo: 'O-1', secretKey: 'nope', buyerPhone: '13800000000', address: 'hidden'}});
  const view = projectWebhookEventForFrontend({normalizedEvent: normalized, rawPayload: {secretKey: 'nope'}});
  const serialized = JSON.stringify(view).toLowerCase();
  assert.equal(serialized.includes('secret'), false); assert.equal(serialized.includes('phone'), false); assert.equal(serialized.includes('hidden'), false);
  assert.equal(view.orderId, 'O-1');
  const logisticsView = projectWebhookEventForFrontend(normalizeWebhookBusinessEvent({
    eventCode: '3001461',
    payload: {deliveryNo: 'D-1', placeRequestId: 'P-1', changeTime: 1756879655633},
  }));
  assert.equal(logisticsView.deliveryNo, 'D-1');
  assert.equal(logisticsView.placeRequestId, 'P-1');
});
test('prefers the Chinese product audit failure reason and exposes only the safe text', () => {
  const normalized = normalizeWebhookBusinessEvent({
    eventCode: '3001450',
    payload: {
      skc_name: 'SKC-AUDIT-1',
      audit_state: 3,
      failed_reason: [
        {language: 'US', content: 'Negotiation failed'},
        {language: 'CN', content: '议价失败:商家操作-不接受议价;拒绝议价'},
      ],
    },
  });
  assert.equal(normalized.auditFailureReason, '议价失败:商家操作-不接受议价;拒绝议价');
  const view = projectWebhookEventForFrontend(normalized);
  assert.equal(view.auditFailureReason, normalized.auditFailureReason);
  assert.doesNotMatch(JSON.stringify(view), /Negotiation failed/);
});

if (!process.exitCode) console.log(`\n${passed} tests passed`);
