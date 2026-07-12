#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  biOpsModelProfiles,
  modelProfilePublicSummary,
  selectBiOpsModelProfile,
} from '../lib/bi_ops_model_policy.mjs';

const profiles = biOpsModelProfiles({});
assert.deepEqual(
  Object.fromEntries(Object.entries(profiles).map(([key, value]) => [key, `${value.model}/${value.reasoning}`])),
  {
    fast: 'gpt-5.6-terra/low',
    intent: 'gpt-5.6-luna/low',
    balanced: 'gpt-5.6-terra/medium',
    deep: 'gpt-5.6-sol/high',
    owner: 'gpt-5.6-sol/high',
  },
);

assert.equal(selectBiOpsModelProfile({question: '今天销售额？'}, {}).name, 'fast');
assert.equal(selectBiOpsModelProfile({mode: 'intent'}, {}).name, 'intent');
assert.equal(selectBiOpsModelProfile({mode: 'action_plan', intents: ['update_inventory']}, {}).name, 'balanced');
assert.equal(selectBiOpsModelProfile({mode: 'action_plan', intents: ['update_inventory']}, {}).reasoning, 'medium');
assert.equal(selectBiOpsModelProfile({mode: 'action_plan', intents: ['update_product_price']}, {}).name, 'deep');
assert.equal(selectBiOpsModelProfile({question: '分析为什么全店利润下降，并给出跨店方案'}, {}).name, 'deep');
assert.equal(selectBiOpsModelProfile({mode: 'owner_diagnostics'}, {}).name, 'owner');

const overridden = selectBiOpsModelProfile({profile: 'fast'}, {
  SHEIN_BI_AGENT_MODEL_FAST: 'gpt-test-fast',
  SHEIN_BI_AGENT_REASONING_FAST: 'low',
  SHEIN_BI_AGENT_TIMEOUT_FAST_MS: '22000',
  SHEIN_BI_AGENT_MODEL_FALLBACK: 'gpt-test-fallback',
});
assert.deepEqual(modelProfilePublicSummary(overridden), {
  tier: 'fast',
  model: 'gpt-test-fast',
  reasoning: 'low',
  timeoutMs: 22000,
  reason: 'explicit_profile',
});
assert.equal(overridden.fallbackModel, 'gpt-test-fallback');

const invalidReasoning = biOpsModelProfiles({SHEIN_BI_AGENT_REASONING_DEEP: 'impossible'});
assert.equal(invalidReasoning.deep.reasoning, 'high');
assert.equal(biOpsModelProfiles({SHEIN_BI_AGENT_REASONING_OWNER: 'ultra'}).owner.reasoning, 'high');

console.log('bi_ops_model_policy: fast, balanced, deep, owner, risk escalation, and env overrides passed');
