#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createSheinWebhookRepository} from '../lib/shein_webhook_repository.mjs';

const baseRow = {
  id: 41, idempotency_key: 'a'.repeat(64), app_id: 'private-app', open_key_id: 'private-open-key',
  event_code: '3001503', store_key: 'JSH', platform_timestamp: '2026-07-19T00:00:00.000Z',
  cipher_hash: 'b'.repeat(64), event_data: 'encrypted-event-data',
  normalized: {eventFamily: 'authorization'}, severity: 'P0', status: 'queued', lease_owner: '',
  lease_expires_at: null, attempt: 0, error: {}, next_attempt_at: null,
  received_at: '2026-07-19T01:00:00.000Z', processed_at: null, alerted_at: null,
  title: '授权异常', summary: '授权已失效', business_key: 'auth-1', action_state: '', duplicate_count: 0,
};

class FakePool {
  constructor() { this.queries = []; this.calls = Object.create(null); }
  async connect() { return {query: this.query.bind(this), release() {}}; }
  async end() { this.closed = true; }
  async query(request, suppliedValues) {
    const text = typeof request === 'string' ? request : request.text;
    const values = typeof request === 'string' ? (suppliedValues || []) : (request.values || []);
    const preparedName = typeof request === 'object' ? (request.name || '') : '';
    const marker = text.match(/shein_webhook:([a-z_]+)/)?.[1] || '';
    const key = preparedName || (marker ? `shein-webhook-${marker.replaceAll('_', '-')}` : '');
    this.queries.push({text, values, name: key, preparedName});
    const maxParameter = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
    assert.equal(values.length, maxParameter, `bound value count must match SQL parameters for ${key || text.slice(0, 80)}`);
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SET TRANSACTION')) return {rows: []};
    this.calls[key] = (this.calls[key] || 0) + 1;
    if (key === 'shein-webhook-store-receipt') {
      return {rows: [{...baseRow, duplicate_count: this.calls[key] - 1, duplicate: this.calls[key] > 1}]};
    }
    if (key === 'shein-webhook-claim-next') return {rows: [{...baseRow, status: 'running', lease_owner: values[0], attempt: 1}]};
    if (key === 'shein-webhook-mark-alerted') return {rows: [{...baseRow, status: 'running', lease_owner: values[3], alerted_at: baseRow.received_at}]};
    if (key === 'shein-webhook-mark-processed') return {rows: [{...baseRow, status: values[1], processed_at: baseRow.received_at}]};
    if (key === 'shein-webhook-list-events') {
      return {rows: [
        {...baseRow, event_type: 'authorization', duplicate: false},
        {...baseRow, id: 40, store_key: 'DL', received_at: '2026-07-19T00:00:00.000Z', event_type: 'quota', duplicate: true},
      ]};
    }
    if (key === 'shein-webhook-get-product-business-context') return {rows: [{context: {storeKey: values[0], skc: values[1], supplierCode: 'S1810电热水壶'}}]};
    if (key === 'shein-webhook-list-store-gates') return {rows: [{store_key: 'JSH', gate_type: 'authorization', state: 'blocked', reason: 'expired', source_receipt_id: 41, source_event_order: null, updated_at: '2026-07-19T01:00:00.000Z'}]};
    if (key === 'shein-webhook-upsert-store-gate') return {rows: [{store_key: values[0], gate_type: values[1], state: values[2], reason: values[3], source_receipt_id: values[4], source_event_order: values[5], updated_at: '2026-07-19T01:01:00.000Z', applied: true}]};
    if (key === 'shein-webhook-reopen-authorization-gate') return {rows: [{store_key: values[0], gate_type: 'authorization', state: 'open', reason: values[2], source_receipt_id: values[1], source_event_order: null, updated_at: '2026-07-19T01:02:00.000Z', applied: true}]};
    if (key === 'shein-webhook-summary-totals') return {rows: [{last_24h: '2', pending: '1', failed: '0', p0: '1', last_received_at: baseRow.received_at}]};
    if (key === 'shein-webhook-summary-by-type') return {rows: [{event_type: 'authorization', total: '2'}]};
    if (key === 'shein-webhook-summary-by-store') return {rows: [{store_key: 'JSH', total: '2'}]};
    return {rows: []};
  }
}

function latest(pool, name) { return [...pool.queries].reverse().find(query => query.name === name); }

const pool = new FakePool();
const repo = createSheinWebhookRepository({pool});

const input = {
  idempotencyKey: 'a'.repeat(64), appId: 'private-app', openKeyId: 'private-open-key', eventCode: '3001503', storeKey: 'JSH',
  platformTimestamp: '2026-07-19T00:00:00Z', cipherHash: 'b'.repeat(64),
  eventData: 'encrypted-event-data',
  normalized: {eventFamily: 'authorization'}, severity: 'P0', title: '授权异常', summary: '授权已失效', businessKey: 'auth-1',
};

