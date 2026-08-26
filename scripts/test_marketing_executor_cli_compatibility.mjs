#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findPersistedMarketingTransactionContinuation} from '../lib/cloud_marketing_deadline_contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  high: path.join(root, 'scripts/marketing/batch_apply_high_click_special_discounts.mjs'),
  manual: path.join(root, 'scripts/marketing/batch_restore_manual_limited_discounts.mjs'),
  drift: path.join(root, 'scripts/marketing/batch_fix_limited_discount_drift.mjs'),
  fallback: path.join(root, 'scripts/marketing/batch_apply_new_listing_limited_discount.mjs'),
  worker: path.join(root, 'scripts/cloud_marketing_repair_worker.sh'),
};
const source = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]));

for (const [key, value] of Object.entries(source).filter(([name]) => name !== 'worker')) {
  assert.doesNotMatch(value, /must be 0 or 1; one invocation may process at most one/,
    `${key} public CLI must accept its historical multi-unit max values`);
  assert.doesNotMatch(value, /required:\s*(?:args\.execute|!args\.dryRunOnly)/,
    `${key} execute mode must remain usable when neither deadline argument is supplied`);
}

assert.match(source.high,
  /let continuationEligible = resume\.eligible/,
  'high-click no-max mode must retain whole-batch semantics');
assert.match(source.manual,
  /let continuationFiles = pendingFiles/,
  'manual no-max mode must retain whole-batch semantics');
for (const key of ['drift', 'fallback']) {
  assert.match(source[key],
    /args\.maxGroups > 0 \? continuationEntries\.slice\(0, args\.maxGroups\) : continuationEntries/,
    `${key} no-max mode must retain whole-batch semantics`);
  assert.match(source[key],
    /let continuationEntries = pendingEntries/,
    `${key} normal no-max mode must retain the full pending batch before continuation filtering`);
}

for (const expected of [
  'batch_apply_high_click_special_discounts.mjs',
  'batch_restore_manual_limited_discounts.mjs',
]) {
  const start = source.worker.indexOf(`node scripts/marketing/${expected}`);
  const end = source.worker.indexOf('\n  status=$?', start);
  assert.ok(start >= 0 && end > start && /--max-items 1/.test(source.worker.slice(start, end)),
    `${expected} worker call must remain explicitly single-item`);
  assert.match(source.worker.slice(start, end), /EXECUTOR_CONTINUATION_ARGS/,
    `${expected} worker call must carry the graceful continuation flag chain`);
}
for (const expected of [
  'batch_fix_limited_discount_drift.mjs',
  'batch_apply_new_listing_limited_discount.mjs',
]) {
  const start = source.worker.indexOf(`node scripts/marketing/${expected}`);
  const end = source.worker.indexOf('\n  status=$?', start);
  assert.ok(start >= 0 && end > start && /--max-groups 1/.test(source.worker.slice(start, end)),
    `${expected} worker call must remain explicitly single-group`);
  assert.match(source.worker.slice(start, end), /EXECUTOR_CONTINUATION_ARGS/,
    `${expected} worker call must carry the graceful continuation flag chain`);
}

