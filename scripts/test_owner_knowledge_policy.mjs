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