const first = await repo.storeReceipt(input);
const second = await repo.storeReceipt(input);
assert.equal(first.duplicate, false, 'initial receipt must enqueue once');
assert.equal(second.duplicate, true, 'same idempotency key must be marked duplicate');
const insert = latest(pool, 'shein-webhook-store-receipt');
assert.match(insert.text, /ON CONFLICT \(idempotency_key\) DO UPDATE/);
assert.match(insert.text, /status, title/);
assert.ok(pool.queries.some(query => query.text === 'BEGIN') && pool.queries.some(query => query.text === 'COMMIT'), 'receipt and queue state must commit atomically');

const claimed = await repo.claimNext({workerId: 'worker-a', leaseMs: 30_000});
assert.equal(claimed.eventData, 'encrypted-event-data', 'only a claimed worker receives encrypted event data');
assert.equal('decryptedPayload' in claimed, false, 'plaintext payload must never be stored or returned');
const claim = latest(pool, 'shein-webhook-claim-next');
assert.match(claim.text, /FOR UPDATE SKIP LOCKED/);
assert.match(claim.text, /lease_expires_at/);
assert.deepEqual(claim.values, ['worker-a', 30_000]);

await repo.markAlerted(claimed.id, {workerId: 'worker-a', actionState: 'alerted'});
assert.match(latest(pool, 'shein-webhook-mark-alerted').text, /status='running' AND lease_owner=\$4/, 'alert completion must own the active lease');
await repo.markProcessed(claimed.id, {workerId: 'worker-a', status: 'succeeded'});
assert.match(latest(pool, 'shein-webhook-mark-processed').text, /status='running' AND lease_owner=\$11/, 'stale workers must not finalize a reclaimed receipt');
await assert.rejects(() => repo.markProcessed(claimed.id, {status: 'succeeded'}), /workerId is required/);

