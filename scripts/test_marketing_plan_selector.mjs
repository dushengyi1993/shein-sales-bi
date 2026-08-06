#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {parseMarketingDateMs, resolveCurrentMarketingPlanPair} from '../lib/marketing_plan_selector.mjs';

const shanghaiMidnight = Date.parse('2026-07-10T00:00:00+08:00');
assert.equal(parseMarketingDateMs('2026-07-10'), shanghaiMidnight, 'date-only values use Shanghai midnight');
assert.equal(parseMarketingDateMs('2026/7/10'), shanghaiMidnight, 'slash date-only values are normalized');
assert.equal(parseMarketingDateMs('2026-07-10 08:30:00'), Date.parse('2026-07-10T08:30:00+08:00'));
assert.equal(parseMarketingDateMs('2026-07-10T08:30:00Z'), Date.parse('2026-07-10T08:30:00Z'));
assert.equal(parseMarketingDateMs(''), 0);
assert.equal(parseMarketingDateMs('not-a-date'), 0);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-selector-'));
try {
  const signup = path.join(root, 'tmp', 'marketing-signup', '20260804-approved-locked');
  fs.mkdirSync(signup, {recursive: true});
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
  const shared = {
    baselineForNextOrdinaryActivity: true,
    planMetadata: {status: 'current_baseline'},
    items: rows,
  };
  const selection = path.join(signup, 'selection-plan-current.json');
  const prices = path.join(signup, 'price-overrides-current.json');
  fs.writeFileSync(selection, JSON.stringify(shared));
  fs.writeFileSync(prices, JSON.stringify(shared));
  const selected = resolveCurrentMarketingPlanPair({root, nowMs: Date.parse('2026-08-06T12:00:00+08:00')});
  assert.equal(selected.strategy, 'auto_latest_current_pair');
  assert.equal(selected.targetPlan, selection, 'dated/locked one-level runtime plan must be discovered');
  assert.equal(selected.priceOverrides, prices);
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

console.log('marketing_plan_selector: deterministic date parsing and nested current-plan selection passed');
