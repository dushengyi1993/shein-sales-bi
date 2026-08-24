#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  discoverInventoryJournalFiles,
  inventoryRecoveryScopeKey,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';
import {discoverInventoryJournalAuditFiles} from './validate_daily_operating_refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-journal-domain-'));
const dailyResults = path.join(temp, 'daily-inventory-replenishment', 'results');
const etResults = path.join(temp, 'et-low-inventory-guard', 'results');
const olderRunDate = '2026-08-17';
const laterRunDate = '2026-08-22';
const currentRunDate = '2026-08-24';
const policyVersion = '2026-08-12.2';
const authorizationId = 'owner-automatic-inventory-20260803-v1';
const scope = {storeKey: 'DL', skc: 'DOMAIN-SKC', skuCode: 'DOMAIN-SKU'};
const baseTime = Date.now() - 60_000;
const at = offset => new Date(baseTime + offset).toISOString();

function makeIntent({runDate, intentId, planHash, recordedAt}) {
  const targetUsableInventory = 10;
  const before = {
    totalInventoryQuantity: 2,
    totalUsableInventory: 2,
    totalLockedQuantity: 0,
    stockRowMissing: false,
  };
  const logicalActionKey = stableInventoryHash({
    runDate,
    store: scope.storeKey,
    skc: scope.skc,
    sku: scope.skuCode,
    target: targetUsableInventory,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion,
    authorizationId,
  });
  const request = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode: scope.skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: computeInventoryOverwriteQuantity(targetUsableInventory, before),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  return {
    kind: 'intent',
    intentId,
    logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate, ...scope}),
    planHash,
    runDate,
    ...scope,
    targetUsableInventory,
    policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt,
  };
}

const readback = (intent, recordedAt) => ({
  kind: 'write_outcome',
  intentId: intent.intentId,
  logicalActionKey: intent.logicalActionKey,
  disposition: 'readback_matched',
  recordedAt,
});

try {
  await fs.mkdir(dailyResults, {recursive: true});
  await fs.mkdir(etResults, {recursive: true});
  const olderIntent = makeIntent({
    runDate: olderRunDate,
    intentId: '57216ae8-1111-4111-8111-111111111111',
    planHash: '1'.repeat(64),
    recordedAt: at(0),
  });
  const laterIntent = makeIntent({
    runDate: laterRunDate,
    intentId: 'dff84d53-6606-4571-9b3e-1e1dac91c479',
    planHash: '2'.repeat(64),
    recordedAt: at(1_000),
  });
  const laterReadback = readback(laterIntent, at(2_000));
  const supersede = {
    kind: 'write_outcome',
    intentId: olderIntent.intentId,
    logicalActionKey: olderIntent.logicalActionKey,
    disposition: 'superseded_by_later_readback',
    recordedAt: at(3_000),
    supersededByIntentId: laterIntent.intentId,
    supersededByRunDate: laterIntent.runDate,
    supersededByRecordedAt: laterReadback.recordedAt,
  };
  const currentIntent = makeIntent({
    runDate: currentRunDate,
    intentId: 'current-domain-terminal-intent',
    planHash: '3'.repeat(64),
    recordedAt: at(4_000),
  });
  const currentReadback = readback(currentIntent, at(5_000));

  const currentJournal = path.join(dailyResults, `daily-inventory-replenishment-${currentRunDate}.json.journal.ndjson`);
  const olderJournal = path.join(dailyResults, `daily-inventory-replenishment-${olderRunDate}.json.journal.ndjson`);
  const etJournal = path.join(etResults, 'et-low-inventory-et-daily-2026-08-22-2026-08-21T17-12-03-415Z.json.journal.ndjson');
  await fs.writeFile(currentJournal, `${JSON.stringify(currentIntent)}\n${JSON.stringify(currentReadback)}\n`);
  await fs.writeFile(olderJournal, `${JSON.stringify(olderIntent)}\n${JSON.stringify(supersede)}\n`);
  await fs.writeFile(etJournal, `${JSON.stringify(laterIntent)}\n${JSON.stringify(laterReadback)}\n`);

  const narrowFiles = await discoverInventoryJournalFiles(currentJournal);
  assert.equal(narrowFiles.includes(path.resolve(etJournal)), false);
  await assert.rejects(
    readInventoryIntentJournals(narrowFiles, {maxRunDate: currentRunDate}),
    /referencedIntentMissing/,
    'daily-only discovery must continue to fail closed when its supersede reference is outside the scanned domain',
  );

  const configuredFiles = await discoverInventoryJournalAuditFiles(currentJournal, {
    SHEIN_BI_INVENTORY_JOURNAL_DIRS: `${dailyResults}${path.delimiter}${etResults}`,
  });
  const configuredLifecycle = await readInventoryIntentJournals(configuredFiles, {maxRunDate: currentRunDate});
  assert.deepEqual(
    [...new Set(configuredFiles.map(file => path.dirname(file)))].sort(),
    [path.resolve(dailyResults), path.resolve(etResults)].sort(),
    'validator helper must return both the daily and ET journal domains',
  );
  assert.deepEqual(
    new Set(configuredFiles),
    new Set([currentJournal, olderJournal, etJournal].map(file => path.resolve(file))),
    'validator helper must discover the complete two-domain journal set',
  );
  assert.equal(
    [...configuredLifecycle.terminalOutcomes.values()].some(outcome => outcome.intentId === laterIntent.intentId && outcome.disposition === 'readback_matched'),
    true,
    'strict aggregate must resolve the supersede reference to the ET later readback',
  );

  const defaultFiles = await discoverInventoryJournalAuditFiles(currentJournal, {});
  assert.equal(defaultFiles.includes(path.resolve(etJournal)), false);
  assert.equal(defaultFiles.every(file => path.dirname(file) === path.resolve(dailyResults)), true);
  await assert.rejects(
    readInventoryIntentJournals(defaultFiles, {maxRunDate: currentRunDate}),
    /referencedIntentMissing/,
    'an unconfigured validator must remain local and fail closed rather than masking the missing reference',
  );

  const [guardSource, validatorSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'scripts', 'cloud_daily_inventory_replenishment_guard.sh'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts', 'validate_daily_operating_refresh.mjs'), 'utf8'),
  ]);
  assert.match(guardSource, /String\(process\.env\.SHEIN_BI_INVENTORY_JOURNAL_DIRS \|\| ''\)[\s\S]*?split\(path\.delimiter\)[\s\S]*?discoverInventoryJournalFiles\(currentJournal, \{[\s\S]*?includeAll: true,[\s\S]*?additionalDirectories: inventoryJournalDirectories/);
  assert.match(validatorSource, /discoverInventoryJournalAuditFiles\(currentJournal, environment = process\.env\)[\s\S]*?split\(path\.delimiter\)[\s\S]*?includeAll: true,[\s\S]*?additionalDirectories/);
  assert.match(validatorSource, /skipped_terminal_readback_recorded[\s\S]*?discoverInventoryJournalAuditFiles\(currentJournal\)[\s\S]*?readInventoryIntentJournals/);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'daily_only_reference_missing_fails_closed',
      'complete_daily_and_et_domain_validates_supersede',
      'validator_env_domain_discovers_et_terminal',
      'validator_without_env_stays_local_and_safe',
      'guard_and_validator_source_contracts',
    ],
  }, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
