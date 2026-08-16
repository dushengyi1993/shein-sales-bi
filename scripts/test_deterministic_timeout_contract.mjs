#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const runner = fs.readFileSync(new URL('./run_deterministic_tests.mjs', import.meta.url), 'utf8');
const releaseGate = fs.readFileSync(new URL('./test_bi_ops_release_gate.mjs', import.meta.url), 'utf8');
const productAttributeFlowTest = 'scripts/test_link_ops_prepare_product_attribute_flow.mjs';

function countDirectProductAttributeFlowInvocations(source) {
  const escapedTarget = productAttributeFlowTest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetExpression = `(?:PRODUCT_ATTRIBUTE_FLOW_TEST|['"]${escapedTarget}['"])`;
  const pattern = new RegExp(
    `\\brun\\s*\\(\\s*process\\.execPath\\s*,\\s*\\[\\s*${targetExpression}(?=\\s*(?:,|\\]))`,
    'gu',
  );
  return [...String(source || '').matchAll(pattern)].length;
}

const testsBlock = runner.match(/const tests = \[([\s\S]*?)\n\];/u)?.[1] || '';
const productAttributeRegistrationCount = testsBlock.split(`'${productAttributeFlowTest}'`).length - 1;
const productAttributeTimeoutRegistered = /file === 'scripts\/test_link_ops_prepare_product_attribute_flow\.mjs'\s*\? 1_800_000/.test(runner);
const registrationGuardPasses = source => productAttributeRegistrationCount === 1
  && productAttributeTimeoutRegistered
  && countDirectProductAttributeFlowInvocations(source) === 0;

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
assert.match(runner, /:\s*30_000;/,
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

for (const evidence of ['PR #99', 'attempt 1', '30042ms', 'attempt 2', '26012ms', '720017ms', 'Attempt 3', '240099ms', '900128ms', '24.7s', '709s', '1,180,547ms', '30-minute budget']) {
  assert.ok(runner.includes(evidence), `timeout rationale must preserve measured evidence: ${evidence}`);
}

console.log(JSON.stringify({
  ok: true,
  checks: ['source_detail_60s', 'description_300s', 'attribute_1800s', 'default_30s', 'timeout_wired', 'ci_evidence_documented', 'release_gate_direct_invocation_zero', 'direct_invocation_injection_rejected', 'direct_invocation_options_rejected', 'direct_invocation_extra_args_rejected', 'node_check_near_miss_ignored'],
}, null, 2));
