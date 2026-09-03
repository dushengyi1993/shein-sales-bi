#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  controlInventoryCutoverActivation,
  finalizeInventoryCompatibilityRotation,
  inventoryCompatibilityStatus,
  readInventoryWriterServiceStates,
  requireCurrentInventoryCutoverActivation,
  stageInventoryCompatibilityRotation,
} from '../lib/inventory_write_cutover.mjs';
import {inventoryWriteScopeKey} from '../lib/durable_inventory_write.mjs';
import {SheinOpenApiClient} from '../lib/shein_openapi_client.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-compat-flows-'));
const checks = [];

try {
  const readServiceState = async raw => (await readInventoryWriterServiceStates(
    ['oneshot.service'],
    {execFileImpl: async () => ({stdout: `${Object.entries(raw).map(([key, value]) => `${key}=${value}`).join('\n')}\n`})},
  ))[0];
  const liveOneshot = await readServiceState({
    LoadState: 'loaded',
    ActiveState: 'activating',
    SubState: 'start',
    MainPID: '1234',
    ExecMainStartTimestamp: 'Tue 2026-09-02 10:00:00 CST',
    NRestarts: '0',
  });
  assert.match(liveOneshot.generationHash, /^[a-f0-9]{64}$/u);
  assert.equal((await readServiceState({
    LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
    MainPID: '123', ExecMainStartTimestamp: 'Tue 2026-09-02 10:00:00 CST', NRestarts: '0',
  })).activeState, 'active');
  assert.equal((await readServiceState({
    LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', NRestarts: '0',
  })).activeState, 'inactive');
  assert.equal((await readServiceState({
    LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', ControlPID: '0', NRestarts: '0',
  })).activeState, 'failed');
  for (const raw of [
    {LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', ControlPID: '12', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'failed', SubState: 'failed', MainPID: '0', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'deactivating', SubState: 'stop', MainPID: '123', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'activating', SubState: 'start', MainPID: '0', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'activating', SubState: 'auto-restart', MainPID: '123', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'activating', SubState: 'start', MainPID: '123', NRestarts: '0'},
    {LoadState: 'not-found', ActiveState: 'activating', SubState: 'start', MainPID: '123', ExecMainStartTimestamp: 'x', NRestarts: '0'},
    {LoadState: 'loaded', ActiveState: 'activating', SubState: 'start', MainPID: '123', ExecMainStartTimestamp: 'x', NRestarts: 'unknown'},
  ]) {
    await assert.rejects(readServiceState(raw), /INVENTORY_CUTOVER_SERVICE_STATE_INVALID/);
  }
  checks.push('oneshot_activating_start_is_live_generation');

  const activationFile = path.join(temp, 'activation.ndjson');
  const activationReceiptFile = path.join(temp, 'activation.receipt.json');
  const compatibilityFile = path.join(temp, 'compatibility.ndjson');
  const compatibilityReceiptFile = path.join(temp, 'compatibility.receipt.json');
  const journalFile = path.join(temp, 'journal.ndjson');
  const manualReceiptFile = path.join(temp, 'manual.receipt.json');
  const lockFile = path.join(temp, 'cutover.lock');
  const commonPaths = {activationFile, activationReceiptFile, compatibilityFile, compatibilityReceiptFile, lockFile};

  const services = [
    {unit: 'shein-bi-daily-inventory-replenishment-guard.service', generationHash: '1'.repeat(64)},
    {unit: 'shein-bi-et-low-inventory-guard.service', generationHash: '2'.repeat(64)},
    {unit: 'shein-bi-et-low-inventory-recheck.service', generationHash: '3'.repeat(64)},
  ];
  const authorityA = {
    deployedCommit: 'a'.repeat(40), sourceFingerprint: 'a'.repeat(64), bundleSha256: 'a'.repeat(64),
    trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: 'a'.repeat(64),
    releaseReceiptFile: path.join(temp, 'release-a.json'), writerServices: services,
    capturedAt: '2026-08-27T01:00:00.000Z',
  };
  const candidateB = {
    deployedCommit: 'b'.repeat(40), sourceFingerprint: 'b'.repeat(64), bundleSha256: 'b'.repeat(64),
    trackedSourceClean: true, releaseReceiptKind: 'formal', releaseReceiptHash: 'b'.repeat(64),
    releaseReceiptFile: path.join(temp, 'release-b.json'),
  };
  const authorityB = {...candidateB, writerServices: services, capturedAt: '2026-08-27T01:20:00.000Z'};
  const maintenanceReader = async () => ({ok: true, active: true, mode: 'all', generation: 1, hash: '9'.repeat(64)});
  const scopeKey = inventoryWriteScopeKey({
    storeKey: 'XL', skc: 'sb12345', skuCode: 'SKU12345', warehouseCode: 'WH01', invType: 'VI',
  });

  await assert.rejects(() => inventoryCompatibilityStatus(commonPaths), /INVENTORY_CUTOVER_ACTIVATION_REQUIRED/);
  const initialOptions = {
    ...commonPaths, authorityReader: async () => authorityA, maintenanceReader,
    now: () => new Date('2026-08-27T01:01:00.000Z'),
    requiredManualResolution: {
      intentId: 'e07f999c-96b2-460c-bfa9-fa924f410ec3', scopeKey, journalFile, receiptFile: manualReceiptFile,
    },
  };
  const dryAct = await controlInventoryCutoverActivation({...initialOptions, mode: 'dry-run'});
  const executedAct = await controlInventoryCutoverActivation({...initialOptions, mode: 'execute', expectedPreflightHash: dryAct.preflightHash});
  assert.equal(executedAct.readback.compatibility.activeGeneration, 1);
  assert.equal((await inventoryCompatibilityStatus(commonPaths)).activated, true);
  checks.push('status_and_initial_activation');

  const stageOptions = {
    ...commonPaths, candidateAuthority: candidateB, authorityReader: async () => authorityA, maintenanceReader,
    now: () => new Date('2026-08-27T01:10:00.000Z'),
  };
  const dryStage = await stageInventoryCompatibilityRotation({...stageOptions, mode: 'dry-run'});
  assert.equal((await stageInventoryCompatibilityRotation({...stageOptions, mode: 'execute', expectedPreflightHash: dryStage.preflightHash})).state, 'rotation_staged');
  await assert.rejects(
    () => requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => authorityB}),
    /INVENTORY_CUTOVER_ROTATION_NOT_FINALIZED/,
  );
  const finalizeOptions = {
    ...commonPaths, authorityReader: async () => authorityB, maintenanceReader,
    now: () => new Date('2026-08-27T01:25:00.000Z'),
  };
  const dryFinalize = await finalizeInventoryCompatibilityRotation({...finalizeOptions, mode: 'dry-run'});
  assert.equal((await finalizeInventoryCompatibilityRotation({...finalizeOptions, mode: 'execute', expectedPreflightHash: dryFinalize.preflightHash})).state, 'rotation_finalized');
  checks.push('stage_and_finalize_rotation');

  await assert.rejects(
    () => requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => authorityA}),
    /INVENTORY_CUTOVER_ROLLBACK_OR_DEPLOYMENT_DRIFT/,
  );
  checks.push('rollback_drift_detection');

  const badCompatibilityFile = path.join(temp, 'bad-compat.ndjson');
  await fs.writeFile(badCompatibilityFile, 'not-valid-json-content\n');
  await assert.rejects(
    () => requireCurrentInventoryCutoverActivation({...commonPaths, compatibilityFile: badCompatibilityFile, authorityReader: async () => authorityB}),
    /INVENTORY_CUTOVER_COMPATIBILITY_REGISTRY_INVALID/,
  );
  checks.push('bad_control_file_fails_closed');

  await assert.rejects(
    () => requireCurrentInventoryCutoverActivation({...commonPaths, authorityReader: async () => ({...authorityB, trackedSourceClean: false})}),
    /INVENTORY_CUTOVER_DEPLOYMENT_AUTHORITY_INVALID|INVENTORY_CUTOVER_ROLLBACK_OR_DEPLOYMENT_DRIFT/,
  );
  checks.push('writer_mismatch_fails_closed');

  const nonInventoryClient = new SheinOpenApiClient({appKey: 'test', appSecret: 'test', storeKey: 'XL'});
  await assert.doesNotReject(() => nonInventoryClient.assertInventoryFence(
    '/open-api/goods/modify-skc-shelf', 'POST', {skc: 'sb12345', shelf_state: 1},
  ));
  checks.push('non_inventory_service_and_calls_unblocked');

  console.log(JSON.stringify({ok: true, checks}, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
