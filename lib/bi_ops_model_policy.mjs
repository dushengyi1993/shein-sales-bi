// Web requests never use max/ultra. Those modes are reserved for an Owner's
// explicit interactive CLI session because ultra can fan out to subagents.
const VALID_REASONING = new Set(['low', 'medium', 'high', 'xhigh']);

const PROFILE_DEFAULTS = Object.freeze({
  fast: Object.freeze({model: 'gpt-5.6-terra', reasoning: 'low', timeoutMs: 45_000}),
  intent: Object.freeze({model: 'gpt-5.6-luna', reasoning: 'low', timeoutMs: 20_000}),
  balanced: Object.freeze({model: 'gpt-5.6-terra', reasoning: 'medium', timeoutMs: 90_000}),
  deep: Object.freeze({model: 'gpt-5.6-sol', reasoning: 'high', timeoutMs: 300_000}),
  owner: Object.freeze({model: 'gpt-5.6-sol', reasoning: 'high', timeoutMs: 600_000}),
});

const HIGH_RISK_INTENTS = new Set([
  'copy_product_draft',
  'activate_link',
  'retire_link',
  'update_supply_price',
  'update_product_price',
  'update_images',
]);

const COMPLEX_ANALYSIS_RE = /为什么|原因|诊断|归因|趋势|预测|方案|策略|对比|异常|利润|售后|活动|跨店|全店|批量|综合分析|深入/i;
const SIMPLE_QUERY_RE = /^(今天|昨日|昨天|本周|上周|近\s*\d+\s*天)?\s*([A-Z]{2,4}\s*)?(销售额|销售|订单|销量|库存|排行|排名|卖了多少|哪个店最好|哪个产品最好)[？?。\s]*$/i;

function envValue(env, key, fallback) {
  const value = String(env?.[key] || '').trim();
  return value || fallback;
}

function envReasoning(env, key, fallback) {
  const value = envValue(env, key, fallback).toLowerCase();
  return VALID_REASONING.has(value) ? value : fallback;
}

function envTimeout(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? Math.max(15_000, Math.floor(value)) : fallback;
}

export function biOpsModelProfiles(env = process.env) {
  const fallbackModel = envValue(env, 'SHEIN_BI_AGENT_MODEL_FALLBACK', 'gpt-5.5');
  return Object.fromEntries(Object.entries(PROFILE_DEFAULTS).map(([name, defaults]) => [name, {
    name,
    model: envValue(env, `SHEIN_BI_AGENT_MODEL_${name.toUpperCase()}`, defaults.model),
    reasoning: envReasoning(env, `SHEIN_BI_AGENT_REASONING_${name.toUpperCase()}`, defaults.reasoning),
    timeoutMs: envTimeout(env, `SHEIN_BI_AGENT_TIMEOUT_${name.toUpperCase()}_MS`, defaults.timeoutMs),
    fallbackModel,
    fallbackReasoning: envReasoning(env, 'SHEIN_BI_AGENT_REASONING_FALLBACK', 'medium'),
  }]));
}

/**
 * Selects a model profile; it does not authorize an operation.
 * Authorization, dry-run, confirmation and readback remain deterministic server rules.
 */
export function selectBiOpsModelProfile(input = {}, env = process.env) {
  const profiles = biOpsModelProfiles(env);
  const requested = String(input.profile || '').trim().toLowerCase();
  if (profiles[requested]) return {...profiles[requested], reason: 'explicit_profile'};

  const mode = String(input.mode || 'query').trim().toLowerCase();
  const question = String(input.question || input.message || '').trim();
  const intents = Array.isArray(input.intents) ? input.intents.map(String) : [];
  const storeCount = Number(input.storeCount || input.stores?.length || 0);
  const actorRole = String(input.actorRole || '').trim().toLowerCase();
  const highRisk = input.highRisk === true || intents.some(intent => HIGH_RISK_INTENTS.has(intent));

  if (mode === 'owner_diagnostics' || mode === 'code' || actorRole === 'owner' && input.ownerEscalation === true) {
    return {...profiles.owner, reason: 'owner_diagnostics'};
  }
  if (mode === 'intent' || mode === 'classification' || mode === 'chart_intent') {
    return {...profiles.intent, reason: 'structured_intent'};
  }
  if (mode === 'deep_analysis' || highRisk || storeCount > 3 || COMPLEX_ANALYSIS_RE.test(question)) {
    return {...profiles.deep, reason: highRisk ? 'high_risk_action' : storeCount > 3 ? 'multi_store' : 'complex_analysis'};
  }
  if (mode === 'action_plan' || intents.length > 0 || question.length > 500) {
    return {...profiles.balanced, reason: 'structured_planning'};
  }
  if (SIMPLE_QUERY_RE.test(question) || mode === 'query') {
    return {...profiles.fast, reason: 'routine_query'};
  }
  return {...profiles.balanced, reason: 'default_balanced'};
}

export function modelProfilePublicSummary(profile) {
  return {
    tier: String(profile?.name || ''),
    model: String(profile?.model || ''),
    reasoning: String(profile?.reasoning || ''),
    timeoutMs: Number(profile?.timeoutMs || 0),
    reason: String(profile?.reason || ''),
  };
}

export const BI_OPS_HIGH_RISK_INTENTS = HIGH_RISK_INTENTS;
