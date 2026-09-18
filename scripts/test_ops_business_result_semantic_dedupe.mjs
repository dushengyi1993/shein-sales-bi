#!/usr/bin/env node
// Same-day duplicate suppression for ops business deliveries.
//
// The delivery fingerprint is byte-based (automation + business date +
// attachment bytes). A stage that re-runs and reports the SAME situation still
// produces different bytes - it recomputes workFingerprint, payload hashes and
// result rows - so it gets a new fingerprint, a new Lark idempotency key and a
// new group message. On 2026-09-18 the hourly marketing repair run posted the
// identical marketing-manualSpecialRestore report three times (03:17, 04:48,
// 05:48), each naming the same unresolved LG/QY fixed_tier_preflight_failed
// blockers.
//
// Contract: a repeat whose reported semantics are unchanged is suppressed (and
// says so), while any real change - resolved item, removed item, changed date -
// is delivered, and an unknown/failed attempt never suppresses a later message.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';

import {
  opsResultSemanticDigest,
  stageAndDeliverBusinessResult,
} from '../lib/ops_business_result_pipeline.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-result-semantic-dedupe-'));
const automationId = 'marketing-manualSpecialRestore';
const businessDate = '2026-09-18';

function resultWith({rows = []} = {}) {
  return {
    status: 'blocked',
    results: rows,
    totals: {storesProcessed: rows.length, storesBlocked: rows.length, storesFailed: 0},
    dryRunOnly: false,
  };
}

const blockedRow = skc => ({
  storeKey: 'LG', skc, state: 'blocked', status: 'fixed_tier_preflight_failed', ok: false,
  error: 'fixed_tier_rule_or_evidence_changed_rebuild_required',
});
const resolvedRow = skc => ({storeKey: 'LG', skc, state: 'updated_readback_matched', status: 'ok', ok: true});

const SCKC_A = 'sv260910035977240606067';
const SCKC_B = 'sv260111174710113552585';

// The digest must ignore volatile scheduling fields by construction.
const base = resultWith({rows: [blockedRow(SCKC_A), blockedRow(SCKC_B)]});
const sameSemantics = {
  ...resultWith({rows: [blockedRow(SCKC_A), blockedRow(SCKC_B)]}),
  createdAt: '2026-09-18T05:48:00Z',
  workFingerprint: 'f'.repeat(64),
};
assert.equal(
  opsResultSemanticDigest({automationId, businessDate, result: base}),
  opsResultSemanticDigest({automationId, businessDate, result: sameSemantics}),
  'volatile scheduling fields must not change the semantic digest',
);
assert.notEqual(
  opsResultSemanticDigest({automationId, businessDate, result: base}),
  opsResultSemanticDigest({automationId, businessDate, result: resultWith({rows: [resolvedRow(SCKC_A), blockedRow(SCKC_B)]})}),
  'a resolved item must change the semantic digest',
);
assert.notEqual(
  opsResultSemanticDigest({automationId, businessDate, result: base}),
  opsResultSemanticDigest({automationId, businessDate, result: resultWith({rows: [blockedRow(SCKC_A)]})}),
  'a removed item must change the semantic digest',
);
assert.notEqual(
  opsResultSemanticDigest({automationId, businessDate, result: base}),
  opsResultSemanticDigest({automationId, businessDate: '2026-09-19', result: base}),
  'a different business date must change the semantic digest',
);

// Stub matching the real call shape (spawnImpl('lark-cli', args, opts) with the
// receipt JSON on stdout and a 'close' event), mirroring the factory the cloud
// delivery test already uses.
// One delivery round = one summary send plus one attachment send, so the stub
// counts lark-cli invocations and the assertions divide by two.
let larkCalls = 0;
const rounds = () => larkCalls / 2;
const spawnImpl = (bin, args, options) => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.resume();
  queueMicrotask(() => {
    larkCalls += 1;
    const output = JSON.stringify({ok: true, data: {message: {message_id: `om_${larkCalls}`}}});
    child.stdout.end(output);
    child.stderr.end('');
    child.emit('close', 0);
  });
  return child;
};

try {
  const call = result => stageAndDeliverBusinessResult({
    automationId,
    businessDate,
    result,
    attachmentName: 'marketing-manualSpecialRestore-2026-09-18.json',
    landingRoot: temp,
    spawnImpl,
    config: {recipientChatId: 'oc_semanticdedupe', defaultIdentity: 'bot'},
  });

  const first = await call(base);
  assert.equal(first.suppressed, false, 'the first delivery must not be suppressed');
  assert.equal(rounds(), 1, `the first delivery must reach the cloud channel (got ${rounds()} rounds)`);

  const repeat = await call(sameSemantics);
  assert.equal(repeat.suppressed, true, 'an unchanged situation must be suppressed');
  assert.equal(repeat.suppressionReason, 'unchanged_semantics_already_delivered');
  assert.equal(rounds(), 1, `the repeat must not reach the cloud channel (got ${rounds()} rounds)`);

  const progressed = await call(resultWith({rows: [resolvedRow(SCKC_A), blockedRow(SCKC_B)]}));
  assert.equal(progressed.suppressed, false, 'a changed situation must deliver');
  assert.equal(rounds(), 2, `the changed situation must reach the cloud channel (got ${rounds()} rounds)`);

  // An unknown attempt must never suppress a later real message.
  const unknownDigest = opsResultSemanticDigest({automationId, businessDate, result: resultWith({rows: [blockedRow(SCKC_A)]})});
  const unknownDir = path.join(temp, automationId, businessDate, 'b'.repeat(64));
  await fs.mkdir(unknownDir, {recursive: true});
  await fs.writeFile(path.join(unknownDir, 'state.json'), JSON.stringify({
    schemaVersion: 'cloud-team-report-state/v1',
    automationId, businessDate, status: 'unknown', semanticDigest: unknownDigest,
    items: {summary: {accepted: false, unknown: true}, attachment: {accepted: false, unknown: true}},
  }), 'utf8');
  const afterUnknown = await call(resultWith({rows: [blockedRow(SCKC_A)]}));
  assert.equal(afterUnknown.suppressed, false, 'an unknown delivery must not suppress a later message');
  assert.equal(rounds(), 3, `the later message must reach the cloud channel (got ${rounds()} rounds)`);

  console.log(JSON.stringify({ok: true, test: 'ops_business_result_semantic_dedupe', checks: [
    'digest_ignores_volatile_fields',
    'digest_tracks_item_and_date_changes',
    'unchanged_situation_suppressed',
    'changed_situation_delivered',
    'unknown_delivery_does_not_suppress',
  ]}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
