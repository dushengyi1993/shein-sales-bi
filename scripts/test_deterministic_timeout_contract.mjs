#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const runnerUrl = new URL('./run_deterministic_tests.mjs', import.meta.url);
const runnerFile = fileURLToPath(runnerUrl);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = fs.readFileSync(runnerUrl, 'utf8');
const releaseGate = fs.readFileSync(new URL('./test_bi_ops_release_gate.mjs', import.meta.url), 'utf8');
const ciWorkflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const productAttributeFlowTest = 'scripts/test_link_ops_prepare_product_attribute_flow.mjs';
const releaseGateTest = 'scripts/test_bi_ops_release_gate.mjs';
const ownershipBaseline = Object.freeze({
  directCalls: 49,
  directUnique: 41,
  intersection: 19,
});
const requiredPortalTests = [
  'scripts/test_bi_portal_external_queue_reconciliation.mjs',
  'scripts/test_bi_portal_core_run_identity.mjs',
];
const requiredRunnerTests = [
  ...requiredPortalTests,
  'scripts/test_order_closure_idempotency.mjs',
  'scripts/test_morning_metric_refetch.mjs',
];
const intentionalManualTests = Object.freeze({
  'scripts/test_bi_portal_section_enqueue_coalescing.mjs': 'manual: queue coalescing requires an isolated Portal fixture.',
  'scripts/test_link_ops_docx_ingestion.mjs': 'manual: DOCX ingestion depends on operator-provided document fixtures.',
  'scripts/test_link_ops_exact_source_hazard_gate.mjs': 'manual: hazard-gate validation requires a reviewed source fixture.',
  'scripts/test_link_ops_exact_source_input_current_projection.mjs': 'manual: current-source projection requires a live reviewed input.',
  'scripts/test_link_ops_job_worker_shutdown.mjs': 'manual: worker shutdown owns process teardown outside deterministic shards.',
  'scripts/test_sk270_cloud_handoff_plan.mjs': 'manual: cloud handoff planning is approval-gated and non-automated.',
});
const directTestsTransferredToDeterministicShards = [
  'scripts/test_bi_ops_chat_action_matrix.mjs',
  'scripts/test_bi_ops_chat_inference.mjs',
  'scripts/test_bi_ops_cli_flow.mjs',
  'scripts/test_bi_ops_frontend_confirm_feedback.mjs',
  'scripts/test_bi_ops_permissions.mjs',
  'scripts/test_bi_ops_portal_shell_sync.mjs',
  'scripts/test_bi_ops_task_projection.mjs',
  'scripts/test_bi_portal_mutation_queue.mjs',
  'scripts/test_bi_portal_repository_crud.mjs',
  'scripts/test_bi_runtime_shutdown_lifecycle.mjs',
  'scripts/test_link_ops_executor_live_source_titles.mjs',
  'scripts/test_link_ops_executor_source_detail_lock.mjs',
  'scripts/test_link_ops_image_role_planner.mjs',
  'scripts/test_link_ops_preflight_product_lock.mjs',
  'scripts/test_link_retire_candidate_policy.mjs',
  'scripts/test_link_retire_candidates_from_csv.mjs',
  'scripts/test_portal_security.mjs',
  'scripts/test_retire_supplier_code_repair_payload.mjs',
  'scripts/test_shein_store_identity_merchant_fallback.mjs',
];

function extractDeterministicRunnerTests(source) {
  const block = String(source || '').match(/const tests = \[([\s\S]*?)\r?\n\];/u)?.[1] || '';
  return [...block.matchAll(/['"](scripts\/test_[^'"]+\.mjs)['"]/gu)].map(match => match[1]);
}

function extractAllRunnerRegistrations(source) {
  const block = String(source || '').match(/const tests = \[([\s\S]*?)\r?\n\];/u)?.[1] || '';
  return [...block.matchAll(/['"](scripts\/[^'"]+\.mjs)['"]/gu)].map(match => match[1]);
}

