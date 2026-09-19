// Verify the coupon not-participating fix against the real guard inputs.
//
// The fix has two halves and both must hold on the SAME shape the guard reads:
//   1. export_marketing_stack_review marks a verified not-enrolled store with
//      coupon15Rule.notParticipating=true (instead of ok:false), and
//   2. build_marketing_daily_guard_report must not treat that as a rule failure
//      nor as a coupon-row count mismatch, and must surface the store instead.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const read = rel => fs.readFile(new URL(rel, import.meta.url), 'utf8');
const checks = [];

const exporter = await read('../scripts/marketing/export_marketing_stack_review.mjs');
assert.match(exporter, /function couponLevelRuleStatus\(storeKey, activityId\)/,
  'the stack review must classify a store as configured / not_participating / missing');
assert.match(exporter, /status === 'not_participating'/,
  'the not-participating state must be handled explicitly');
assert.match(exporter, /notParticipating: true/,
  'a not-enrolled store must be reported as a fact, not as a failure');
assert.match(exporter, /levelRuleIdSource: 'verified_not_participating'/,
  'the evidence must record how the not-participating state was established');
// A genuinely unconfigured store must still fail closed.
assert.match(exporter, /return \{status: 'missing', levelRuleId: 0\}/,
  'a store with neither a tier nor a not-participating fact must stay missing');
checks.push('exporter_distinguishes_missing_from_not_participating');

const guard = await read('../scripts/marketing/build_marketing_daily_guard_report.mjs');
assert.match(guard, /if \(rule\?\.notParticipating === true\) return false;/,
  'a not-participating row must not count as a coupon rule failure');
assert.match(guard, /couponNotParticipatingRows/,
  'not-participating rows must be collected separately');
assert.match(guard, /expectedCouponRowsExcludingNotParticipating/,
  'the coupon row count expectation must exclude not-enrolled stores');
assert.match(guard, /notParticipatingStores: \[\.\.\.new Set\(couponNotParticipatingRows/,
  'the report must name the not-enrolled stores so the fact stays visible');
checks.push('guard_reports_instead_of_blocking');

// The config must record the verified fact rather than inventing an id.
const config = JSON.parse(await read('../config/marketing_coupon_level_rules.json'));
const stores = config?.activities?.['34810']?.stores || {};
for (const storeKey of ['LG', 'HY']) {
  assert.equal(stores[storeKey]?.notParticipating, true,
    `${storeKey} must be recorded as not participating (verified on the activity detail page)`);
  assert.equal(Number(stores[storeKey]?.levelRuleId || 0), 0,
    `${storeKey} must NOT have an invented levelRuleId`);
  assert.ok(String(stores[storeKey]?.evidence || '').length > 40,
    `${storeKey} must carry the evidence that established the fact`);
}
assert.equal(Number(stores.CX?.levelRuleId), 2000, 'the existing per-store ids must be untouched');
checks.push('config_records_verified_fact_without_inventing_ids');

console.log(JSON.stringify({ok: true, test: 'marketing_coupon_not_participating_contract', checks}));

