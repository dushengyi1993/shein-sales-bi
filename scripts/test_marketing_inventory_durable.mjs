import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {writeMarketingInventoryOnce} from '../lib/marketing_activity_inventory_openapi.mjs';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-durable-inventory-full-'));
const journalDir = path.join(tmpDir, 'journals');
await fs.mkdir(journalDir, {recursive: true});

const journalFile = path.join(journalDir, 'daily-inventory-replenishment-2026-09-05.json.journal.ndjson');
const storeKey = 'LQ';
const target = {
  skc: 'sv-durable-test',
  skuCode: 'sku-durable-test',
};
const transactionHash = crypto.createHash('sha256').update('tx-durable-test').digest('hex');
const runDate = '2026-09-05';
process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION = 'auth-mock-123';

let currentStock = {
  totalInventoryQuantity: 10,
  totalUsableInventory: 6,
  totalLockedQuantity: 4,
  temporaryInventoryQuantity: 0,
};

let postCalls = 0;
let journalIntentVerifiedInFlight = false;

const client = {
  inventoryJournalDomainDirectories: () => [journalDir],
  assertInventoryFence: (pathname, method, body, headers, scope) => {
    assert.equal(method, 'POST');
    assert.equal(pathname, '/open-api/stock/change-inventory/v2');
    assert.ok(scope.intentId);
  },
  request: async (pathname, opts) => {
    postCalls += 1;

    // 1. requestVÞŒ‘Ì‹ûSÖw[žjournalšŒ‹Á[Œetintent/hash]ò[XW(
    const content = await fs.readFile(journalFile, 'utf8');
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    const matchedIntent = records.find(r => r.kind === 'intent' && r.intentId === opts.inventoryScope?.intentId);
    assert.ok(matchedIntent, 'Durable intent must exist in journal before HTTP request resolves');
    assert.equal(matchedIntent.logicalActionKey, opts.inventoryScope.logicalActionKey);
    assert.equal(matchedIntent.requestPayloadHash, opts.inventoryScope.requestPayloadHash);
    assert.equal(matchedIntent.storeKey, storeKey);
    assert.equal(matchedIntent.skuCode, target.skuCode);
    assert.ok(matchedIntent.request, 'Request must be durably recorded');
    journalIntentVerifiedInFlight = true;

    // Simulate immediate backend stock update so readback matches
    if (opts.body?.updateSkuInventoryQuantityRequests?.[0]) {
      const req = opts.body.updateSkuInventoryQuantityRequests[0];
      currentStock.totalInventoryQuantity = req.changeQuantity;
      currentStock.totalUsableInventory = req.changeQuantity - (currentStock.totalLockedQuantity + currentStock.temporaryInventoryQuantity);
    }
    return {status: 200, ok: true, data: {code: '0', msg: 'OK', info: {success: true}}};
  },
  inventoryCutoverLock: path.join(tmpDir, 'cutover.lock'),
};

// Scenario 1: Temporary raise with in-flight journal intent verification
const raiseRes = await writeMarketingInventoryOnce({
  client,
  storeKey,
  journalFile,
  transactionHash,
  runDate,
  target,
  phase: 'temporary_raise',
  overwriteQuantity: 14,
  desiredUsableInventory: 10,
  readStock: async () => ({...currentStock}),
});

assert.equal(journalIntentVerifiedInFlight, true, 'Intent verified on disk inside client.request before return');
assert.equal(postCalls, 1, 'Exactly one POST call on temporary raise');
assert.equal(raiseRes.ok, true, 'Readback matched successfully');
assert.equal(currentStock.totalUsableInventory, 10, 'Usable raised to 10');

// Scenario 2: Repeat call with same key -> rejected before dispatch, 0 repeat POST
await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client,
      storeKey,
      journalFile,
      transactionHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14,
      desiredUsableInventory: 10,
      readStock: async () => ({...currentStock}),
    });
  },
  /INVENTORY_WRITE_ALREADY_RECORDED/
);
assert.equal(postCalls, 1, 'No repeat POST on already recorded intent');

// Scenario 3: Restore phase test
const restoreRes = await writeMarketingInventoryOnce({
  client,
  storeKey,
  journalFile,
  transactionHash,
  runDate,
  target,
  phase: 'restore',
  overwriteQuantity: 10,
  desiredUsableInventory: 6,
  readStock: async () => ({...currentStock}),
});
assert.equal(postCalls, 2, 'Exactly one POST call on restore phase (total 2 POSTs across raise + restore)');
assert.equal(restoreRes.ok, true, 'Restore readback matched');
assert.equal(currentStock.totalUsableInventory, 6, 'Usable restored to 6');