function enumerateDiskTestFiles() {
  const scriptsDirectory = fileURLToPath(new URL('./', import.meta.url));
  return fs.readdirSync(scriptsDirectory, {withFileTypes: true})
    .filter(entry => entry.isFile() && /^test_.*\.mjs$/u.test(entry.name))
    .map(entry => `scripts/${entry.name}`)
    .sort();
}

function readRunnerManifest(shard = '1/1') {
  const result = spawnSync(process.execPath, [runnerFile, '--list', '--shard', shard], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0,
    `deterministic runner manifest ${shard} must be readable: ${result.stderr || result.error?.message || ''}`);
  let manifest;
  assert.doesNotThrow(() => { manifest = JSON.parse(result.stdout); },
    `deterministic runner manifest ${shard} must be valid JSON`);
  assert.equal(manifest?.ok, true, `deterministic runner manifest ${shard} must report ok=true`);
  assert.equal(manifest?.shard, shard, `deterministic runner manifest ${shard} must preserve shard identity`);
  assert.ok(Array.isArray(manifest?.tests), `deterministic runner manifest ${shard} must list tests`);
  return manifest;
}

function extractDirectReleaseGateTestInvocations(source) {
  const pattern = /\brun\s*\(\s*process\.execPath\s*,\s*\[\s*['"](scripts\/test_[^'"]+\.mjs)['"]/gu;
  return [...String(source || '').matchAll(pattern)].map(match => match[1]);
}

function extractWorkflowJobBlock(source, jobName) {
  const lines = String(source || '').split(/\r?\n/u);
  const start = lines.findIndex(line => line === '  ' + jobName + ':');
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^  [a-zA-Z0-9_-]+:\s*$/u.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

function countLiteral(source, literal) {
  return String(source || '').split(literal).length - 1;
}

function countDirectProductAttributeFlowInvocations(source) {
  const escapedTarget = productAttributeFlowTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetExpression = `(?:PRODUCT_ATTRIBUTE_FLOW_TEST|['"]${escapedTarget}['"])`;
  const pattern = new RegExp(
    `\\brun\\s*\\(\\s*process\\.execPath\\s*,\\s*\\[\\s*${targetExpression}(?=\\s*(?:,|\\]))`,
    'gu',
  );
  return [...String(source || '').matchAll(pattern)].length;
}

function extractTimeoutChain(source) {
  const match = String(source || '').match(/const timeout\s*=\s*([\s\S]*?);[\s\S]*?console\.error/u);
  return match ? match[1] : '';
}

function evaluateRunnerTimeout(source, file, platform) {
  const chain = extractTimeoutChain(source);
  assert.ok(chain, 'timeout tier chain must be extractable from the deterministic runner');
  const overrides = source.match(/const V6_TEST_TIMEOUTS = (\{[\s\S]*?\n\});/u)?.[1];
  assert.ok(overrides, 'V6 per-file timeout overrides must be extracted from the actual runner');
  return new Function('file', 'process', 'const V6_TEST_TIMEOUTS = ' + overrides + '; return (' + chain + ');')(file, {platform});
}

const testsBlock = runner.match(/const tests = \[([\s\S]*?)\n\];/u)?.[1] || '';
const productAttributeRegistrationCount = testsBlock.split(`'${productAttributeFlowTest}'`).length - 1;
const productAttributeTimeoutRegistered = /file === 'scripts\/test_link_ops_prepare_product_attribute_flow\.mjs'\s*\? 1_800_000/.test(runner);
const registrationGuardPasses = source => productAttributeRegistrationCount === 1
  && productAttributeTimeoutRegistered
  && countDirectProductAttributeFlowInvocations(source) === 0;
const deterministicTests = extractDeterministicRunnerTests(runner);
const allRunnerRegistrations = extractAllRunnerRegistrations(runner);
const diskTestFiles = enumerateDiskTestFiles();
const diskTestSet = new Set(diskTestFiles);
const manualTestFiles = Object.keys(intentionalManualTests);
const manualTestSet = new Set(manualTestFiles);
const canonicalManifest = readRunnerManifest();
const canonicalDeterministicTests = canonicalManifest.tests.filter(file => /^scripts\/test_/u.test(file));
const shardManifests = [1, 2, 3, 4].map(index => readRunnerManifest(`${index}/4`));
const shardedTests = shardManifests.flatMap(manifest => manifest.tests);
const directInvocations = extractDirectReleaseGateTestInvocations(releaseGate);
const deterministicSet = new Set(deterministicTests);
const directSet = new Set(directInvocations);
const ownershipIntersection = [...deterministicSet].filter(file => directSet.has(file)).sort();
const ownershipUnion = new Set([...deterministicSet, ...directSet, releaseGateTest]);
const coverageOwners = [
  ['canonical deterministic runner', deterministicSet],
  ['direct release-gate invocation', directSet],
  ['dedicated release-gate job', new Set([releaseGateTest])],
  ['intentional manual allowlist', manualTestSet],
];
const coverageUnion = new Set(coverageOwners.flatMap(([, files]) => [...files]));
const releaseGateJob = extractWorkflowJobBlock(ciWorkflow, 'release-gate');
const ciTerminalJob = extractWorkflowJobBlock(ciWorkflow, 'ci-terminal');
const releaseGateCiCommand = 'node ' + releaseGateTest;
const releaseGateBuildCommand = 'npm run build:portal-shell';

assert.match(runner,
  /file === 'scripts\/test_link_ops_executor_source_detail_lock\.mjs'\s*\? 60_000/,
  'source-detail-lock must have an explicit bounded 60s CI tier');
assert.match(runner,
  /file === 'scripts\/test_link_ops_prepare_descriptions_flow\.mjs'\s*\? 300_000/,
  'description flow must have an explicit bounded 300s CI tier');
assert.match(runner,
  /file === 'scripts\/test_link_ops_prepare_product_attribute_flow\.mjs'\s*\? 1_800_000/,
  'attribute flow must have an explicit bounded 1800s CI tier');
assert.equal(productAttributeRegistrationCount, 1,
  'attribute flow must be registered exactly once in the deterministic tests block');
assert.match(runner,
  /file === 'scripts\/test_bi_query_surface_isolation\.mjs'\s*\? 240_000/,
  'BI query surface isolation must have an explicit bounded 240s CI tier');
assert.match(runner,
  /file === 'scripts\/test_bi_portal_core_warmup_queue_owned\.mjs'\s*\? 120_000/,
  'portal warmup queue-owned must have an explicit bounded 120s CI tier');
assert.match(runner,
  /file === 'scripts\/test_morning_coordinator_portal_async\.mjs'\s*\? 120_000/,
  'morning coordinator portal async must have an explicit bounded 120s CI tier');
assert.match(runner,
  /file === 'scripts\/test_bi_ops_cli_flow\.mjs'\s*\? 90_000/,
  'bi ops CLI flow must have an explicit bounded 90s CI tier');
assert.match(runner,
  /file === 'scripts\/test_partner_cli_version_change\.mjs'\s*\? 60_000/,
  'partner CLI version-change integration must have an explicit bounded 60s CI tier');
assert.match(runner,
  /file === 'scripts\/test_et_forwarder_runtime_contract\.mjs'\s*\? 60_000/,
  'ET forwarder runtime contract must have an explicit bounded 60s CI tier');
assert.match(runner,
  /process\.platform\s*===\s*['"]win32['"]\s*\?\s*2_400_000\s*:\s*1_800_000/,
  'runtime layout migration margin must be an exact win32-gated ternary (2.4M local / 1.8M elsewhere)');
// Runtime-layout migration release-gate margin: the latest complete pass took
// 1,791,363ms against the 1,800,000ms gate, leaving under 10s of margin. The
// runner gives local Windows/Git Bash a bounded 2,400,000ms margin and every
// other platform (including the GitHub Linux CI) the unchanged 1,800,000ms
// gate, while TEST_ESTIMATES_MS stays 1,800,000 for shard balancing (locked by
// the estimate assertion below). These assertions evaluate the actual tier
// chain, so the proof is exact and cannot silently widen any other gate.
const migrationFile = 'scripts/test_migrate_cloud_runtime_mount_layout.mjs';
assert.equal(evaluateRunnerTimeout(runner, migrationFile, 'win32'), 2_400_000,
  'runtime layout migration must get the bounded 2.4M local Windows/Git Bash margin');
assert.equal(evaluateRunnerTimeout(runner, migrationFile, 'linux'), 1_800_000,
  'runtime layout migration must keep the bounded 1.8M gate on Linux CI (30 minutes)');
assert.equal(evaluateRunnerTimeout(runner, migrationFile, 'darwin'), 1_800_000,
  'runtime layout migration must keep the bounded 1.8M gate on every non-Windows platform');
// Every other tier must evaluate identically on win32 and non-Windows, proving
// the platform margin did not widen or relax any unrelated gate.
const platformInvariantTiers = [
  ['scripts/test_link_ops_prepare_descriptions_flow.mjs', 300_000],
  ['scripts/test_link_ops_update_description_flow.mjs', 240_000],
  ['scripts/test_bi_query_surface_isolation.mjs', 240_000],
  ['scripts/test_bi_portal_core_warmup_queue_owned.mjs', 120_000],
  ['scripts/test_bi_section_streaming.mjs', 120_000],
  ['scripts/test_bi_section_portal_streaming.mjs', 120_000],
  ['scripts/test_morning_coordinator_portal_async.mjs', 120_000],
  ['scripts/test_morning_chain_reliability.mjs', 120_000],
  ['scripts/test_morning_chain_wrapper_reliability.mjs', 120_000],
  ['scripts/test_cloud_session_manager_reliability.mjs', 120_000],
  ['scripts/test_bi_ops_cli_flow.mjs', 90_000],
  ['scripts/test_partner_cli_version_change.mjs', 60_000],
  ['scripts/test_link_ops_executor_source_detail_lock.mjs', 60_000],
  ['scripts/test_et_forwarder_runtime_contract.mjs', 60_000],
  ['scripts/test_cloud_db_backup_contract.mjs', 180_000],
  ['scripts/test_link_ops_prepare_product_attribute_flow.mjs', 1_800_000],
  ['scripts/test_cos_backup_remote_verifier.mjs', 60_000],
  ['scripts/test_bi_portal_mutation_queue.mjs', 120_000],
];
for (const [file, expected] of platformInvariantTiers) {
  assert.equal(evaluateRunnerTimeout(runner, file, 'win32'), expected,
    `${file} tier must be unchanged on local Windows`);
  assert.equal(evaluateRunnerTimeout(runner, file, 'linux'), expected,
    `${file} tier must be unchanged on Linux CI`);
}
for (const platform of ['win32', 'linux']) {
  assert.equal(evaluateRunnerTimeout(runner, 'scripts/test_unclassified_default_budget.mjs', platform), 30_000,
    `unclassified tests must keep the default 30s fail-fast budget on ${platform}`);
}
assert.match(runner,
  /file === 'scripts\/test_cloud_db_backup_contract\.mjs'\s*\? 180_000/,
  'database backup fault-injection suite must have an explicit bounded 180s CI tier');
assert.match(runner, /'scripts\/test_bi_portal_core_warmup_queue_owned\.mjs':\s*120_000/, 'warmup estimate must be synced to its 120s tier');
assert.match(runner, /'scripts\/test_bi_query_surface_isolation\.mjs':\s*120_000/, 'query surface estimate must reflect its measured integration runtime');
assert.match(runner, /'scripts\/test_morning_coordinator_portal_async\.mjs':\s*120_000/, 'morning coordinator estimate must be synced to its 120s tier');
assert.match(runner, /'scripts\/test_bi_ops_cli_flow\.mjs':\s*90_000/, 'CLI flow estimate must be synced to its 90s tier');
assert.match(runner, /'scripts\/test_partner_cli_version_change\.mjs':\s*30_000/, 'partner CLI version-change estimate must reflect its measured 27s runtime');
assert.match(runner, /'scripts\/test_et_forwarder_runtime_contract\.mjs':\s*60_000/, 'ET forwarder estimate must be synced to its 60s tier');
assert.match(runner, /'scripts\/test_migrate_cloud_runtime_mount_layout\.mjs':\s*1_800_000/, 'runtime layout migration estimate must be synced to its 1800s tier');
assert.match(runner, /'scripts\/test_cloud_db_backup_contract\.mjs':\s*120_000/, 'database backup estimate must reflect its measured 103s runtime');
assert.equal(deterministicTests.filter(file => file === releaseGateTest).length, 0,
  'release gate must be absent from the deterministic runner because its dedicated CI job is the sole owner');
assert.doesNotMatch(runner, /['"]scripts\/test_bi_ops_release_gate\.mjs['"]\s*:/,
  'release gate must be absent from deterministic shard estimates');
assert.doesNotMatch(runner, /file === ['"]scripts\/test_bi_ops_release_gate\.mjs['"]\s*\?/,
  'release gate must be absent from deterministic per-test timeout tiers');
assert.equal(deterministicTests.filter(file => file === 'scripts/test_bi_portal_repository_crud.mjs').length, 1,
  'Portal repository CRUD must be registered exactly once in the deterministic runner');
assert.equal(deterministicTests.filter(file => file === 'scripts/test_bi_portal_mutation_queue.mjs').length, 1,
  'Portal mutation-queue must be registered exactly once in the deterministic runner');
assert.match(runner,
  /file === 'scripts\/test_bi_portal_mutation_queue\.mjs'\s*\? 120_000/,
  'Portal mutation-queue must keep an explicit bounded 120s CI tier');
assert.match(runner, /'scripts\/test_bi_portal_mutation_queue\.mjs':\s*60_000/, 'Portal mutation-queue shard estimate must be synced to its bounded tier headroom');
assert.match(runner,
  /file === 'scripts\/test_order_closure_idempotency\.mjs'\s*\? 120_000/,
  'order-closure idempotency must have a focused bounded 120s outer tier');
assert.match(runner,
  /file === 'scripts\/test_morning_metric_refetch\.mjs'\s*\? 180_000/,
  'morning metric refetch must keep its measured-safe focused 180s outer tier');
assert.match(runner,
  /'scripts\/test_order_closure_idempotency\.mjs':\s*60_000/,
  'order-closure idempotency shard estimate must stay at its focused 60s bound');
assert.match(runner,
  /'scripts\/test_morning_metric_refetch\.mjs':\s*120_000/,
  'morning metric refetch shard estimate must stay at its measured-safe 120s bound');
assert.equal(deterministicTests.length, deterministicSet.size,
  'deterministic runner test registrations must be unique');
assert.equal(allRunnerRegistrations.length, new Set(allRunnerRegistrations).size,
  'all canonical runner registrations, including smoke tests, must be unique');
assert.deepEqual(canonicalManifest.tests, allRunnerRegistrations,
  'runtime canonical manifest must exactly match the source registration order with no missing tests');
assert.deepEqual(canonicalDeterministicTests, deterministicTests,
  'the derived test_* registration count must match the canonical runtime manifest');
assert.equal(shardedTests.length, canonicalManifest.tests.length,
  'four canonical shards must preserve the exact registration count');
assert.equal(new Set(shardedTests).size, canonicalManifest.tests.length,
  'four canonical shards must contain every registration exactly once');
assert.deepEqual([...shardedTests].sort(), [...canonicalManifest.tests].sort(),
  'four canonical shards must have no missing or unexpected registrations');
for (const file of canonicalManifest.tests) {
  assert.equal(fs.existsSync(new URL(`../${file}`, import.meta.url)), true,
    `canonical deterministic registration must resolve to an existing file: ${file}`);
  for (const platform of ['win32', 'linux']) {
    const timeout = evaluateRunnerTimeout(runner, file, platform);
    assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2_400_000,
      `${file} must have a finite positive timeout no wider than 2,400,000ms on ${platform}`);
  }
}
for (const file of requiredRunnerTests) {
  assert.equal(allRunnerRegistrations.filter(candidate => candidate === file).length, 1,
    `required deterministic regression must be registered exactly once in runner source: ${file}`);
  assert.equal(canonicalManifest.tests.filter(candidate => candidate === file).length, 1,
    `required deterministic regression must appear exactly once in the canonical manifest: ${file}`);
  assert.equal(shardedTests.filter(candidate => candidate === file).length, 1,
    `required deterministic regression must be owned by exactly one deterministic shard: ${file}`);
}
assert.equal(manualTestFiles.length, manualTestSet.size,
  'intentional manual allowlist entries must be unique');
for (const [file, rationale] of Object.entries(intentionalManualTests)) {
  assert.ok(diskTestSet.has(file), `manual allowlist file must exist on disk: ${file}`);
  assert.match(rationale, /\S/u, `manual allowlist file must have a one-line rationale: ${file}`);
}
for (const [ownerName, files] of coverageOwners) {
  for (const file of files) {
    assert.ok(diskTestSet.has(file), `${ownerName} owns a non-disk test file: ${file}`);
  }
}
for (let left = 0; left < coverageOwners.length; left += 1) {
  for (let right = left + 1; right < coverageOwners.length; right += 1) {
    const [leftName, leftFiles] = coverageOwners[left];
    const [rightName, rightFiles] = coverageOwners[right];
    assert.deepEqual([...leftFiles].filter(file => rightFiles.has(file)).sort(), [],
      `${leftName} and ${rightName} ownership must not overlap`);
  }
}
assert.deepEqual([...coverageUnion].sort(), diskTestFiles,
  'all scripts/test_*.mjs files must be covered exactly by runner, release-gate ownership, or the explicit manual allowlist');
assert.equal(coverageUnion.size, diskTestFiles.length,
  'all disk test files must have exactly one owner');
for (const [file, expected] of [
  ['scripts/test_order_closure_idempotency.mjs', 120_000],
  ['scripts/test_morning_metric_refetch.mjs', 180_000],
]) {
  assert.equal(evaluateRunnerTimeout(runner, file, 'win32'), expected, `${file} must keep its focused Windows timeout`);
  assert.equal(evaluateRunnerTimeout(runner, file, 'linux'), expected, `${file} must keep its focused Linux timeout`);
}
assert.equal(directInvocations.length, ownershipBaseline.directCalls - directTestsTransferredToDeterministicShards.length,
  'release gate direct call sites must drop only the 19 tests transferred to deterministic shards');
assert.equal(directSet.size, ownershipBaseline.directUnique - directTestsTransferredToDeterministicShards.length,
  'release gate unique direct tests must drop only the 19 shard-owned tests');
assert.deepEqual(ownershipIntersection, [],
  'release-gate direct test list and deterministic registrations must have an empty intersection');
assert.equal(new Set(directTestsTransferredToDeterministicShards).size, ownershipBaseline.intersection,
  'the transfer contract must enumerate all 19 former overlaps exactly once');
for (const file of directTestsTransferredToDeterministicShards) {
  assert.equal(deterministicTests.filter(candidate => candidate === file).length, 1,
    `transferred test must remain exactly once in deterministic runner: ` + file);
  assert.equal(directInvocations.filter(candidate => candidate === file).length, 0,
    `transferred test must not remain a direct release-gate invocation: ` + file);
}
assert.equal(ownershipUnion.size, deterministicSet.size + directSet.size + 1,
  'disjoint deterministic tests, direct release-gate smokes, and the dedicated gate must preserve their derived owner union');
assert.match(releaseGateJob, /^  release-gate:$/mu,
  'CI must declare a dedicated release-gate job');
assert.match(releaseGateJob, /^    needs: source-checks$/mu,
  'dedicated release-gate job must remain downstream of source checks');
assert.match(releaseGateJob, /^    timeout-minutes: 45$/mu,
  'dedicated release-gate job must retain a finite 45-minute budget');
assert.equal(countLiteral(releaseGateJob, releaseGateCiCommand), 1,
  'dedicated release-gate job must invoke the release gate exactly once');
assert.equal(countLiteral(releaseGateJob, releaseGateBuildCommand), 1,
  'dedicated release-gate job must generate the ignored Portal shell exactly once');
assert.ok(releaseGateJob.indexOf(releaseGateBuildCommand) < releaseGateJob.indexOf(releaseGateCiCommand),
  'dedicated release-gate job must generate the Portal shell before running the gate');
assert.equal(countLiteral(ciWorkflow, releaseGateCiCommand), 1,
  'no other CI job may invoke the release gate');
const ciTerminalThreeDependencyNeeds = /^    needs: \[source-checks, deterministic-shards, release-gate\]$/mu;
assert.match(ciTerminalJob, ciTerminalThreeDependencyNeeds,
  'ci-terminal needs must exact-require source-checks, every deterministic shard, and the release gate');
assert.doesNotMatch('  ci-terminal:\n    needs: [source-checks, deterministic-shards]\n', ciTerminalThreeDependencyNeeds,
  'dropping the release-gate dependency must fail the exact ci-terminal needs regex');
assert.match(ciTerminalJob, /^          SOURCE_CHECKS_RESULT: \$\{\{ needs\.source-checks\.result \}\}$/mu,
  'ci-terminal must read the exact source-checks result');
assert.match(ciTerminalJob, /^          DETERMINISTIC_SHARDS_RESULT: \$\{\{ needs\.deterministic-shards\.result \}\}$/mu,
  'ci-terminal must read the exact deterministic-shards result');
assert.match(ciTerminalJob, /^          RELEASE_GATE_RESULT: \$\{\{ needs\.release-gate\.result \}\}$/mu,
  'ci-terminal must read the exact release-gate result');
assert.match(ciTerminalJob,
  /if \[ "\$SOURCE_CHECKS_RESULT" != 'success' \] \|\| \[ "\$DETERMINISTIC_SHARDS_RESULT" != 'success' \] \|\| \[ "\$RELEASE_GATE_RESULT" != 'success' \]; then[\s\S]*?^            exit 1$/mu,
  'ci-terminal must fail closed unless all three exact dependencies succeed');
assert.match(runner, /:\s*30_000\)?;/,
  'unclassified deterministic tests must retain the default 30s fail-fast budget');
assert.match(runner, /spawnSync\(process\.execPath,[\s\S]*?timeout,/,
  'the per-test timeout must remain wired into spawnSync');
assert.match(releaseGate, /const directInvocationCount = countDirectProductAttributeFlowInvocations\(releaseGateSource\)/,
  'release gate must count direct product-attribute flow invocations from its own source');
assert.match(releaseGate, /registeredCount === 1 && timeoutRegistered && directInvocationCount === 0/,
  'release gate registration guard must fail closed unless direct invocation count is zero');
assert.equal(registrationGuardPasses(releaseGate), true,
  'current release gate must satisfy registration=1, timeout=1.8M, directInvocation=0');

const injectedLiteralInvocation = `${releaseGate}\nvoid run(process.execPath, ['${productAttributeFlowTest}']);\n`;
assert.equal(registrationGuardPasses(injectedLiteralInvocation), false,
  'temporary literal direct invocation must fail the registration guard');
const injectedConstantInvocation = `${releaseGate}\nvoid run(process.execPath, [PRODUCT_ATTRIBUTE_FLOW_TEST]);\n`;
assert.equal(registrationGuardPasses(injectedConstantInvocation), false,
  'temporary constant direct invocation must fail the registration guard');
const injectedOptionsInvocation = `${releaseGate}\nvoid run(process.execPath, [PRODUCT_ATTRIBUTE_FLOW_TEST], {allowFailure: true});\n`;
assert.equal(registrationGuardPasses(injectedOptionsInvocation), false,
  'direct invocation with run options must fail the registration guard');
const injectedProbeInvocation = `${releaseGate}\nvoid run(process.execPath, [PRODUCT_ATTRIBUTE_FLOW_TEST, '--probe']);\n`;
assert.equal(registrationGuardPasses(injectedProbeInvocation), false,
  'direct invocation with additional target arguments must fail the registration guard');
const checkOnlyNearMisses = `const CHECK_FILES = ['${productAttributeFlowTest}'];\nvoid run(process.execPath, ['--check', PRODUCT_ATTRIBUTE_FLOW_TEST]);\n`;
assert.equal(countDirectProductAttributeFlowInvocations(checkOnlyNearMisses), 0,
  'CHECK_FILES and node --check references must not be counted as direct executions');

for (const evidence of ['PR #99', 'attempt 1', '30042ms', 'attempt 2', '26012ms', '720017ms', 'Attempt 3', '240099ms', '900128ms', '24.7s', '709s', '1,180,547ms', '30-minute budget', '30016ms', '30014ms', '30021ms', '30011ms', '36,615ms', 'A-R crash/fingerprint/path-safety suite', '30018ms', '900018ms', '30-minute tier', '1,200,015ms', 'Q1-Q4', 'release-gate job', 'CRUD', '30025ms', '96.7s', '125946ms', '240s outer tier', '103081ms', '30023ms', '180s outer tier', '27014ms', '30013ms', '1,791,363ms', '1,800,000ms', '2,400,000ms', '40-minute']) {
  assert.ok(runner.includes(evidence), `timeout rationale must preserve measured evidence: ${evidence}`);
}

console.log(JSON.stringify({
  ok: true,
  checks: ['source_detail_60s', 'query_surface_240s', 'warmup_120s', 'morning_coordinator_120s', 'cli_flow_90s', 'partner_cli_version_change_60s', 'et_forwarder_60s', 'runtime_layout_migration_win32_2400s_margin', 'runtime_layout_migration_nonwin32_1800s_gate', 'runtime_layout_migration_estimate_1800s', 'other_tiers_platform_invariant', 'cloud_db_backup_180s', 'mutation_queue_120s', 'description_300s', 'attribute_1800s', 'order_closure_idempotency_120s', 'morning_metric_refetch_180s', 'default_30s', 'timeout_wired', 'estimate_tier_sync', 'ci_evidence_documented', 'release_gate_absent_from_deterministic_runner', 'release_gate_absent_from_deterministic_estimates_and_tiers', 'repository_crud_registered_once', 'mutation_queue_registered_once', 'canonical_manifest_matches_source', 'four_shards_exact_union', 'all_registered_files_exist', 'all_entries_have_bounded_timeout', 'new_portal_tests_registered_once', 'required_runner_tests_registered_once', 'exact_disk_test_coverage', 'manual_allowlist_rationales', 'ownership_intersection_zero', 'transferred_tests_owned_once', 'ownership_union_derived', 'dedicated_ci_release_gate_once', 'ci_terminal_three_dependency_exact', 'ci_terminal_release_gate_required_fail_closed', 'release_gate_direct_invocation_zero', 'direct_invocation_injection_rejected', 'direct_invocation_options_rejected', 'direct_invocation_extra_args_rejected', 'node_check_near_miss_ignored'],
  ownership: {
    before: ownershipBaseline,
    after: {
      deterministicEntries: deterministicTests.length,
      deterministicUnique: deterministicSet.size,
      allRunnerRegistrations: allRunnerRegistrations.length,
      canonicalManifestEntries: canonicalManifest.tests.length,
      fourShardEntries: shardedTests.length,
      diskTestFiles: diskTestFiles.length,
      exactCoverageOwners: coverageUnion.size,
      intentionalManualTests: manualTestFiles.length,
      directCalls: directInvocations.length,
      directUnique: directSet.size,
      intersection: ownershipIntersection.length,
      unionIncludingDedicatedReleaseGate: ownershipUnion.size,
      dedicatedReleaseGateCiCommands: countLiteral(ciWorkflow, releaseGateCiCommand),
    },
  },
}, null, 2));