assert.match(source.high, /if \(args\.continuation\) \{\s*deadlineDeferred = true;\s*break;/,
  'high-click continuation must not create a new durable registration');
for (const key of ['manual', 'drift', 'fallback']) {
  assert.match(source[key], /findPersistedMarketingTransactionContinuation/,
    `${key} continuation must require persisted transaction evidence before group work`);
  assert.match(source[key], /execute && continuation \? \['--continuation'\] : \[\]/,
    `${key} must pass continuation through to the transactional child`);
  assert.match(source[key], /findPersistedMarketingTransactionContinuation\(\{[\s\S]{0,260}?rescuePath/,
    `${key} continuation finder must bind the individual rescue candidate`);
}

const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'marketing-cli-compat-'));
try {
  const registry = path.join(tempRoot, 'manual-registry.json');
  const missingGuard = path.join(tempRoot, 'missing-marketing-daily-guard-2099-01-01.json');
  const outDir = path.join(tempRoot, 'out');
  await fsp.writeFile(registry, '{"schemaVersion":1,"entries":[]}\n', 'utf8');

  const continuationRoot = path.join(tempRoot, 'continuation-root');
  const continuationJournalDir = path.join(continuationRoot, 'state', 'marketing-replacement-transactions');
  await fsp.mkdir(continuationJournalDir, {recursive: true});
  const workFingerprint = 'b'.repeat(64);
  const rescueCandidates = [];
  for (const suffix of ['first', 'second']) {
    const rescuePath = path.join(continuationRoot, `${suffix}.json`);
    await fsp.writeFile(rescuePath, `${JSON.stringify({storeKey: 'DL', rows: [{skc: `S-${suffix}`} ]})}\n`);
    const rescueHash = crypto.createHash('sha256').update(await fsp.readFile(rescuePath)).digest('hex');
    const transactionId = crypto.createHash('sha256').update(`DL\n${rescueHash}`).digest('hex').slice(0, 24);
    rescueCandidates.push({suffix, rescuePath, rescueHash, transactionId});
  }
  const second = rescueCandidates[1];
  const secondOperationPath = path.join(continuationRoot, 'inventory-executable-DL-second.json');
  await fsp.writeFile(secondOperationPath, `${JSON.stringify({storeKey: 'DL', rows: [{skc: 'S-second'}], parentRescue: 'second.json'})}\n`);
  const secondOperationHash = crypto.createHash('sha256').update(await fsp.readFile(secondOperationPath)).digest('hex');
  const exactScope = {
    storeKey: 'DL',
    transactionId: second.transactionId,
    rescuePath: path.relative(continuationRoot, secondOperationPath).replaceAll(path.sep, '/'),
    rescueHash: secondOperationHash,
    targetSkcs: ['S-second'],
  };
  const createAttempt = {
    schemaVersion: 1,
    operation: 'limited_discount_create',
    role: 'create_only',
    state: 'create_started',
    workFingerprint,
    exactScope,
  };
  createAttempt.operationId = crypto.createHash('sha256')
    .update(JSON.stringify({role: createAttempt.role, workFingerprint, exactScope}))
    .digest('hex');
  await fsp.writeFile(path.join(continuationJournalDir, `limited-discount-tx-DL-${second.transactionId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      storeKey: 'DL',
      transactionId: second.transactionId,
      rescuePath: path.relative(continuationRoot, second.rescuePath).replaceAll(path.sep, '/'),
      rescueHash: second.rescueHash,
      operationRescuePath: exactScope.rescuePath,
      operationRescueHash: secondOperationHash,
      runPayloadHash: workFingerprint,
      phase: 'desired_create_started',
      mutationsStarted: true,
      createAttempt,
    })}\n`);
  const matched = [];
  for (const candidate of rescueCandidates) {
    if (await findPersistedMarketingTransactionContinuation({
      root: continuationRoot,
      storeKey: 'DL',
      workFingerprint,
      rescuePath: candidate.rescuePath,
    })) matched.push(candidate.suffix);
  }
  assert.deepEqual(matched.slice(0, 1), ['second'],
    'same-store same-fingerprint max1 continuation selection must skip first and choose the exact second candidate with a journal');

  const base = [
    files.drift,
    '--guard', missingGuard,
    '--out-dir', outDir,
    '--skip-build-plan',
  ];
  const environment = {
    ...process.env,
    SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY: registry,
  };
  const cases = [
    {name: 'dry-run no max', args: []},
    {name: 'execute no max or deadline', args: ['--execute']},
    {name: 'dry-run multi-group max', args: ['--max-groups', '2']},
    {name: 'execute multi-group max without deadline', args: ['--execute', '--max-groups', '2']},
    {name: 'execute continuation full deadline pair', args: ['--execute', '--continuation', '--graceful-cutoff-epoch', String(Math.floor(Date.now() / 1000) - 1), '--outer-hard-deadline-epoch', String(Math.floor(Date.now() / 1000) + 1800)]},
  ];
  for (const testCase of cases) {
    const result = spawnSync(process.execPath, [...base, ...testCase.args], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.equal(result.error, undefined, `${testCase.name} spawn failed: ${result.error?.message || ''}`);
    assert.notEqual(result.status, 0, `${testCase.name} fixture must stop at the deliberately missing guard`);
    assert.match(output, /Guard report does not exist/,
      `${testCase.name} must parse successfully and reach the missing-guard boundary: ${output}`);
    assert.doesNotMatch(output, /max-groups must be 0 or 1|one invocation may process at most one|deadlines are required|must be supplied together/,
      `${testCase.name} must preserve the public CLI compatibility path: ${output}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const incompletePair = spawnSync(process.execPath, [
    ...base,
    '--execute',
    '--graceful-cutoff-epoch', String(now + 3600),
  ], {cwd: root, env: environment, encoding: 'utf8', timeout: 30000, windowsHide: true});
  assert.notEqual(incompletePair.status, 0);
  assert.match(`${incompletePair.stdout || ''}\n${incompletePair.stderr || ''}`,
    /graceful and outer hard deadlines must be supplied together/,
    'supplying either deadline must require the complete pair');
} finally {
  await fsp.rm(tempRoot, {recursive: true, force: true});
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    'four_public_cli_no_max_batch_semantics_preserved',
    'multi_group_dry_run_and_execute_arguments_remain_compatible',
    'deadline_pair_is_optional_together_and_required_when_partial',
    'worker_keeps_all_four_executor_invocations_at_max_one',
    'worker_and_four_parent_continuation_cli_chain_is_explicit_and_new_work_is_gated',
    'three_transaction_parents_bind_each_candidate_and_max1_selects_exact_second_journal',
  ],
}, null, 2));
