#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createSheinWebhookAuditContextProvider,
  normalizeDiscussAuditContext,
  shouldLookupProductAuditContext,
} from '../lib/shein_webhook_audit_context.mjs';

assert.equal(shouldLookupProductAuditContext('议价失败：商家拒绝议价'), true);
assert.equal(shouldLookupProductAuditContext('商品图片模糊'), false);

const row = {
  discussSn: 'YJ-1',
  discussStatus: 4,
  skcName: 'SKC-1',
  supplierCode: '(全)KJ-102三明治机和早餐机',
  appealCount: 4,
  reason: '商家操作-不接受议价',
  appealReason: '拒绝议价',
  skuCostPrices: [{
    skuCode: 'SKU-1',
    costPriceHistories: [
      {serialNumber: 0, costPrice: 99, currency: 'SAR'},
      {serialNumber: 2, costPrice: 106, currency: 'SAR'},
      {serialNumber: 1, costPrice: 103, currency: 'SAR'},
    ],
    suggestCostPrice: 70.79,
    suggestCostCurrency: 'SAR',
  }],
};
const normalized = normalizeDiscussAuditContext(row, {auditFailureReason: '议价失败:商家操作-不接受议价;拒绝议价'});
assert.deepEqual(normalized.merchantOffer, {min: 106, max: 106, currency: 'SAR'});
assert.deepEqual(normalized.platformSuggested, {min: 70.79, max: 70.79, currency: 'SAR'});
assert.equal(normalized.failureReason, '议价失败:商家操作-不接受议价;拒绝议价');
assert.equal(normalizeDiscussAuditContext({...row, appealCount: null}).appealCount, null);

const calls = [];
const provider = await createSheinWebhookAuditContextProvider({
  config: {
    apiBaseUrls: {prodSemiManaged: 'https://fake.shein.test'},
    stores: [{storeKey: 'TZ', openKeyId: 'OPEN-TZ', secretKey: 'SECRET-TZ'}],
  },
  fetchImpl: async (url, init) => {
    calls.push({url, init});
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({code: '0', info: {records: [row]}}),
    };
  },
});
const context = await provider.getAuditContext({
  storeKey: 'tz',
  skc: 'SKC-1',
  auditFailureReason: '议价失败：拒绝议价',
});
assert.equal(context.supplierCode, '(全)KJ-102三明治机和早餐机');
assert.equal(context.merchantOffer.min, 106);
assert.equal(context.platformSuggested.min, 70.79);
assert.equal(calls.length, 1);
assert.match(calls[0].url, /query-discuss-list$/);
assert.equal(calls[0].init.headers.language, 'CN');
assert.equal(JSON.parse(calls[0].init.body).pageSize, 200);
assert.doesNotMatch(JSON.stringify(context), /OPEN-TZ|SECRET-TZ/);

const ignored = await provider.getAuditContext({storeKey: 'TZ', skc: 'SKC-1', auditFailureReason: '图片不清晰'});
assert.equal(ignored.failureReason, '图片不清晰');
assert.equal(ignored.supplierCode, '(全)KJ-102三明治机和早餐机');
assert.equal(calls.length, 2, 'non-negotiation audit failures may resolve the product but must not query stale negotiation prices');
assert.match(calls[1].url, /searchProduct$/);

const missingReasonCalls = [];
const missingReasonProvider = await createSheinWebhookAuditContextProvider({
  config: {
    apiBaseUrls: {prodSemiManaged: 'https://fake.shein.test'},
    stores: [{storeKey: 'YJ', openKeyId: 'OPEN-YJ', secretKey: 'SECRET-YJ'}],
  },
  fetchImpl: async (url, init) => {
    missingReasonCalls.push({url, body: JSON.parse(init.body)});
    if (url.endsWith('/open-api/goods/query-document-state')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify({code: '0', info: {data: [{spuName: 'v2607142256072445', version: 'SPMP260714338220723', skcList: [{skcName: 'sv260714225607244563190', documentSn: 'SPMPA4202607143661488', documentState: 3, failedReason: [{language: 'zh-cn', content: '议价失败:商家操作-不接受议价;拒绝议价'}]}]}]}}),
      };
    }
    if (url.endsWith('/open-api/goods/discuss/query-discuss-list')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        text: async () => JSON.stringify({code: '0', info: {records: [{...row, skcName: 'sv260714225607244563190', supplierCode: '(全)KJ-102三明治机和早餐机', skuCostPrices: [{skuCode: 'SKU-1', costPriceHistories: [{serialNumber: 0, costPrice: 104, currency: 'SAR'}], suggestCostPrice: 70.79, suggestCostCurrency: 'SAR'}]}]}}),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  },
});
const missingReasonContext = await missingReasonProvider.getAuditContext({
  storeKey: 'YJ',
  skc: 'sv260714225607244563190',
  productId: 'v2607142256072445',
  version: 'SPMP260714338220723',
  documentId: 'SPMPA4202607143661488',
});
assert.equal(missingReasonContext.failureReason, '议价失败:商家操作-不接受议价;拒绝议价');
assert.equal(missingReasonContext.supplierCode, '(全)KJ-102三明治机和早餐机');
assert.deepEqual(missingReasonContext.merchantOffer, {min: 104, max: 104, currency: 'SAR'});
assert.deepEqual(missingReasonContext.platformSuggested, {min: 70.79, max: 70.79, currency: 'SAR'});
assert.equal(missingReasonContext.documentId, 'SPMPA4202607143661488');
assert.equal(missingReasonCalls.length, 2, 'missing callback reason must resolve document state before negotiation prices');
assert.match(missingReasonCalls[0].url, /query-document-state$/);
assert.match(missingReasonCalls[1].url, /query-discuss-list$/);

console.log('shein_webhook_audit_context: safe negotiation context passed');
