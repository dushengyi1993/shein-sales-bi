#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {validateOrdinaryCampaignDocuments} from '../lib/marketing_ordinary_campaign_approval.mjs';
import {verifyMarketingPlanRegistrySync} from '../lib/marketing_plan_registry.mjs';

const ROOT = path.resolve('.');
const ordinaryScript = path.resolve('scripts/marketing/promote_ordinary_campaign_baseline.mjs');
const compositeScript = path.resolve('scripts/marketing/promote_composite_ordinary_campaign_baseline.mjs');
const stores = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8')).stores
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || store.store_key || store.key || '').trim().toUpperCase())
  .filter(Boolean);
assert.equal(stores.length, 19, 'fixture must bind the fixed config/stores.json enabled set');
assert.equal(new Set(stores).size, 19, 'fixed enabled store keys must be unique');

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, text, 'utf8');
  return {text, sha256: sha256Text(text)};
}

function rows(label, indexes = stores.map((_, index) => index), priceOffset = 0) {
  return indexes.map(index => ({
    storeKey: stores[index],
    activityId: 71000,
    skc: `promotion-${label}-${String(index).padStart(2, '0')}`,
    targetPrice: 100 + index / 100 + priceOffset,
    finalTargetPrice: 100 + index / 100 + priceOffset,
    cost: 40,
    storageUnitCostSar: 0.5,
    selected: true,
  }));
}

function writeApprovalFixture(dir, label, inputRows) {
  const selectionPath = path.join(dir, `${label}-selection.json`);
  const pricesPath = path.join(dir, `${label}-prices.json`);
  const approvalManifest = path.join(dir, `${label}-approval-manifest.json`);
  const approvalText = `fixture approval ${label}`;
  const approvalSource = `promotion-registry-test:${label}`;
  const baseSelection = {
    items: inputRows,
    executionStatus: 'user_approved_pending_execution',
    planMetadata: {approvalText, approvalSource},
  };
  const basePrices = {
    items: inputRows,
    executionStatus: 'user_approved_pending_execution',
    planMetadata: {approvalText, approvalSource},
  };
  const validated = validateOrdinaryCampaignDocuments(baseSelection, basePrices);
  for (const doc of [baseSelection, basePrices]) doc.planMetadata.workFingerprint = validated.workFingerprint;
  const selectionFile = writeJson(selectionPath, baseSelection);
  const pricesFile = writeJson(pricesPath, basePrices);
  writeJson(approvalManifest, {
    schemaVersion: 1,
    approvalText,
    approvalSource,
    approvedAt: '2026-08-24T01:02:03.000Z',
    outputSelection: rel(selectionPath),
    outputPrices: rel(pricesPath),
    hashes: {
      outputSelectionSha256: selectionFile.sha256,
      outputPricesSha256: pricesFile.sha256,
      selectionPayloadHash: validated.selectionPayloadHash,
      pricePayloadHash: validated.pricePayloadHash,
      workFingerprint: validated.workFingerprint,
    },
  });
  return {selectionPath, pricesPath, approvalManifest, rows: inputRows, validated};
}

function readbackRows(inputRows) {
  return inputRows.map(row => ({
    storeKey: row.storeKey,
    activityId: row.activityId,
    skc: row.skc,
    canonical: row.canonical || '',
    expectedActivityPrice: row.targetPrice,
    actualActivityPrice: row.targetPrice,
    finalTargetPrice: row.finalTargetPrice,
    couponFactor: row.couponFactor,
    combo: row.combo,
    enrolledOrUnderReview: true,
    priceOk: true,
  }));
}

function writeReadback(file, identityFixture, observedRows = identityFixture.rows, {withPlanAlignment = true} = {}) {
  const rows = readbackRows(observedRows);
  const observedStoreKeys = [...new Set(rows.map(row => String(row.storeKey || '').toUpperCase()))];
  const readbackStoreKeys = [...stores, ...observedStoreKeys.filter(storeKey => !stores.includes(storeKey))];
  const byStore = readbackStoreKeys.map(storeKey => ({
    storeKey,
    rows: rows.filter(row => row.storeKey === storeKey),
  }));
  const rowCount = identityFixture.validated.selectionRows.length;
  return writeJson(file, {
    summary: {
      ok: true,
      plannedRows: rowCount,
      checkedRows: rowCount,
      missingRows: 0,
      priceMismatchRows: 0,
      extraAvailableRows: 0,
      activityListGapRows: 0,
      badPacketActivities: 0,
      selectionPlan: rel(identityFixture.selectionPath),
      priceOverrides: rel(identityFixture.pricesPath),
      ...(withPlanAlignment ? {
        planAlignment: {
          ok: true,
          selectionRows: identityFixture.validated.selectionRows.length,
          priceRows: identityFixture.validated.priceRows.length,
          readbackRows: rows.length,
          selectionPayloadHash: identityFixture.validated.selectionPayloadHash,
          pricePayloadHash: identityFixture.validated.pricePayloadHash,
          workFingerprint: identityFixture.validated.workFingerprint,
        },
      } : {}),
    },
    stores: byStore,
  });
}

