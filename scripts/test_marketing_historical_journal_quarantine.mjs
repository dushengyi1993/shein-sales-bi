import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {writeMarketingInventoryOnce, readMarketingInventoryJournalDomain} from '../lib/marketing_activity_inventory_openapi.mjs';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';
import {inventoryRecoveryScopeKey, readInventoryIntentJournals} from '../lib/durable_inventory_write.mjs';
import {stableInventoryHash, INVENTORY_OVERWRITE_COMPUTATION_VERSION} from '../lib/inventory_replenishment_policy.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-quarantine-'));
const priorAuthorization = process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION;
process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION = 'fixture-marketing';
try {
  const runDate = '2026-09-06';
  const journalFile = path.join(temp, `daily-inventory-replenishment-${runDate}.json.journal.ndjson`);
  const historicalFile = path.join(temp, 'daily-inventory-replenishment-2026-08-17.json.journal.ndjson');
  const scope = {storeKey: 'XL', skc: 'old-skc', skuCode: 'old-sku'};
  const key = stableInventoryHash({runDate:'2026-08-17',store:scope.storeKey,skc:scope.skc,sku:scope.skuCode,
    target:10,actionType:'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',policyVersion:'2026-08-12.2',authorizationId:'fixture'});
  const request = {pathname: '/open-api/stock/change-inventory/v2', method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{idempotencyKey: `bi-inv-${key.slice(0,42)}`,
      skuCode: scope.skuCode, invType: 'VI', changeType: 'OVERWRITE', changeQuantity: 10,
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard'}]}, headers: {language: 'en'}};
  const before = {totalInventoryQuantity: 2, totalUsableInventory: 2, totalLockedQuantity: 0, temporaryInventoryQuantity: 0, stockRowMissing: false};
  const intent = {kind: 'intent', intentId: 'historical-dangling', logicalActionKey: key,
    recoveryScopeKey: inventoryRecoveryScopeKey(scope), planHash: key,
    runDate: '2026-08-17', ...scope, targetUsableInventory: 10, policyVersion: '2026-08-12.2',
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION, authorizationId: 'fixture',
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request), request, before, recordedAt: '2026-08-17T00:00:00.000Z'};
  const dangling = {kind: 'write_outcome', intentId: intent.intentId, logicalActionKey: key,
    disposition: 'superseded_by_later_readback', recordedAt: '2026-08-18T00:00:00.000Z',
    supersededByIntentId: 'missing-later', supersededByRunDate: '2026-08-18', supersededByRecordedAt: '2026-08-18T00:00:00.000Z'};
  await fs.writeFile(historicalFile, [intent, dangling].map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(readInventoryIntentJournals([historicalFile], {maxRunDate: runDate}), /referencedIntentMissing/);
  let posts = 0;
  let stock = {...before};
  const client = new SheinOpenApiClient({inventoryStoreKey:'XL',inventoryJournalFile:journalFile,
    inventoryCutoverLock:path.join(temp,'cutover.lock'), inventoryCutoverReader:async()=>({activated:false}),
    inventoryFenceReader:()=>readMarketingInventoryJournalDomain({client,journalFile,runDate})});
  client.inventoryJournalDomainDirectories = () => [temp];
  client.request = async (pathname, options) => {
    await client.assertInventoryFence(pathname, options.method, options.body, options.headers, options.inventoryScope);
    posts++; stock = {...before, totalInventoryQuantity:10,totalUsableInventory:10};
    return {status:200,ok:true,data:{code:'0',info:{success:true}}};
  };
  const options = {client, storeKey: 'XL', journalFile, transactionHash: stableInventoryHash('new-marketing'), runDate,
    target: {skc: 'new-skc', skuCode: 'new-sku'}, phase: 'temporary_raise', overwriteQuantity: 10,
    desiredUsableInventory: 10, readStock: async () => stock};
  assert.equal((await writeMarketingInventoryOnce(options)).ok, true);
  assert.equal(posts, 1, 'unrelated historical dangling must not block new item');
  await assert.rejects(writeMarketingInventoryOnce(options), /INVENTORY_WRITE_ALREADY_RECORDED/);
  await assert.rejects(writeMarketingInventoryOnce({...options, target: scope,
    transactionHash: stableInventoryHash('same-historical-scope')}), /INVENTORY_WRITE_PENDING_CONFLICT/);
  assert.equal(posts, 1, 'repeat and historical pending produce zero extra POST');
  const bundle = await readInventoryIntentJournals([journalFile, historicalFile], {maxRunDate: runDate,
    currentJournalFile: journalFile, quarantineHistoricalDanglingSupersedes: true, allowMultiplePendingByScope: true});
  assert.equal(bundle.quarantinedSupersedes.length, 1);
  assert.ok([...bundle.pending.values()].some(row => row.intentId === intent.intentId));
  await assert.rejects(readInventoryIntentJournals([historicalFile], {maxRunDate: runDate,
    currentJournalFile: historicalFile, quarantineHistoricalDanglingSupersedes: true}), /referencedIntentMissing/);
  console.log(JSON.stringify({ok: true, posts, historicalPendingProtected: true, currentDanglingRejected: true}));
} finally {
  if (priorAuthorization === undefined) delete process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION;
  else process.env.SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION = priorAuthorization;
  await fs.rm(temp, {recursive: true, force: true});
}
