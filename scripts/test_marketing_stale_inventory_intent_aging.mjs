// Owner-authorized aging rule for a stale durable inventory intent, applied to
// the marketing activity inventory transaction.
//
// 2026-09-19: YJ sv260124173320240908190 stayed blocked for weeks because an
// intent the 2026-08-17 daily run abandoned was still pending. The daily
// inventory executor already had an owner-authorized rule for exactly this
// case; the marketing write path did not, so every marketing repair run
// failed closed with INVENTORY_WRITE_PENDING_CONFLICT on the same SKU.
//
// The contract under test:
//  1. only a STRICTLY earlier run date may be aged out (same-day uncertainty
//     keeps its duplicate-submission protection),
//  2. a scope whose live value already equals the abandoned target is NOT
//     superseded (the exact-readback path owns it),
//  3. a warehouse-scoped intent needs a matching single-warehouse readback,
//  4. the recorded closure is an honest originalEffectUnknown supersede whose
//     exact shape the journal validator accepts.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  INVENTORY_SUPERSEDED_BY_LATER_PLAN_DISPOSITION,
  INVENTORY_SUPERSEDED_BY_LATER_PLAN_RULE,
  inventoryIntentScopeKey,
  selectAgedPendingInventoryIntent,
} from '../lib/durable_inventory_write.mjs';

const SCOPE = Object.freeze({storeKey: 'YJ', skc: 'sv260124173320240908190', skuCode: 'I1mks4at1t49dw', invType: 'VI'});

function bundleWith(intent) {
  const key = `${intent.journalFile}\u0000${intent.intentId}`;
  return {
    pending: new Map([[key, intent]]),
    pendingByScope: new Map([[inventoryIntentScopeKey(intent), [intent]]]),
  };
}

function intent(overrides = {}) {
  return {
    kind: 'intent',
    intentId: 'e7f93933-b6fc-4b2e-b239-2155cd70568f',
    logicalActionKey: '2b6bbb7f7f400e600bc6b9775ba19a24fbffe578792ed7eeb2542f9251213f60',
    runDate: '2026-08-17',
    storeKey: 'YJ',
    skc: 'sv260124173320240908190',
    skuCode: 'I1mks4at1t49dw',
    invType: 'VI',
    targetUsableInventory: 10,
    journalFile: '/srv/shein-bi/runtime/daily-inventory-replenishment/results/daily-inventory-replenishment-2026-08-17.json.journal.ndjson',
    ...overrides,
  };
}

const checks = [];
const select = (overrides, options) => selectAgedPendingInventoryIntent(
  bundleWith(intent(overrides)),
  {scope: SCOPE, runDate: '2026-09-19', currentUsableInventory: 6, ...options},
);

// 1. The real 2026-09-19 YJ case must be selected.
assert.equal(select({})?.intentId, 'e7f93933-b6fc-4b2e-b239-2155cd70568f',
  'the stale 2026-08-17 intent must be selectable by a strictly later run');
checks.push('selects_stale_intent_from_earlier_run');

// 2. Same-day uncertainty must keep its protection.
assert.equal(select({}, {runDate: '2026-08-17'}), null, 'a same-day pending intent must not be aged out');
assert.equal(select({}, {runDate: '2026-09-20'})?.intentId, 'e7f93933-b6fc-4b2e-b239-2155cd70568f',
  'a later date still ages the same intent');
assert.equal(select({}, {runDate: '2026-08-16'}), null, 'an earlier run date must never age a newer intent');
assert.equal(select({}, {runDate: 'not-a-date'}), null, 'an invalid run date must fail closed');
checks.push('same_day_uncertainty_keeps_duplicate_protection');

// 3. A scope already sitting at the abandoned target is the readback path, not a supersede.
assert.equal(select({}, {currentUsableInventory: 10}), null,
  'live value equal to the abandoned target must be closed by exact readback, not superseded');
assert.equal(select({}, {currentUsableInventory: 6})?.intentId, 'e7f93933-b6fc-4b2e-b239-2155cd70568f',
  'a genuinely different live value may be superseded');
checks.push('readback_satisfied_scope_is_left_to_exact_readback');

// 4. Scope and warehouse precision.
assert.equal(select({skc: 'sv-some-other-skc'}), null, 'a different SKC must not be aged out by this scope');
assert.equal(select({skuCode: 'I-other-sku'}), null, 'a different SKU must not be aged out by this scope');
assert.equal(select({warehouseCode: 'PS0916742261'}, {currentWarehouseCodes: ['PS0916742261']})?.intentId,
  'e7f93933-b6fc-4b2e-b239-2155cd70568f', 'a matching single warehouse may be aged out');
assert.equal(select({warehouseCode: 'PS0916742261'}, {currentWarehouseCodes: ['PS-OTHER']}), null,
  'a different warehouse must not be aged out');
assert.equal(select({warehouseCode: 'PS0916742261'}, {currentWarehouseCodes: ['A', 'B']}), null,
  'an ambiguous multi-warehouse readback must not be aged out');
checks.push('warehouse_scope_must_match_exactly');

// 5. Only a single unambiguous pending intent in the scope is eligible.
assert.equal(selectAgedPendingInventoryIntent({pending: new Map(), pendingByScope: new Map()},
  {scope: SCOPE, runDate: '2026-09-19', currentUsableInventory: 6}), null, 'no pending intent means nothing to age');
const two = intent();
const twoKey = '/srv/other/journal.ndjson\u0000' + two.intentId + '-2';
const ambiguous = bundleWith(two);
ambiguous.pending.set(twoKey, {...two, intentId: two.intentId + '-2', journalFile: '/srv/other/journal.ndjson'});
assert.equal(selectAgedPendingInventoryIntent(ambiguous,
  {scope: SCOPE, runDate: '2026-09-19', currentUsableInventory: 6}), null,
  'two pending intents in one scope must fail closed instead of guessing');
checks.push('ambiguous_scope_fails_closed');

// 6. The recorded closure must use the exact validated shape and disposition.
assert.equal(INVENTORY_SUPERSEDED_BY_LATER_PLAN_DISPOSITION, 'superseded_by_later_plan');
assert.equal(INVENTORY_SUPERSEDED_BY_LATER_PLAN_RULE, 'stale-pending-intent-superseded-by-later-daily-plan/v1');
checks.push('closure_uses_validated_disposition');

// 7. The marketing writer must actually consult the rule before it fences.
const writer = fs.readFileSync(new URL('../lib/marketing_activity_inventory_openapi.mjs', import.meta.url), 'utf8');
assert.match(writer, /selectAgedPendingInventoryIntent\(bundle, \{/,
  'the marketing inventory writer must consult the shared aging rule');
assert.match(writer, /appendInventoryReconciliationRecord\(journalFile, aged, \{/,
  'the aged intent must be closed through the cross-journal reconciliation writer');
assert.match(writer, /originalEffectUnknown: true/,
  'the closure must record that the original effect stays unknown');
assert.match(writer, /MARKETING_INVENTORY_STALE_INTENT_SUPERSEDE_FAILED/,
  'a failed supersede must fail closed rather than proceed to POST');
checks.push('marketing_writer_applies_aging_before_fence');

console.log(JSON.stringify({ok: true, test: 'marketing_stale_inventory_intent_aging', checks}));