function run(script, args, {cwd = ROOT, env = {}} = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: {...process.env, ...env},
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parseOutput(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function commonArgs(fixture, readback, batch) {
  return [
    '--selection', fixture.selectionPath,
    '--prices', fixture.pricesPath,
    '--approval-manifest', fixture.approvalManifest,
    '--readback', readback,
    '--batch', batch,
  ];
}

const tempRoot = path.join(ROOT, 'tmp', `test-marketing-plan-promotion-registry-${process.pid}-${Date.now()}`);
try {
  fs.mkdirSync(tempRoot, {recursive: true});

  const defaultFixture = writeApprovalFixture(tempRoot, 'default', rows('default'));
  const defaultReadback = path.join(tempRoot, 'default-readback.json');
  writeReadback(defaultReadback, defaultFixture);
  const beforeSelection = fs.readFileSync(defaultFixture.selectionPath, 'utf8');
  const beforePrices = fs.readFileSync(defaultFixture.pricesPath, 'utf8');
  const missingIdentityReadback = path.join(tempRoot, 'missing-plan-alignment-readback.json');
  writeReadback(missingIdentityReadback, defaultFixture, defaultFixture.rows, {withPlanAlignment: false});
  const missingIdentitySelectionOut = path.join(tempRoot, 'missing-plan-alignment-selection-out.json');
  const missingIdentityPricesOut = path.join(tempRoot, 'missing-plan-alignment-prices-out.json');
  const missingIdentity = run(ordinaryScript, [
    ...commonArgs(defaultFixture, missingIdentityReadback, 'missing-plan-alignment'),
    '--selection-out', missingIdentitySelectionOut,
    '--prices-out', missingIdentityPricesOut,
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(missingIdentity.status, 0, 'ordinary promotion must reject readback without planAlignment identity');
  assert.match(`${missingIdentity.stdout}\n${missingIdentity.stderr}`, /planAlignment exact identity is missing/i);
  assert.equal(fs.existsSync(missingIdentitySelectionOut), false, 'missing identity must fail before selection output write');
  assert.equal(fs.existsSync(missingIdentityPricesOut), false, 'missing identity must fail before price output write');

  for (const missingField of ['selectionPayloadHash', 'pricePayloadHash', 'workFingerprint']) {
    const partialReadback = path.join(tempRoot, `partial-plan-alignment-${missingField}-readback.json`);
    writeReadback(partialReadback, defaultFixture);
    const partialDoc = JSON.parse(fs.readFileSync(partialReadback, 'utf8'));
    delete partialDoc.summary.planAlignment[missingField];
    writeJson(partialReadback, partialDoc);
    const partialSelectionOut = path.join(tempRoot, `partial-plan-alignment-${missingField}-selection-out.json`);
    const partialPricesOut = path.join(tempRoot, `partial-plan-alignment-${missingField}-prices-out.json`);
    const partialIdentity = run(ordinaryScript, [
      ...commonArgs(defaultFixture, partialReadback, `partial-plan-alignment-${missingField}`),
      '--selection-out', partialSelectionOut,
      '--prices-out', partialPricesOut,
      '--no-registry-publish',
    ], {cwd: tempRoot});
    assert.notEqual(partialIdentity.status, 0, `ordinary promotion must reject planAlignment missing ${missingField}`);
    assert.match(`${partialIdentity.stdout}\n${partialIdentity.stderr}`, new RegExp(`planAlignment\\.${missingField} exact hash binding is missing`, 'i'));
    assert.equal(fs.existsSync(partialSelectionOut), false, `missing ${missingField} must fail before selection output write`);
    assert.equal(fs.existsSync(partialPricesOut), false, `missing ${missingField} must fail before price output write`);
  }
  for (const missingField of ['selectionRows', 'priceRows', 'readbackRows']) {
    const partialReadback = path.join(tempRoot, `partial-plan-alignment-${missingField}-readback.json`);
    writeReadback(partialReadback, defaultFixture);
    const partialDoc = JSON.parse(fs.readFileSync(partialReadback, 'utf8'));
    delete partialDoc.summary.planAlignment[missingField];
    writeJson(partialReadback, partialDoc);
    const partialSelectionOut = path.join(tempRoot, `partial-plan-alignment-${missingField}-selection-out.json`);
    const partialPricesOut = path.join(tempRoot, `partial-plan-alignment-${missingField}-prices-out.json`);
    const partialIdentity = run(ordinaryScript, [
      ...commonArgs(defaultFixture, partialReadback, `partial-plan-alignment-${missingField}`),
      '--selection-out', partialSelectionOut,
      '--prices-out', partialPricesOut,
      '--no-registry-publish',
    ], {cwd: tempRoot});
    assert.notEqual(partialIdentity.status, 0, `ordinary promotion must reject planAlignment missing ${missingField}`);
    assert.match(`${partialIdentity.stdout}\n${partialIdentity.stderr}`, new RegExp(`planAlignment\\.${missingField} mismatch`, 'i'));
    assert.equal(fs.existsSync(partialSelectionOut), false, `missing ${missingField} must fail before selection output write`);
    assert.equal(fs.existsSync(partialPricesOut), false, `missing ${missingField} must fail before price output write`);
  }
  const alternateFixture = writeApprovalFixture(tempRoot, 'alternate', rows('alternate', stores.map((_, index) => index), 1));
  const sameSizeMismatchReadback = path.join(tempRoot, 'same-size-mismatch-readback.json');
  writeReadback(sameSizeMismatchReadback, alternateFixture);
  const sameSizeMismatchSelectionOut = path.join(tempRoot, 'same-size-mismatch-selection-out.json');
  const sameSizeMismatchPricesOut = path.join(tempRoot, 'same-size-mismatch-prices-out.json');
  const sameSizeMismatch = run(ordinaryScript, [
    ...commonArgs(defaultFixture, sameSizeMismatchReadback, 'same-size-mismatch'),
    '--selection-out', sameSizeMismatchSelectionOut,
    '--prices-out', sameSizeMismatchPricesOut,
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(sameSizeMismatch.status, 0, 'ordinary promotion must reject a clean readback from another same-size batch');
  assert.match(`${sameSizeMismatch.stdout}\n${sameSizeMismatch.stderr}`, /planAlignment\.(selectionPayloadHash|pricePayloadHash|workFingerprint) mismatch/i);
  assert.equal(fs.existsSync(sameSizeMismatchSelectionOut), false, 'same-size mismatch must fail before selection output write');
  assert.equal(fs.existsSync(sameSizeMismatchPricesOut), false, 'same-size mismatch must fail before price output write');
  assert.equal(fs.readFileSync(defaultFixture.selectionPath, 'utf8'), beforeSelection);
  assert.equal(fs.readFileSync(defaultFixture.pricesPath, 'utf8'), beforePrices);
  const missingMode = run(ordinaryScript, commonArgs(defaultFixture, defaultReadback, 'missing-mode'));
  assert.notEqual(missingMode.status, 0, 'promotion without an explicit registry mode must fail');
  assert.equal(fs.readFileSync(defaultFixture.selectionPath, 'utf8'), beforeSelection, 'missing mode must not write selection');
  assert.equal(fs.readFileSync(defaultFixture.pricesPath, 'utf8'), beforePrices, 'missing mode must not write prices');

  const bothModes = run(ordinaryScript, [
    ...commonArgs(defaultFixture, defaultReadback, 'both-modes'),
    '--registry-file', path.join(tempRoot, 'invalid-current.json'),
    '--no-registry-publish',
  ]);
  assert.notEqual(bothModes.status, 0, 'promotion with both registry modes must fail');
  assert.equal(fs.readFileSync(defaultFixture.selectionPath, 'utf8'), beforeSelection, 'both modes must not write selection');

  const offlineSelection = path.join(tempRoot, 'offline-selection.json');
  const offlinePrices = path.join(tempRoot, 'offline-prices.json');
  const offline = parseOutput(run(ordinaryScript, [
    ...commonArgs(defaultFixture, defaultReadback, 'offline-candidate'),
    '--selection-out', offlineSelection,
    '--prices-out', offlinePrices,
    '--no-registry-publish',
  ]));
  assert.equal(offline.registryPublished, false);
  const offlineSelectionDoc = JSON.parse(fs.readFileSync(offlineSelection, 'utf8'));
  const offlinePricesDoc = JSON.parse(fs.readFileSync(offlinePrices, 'utf8'));
  assert.equal(offlineSelectionDoc.executionStatus, 'completed');
  assert.equal(offlinePricesDoc.executionStatus, 'completed');
  assert.equal(offlineSelectionDoc.planMetadata.status, 'offline_candidate');
  assert.equal(offlinePricesDoc.planMetadata.status, 'offline_candidate');
  assert.equal(offlineSelectionDoc.baselineForNextOrdinaryActivity, false);
  assert.equal(offlinePricesDoc.baselineForNextOrdinaryActivity, false);
  assert.equal(offlineSelectionDoc.baselineForLimitedDiscountFallback, false);
  assert.equal(offlinePricesDoc.baselineForLimitedDiscountFallback, false);
  assert.equal(offlineSelectionDoc.planMetadata.supersededBy, null);
  assert.equal(offlinePricesDoc.planMetadata.supersededBy, null);
  assert.equal(offline.authoritative, false);

  const ordinaryPairBefore = {
    selection: fs.readFileSync(offlineSelection),
    prices: fs.readFileSync(offlinePrices),
  };
  const ordinarySecondWriteFault = run(ordinaryScript, [
    ...commonArgs(defaultFixture, defaultReadback, 'ordinary-second-output-fault'),
    '--selection-out', offlineSelection,
    '--prices-out', offlinePrices,
    '--no-registry-publish',
  ], {
    cwd: tempRoot,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PROMOTION_TEST_FAULT: 'before_prices_output_rename',
    },
  });
  assert.notEqual(ordinarySecondWriteFault.status, 0, 'ordinary second output fault must fail');
  assert.match(`${ordinarySecondWriteFault.stdout}\n${ordinarySecondWriteFault.stderr}`, /Injected promotion test fault before prices output rename/i);
  assert.equal(fs.readFileSync(offlineSelection).equals(ordinaryPairBefore.selection), true,
    'ordinary second output fault must restore previous selection bytes');
  assert.equal(fs.readFileSync(offlinePrices).equals(ordinaryPairBefore.prices), true,
    'ordinary second output fault must preserve previous prices bytes');
  assert.equal(fs.readFileSync(defaultFixture.selectionPath, 'utf8'), beforeSelection,
    'ordinary second output fault must not change selection source bytes');
  assert.equal(fs.readFileSync(defaultFixture.pricesPath, 'utf8'), beforePrices,
    'ordinary second output fault must not change prices source bytes');

  const registryFixture = writeApprovalFixture(tempRoot, 'registry', rows('registry'));
  const registryReadback = path.join(tempRoot, 'registry-readback.json');
  writeReadback(registryReadback, registryFixture, registryFixture.rows, {withPlanAlignment: true});
  const registryRoot = path.join(tempRoot, 'ordinary-registry');
  const registryFile = path.join(registryRoot, 'current.json');
  const rejectedRegistrySelectionOut = path.join(tempRoot, 'rejected-registry-selection.json');
  const rejectedRegistryPricesOut = path.join(tempRoot, 'rejected-registry-prices.json');
  const registrySourceBefore = {
    selection: fs.readFileSync(registryFixture.selectionPath),
    prices: fs.readFileSync(registryFixture.pricesPath),
  };
  const incompatibleRegistryOutputs = run(ordinaryScript, [
    ...commonArgs(registryFixture, registryReadback, 'ordinary-registry-incompatible-outputs'),
    '--selection-out', rejectedRegistrySelectionOut,
    '--prices-out', rejectedRegistryPricesOut,
    '--registry-file', registryFile,
  ], {cwd: tempRoot});
  assert.notEqual(incompatibleRegistryOutputs.status, 0, 'registry mode must reject mutable output options');
  assert.match(`${incompatibleRegistryOutputs.stdout}\n${incompatibleRegistryOutputs.stderr}`, /incompatible with registry mode/i);
  assert.equal(fs.existsSync(rejectedRegistrySelectionOut), false);
  assert.equal(fs.existsSync(rejectedRegistryPricesOut), false);
  assert.equal(fs.existsSync(registryFile), false);
  assert.equal(fs.readFileSync(registryFixture.selectionPath).equals(registrySourceBefore.selection), true);
  assert.equal(fs.readFileSync(registryFixture.pricesPath).equals(registrySourceBefore.prices), true);

  const published = parseOutput(run(ordinaryScript, [
    ...commonArgs(registryFixture, registryReadback, 'ordinary-registry'),
    '--registry-file', registryFile,
  ], {cwd: tempRoot}));
  assert.equal(published.registryPublished, true);
  assert.equal(published.authoritative, true);
  assert.equal(published.stagingCleanup.ok, true);
  assert.match(published.registryHash, /^[a-f0-9]{64}$/);
  assert.equal(published.registryFile, path.resolve(registryFile));
  assert.match(published.baselineId, /^ordinary-ordinary-registry-[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(registryFixture.selectionPath).equals(registrySourceBefore.selection), true,
    'successful registry promotion must not mutate approved selection source bytes');
  assert.equal(fs.readFileSync(registryFixture.pricesPath).equals(registrySourceBefore.prices), true,
    'successful registry promotion must not mutate approved prices source bytes');
  const verified = verifyMarketingPlanRegistrySync({registryFile, registryRoot, expectedStoreKeys: stores});
  assert.equal(verified.registryHash, published.registryHash);
  assert.equal(verified.registry.baselineId, published.baselineId);
  assert.equal(published.selectionOut, verified.targetPlan);
  assert.equal(published.pricesOut, verified.priceOverrides);
  assert.equal(published.registrySelectionPlan, verified.targetPlan);
  assert.equal(published.registryPriceOverrides, verified.priceOverrides);
  assert.notEqual(published.selectionOut, registryFixture.selectionPath);
  assert.notEqual(published.pricesOut, registryFixture.pricesPath);
  const immutableSelection = JSON.parse(fs.readFileSync(verified.targetPlan, 'utf8'));
  const immutablePrices = JSON.parse(fs.readFileSync(verified.priceOverrides, 'utf8'));
  assert.equal(immutableSelection.planMetadata.status, 'current_baseline');
  assert.equal(immutablePrices.planMetadata.status, 'current_baseline');
  assert.equal(immutableSelection.baselineForNextOrdinaryActivity, true);
  assert.equal(immutablePrices.baselineForLimitedDiscountFallback, true);
  assert.equal(immutableSelection.planMetadata.supersededBy, null);
  assert.equal(immutablePrices.planMetadata.supersededBy, null);

  const registryFaultFixture = writeApprovalFixture(tempRoot, 'registry-fault', rows('registry-fault', stores.map((_, index) => index), 2));
  const registryFaultReadback = path.join(tempRoot, 'registry-fault-readback.json');
  writeReadback(registryFaultReadback, registryFaultFixture);
  const registryTransactionBefore = {
    sourceSelection: fs.readFileSync(registryFaultFixture.selectionPath),
    sourcePrices: fs.readFileSync(registryFaultFixture.pricesPath),
    current: fs.readFileSync(registryFile),
  };
  const registryPublishFault = run(ordinaryScript, [
    ...commonArgs(registryFaultFixture, registryFaultReadback, 'ordinary-registry-fault'),
    '--registry-file', registryFile,
  ], {
    cwd: tempRoot,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_current_pointer_replace',
    },
  });
  assert.notEqual(registryPublishFault.status, 0, 'registry post-replace fault must fail the promotion');
  assert.match(`${registryPublishFault.stdout}\n${registryPublishFault.stderr}`, /injected test fault: after_current_pointer_replace/i);
  assert.equal(fs.readFileSync(registryFile).equals(registryTransactionBefore.current), true,
    'registry failure must restore previous current pointer bytes');
  assert.equal(fs.readFileSync(registryFaultFixture.selectionPath).equals(registryTransactionBefore.sourceSelection), true,
    'registry failure must not change selection source bytes');
  assert.equal(fs.readFileSync(registryFaultFixture.pricesPath).equals(registryTransactionBefore.sourcePrices), true,
    'registry failure must not change prices source bytes');
  const verifiedAfterRegistryFault = verifyMarketingPlanRegistrySync({registryFile, registryRoot, expectedStoreKeys: stores});
  assert.equal(verifiedAfterRegistryFault.registryHash, published.registryHash,
    'previous current pointer must remain the authoritative verified registry after rollback');

  const interruptionFixture = writeApprovalFixture(tempRoot, 'registry-interruption', rows('registry-interruption', stores.map((_, index) => index), 3));
  const interruptionReadback = path.join(tempRoot, 'registry-interruption-readback.json');
  writeReadback(interruptionReadback, interruptionFixture);
  const interruptionBefore = {
    sourceSelection: fs.readFileSync(interruptionFixture.selectionPath),
    sourcePrices: fs.readFileSync(interruptionFixture.pricesPath),
    current: fs.readFileSync(registryFile),
  };
  const beforePointerInterruption = run(ordinaryScript, [
    ...commonArgs(interruptionFixture, interruptionReadback, 'ordinary-before-pointer-interruption'),
    '--registry-file', registryFile,
  ], {
    cwd: tempRoot,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_candidate_verify',
    },
  });
  assert.notEqual(beforePointerInterruption.status, 0, 'pre-pointer interruption must fail before current replacement');
  assert.match(`${beforePointerInterruption.stdout}\n${beforePointerInterruption.stderr}`, /injected test fault: after_candidate_verify/i);
  assert.equal(fs.readFileSync(interruptionFixture.selectionPath).equals(interruptionBefore.sourceSelection), true,
    'pre-pointer interruption must leave approved selection bytes unchanged');
  assert.equal(fs.readFileSync(interruptionFixture.pricesPath).equals(interruptionBefore.sourcePrices), true,
    'pre-pointer interruption must leave approved prices bytes unchanged');
  assert.equal(fs.readFileSync(registryFile).equals(interruptionBefore.current), true,
    'pre-pointer interruption must leave the old authoritative current pointer unchanged');
  const verifiedAfterInterruption = verifyMarketingPlanRegistrySync({registryFile, registryRoot, expectedStoreKeys: stores});
  assert.equal(verifiedAfterInterruption.registryHash, published.registryHash,
    'no staged or orphan material may become authoritative before current rename');

  const wrongStoreRows = rows('wrong-store-set');
  wrongStoreRows[0] = {...wrongStoreRows[0], storeKey: 'WRONG'};
  const wrongStoreFixture = writeApprovalFixture(tempRoot, 'wrong-store-set', wrongStoreRows);
  const wrongStoreReadback = path.join(tempRoot, 'wrong-store-readback.json');
  writeReadback(wrongStoreReadback, wrongStoreFixture);
  const wrongStoreRegistryFile = path.join(tempRoot, 'wrong-store-registry', 'current.json');
  const wrongStoreSelectionBefore = fs.readFileSync(wrongStoreFixture.selectionPath, 'utf8');
  const wrongStorePricesBefore = fs.readFileSync(wrongStoreFixture.pricesPath, 'utf8');
  const wrongStorePublish = run(ordinaryScript, [
    ...commonArgs(wrongStoreFixture, wrongStoreReadback, 'wrong-store-registry'),
    '--registry-file', wrongStoreRegistryFile,
  ], {cwd: tempRoot});
  assert.notEqual(wrongStorePublish.status, 0, 'registry promotion must reject a wrong 19-store set');
  assert.match(`${wrongStorePublish.stdout}\n${wrongStorePublish.stderr}`, /enabled store coverage mismatch/i);
  assert.equal(fs.existsSync(wrongStoreRegistryFile), false, 'wrong store set must not publish current');
  assert.equal(fs.readFileSync(wrongStoreFixture.selectionPath, 'utf8'), wrongStoreSelectionBefore);
  assert.equal(fs.readFileSync(wrongStoreFixture.pricesPath, 'utf8'), wrongStorePricesBefore);

  const compositeRows = rows('composite');
  const firstApproval = writeApprovalFixture(tempRoot, 'composite-first', compositeRows.slice(0, 9));
  const secondApproval = writeApprovalFixture(tempRoot, 'composite-second', compositeRows.slice(9));
  const compositeInput = writeApprovalFixture(tempRoot, 'composite-input', compositeRows);
  const compositeReadback = path.join(tempRoot, 'composite-readback.json');
  writeReadback(compositeReadback, compositeInput);
  const samePathBefore = fs.readFileSync(compositeInput.selectionPath, 'utf8');
  const samePathPricesBefore = fs.readFileSync(compositeInput.pricesPath, 'utf8');
  const compositeMissingIdentityReadback = path.join(tempRoot, 'composite-missing-plan-alignment-readback.json');
  writeReadback(compositeMissingIdentityReadback, compositeInput, compositeInput.rows, {withPlanAlignment: false});
  const compositeMissingIdentity = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeMissingIdentityReadback,
    '--batch', 'composite-missing-plan-alignment',
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(compositeMissingIdentity.status, 0, 'composite promotion must reject readback without planAlignment identity');
  assert.match(`${compositeMissingIdentity.stdout}\n${compositeMissingIdentity.stderr}`, /planAlignment exact identity is missing/i);
  assert.equal(fs.readFileSync(compositeInput.selectionPath, 'utf8'), samePathBefore,
    'composite missing identity must fail before selection write');
  assert.equal(fs.readFileSync(compositeInput.pricesPath, 'utf8'), samePathPricesBefore,
    'composite missing identity must fail before prices write');

  const compositePartialIdentityReadback = path.join(tempRoot, 'composite-partial-plan-alignment-readback.json');
  writeReadback(compositePartialIdentityReadback, compositeInput);
  const compositePartialIdentityDoc = JSON.parse(fs.readFileSync(compositePartialIdentityReadback, 'utf8'));
  delete compositePartialIdentityDoc.summary.planAlignment.workFingerprint;
  writeJson(compositePartialIdentityReadback, compositePartialIdentityDoc);
  const compositePartialIdentity = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositePartialIdentityReadback,
    '--batch', 'composite-partial-plan-alignment',
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(compositePartialIdentity.status, 0, 'composite promotion must reject partial planAlignment identity');
  assert.match(`${compositePartialIdentity.stdout}\n${compositePartialIdentity.stderr}`, /planAlignment\.workFingerprint exact hash binding is missing/i);
  assert.equal(fs.readFileSync(compositeInput.selectionPath, 'utf8'), samePathBefore,
    'composite partial identity must fail before selection write');
  assert.equal(fs.readFileSync(compositeInput.pricesPath, 'utf8'), samePathPricesBefore,
    'composite partial identity must fail before prices write');

  const samePathComposite = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.selectionPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeReadback,
    '--batch', 'composite-same-path',
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(samePathComposite.status, 0, 'composite promotion must reject one path for both documents');
  assert.match(`${samePathComposite.stdout}\n${samePathComposite.stderr}`, /must be different files/i);
  assert.equal(fs.readFileSync(compositeInput.selectionPath, 'utf8'), samePathBefore,
    'composite same-path rejection must happen before any write');
  assert.equal(fs.readFileSync(compositeInput.pricesPath, 'utf8'), samePathPricesBefore,
    'composite same-path rejection must preserve prices');
  const compositeMismatchSelectionBefore = fs.readFileSync(compositeInput.selectionPath, 'utf8');
  const compositeMismatchPricesBefore = fs.readFileSync(compositeInput.pricesPath, 'utf8');
  const compositeMismatchReadback = path.join(tempRoot, 'composite-same-size-mismatch-readback.json');
  writeReadback(compositeMismatchReadback, alternateFixture);
  const compositeSameSizeMismatch = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeMismatchReadback,
    '--batch', 'composite-same-size-mismatch',
    '--no-registry-publish',
  ], {cwd: tempRoot});
  assert.notEqual(compositeSameSizeMismatch.status, 0,
    'composite promotion must reject a clean readback from another same-size batch');
  assert.match(`${compositeSameSizeMismatch.stdout}\n${compositeSameSizeMismatch.stderr}`, /planAlignment\.(selectionPayloadHash|pricePayloadHash|workFingerprint) mismatch/i);
  assert.equal(fs.readFileSync(compositeInput.selectionPath, 'utf8'), compositeMismatchSelectionBefore);
  assert.equal(fs.readFileSync(compositeInput.pricesPath, 'utf8'), compositeMismatchPricesBefore);

  const compositeSecondWriteBefore = {
    selection: fs.readFileSync(compositeInput.selectionPath),
    prices: fs.readFileSync(compositeInput.pricesPath),
  };
  const compositeSecondWriteFault = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeReadback,
    '--batch', 'composite-second-output-fault',
    '--no-registry-publish',
  ], {
    cwd: tempRoot,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PROMOTION_TEST_FAULT: 'before_prices_output_rename',
    },
  });
  assert.notEqual(compositeSecondWriteFault.status, 0, 'composite second output fault must fail');
  assert.match(`${compositeSecondWriteFault.stdout}\n${compositeSecondWriteFault.stderr}`, /Injected promotion test fault before prices output rename/i);
  assert.equal(fs.readFileSync(compositeInput.selectionPath).equals(compositeSecondWriteBefore.selection), true,
    'composite second output fault must restore previous selection bytes');
  assert.equal(fs.readFileSync(compositeInput.pricesPath).equals(compositeSecondWriteBefore.prices), true,
    'composite second output fault must preserve previous prices bytes');

  const compositeOffline = parseOutput(run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeReadback,
    '--batch', 'composite-offline',
    '--no-registry-publish',
  ], {cwd: tempRoot}));
  assert.equal(compositeOffline.registryPublished, false);
  assert.equal(compositeOffline.authoritative, false);
  const compositeOfflineSelection = JSON.parse(fs.readFileSync(compositeInput.selectionPath, 'utf8'));
  const compositeOfflinePrices = JSON.parse(fs.readFileSync(compositeInput.pricesPath, 'utf8'));
  assert.equal(compositeOfflineSelection.planMetadata.status, 'offline_candidate');
  assert.equal(compositeOfflinePrices.planMetadata.status, 'offline_candidate');
  assert.equal(compositeOfflineSelection.baselineForNextOrdinaryActivity, false);
  assert.equal(compositeOfflinePrices.baselineForNextOrdinaryActivity, false);
  assert.equal(compositeOfflineSelection.baselineForLimitedDiscountFallback, false);
  assert.equal(compositeOfflinePrices.baselineForLimitedDiscountFallback, false);
  const compositeRegistryRoot = path.join(tempRoot, 'composite-registry');
  const compositeRegistryFile = path.join(compositeRegistryRoot, 'current.json');
  const compositeRegistrySourceBefore = {
    selection: fs.readFileSync(compositeInput.selectionPath),
    prices: fs.readFileSync(compositeInput.pricesPath),
  };
  const compositePublished = parseOutput(run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeReadback,
    '--batch', 'composite-registry',
    '--registry-file', compositeRegistryFile,
  ], {cwd: tempRoot}));
  assert.equal(compositePublished.registryPublished, true);
  assert.equal(compositePublished.authoritative, true);
  assert.equal(compositePublished.stagingCleanup.ok, true);
  assert.equal(fs.readFileSync(compositeInput.selectionPath).equals(compositeRegistrySourceBefore.selection), true,
    'successful composite registry promotion must not mutate selection source bytes');
  assert.equal(fs.readFileSync(compositeInput.pricesPath).equals(compositeRegistrySourceBefore.prices), true,
    'successful composite registry promotion must not mutate prices source bytes');
  const compositeVerified = verifyMarketingPlanRegistrySync({
    registryFile: compositeRegistryFile,
    registryRoot: compositeRegistryRoot,
    expectedStoreKeys: stores,
  });
  assert.equal(compositeVerified.registryHash, compositePublished.registryHash);
  assert.equal(compositePublished.selectionOut, compositeVerified.targetPlan);
  assert.equal(compositePublished.pricesOut, compositeVerified.priceOverrides);
  assert.notEqual(compositePublished.selectionOut, compositeInput.selectionPath);
  assert.notEqual(compositePublished.pricesOut, compositeInput.pricesPath);
  assert.equal(JSON.parse(fs.readFileSync(compositeVerified.targetPlan, 'utf8')).planMetadata.supersededBy, null);
  assert.equal(JSON.parse(fs.readFileSync(compositeVerified.priceOverrides, 'utf8')).planMetadata.supersededBy, null);

  const compositeRegistryFailureBefore = {
    selection: fs.readFileSync(compositeInput.selectionPath),
    prices: fs.readFileSync(compositeInput.pricesPath),
    current: fs.readFileSync(compositeRegistryFile),
  };
  const compositeRegistryFailure = run(compositeScript, [
    '--selection', compositeInput.selectionPath,
    '--prices', compositeInput.pricesPath,
    '--approval-manifest', firstApproval.approvalManifest,
    '--approval-manifest', secondApproval.approvalManifest,
    '--readback', compositeReadback,
    '--batch', 'composite-registry-fault',
    '--registry-file', compositeRegistryFile,
  ], {
    cwd: tempRoot,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_current_pointer_replace',
    },
  });
  assert.notEqual(compositeRegistryFailure.status, 0, 'composite registry failure must fail closed');
  assert.equal(fs.readFileSync(compositeInput.selectionPath).equals(compositeRegistryFailureBefore.selection), true,
    'failed composite registry promotion must not mutate selection source bytes');
  assert.equal(fs.readFileSync(compositeInput.pricesPath).equals(compositeRegistryFailureBefore.prices), true,
    'failed composite registry promotion must not mutate prices source bytes');
  assert.equal(fs.readFileSync(compositeRegistryFile).equals(compositeRegistryFailureBefore.current), true,
    'failed composite registry promotion must restore the previous current pointer');
  const compositeVerifiedAfterFailure = verifyMarketingPlanRegistrySync({
    registryFile: compositeRegistryFile,
    registryRoot: compositeRegistryRoot,
    expectedStoreKeys: stores,
  });
  assert.equal(compositeVerifiedAfterFailure.registryHash, compositePublished.registryHash);

  console.log(JSON.stringify({ok: true, checks: [
    'missing_registry_mode_fails_before_write',
    'both_registry_modes_fail_before_write',
    'ordinary_missing_plan_alignment_identity_fails_before_write',
    'ordinary_partial_plan_alignment_hashes_and_fingerprint_fail_before_write',
    'ordinary_missing_exact_plan_alignment_row_counts_fail_before_write',
    'ordinary_same_size_readback_mismatch_fails_closed',
    'offline_promotion_is_structurally_non_authoritative',
    'ordinary_second_output_fault_restores_pair_bytes',
    'registry_mode_rejects_mutable_output_options',
    'ordinary_registry_publish_uses_verified_immutable_pair_without_source_mutation',
    'registry_post_replace_fault_preserves_sources_and_previous_current_bytes',
    'pre_pointer_interruption_preserves_inputs_and_old_authoritative_current',
    'fixed_root_store_config_bound_outside_cwd',
    'wrong_store_set_rejected_before_write',
    'composite_missing_and_partial_plan_alignment_identity_fail_before_write',
    'composite_same_path_rejected_before_write',
    'composite_same_size_readback_mismatch_fails_closed',
    'composite_second_output_fault_restores_pair_bytes',
    'composite_offline_promotion_is_structurally_non_authoritative',
    'composite_registry_publish_uses_verified_immutable_pair_without_source_mutation',
    'composite_registry_failure_preserves_sources_and_previous_current',
  ]}, null, 2));
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
