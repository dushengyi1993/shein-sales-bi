#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  checkSheinWebhookExternalWriteGate,
  runSheinWebhookExternalWriteGuarded,
} from '../lib/shein_webhook_external_write_guard.mjs';

let gates = [];
let closes = 0;
const createRepository = () => ({
  listStoreGates: async ({storeKeys}) => gates.filter(gate => storeKeys.includes(gate.storeKey) && gate.state === 'blocked'),
  reopenAuthorizationGate: async () => ({applied: false, state: 'blocked'}),
  close: async () => { closes += 1; },
});
const liveGuard = ({writeStores}) => checkSheinWebhookExternalWriteGate({writeStores, createRepository});

// Simulate pre-processing completing while a newer webhook receipt closes the
// store gate before the publish request is allowed to start.
let publishRequests = 0;
gates = [{storeKey: 'HL', gateType: 'quota', state: 'blocked', updatedAt: new Date().toISOString()}];
const publish = await runSheinWebhookExternalWriteGuarded({
  writeStores: ['HL'],
  guard: liveGuard,
  write: async () => { publishRequests += 1; },
});
assert.equal(publish.ok, false);
assert.equal(publishRequests, 0, 'a gate closed after preprocessing must prevent publishOrEdit');

// The maintenance executor must check every payload, not only once before its
// loop: the first write can succeed, then a new gate must stop the next one.
gates = [];
let maintenanceRequests = 0;
const first = await runSheinWebhookExternalWriteGuarded({
  writeStores: ['DX'],
  guard: liveGuard,
  write: async () => { maintenanceRequests += 1; },
});
assert.equal(first.ok, true);
gates = [{storeKey: 'DX', gateType: 'authorization', state: 'blocked', updatedAt: new Date().toISOString()}];
const second = await runSheinWebhookExternalWriteGuarded({
  writeStores: ['DX'],
  guard: liveGuard,
  write: async () => { maintenanceRequests += 1; },
});
assert.equal(second.ok, false);
assert.equal(maintenanceRequests, 1, 'a gate closed during maintenance must prevent the next payload write');
assert.equal(closes, 3, 'each self-created repository pool is closed');

console.log('shein_webhook_external_write_guard: immediate fail-closed publish and per-payload maintenance checks passed');
