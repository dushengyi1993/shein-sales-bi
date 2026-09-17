#!/usr/bin/env node
// The retire-link review proves a 15-day protection window from two independent
// sources: the per-day link documents under outputs/shein_links/<store>/ and the
// warehouse link facts. On 2026-09-17 the migrated host carried only
// 2026-09-14..16 of those documents, so the review could neither collect the
// formal evidence nor prove the window for 129 of 346 rows. This contract keeps
// the retention that the window depends on explicit and big enough.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WINDOW_DAYS = 15;
const MIN_RETENTION_DAYS = 16;
const DOCUMENTED_RETENTION_DAYS = 30;

const maintenance = read('scripts/cloud_disk_maintenance.sh');
const declared = maintenance.match(/OUTPUT_RETENTION_DAYS="\$\{SHEIN_BI_OUTPUT_RETENTION_DAYS:-(\d+)\}"/);
assert.ok(declared, 'the outputs retention default must be declared explicitly');
const retentionDays = Number(declared[1]);
assert.ok(retentionDays >= MIN_RETENTION_DAYS,
  `outputs retention ${retentionDays}d must at least cover the ${WINDOW_DAYS}-day protection window plus one day`);
assert.ok(retentionDays >= DOCUMENTED_RETENTION_DAYS,
  `the documented retention policy is ${DOCUMENTED_RETENTION_DAYS} days; got ${retentionDays}`);

// The window is declared in the shared policy and in the shipped collector.
for (const [label, source] of [
  ['lib/link_retire_review_evidence.mjs', read('lib/link_retire_review_evidence.mjs')],
  ['scripts/collect_link_retire_review_evidence.mjs', read('scripts/collect_link_retire_review_evidence.mjs')],
]) {
  const windowDays = Number((source.match(/const start = shiftDate\(runDate, -(\d+)\)/) || [])[1]);
  assert.equal(windowDays, WINDOW_DAYS, `${label} must keep the ${WINDOW_DAYS}-day protection window`);
  assert.ok(retentionDays > windowDays, `retention must exceed the protection window: ${retentionDays} vs ${windowDays}`);
}
// The inclusive 15-day rule is expressed as a cutoff of runDate - 14.
assert.match(read('lib/link_retire_review_evidence.mjs'), /const cutoff = shiftDate\(runDate, -14\)/, 'the protection cutoff must stay runDate - 14');

// Aged outputs are archived before deletion, and every unsafe path retains them.
assert.match(maintenance, /archive_dir="\$COS_ARCHIVE_ROOT\/\$archive_day"/, 'aged outputs must be archived, not deleted in place');
assert.match(maintenance, /if \[\[ "\$OFFSITE_ENABLED" == "0" \]\]; then[\s\S]*?old outputs retained[\s\S]*?return 0/, 'local-only mode must retain old outputs');
assert.match(maintenance, /if ! cos_ready; then[\s\S]*?local files retained[\s\S]*?return 0/, 'an unmounted archive target must retain old outputs');
assert.match(maintenance, /if \(\( DRY_RUN \)\); then[\s\S]*?local files retained/, 'a dry run must retain old outputs');

console.log(JSON.stringify({
  ok: true,
  test: 'link_retire_history_retention_contract',
  retentionDays,
  windowDays: WINDOW_DAYS,
  checks: ['outputs_retention_covers_protection_window', 'window_declared_in_policy_and_collector', 'aged_outputs_archived_never_deleted_in_place'],
}));