const events = await repo.listEvents({allowedStores: ['JSH'], limit: 1});
assert.equal(events.rows.length, 1);
assert.ok(events.nextCursor, 'limit + 1 response must yield a cursor');
assert.deepEqual(Object.keys(events.rows[0]).sort(), ['actionState', 'businessKey', 'duplicate', 'eventCode', 'eventType', 'id', 'processedAt', 'receivedAt', 'severity', 'status', 'storeKey', 'summary', 'title'].sort());
const list = latest(pool, 'shein-webhook-list-events');
assert.equal(list.preparedName, '', 'dynamic event-list SQL must not reuse a fixed prepared-statement name');
assert.match(list.text, /store_key = ANY\(\$1::text\[\]\)/, 'allowed stores must be SQL constrained');
assert.equal(list.values[0][0], 'JSH');
assert.doesNotMatch(list.text, /decrypted_payload|cipher_hash|app_id|open_key_id/, 'frontend projection must exclude secrets and payload');
assert.match(list.text, /appScopedOnly/, 'business timeline must hide technical validation deliveries by default');
assert.match(list.text, /severity IN \('P0','P1','P2'\)/, 'business timeline must show only operator-relevant severity levels by default');
assert.match(list.text, /status IN \('failed','retry','dead_letter'\)/, 'business timeline must still surface processing failures regardless of business severity');
assert.doesNotMatch(list.text, /order_warehouse_synced/, 'routine order-sync success must not need a one-off special case in the operator timeline');
assert.match(list.text, /row_number\(\) OVER \(PARTITION BY[\s\S]*product_shelves/, 'per-site shelf callbacks must collapse to one business incident');
assert.match(list.text, /concat_ws\('\|'[\s\S]*COALESCE\(business_key,''\)/, 'incident grouping must include the SKC/business key so distinct links can never collapse together');
assert.match(list.text, /ops\.get_shein_webhook_product_context/, 'historical shelf incidents must receive safe business context at read time');
assert.doesNotMatch(list.text, /SELECT \*/, 'safe-projection CTE must not request ciphertext or identity columns through SELECT *');
await repo.listEvents({allowedStores: ['JSH'], limit: 1, includeTechnical: true});
assert.doesNotMatch(latest(pool, 'shein-webhook-list-events').text, /appScopedOnly/, 'technical audit callers may explicitly include validation deliveries');
assert.doesNotMatch(latest(pool, 'shein-webhook-list-events').text, /order_warehouse_synced/, 'technical audit callers may explicitly include routine order receipts');
await repo.listEvents({allowedStores: ['JSH'], limit: 1, cursor: events.nextCursor});
assert.match(latest(pool, 'shein-webhook-list-events').text, /\(received_at, id\) < \(/, 'cursor must be a stable SQL keyset predicate');
await repo.listEvents({allowedStores: [], limit: 1});
assert.match(latest(pool, 'shein-webhook-list-events').text, /WHERE FALSE/, 'empty event scope must not become all stores');

const productContext = await repo.getProductBusinessContext({storeKey: 'tz', skc: 'SKC-1', eventAt: '2026-07-21T03:46:32.000Z'});
assert.equal(productContext.supplierCode, 'S1810电热水壶');
assert.deepEqual(latest(pool, 'shein-webhook-get-product-business-context').values, ['TZ', 'SKC-1', '2026-07-21T03:46:32.000Z']);

const gates = await repo.listStoreGates({storeKeys: ['JSH']});
assert.deepEqual(gates[0], {storeKey: 'JSH', gateType: 'authorization', state: 'blocked', reason: 'expired', sourceReceiptId: '41', sourceEventOrder: null, updatedAt: '2026-07-19T01:00:00.000Z'});
const gateList = latest(pool, 'shein-webhook-list-store-gates');
assert.equal(gateList.preparedName, '', 'dynamic gate-list SQL must not reuse a fixed prepared-statement name');
assert.match(gateList.text, /store_key = ANY\(\$1::text\[\]\)/);
assert.match(gateList.text, /state='blocked'/);
await repo.listStoreGates({storeKeys: []});
assert.match(latest(pool, 'shein-webhook-list-store-gates').text, /WHERE FALSE/, 'empty gate scope must not become all stores');
await repo.listStoreGates({storeKeys: '*', blockingOnly: false});
assert.doesNotMatch(latest(pool, 'shein-webhook-list-store-gates').text, /ANY\(/, "only literal '*' may request all stores");
const updatedGate = await repo.upsertStoreGate({storeKey: 'JSH', gateType: 'quota', state: 'blocked', reason: 'zero', sourceReceiptId: 44, sourceEventOrder: '1700000000000000'});
assert.equal(updatedGate.applied, true);
const gateUpsert = latest(pool, 'shein-webhook-upsert-store-gate');
assert.match(gateUpsert.text, /EXCLUDED\.source_event_order > ops\.shein_webhook_store_gate\.source_event_order/, 'platform event order must win over receipt arrival order');
assert.match(gateUpsert.text, /EXCLUDED\.gate_type <> 'quota'[\s\S]*EXCLUDED\.state='blocked'/, 'an unversioned blocked quota gate must fail closed instead of accepting an unverifiable reopen');
assert.match(gateUpsert.text, /EXCLUDED\.state='blocked' AND EXCLUDED\.source_event_order IS NULL/, 'an unversioned risk-closing event must always fail closed even after an ordered open gate');
assert.equal(gateUpsert.values[5], '1700000000000000');
assert.match(gateUpsert.text, /false AS applied/, 'a stale transition must return the current gate as not applied');
const reopened = await repo.reopenAuthorizationGate({storeKey: 'JSH', sourceReceiptId: 41, reason: 'probe recovered'});
assert.equal(reopened.state, 'open');
assert.match(latest(pool, 'shein-webhook-reopen-authorization-gate').text, /ops\.reopen_shein_webhook_authorization_gate/);

const totals = await repo.summary({allowedStores: ['JSH'], now: '2026-07-19T02:00:00Z'});
assert.deepEqual(totals.totals, {last24h: 2, pending: 1, failed: 0, p0: 1});
assert.equal(totals.byStore[0].storeKey, 'JSH');
assert.match(latest(pool, 'shein-webhook-summary-by-store').text, /store_key = ANY/, 'summary scope must also be SQL constrained');
assert.equal(latest(pool, 'shein-webhook-summary-by-store').preparedName, '', 'dynamic summary SQL must be unnamed');
assert.match(latest(pool, 'shein-webhook-summary-totals').text, /appScopedOnly/, 'business summary must hide technical validation deliveries by default');
assert.match(latest(pool, 'shein-webhook-summary-totals').text, /severity IN \('P0','P1','P2'\)/, 'business summary must count only operator-relevant events');
assert.match(latest(pool, 'shein-webhook-summary-totals').text, /status IN \('failed','retry','dead_letter'\)/, 'business summary must count processing failures even when the event was otherwise routine');
assert.match(latest(pool, 'shein-webhook-summary-totals').text, /incident_rank=1/, 'summary KPIs must count merged business incidents instead of per-site shelf callbacks');
assert.doesNotMatch(latest(pool, 'shein-webhook-summary-totals').text, /SELECT \*/, 'summary CTE must stay within the portal safe-column grant');
await repo.summary({allowedStores: ['JSH'], now: '2026-07-19T02:00:00Z', includeTechnical: true});
assert.doesNotMatch(latest(pool, 'shein-webhook-summary-totals').text, /appScopedOnly/, 'technical audit callers may explicitly include validation deliveries');
assert.doesNotMatch(latest(pool, 'shein-webhook-summary-totals').text, /severity IN \('P0','P1','P2'\)/, 'technical audit summary may explicitly include routine low-priority receipts');
await repo.summary({allowedStores: '*', now: '2026-07-19T02:00:00Z'});
assert.match(latest(pool, 'shein-webhook-summary-by-type').text, /\$1::timestamptz IS NOT NULL AND TRUE/, 'all-store summary must still bind its time parameter');
await repo.summary({allowedStores: [], now: '2026-07-19T02:00:00Z'});
assert.match(latest(pool, 'shein-webhook-summary-by-store').text, /\$1::timestamptz IS NOT NULL AND FALSE/, 'empty-store summary must bind safely and remain fail-closed');

console.log('shein webhook repository tests: ok');
