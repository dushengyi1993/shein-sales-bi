#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  discoverOfflineMarketingPlanPair,
  parseMarketingDateMs,
  resolveCurrentMarketingPlanPair,
} from '../lib/marketing_plan_selector.mjs';
import {validateMarketingPlanPairDocuments} from '../lib/marketing_plan_registry.mjs';

const shanghaiMidnight = Date.parse('2026-07-10T00:00:00+08:00');
assert.equal(parseMarketingDateMs('2026-07-10'), shanghaiMidnight, 'date-only values use Shanghai midnight');
assert.equal(parseMarketingDateMs('2026/7/10'), shanghaiMidnight, 'slash date-only values are normalized');
assert.equal(parseMarketingDateMs('2026-07-10 08:30:00'), Date.parse('2026-07-10T08:30:00+08:00'));
assert.equal(parseMarketingDateMs('2026-07-10T08:30:00Z'), Date.parse('2026-07-10T08:30:00Z'));
assert.equal(parseMarketingDateMs(''), 0);
assert.equal(parseMarketingDateMs('not-a-date'), 0);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-selector-'));
const registryEnvKey = 'SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE';
const savedRegistryEnv = process.env[registryEnvKey];
delete process.env[registryEnvKey];
try {
  fs.mkdirSync(path.join(root, 'config'), {recursive: true});
  const stores = Array.from({length: 19}, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
  fs.writeFileSync(path.join(root, 'config', 'stores.json'), JSON.stringify({stores: stores.map(storeKey => ({storeKey}))}));
  const rows = Array.from({length: 114}, (_, i) => ({
    storeKey: stores[i % stores.length],
    activityId: 50000 + (i % 3),
    skc: `sv${String(i).padStart(8, '0')}`,
    eventStart: '2026-08-01 00:00:00',
    eventEnd: '2026-08-31 23:59:59',
  }));
  function validPairDocuments(selectionRows = rows, priceRows = selectionRows, {
    status = 'current_baseline',
    executionStatus = 'completed',
  } = {}) {
    const initial = validateMarketingPlanPairDocuments({
      selection: {items: selectionRows},
      prices: {items: priceRows},
      requireCurrentBaseline: false,
      expectedStoreCount: 19,
    });
    const planMetadata = {
      status,
      supersededBy: null,
      activityBatch: 'selector-fixture-batch',
      promotedAt: '2026-08-01T00:00:00.000Z',
      selectionPayloadHash: initial.selectionPayloadHash,
      pricePayloadHash: initial.pricePayloadHash,
      workFingerprint: initial.workFingerprint,
    };
    const decorate = items => ({
      baselineForNextOrdinaryActivity: true,
      baselineForLimitedDiscountFallback: true,
      executionStatus,
      planMetadata,
      items,
    });
    return {selection: decorate(selectionRows), prices: decorate(priceRows)};
  }

  function writePair(directory, name, options = {}) {
    const pair = validPairDocuments(rows, options.priceRows || rows, options);
    fs.mkdirSync(directory, {recursive: true});
    const selection = path.join(directory, `selection-plan-${name}.json`);
    const prices = path.join(directory, `price-overrides-${name}.json`);
    fs.writeFileSync(selection, `${JSON.stringify(pair.selection)}\n`);
    fs.writeFileSync(prices, `${JSON.stringify(pair.prices)}\n`);
    return {selection, prices};
  }

  const signup = path.join(root, 'tmp', 'marketing-signup', '20260804-approved-locked');
  const qualified = writePair(signup, 'qualified');
  const newer = writePair(
    path.join(root, 'tmp', 'marketing-signup', '20260805-newer-qualified'),
    'newer-qualified',
  );
  const newerMtime = new Date(Date.now() + 60_000);
  fs.utimesSync(newer.selection, newerMtime, newerMtime);
  fs.utimesSync(newer.prices, newerMtime, newerMtime);

  assert.throws(() => resolveCurrentMarketingPlanPair({
    root,
    nowMs: Date.parse('2026-08-06T12:00:00+08:00'),
  }), /verified durable registry.*current\.json|registry is not configured/i,
  'a qualified newer tmp pair must not be selected without a durable registry');

  const explicit = resolveCurrentMarketingPlanPair({
    root,
    targetPlan: qualified.selection,
    priceOverrides: qualified.prices,
    targetPlanExplicit: true,
    priceOverridesExplicit: true,
  });
  assert.equal(explicit.strategy, 'explicit_both');
  assert.equal(explicit.targetPlan, path.resolve(qualified.selection));
  assert.equal(explicit.priceOverrides, path.resolve(qualified.prices));

  const offline = writePair(
    path.join(root, 'tmp', 'marketing-signup', '20260806-offline-interrupted'),
    'offline-interrupted',
    {status: 'offline_candidate'},
  );
  assert.throws(() => resolveCurrentMarketingPlanPair({
    root,
    targetPlan: offline.selection,
    priceOverrides: offline.prices,
    targetPlanExplicit: true,
    priceOverridesExplicit: true,
  }), /current_baseline|offline_candidate/i,
  'explicit offline_candidate material must be rejected');

  const pending = writePair(
    path.join(root, 'tmp', 'marketing-signup', '20260807-pending'),
    'pending',
    {executionStatus: 'pending_execution'},
  );
  assert.throws(() => resolveCurrentMarketingPlanPair({
    root,
    targetPlan: pending.selection,
    priceOverrides: pending.prices,
    targetPlanExplicit: true,
    priceOverridesExplicit: true,
  }), /executionStatus.*completed|pending_execution/i,
  'explicit pending material must be rejected');

  const incomplete = writePair(
    path.join(root, 'tmp', 'marketing-signup', '20260808-incomplete'),
    'incomplete',
    {executionStatus: 'incomplete'},
  );
  const incompletePrices = JSON.parse(fs.readFileSync(incomplete.prices, 'utf8'));
  incompletePrices.items.pop();
  fs.writeFileSync(incomplete.prices, `${JSON.stringify(incompletePrices)}\n`);
  assert.throws(() => resolveCurrentMarketingPlanPair({
    root,
    targetPlan: incomplete.selection,
    priceOverrides: incomplete.prices,
    targetPlanExplicit: true,
    priceOverridesExplicit: true,
  }), /pair key mismatch|row count mismatch|executionStatus.*completed/i,
  'explicit incomplete material must be rejected');

  const offlineDiscovery = discoverOfflineMarketingPlanPair({
    root,
    nowMs: Date.parse('2026-08-06T12:00:00+08:00'),
  });
  assert.equal(offlineDiscovery.strategy, 'offline_non_authoritative');
  assert.equal(offlineDiscovery.authority, 'offline');
  assert.equal(offlineDiscovery.authoritative, false);
  assert.equal(offlineDiscovery.isCurrent, false);
  assert.equal(offlineDiscovery.current, false);
  assert.match(offlineDiscovery.currentSource, /tmp\/marketing-signup-mtime-discovery/);
  assert.ok(offlineDiscovery.rejectedCandidates.some(candidate => (
    String(candidate.targetPlan || '').endsWith('selection-plan-offline-interrupted.json')
    && candidate.rejectReasons.includes('plan_metadata_offline_candidate')
  )), 'offline_candidate must remain rejected during offline discovery');

  fs.rmSync(qualified.selection);
  fs.rmSync(qualified.prices);
  fs.rmSync(newer.selection);
  fs.rmSync(newer.prices);
  fs.rmSync(pending.selection);
  fs.rmSync(pending.prices);
  fs.rmSync(incomplete.selection);
  fs.rmSync(incomplete.prices);
  assert.throws(() => discoverOfflineMarketingPlanPair({
    root,
    nowMs: Date.parse('2026-08-06T12:00:00+08:00'),
  }), /No non-authoritative offline.*never establishes a current plan/i,
  'offline_candidate must not be returned as an offline current plan');

} finally {
  if (savedRegistryEnv === undefined) delete process.env[registryEnvKey];
  else process.env[registryEnvKey] = savedRegistryEnv;
  fs.rmSync(root, {recursive: true, force: true});
}

console.log('marketing_plan_selector: fail-closed registry resolution, explicit pair validation, and offline separation passed');
