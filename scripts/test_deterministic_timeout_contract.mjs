#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const runner = fs.readFileSync(new URL('./run_deterministic_tests.mjs', import.meta.url), 'utf8');

assert.match(runner,
  /file === 'scripts\/test_link_ops_executor_source_detail_lock\.mjs'\s*\? 60_000/,
  'source-detail-lock must have an explicit bounded 60s CI tier');
assert.match(runner,
  /file === 'scripts\/test_link_ops_prepare_product_attribute_flow\.mjs'\s*\? 900_000/,
  'attribute flow must have an explicit bounded 900s CI tier');
assert.match(runner, /:\s*30_000;/,
  'unclassified deterministic tests must retain the default 30s fail-fast budget');
assert.match(runner, /spawnSync\(process\.execPath,[\s\S]*?timeout,/,
  'the per-test timeout must remain wired into spawnSync');

for (const evidence of ['PR #99', 'attempt 1', '30042ms', 'attempt 2', '26012ms', '720017ms', '24.7s', '709s']) {
  assert.ok(runner.includes(evidence), `timeout rationale must preserve measured evidence: ${evidence}`);
}

console.log(JSON.stringify({
  ok: true,
  checks: ['source_detail_60s', 'attribute_900s', 'default_30s', 'timeout_wired', 'ci_evidence_documented'],
}, null, 2));
