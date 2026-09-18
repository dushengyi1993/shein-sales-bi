#!/usr/bin/env node
// The marketing repair queue never reached a terminal state for ten days
// (2026-09-08..09-18) and the daily Feishu report was never sent, because a
// verified success was reported as a failure at four separate points in one
// chain. This test pins each link so the chain cannot silently regress.
//
// 1. A submit that reports `already_exactly_covered` performed no write, so it
//    must NOT be required to produce a post-submit enrollment readback.
//    Requiring one downgraded it to `submit_or_pre_submit_failed`.
// 2. A platform refusal must name its SKCs, otherwise the terminal-readiness
//    check can never account for the row.
// 3. The cloud lane must not hand its remaining queue back to a retired local
//    continuation.
// 4. An unhandled terminal state must still deliver the daily report, because
//    that report is the only channel naming what needs a human decision.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = rel => fs.readFile(new URL(rel, import.meta.url), 'utf8');

const transaction = await read('../lib/marketing_activity_inventory_transaction.mjs');
const batchApply = await read('../scripts/marketing/batch_apply_new_listing_limited_discount.mjs');
const worker = await read('../scripts/cloud_marketing_repair_worker.sh');
const checks = [];

// 1. no-write success must skip the post-submit readback requirement
assert.match(transaction, /const submitPerformedNoWrite = result\?\.full\?\.status === 'already_exactly_covered'/,
  'an already-covered submit must be recognised as a no-write success');
assert.match(transaction, /if \(!submitPerformedNoWrite\) evidence\.enrollmentReadback = await readEnrollment/,
  'the post-submit readback must be skipped when no write was performed');
assert.match(transaction, /submitPerformedNoWrite \? \{ok: true, noWriteRequired: true\} : validateEnrollment/,
  'the no-write success must not be validated against a fresh readback');
assert.ok(!/if \(submitPerformedNoWrite\) \{[\s\S]{0,400}?return evidence;/.test(transaction),
  'the no-write path must not early-return: the finally block releases inventory locks and restores stock');
checks.push('no_write_success_is_not_a_failure');

// 2. platform refusals must carry their SKCs into the terminal evidence
assert.match(batchApply, /function platformRefusedSkcs\(blocked, allowedSkcs = \[\]\)/,
  'platform refusals must be able to name their SKCs');
assert.match(batchApply, /\.\.\.platformRefusedSkcs\(blockedDryRun, record\.targetSkcs/,
  'the failure record must fold platform-refused SKCs into blockedSkcs');
assert.match(batchApply, /for \(const row of blocked\?\.unsafeExistingLimitedDiscounts \|\| \[\]\)/,
  'an activity holding out-of-plan SKCs is an operator-facing blocker that must name its target SKCs');
checks.push('platform_refusal_names_its_skcs');

// 3. the cloud lane owns its own continuation
assert.match(worker, /cloud lane keeps the exact queue for its next scheduled run/,
  'the cloud lane must keep its own remaining queue');
assert.ok(!/deferred_to_local \"\$message; remaining exact queue preserved for local-browser continuation\"/.test(worker),
  'the retired local-browser continuation must not be the cloud hand-back target');
checks.push('cloud_lane_owns_its_continuation');

// 4. unhandled rows must still be reported to the operator
assert.match(worker, /terminal_readiness_summary\(\)/,
  'the worker must be able to summarise unhandled rows');
assert.match(worker, /daily report delivered for operator decision/,
  'an unhandled terminal state must still deliver the daily report');
assert.match(worker, /--fallback-result \"\$ROOT\/outputs\/reports\/new-listing-7d-limited-discount-execution-summary-\$\{DATE\}\.json\"/,
  'the readiness summary must read the same evidence set as the readiness check');
checks.push('unhandled_rows_reach_the_daily_report');

console.log(JSON.stringify({ok: true, test: 'marketing_repair_terminal_chain_contract', checks}));

