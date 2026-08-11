#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activateInventoryBootstrapLock,
  INVENTORY_BOOTSTRAP_LOCK_SCHEMA,
  normalizeInventoryBootstrapLockRegistry,
  readInventoryBootstrapLockRegistry,
  reserveInventoryBootstrapLock,
  upsertInventoryBootstrapLock,
} from '../lib/inventory_bootstrap_lock_registry.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-bootstrap-lock-'));
const file = path.join(tmp, 'locks.json');
const missing = await readInventoryBootstrapLockRegistry(file);
assert.equal(missing.exists, false);
assert.equal(missing.registry.schemaVersion, INVENTORY_BOOTSTRAP_LOCK_SCHEMA);
assert.match(missing.hash, /^[a-f0-9]{64}$/);

const first = await reserveInventoryBootstrapLock(file, {
  matchKey: 'sk6863',
  canonical: 'SK-6863半自动意式咖啡机',
  storeKey: 'hl',
  skc: 'seed-skc',
  skuCode: 'seed-sku',
  targetUsableInventory: 10,
  policyVersion: '2026-08-12.1',
  planHash: 'a'.repeat(64),
}, {now: '2026-08-11T15:00:00.000Z', expectedRegistryHash: missing.hash});
assert.equal(first.entry.matchKey, 'SK6863');
assert.equal(first.entry.storeKey, 'HL');
assert.equal(first.entry.targetUsableInventory, 10);
assert.equal(first.entry.status, 'pending');
assert.equal(first.entry.createdAt, '2026-08-11T15:00:00.000Z');

const second = await activateInventoryBootstrapLock(file, {
  ...first.entry,
  planHash: 'b'.repeat(64),
}, {now: '2026-08-11T15:05:00.000Z'});
assert.equal(second.entry.createdAt, first.entry.createdAt);
assert.equal(second.entry.updatedAt, '2026-08-11T15:05:00.000Z');
assert.equal(second.entry.planHash, 'b'.repeat(64));
assert.equal(second.entry.status, 'active');
assert.notEqual(second.hash, first.hash);

const third = await reserveInventoryBootstrapLock(file, {
  matchKey: 'SK7000', canonical: 'SK-7000产品', storeKey: 'DL', skc: 'second-skc', skuCode: 'second-sku',
  targetUsableInventory: 10, policyVersion: '2026-08-12.1', planHash: 'c'.repeat(64),
}, {now: '2026-08-11T15:05:30.000Z', expectedRegistryHash: second.hash});
assert.equal(third.entry.status, 'pending');
const fourth = await activateInventoryBootstrapLock(file, {
  ...third.entry,
  planHash: 'd'.repeat(64),
}, {now: '2026-08-11T15:05:40.000Z'});
assert.equal(fourth.entry.status, 'active');
assert.notEqual(fourth.hash, second.hash);

await assert.rejects(() => reserveInventoryBootstrapLock(file, {
  ...second.entry,
  planHash: 'c'.repeat(64),
}), /already reserved/);
await assert.rejects(() => upsertInventoryBootstrapLock(file, {
  ...second.entry,
  status: 'pending',
}), /cannot transition active to pending/);

await assert.rejects(() => upsertInventoryBootstrapLock(file, {
  ...second.entry,
  skc: 'different-skc',
}, {now: '2026-08-11T15:06:00.000Z'}), /identity mismatch/);

const normalized = normalizeInventoryBootstrapLockRegistry(JSON.parse(await fs.readFile(file, 'utf8')));
assert.deepEqual(Object.keys(normalized.locks), ['SK6863', 'SK7000']);
assert.equal(normalized.locks.SK6863.skc, 'seed-skc');
const invalidFile = path.join(tmp, 'invalid.json');
await fs.writeFile(invalidFile, JSON.stringify({schemaVersion: 'unknown/v1', locks: {}}));
await assert.rejects(() => readInventoryBootstrapLockRegistry(invalidFile), /unsupported inventory bootstrap lock schema/);
assert.throws(() => normalizeInventoryBootstrapLockRegistry({locks: {SK1: {
  ...second.entry,
  matchKey: 'SK1',
  status: 'unknown',
}}}), /policy\/status is invalid/);
assert.throws(() => normalizeInventoryBootstrapLockRegistry({locks: {SK1: {
  ...second.entry,
  matchKey: 'SK1',
  planHash: 'not-a-hash',
}}}), /planHash is invalid/);
console.log(JSON.stringify({ok: true, checks: 23}, null, 2));
