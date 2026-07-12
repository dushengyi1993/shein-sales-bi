import assert from 'node:assert/strict';
import {
  actorCanPublishOwnerKnowledge,
  createOwnerKnowledgeDeviceCredential,
  formatOwnerKnowledgeRulesForPrompt,
  isOwnerKnowledgeCandidateText,
  isOwnerKnowledgeDurableText,
  normalizeOwnerKnowledgeExperience,
  ownerKnowledgeBundleFingerprint,
  parseOwnerKnowledgeDeviceToken,
  selectRelevantOwnerKnowledgeRules,
} from '../lib/owner_knowledge_policy.mjs';

assert.equal(isOwnerKnowledgeDurableText('以后所有新发品都必须先检查供货价。'), true);
assert.equal(isOwnerKnowledgeDurableText('可以执行'), false);
assert.equal(isOwnerKnowledgeCandidateText('这次失败的原因是输入电压缺失，后续应该先检查。'), true);
assert.equal(isOwnerKnowledgeCandidateText('成功了'), false);

const oneWay = normalizeOwnerKnowledgeExperience({
  text: '我的经验一定同步给同事，但同事不能反向覆盖我的规则。',
  sourceKind: 'owner_codex_session',
  actorUser: '杜圣宜',
});
assert.equal(oneWay.activation, 'active');
assert.equal(oneWay.ruleKey, 'authority.owner-one-way-knowledge');
assert.equal(oneWay.tags.includes('identity'), true);

const image = normalizeOwnerKnowledgeExperience({
  text: '图片角色顺序应优先主图，再按卖点、参数和场景组织细节图。',
  sourceKind: 'owner_memory',
  explicitDurable: true,
});
assert.equal(image.activation, 'active');
assert.equal(image.ruleKey, 'images.role-ordering');

const inferred = normalizeOwnerKnowledgeExperience({
  text: '这次预检发现某个平台字段可能有变化。',
  sourceKind: 'owner_codex_final',
});
assert.equal(inferred.activation, 'candidate');

const fakeGithubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
const fakeApiKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
const fakeAwsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const fakeCredentialUrl = ['postgres://user', 'db-password@example.invalid/db'].join(':');
const fakeLabeledToken = ['owner', 'private', 'token', 'value'].join('-');
const fakeSessionCookie = ['abcdef', '123456'].join('');
const fakeSlackToken = ['xoxb', '123456789012', 'abcdefghijklmnopqrstuvwxyz'].join('-');
const fakeOpaqueHexSecret = ['0123456789abcdef', 'fedcba9876543210'].join('');
const redacted = normalizeOwnerKnowledgeExperience({
  text: `以后排障记录不得泄露 token=${fakeLabeledToken}、Bearer abcdefghijklmnop、${fakeGithubToken}、${fakeApiKey}、${fakeAwsKey}、${fakeSlackToken}、${fakeOpaqueHexSecret}、bi_session=${fakeSessionCookie} 或 ${fakeCredentialUrl}。`,
  explicitDurable: true,
});
assert.equal(redacted.text.includes(fakeLabeledToken), false, 'server-side normalization redacts token values');
assert.equal(redacted.text.includes('abcdefghijklmnop'), false, 'server-side normalization redacts bearer values');
assert.equal(redacted.text.includes(fakeGithubToken), false, 'server-side normalization redacts bare GitHub tokens');
assert.equal(redacted.text.includes(fakeApiKey), false, 'server-side normalization redacts bare API keys');
assert.equal(redacted.text.includes(fakeAwsKey), false, 'server-side normalization redacts AWS access keys');
assert.equal(redacted.text.includes(fakeSlackToken), false, 'server-side normalization redacts Slack-style opaque tokens');
assert.equal(redacted.text.includes(fakeOpaqueHexSecret), false, 'server-side normalization redacts unlabeled high-entropy app secrets');
assert.equal(redacted.text.includes(fakeSessionCookie), false, 'server-side normalization redacts session cookies');
assert.equal(redacted.text.includes('db-password'), false, 'server-side normalization redacts credential URLs');
assert.match(normalizeOwnerKnowledgeExperience({text: '以后 FY 的 SK-5110 必须保留。', explicitDurable: true}).text, /SK-5110/, 'business SKU is not mistaken for an API key');
const futureDated = normalizeOwnerKnowledgeExperience({text: '以后真实提交都必须回读。', sourceAt: '2099-01-01T00:00:00.000Z', explicitDurable: true, activation: 'active'});
assert.ok(Date.parse(futureDated.source.at) <= Date.now() + 1_000, 'future client timestamps are clamped to server time');
assert.equal(futureDated.activation, 'candidate', 'future client timestamps are isolated instead of promoted to current');
assert.equal(futureDated.timeAnomaly, 'future_source_at');
const invalidDated = normalizeOwnerKnowledgeExperience({text: '以后真实提交都必须回读。', sourceAt: 'not-a-timestamp', explicitDurable: true, activation: 'active'});
assert.equal(invalidDated.activation, 'candidate', 'invalid client timestamps are isolated instead of promoted to current');
assert.equal(invalidDated.timeAnomaly, 'invalid_source_at');
const injectedMachinePolicy = normalizeOwnerKnowledgeExperience({
  text: '以后所有真实提交必须先预检、确认和回读。',
  explicitDurable: true,
  machinePolicy: {apiKey: 'shortsecret123', credentials: {pin: 837261}},
});
assert.deepEqual(injectedMachinePolicy.machinePolicy, {
  controlledWrite: {requireDryRun: true, requireHumanConfirmation: true, requireAudit: true, requireReadback: true, allowSilentWrite: false},
}, 'client-supplied machinePolicy is ignored in favor of the server-derived schema');

const selected = selectRelevantOwnerKnowledgeRules([oneWay, image], {
  question: '请帮我给商品图片排序并换主图',
}, {limit: 1});
assert.equal(selected.length, 1);
assert.equal(selected[0].ruleKey, 'images.role-ordering');
assert.match(formatOwnerKnowledgeRulesForPrompt(selected), /卖点、参数和场景/);
assert.match(ownerKnowledgeBundleFingerprint([oneWay, image]), /^[a-f0-9]{64}$/);

assert.equal(actorCanPublishOwnerKnowledge({role: 'owner'}, 'dushengyi'), false, 'owner role alone is not authority');
assert.equal(actorCanPublishOwnerKnowledge({role: 'owner', knowledgePublisher: true}, 'dushengyi'), true);
assert.equal(actorCanPublishOwnerKnowledge({role: 'knowledge_device', knowledgeAuthorityId: 'dushengyi'}, 'dushengyi'), true);

const credential = createOwnerKnowledgeDeviceCredential('office-pc');
const parsed = parseOwnerKnowledgeDeviceToken(credential.token);
assert.equal(parsed.deviceId, 'office-pc');
assert.equal(parsed.tokenHash, credential.tokenHash);
assert.equal(parseOwnerKnowledgeDeviceToken('bad-token'), null);

console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_policy'}));