// Scenario 4: Second restore on recorded key rejected -> 0 additional POST
await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client,
      storeKey,
      journalFile,
      transactionHash,
      runDate,
      target,
      phase: 'restore',
      overwriteQuantity: 10,
      desiredUsableInventory: 6,
      readStock: async () => ({...currentStock}),
    });
  },
  /INVENTORY_WRITE_ALREADY_RECORDED/
);
assert.equal(postCalls, 2, 'Second restore rejected, POST calls remain 2');

// Scenario 5: Transport hang / throw -> intent recorded, retry throws ALREADY_RECORDED -> 0 repeated POST
const transportFailTxHash = crypto.createHash('sha256').update('tx-transport-fail').digest('hex');
const failingClient = {
  inventoryJournalDomainDirectories: () => [journalDir],
  assertInventoryFence: client.assertInventoryFence,
  inventoryCutoverLock: path.join(tmpDir, 'cutover-fail.lock'),
  request: async () => {
    postCalls += 1;
    throw new Error('ETIMEDOUT: network transport hang');
  },
};

await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client: failingClient,
      storeKey,
      journalFile,
      transactionHash: transportFailTxHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14,
      desiredUsableInventory: 10,
      readStock: async () => ({...currentStock}),
    });
  },
  /ETIMEDOUT/
);
assert.equal(postCalls, 3, 'One POST was dispatched before timeout');

// Retry same phase with transportFailTxHash -> must see INVENTORY_WRITE_ALREADY_RECORDED, exactly 0 new POSTs
await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client: failingClient,
      storeKey,
      journalFile,
      transactionHash: transportFailTxHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14,
      desiredUsableInventory: 10,
      readStock: async () => ({...currentStock}),
    });
  },
  /INVENTORY_WRITE_ALREADY_RECORDED/
);
assert.equal(postCalls, 3, 'POST count strictly remains 3 after transport throw retry');

// Scenario 6: Ordinary + temp both non-zero, temp missing or non-conserving -> 0 POST
const nonConservingTxHash = crypto.createHash('sha256').update('tx-non-conserving').digest('hex');
await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client,
      storeKey,
      journalFile,
      transactionHash: nonConservingTxHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14,
      desiredUsableInventory: 10,
      // Missing tempLocked or sum mismatch: total(10) != usable(6) + locked(4) + tempLocked(2) = 12
      readStock: async () => ({
        totalInventoryQuantity: 10,
        totalUsableInventory: 6,
        totalLockedQuantity: 4,
        temporaryInventoryQuantity: 2,
      }),
    });
  },
  /INVENTORY_CONSERVATION_MISMATCH/
);
assert.equal(postCalls, 3, 'Zero POST when inventory conservation fails');

// Scenario 7: Baseline occupancy changed in lock before submit -> 0 POST
const occupancyChangeTxHash = crypto.createHash('sha256').update('tx-occupancy-change').digest('hex');
await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client,
      storeKey,
      journalFile,
      transactionHash: occupancyChangeTxHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14, // expects 10 target + 4 locked = 14
      desiredUsableInventory: 10,
      // Stock unexpectedly changed locked quantity to 5 -> expected overwrite would be 15 != 14
      readStock: async () => ({
        totalInventoryQuantity: 11,
        totalUsableInventory: 6,
        totalLockedQuantity: 5,
        temporaryInventoryQuantity: 0,
      }),
    });
  },
  /MARKETING_INVENTORY_OCCUPANCY_CHANGED_BEFORE_SUBMIT/
);
assert.equal(postCalls, 3, 'Zero POST when baseline occupancy changes before submit');

// Scenario 8: Malformed global journal in journal domain -> readFenceBundle throws -> 0 POST
const malformedTxHash = crypto.createHash('sha256').update('tx-malformed-journal').digest('hex');
const malformedJournalFile = path.join(journalDir, 'daily-inventory-replenishment-2026-09-04.json.journal.ndjson');
await fs.writeFile(malformedJournalFile, '{"kind":"intent","invalidJsonLine":true', 'utf8');

await assert.rejects(
  async () => {
    await writeMarketingInventoryOnce({
      client,
      storeKey,
      journalFile,
      transactionHash: malformedTxHash,
      runDate,
      target,
      phase: 'temporary_raise',
      overwriteQuantity: 14,
      desiredUsableInventory: 10,
      readStock: async () => ({...currentStock}),
    });
  },
  err => Boolean(err)
);
assert.equal(postCalls, 3, 'Zero POST when global journal domain contains malformed journal');

// Clean up
await fs.rm(tmpDir, {recursive: true, force: true});

console.log(JSON.stringify({
  ok: true,
  test: 'scripts/test_marketing_inventory_durable.mjs passed with all contract assertions (in-flight intent, transport hang 0-repeat, conservation check, occupancy change rejection, malformed journal rejection, and 0-repeat restore/raise)',
}, null, 2));
