#!/usr/bin/env node
import assert from 'node:assert/strict';
import {evaluateSheinWebhookWriteGates} from '../lib/shein_webhook_write_gate.mjs';

const missing = await evaluateSheinWebhookWriteGates({writeStores: ['JSH']});
assert.equal(missing.ok, false);
assert.match(missing.blockers[0], /失败关闭/);

let gates = [];
const repository = {
  listStoreGates: async ({storeKeys}) => gates.filter(gate => storeKeys.includes(gate.storeKey) && gate.state === 'blocked'),
  reopenAuthorizationGate: async input => {
    const current = gates.find(gate => gate.storeKey === input.storeKey && gate.gateType === 'authorization');
    if (current && Number(input.sourceReceiptId) < Number(current.sourceReceiptId)) return {...current, applied: false};
    const next = {...current, ...input, gateType: 'authorization', state: 'open', updatedAt: new Date().toISOString(), applied: true};
    gates = gates.filter(gate => !(gate.storeKey === input.storeKey && gate.gateType === 'authorization'));
    gates.push(next);
    return next;
  },
};

const beforeEvent = await evaluateSheinWebhookWriteGates({repository, writeStores: ['JSH']});
assert.equal(beforeEvent.ok, true);
gates.push({storeKey: 'JSH', gateType: 'quota', state: 'blocked', reason: 'zero', sourceReceiptId: '20', updatedAt: '2026-07-19T10:00:00.000Z'});
const immediatelyBeforeWrite = await evaluateSheinWebhookWriteGates({repository, writeStores: ['JSH']});
assert.equal(immediatelyBeforeWrite.ok, false, 'a gate arriving after preflight must stop the final write check');
assert.match(immediatelyBeforeWrite.blockers[0], /商品额度为 0/);

gates = [{storeKey: 'DL', gateType: 'authorization', state: 'blocked', reason: 'revoked', sourceReceiptId: '30', updatedAt: '2026-07-19T10:00:00.000Z'}];
const recovered = await evaluateSheinWebhookWriteGates({
  repository,
  writeStores: ['DL'],
  loadProbeSummary: () => ({fresh: true, generatedAtMs: Date.parse('2026-07-19T10:01:00.000Z'), byStore: new Map([['DL', {ok: true}]])}),
  probeIsReadReady: probe => probe?.ok === true,
});
assert.equal(recovered.ok, true);
assert.equal(recovered.clearedGates[0].state, 'open');

const staleRepository = {
  listStoreGates: async () => [{storeKey: 'FY', gateType: 'authorization', state: 'blocked', sourceReceiptId: '40', updatedAt: '2026-07-19T10:00:00.000Z'}],
  reopenAuthorizationGate: async () => ({storeKey: 'FY', gateType: 'authorization', state: 'blocked', sourceReceiptId: '41', applied: false}),
};
const staleRecovery = await evaluateSheinWebhookWriteGates({
  repository: staleRepository,
  writeStores: ['FY'],
  loadProbeSummary: () => ({fresh: true, generatedAtMs: Date.parse('2026-07-19T10:01:00.000Z'), byStore: new Map([['FY', {ok: true}]])}),
  probeIsReadReady: () => true,
});
assert.equal(staleRecovery.ok, false, 'a newer revocation must win over an older probe-based reopen');

console.log('shein_webhook_write_gate: fail-closed double-check and monotonic recovery passed');
