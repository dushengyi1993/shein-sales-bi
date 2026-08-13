import crypto from 'node:crypto';

export const OWNER_KNOWLEDGE_RECORD_TYPES = Object.freeze({
  version: 'owner_knowledge_rule_version',
  current: 'owner_knowledge_rule_current',
  bundle: 'owner_knowledge_bundle',
  distribution: 'owner_knowledge_distribution',
  distributionPending: 'owner_knowledge_distribution_pending',
  device: 'owner_knowledge_device',
  completion: 'owner_knowledge_completion_check',
  review: 'owner_knowledge_rule_review',
  tombstone: 'owner_knowledge_rule_tombstone',
});

const MAX_TEXT_CHARS = 4_000;
const DEFAULT_PROJECT_SCOPE = 'project:shein-sales-bi';
const DURABLE_SIGNAL = /(?:以后|后续|从现在起|今后|默认|必须|一定|一律|永远|不允许|不能|不得|不要|禁止|别再|不再|优先|统一|以.+为准|只允许|需要始终|应该始终|应当始终|记住|长期规则|负责人规则)/u;
const CANDIDATE_SIGNAL = /(?:不对|错了|失败|报错|根因|原因是|修复|解决|成功了|搞定了|验证通过|应该|应当|建议|经验|规则|教训|以后|后续|默认|必须|一定|不能|不要|禁止|优先|统一|以.+为准)/u;

const TAG_PATTERNS = Object.freeze([
  ['identity', /(?:负责人|同事|账号|身份|权限|授权|覆盖|同步|经验|规则包)/u],
  ['images', /(?:图片|主图|细节图|轮播|方形图|SKU图|色块图|换图|排图|排序)/iu],
  ['publish', /(?:上新|上架|补链|补链接|发品|发布|刊登|草稿|审核)/u],
  ['product_identity', /(?:product_model|supplier_code|standard_goods_sn|型号|货号)/iu],
  ['attributes', /(?:属性|attribute|输入电压|输入电流|危险品|材质|功率)/iu],
  ['price', /(?:供货价|成本价|售价|价格|利润|折扣|券|营销活动)/u],
  ['inventory', /(?:库存|可售|售罄|补货)/u],
  ['marketing', /(?:营销|活动|优惠券|限时折扣|报名)/u],
  ['stores', /(?:店铺|19店|全店|源店|目标店)/u],
  ['execution', /(?:执行|提交|预检|回读|审计|payload|hash|真实写|SHEIN)/iu],
  ['ui', /(?:网页|前端|界面|排版|字体|颜色|看不清|按钮|文案)/u],
  ['data_truth', /(?:云端|live|事实源|快照|数据口径|warehouse|systemd)/iu],
]);

function cleanText(value, max = MAX_TEXT_CHARS) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function shannonEntropy(value) {
  const text = String(value || '');
  if (!text) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function redactOpaqueSecrets(value) {
  return String(value || '')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, '[REDACTED OPAQUE TOKEN]')
    .replace(/\b[a-f0-9]{32,128}\b/gi, '[REDACTED OPAQUE TOKEN]')
    .replace(/(?<![A-Za-z0-9_])([A-Za-z0-9_+/=-]{28,256})(?![A-Za-z0-9_])/g, token => {
      if (/^\d+$/.test(token)) return token;
      const classes = [/[a-z]/.test(token), /[A-Z]/.test(token), /\d/.test(token), /[_+/=-]/.test(token)].filter(Boolean).length;
      const entropy = shannonEntropy(token);
      return (classes >= 2 && entropy >= 3.5) || entropy >= 4.2 ? '[REDACTED OPAQUE TOKEN]' : token;
    });
}

export function redactOwnerKnowledgeSensitiveText(value) {
  const knownRedacted = cleanText(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\bokd\.[a-z0-9_.:@-]{3,96}\.[A-Za-z0-9_-]{32,}\b/gi, '[REDACTED OWNER DEVICE TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]')
    .replace(/((?:https?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/((?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key|x-gw-auth|secret|cookie|authorization|bi_session|session(?:id)?|密码|密钥|令牌)\s*[:=：]\s*)[^\s,;，；]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]');
  return redactOpaqueSecrets(knownRedacted);
}

export function ownerKnowledgeTextContainsSensitiveData(value) {
  const text = cleanText(value);
  return redactOwnerKnowledgeSensitiveText(text) !== text;
}

function cleanToken(value, max = 160) {
  return cleanText(value, max)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.:@/-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function sourceTimestamp(value, fallback = new Date().toISOString()) {
  const supplied = String(value || '').trim();
  const parsed = Date.parse(supplied);
  const now = Date.now();
  const fallbackParsed = Date.parse(String(fallback || ''));
  const safeFallback = Number.isFinite(fallbackParsed) && fallbackParsed <= now + 60_000 ? fallbackParsed : now;
  if (!supplied) return {at: new Date(safeFallback).toISOString(), anomaly: ''};
  if (!Number.isFinite(parsed)) return {at: new Date(safeFallback).toISOString(), anomaly: 'invalid_source_at'};
  if (parsed > now + 60_000) return {at: new Date(now).toISOString(), anomaly: 'future_source_at'};
  return {at: new Date(parsed).toISOString(), anomaly: ''};
}

export function isOwnerKnowledgeDurableText(value) {
  const text = cleanText(value);
  return text.length >= 6 && DURABLE_SIGNAL.test(text);
}

export function isOwnerKnowledgeCandidateText(value) {
  const text = cleanText(value);
  if (text.length < 6) return false;
  if (/^(?:可以执行|执行吧|提交吧|干吧|好的|好|嗯|收到|成功了|搞定了)[。！!\s]*$/u.test(text)) return false;
  return CANDIDATE_SIGNAL.test(text);
}

export function inferOwnerKnowledgeTags(value, supplied = []) {
  const text = cleanText(value);
  return unique([
    ...supplied.map(tag => cleanToken(tag, 60)),
    ...TAG_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag),
  ]).slice(0, 24);
}

export function inferOwnerKnowledgeRuleKey(value, tags = []) {
  const text = cleanText(value);
  if (/(?:同事|其他账号).*(?:不能|不得|不允许).*(?:同步|沉淀|覆盖|修改)|(?:我的|负责人).*(?:经验|规则).*(?:同步|传递)/u.test(text)) {
    return 'authority.owner-one-way-knowledge';
  }
  if (/(?:product_model|supplier_code|standard_goods_sn|型号.*货号|货号.*型号)/iu.test(text)) return 'publish.product-identity-fields';
  if (/(?:图片|主图|细节图|轮播|方形图|SKU图|色块图).*(?:排序|顺序|角色|优先)/u.test(text)) return 'images.role-ordering';
  if (/(?:供货价|成本价).*(?:提交前|区间|复核|撤回)/u.test(text)) return 'publish.supply-price-guard';
  if (/(?:真实提交|真实写|执行).*(?:预检|确认|回读|审计|hash)/iu.test(text)) return 'execution.controlled-write-boundary';
  if (/(?:店铺|19店|全店).*(?:OpenAPI|api|能力|授权)/iu.test(text)) return 'stores.openapi-capability';
  if (/(?:新上架|上架.*7天|新品).*(?:限时折扣|营销|活动)/u.test(text)) return 'marketing.new-listing-treatment';
  if (/(?:网页|前端|界面).*(?:字体|排版|颜色|看不清|位置|布局)/u.test(text)) return 'ui.readability-and-layout';
  const stableTags = unique(tags).sort().slice(0, 4);
  const basis = stableTags.length ? `${stableTags.join('.')}.${hash(text).slice(0, 12)}` : hash(text).slice(0, 16);
  return `advisory.${basis}`;
}

function inferRisk(text, tags) {
  if (/(?:密钥|token|cookie|密码|授权|真实提交|真实写|删除|下架|价格|库存|供货价|退款|财务)/iu.test(text)) return 'high';
  if (tags.some(tag => ['publish', 'marketing', 'execution', 'attributes'].includes(tag))) return 'medium';
  return 'low';
}

export function ownerKnowledgeMachinePolicyForRuleKey(ruleKey) {
  if (ruleKey === 'authority.owner-one-way-knowledge') {
    return {knowledgeAuthority: {publisher: 'owner_only', coworkerPersistence: 'task_or_session_only', allowReverseOverwrite: false}};
  }
  if (ruleKey === 'execution.controlled-write-boundary') {
    return {controlledWrite: {requireDryRun: true, requireHumanConfirmation: true, requireAudit: true, requireReadback: true, allowSilentWrite: false}};
  }
  if (ruleKey === 'publish.product-identity-fields') {
    return {productIdentity: {productModel: 'pure_model_only', supplierCode: 'model_plus_product_name'}};
  }
  if (ruleKey === 'images.role-ordering') {
    return {imageWorkflow: {mode: 'upload_suggest_adjust_controlled_submit', requireUrlConversion: true, requirePreview: true}};
  }
  if (ruleKey === 'publish.supply-price-guard') {
    return {supplyPrice: {requirePreSubmitRangeCheck: true, requireFinalReview: true}};
  }
  return null;
}

export function normalizeOwnerKnowledgeExperience(input = {}, options = {}) {
  const text = redactOwnerKnowledgeSensitiveText(input.text || input.statement || input.content || input.message);
  if (!text) throw new TypeError('owner knowledge text is required');
  const sourceKind = cleanToken(input.sourceKind || options.sourceKind || 'owner_manual', 80) || 'owner_manual';
  const sourceId = cleanText(input.sourceId || options.sourceId || '', 500);
  const sourceTime = sourceTimestamp(input.sourceAt || input.at || options.sourceAt);
  const sourceAt = sourceTime.at;
  const actorUser = cleanText(input.actorUser || options.actorUser || '', 180);
  const tags = inferOwnerKnowledgeTags(text, Array.isArray(input.tags) ? input.tags : []);
  const suppliedRuleKey = cleanToken(input.ruleKey || '', 180);
  const ruleKey = suppliedRuleKey || inferOwnerKnowledgeRuleKey(text, tags);
  const explicitDurable = input.explicitDurable === true || isOwnerKnowledgeDurableText(text);
  const requestedActivation = String(input.activation || input.status || '').trim().toLowerCase();
  // Collection and model analysis may only propose rules. Activation is an
  // explicit owner review operation in owner_knowledge_service.mjs.
  const activation = 'candidate';
  const scope = unique([
    DEFAULT_PROJECT_SCOPE,
    ...(Array.isArray(input.scope) ? input.scope : input.scope ? [input.scope] : []),
  ].map(item => cleanToken(item, 160))).slice(0, 16);
  const normalizedForHash = cleanText(text).toLowerCase();
  const contentHash = hash(JSON.stringify({ruleKey, text: normalizedForHash, scope, tags}));
  const ruleId = `okr_${hash(ruleKey).slice(0, 20)}`;
  const versionId = `${ruleId}_${contentHash.slice(0, 20)}`;
  return {
    version: 1,
    ruleId,
    versionId,
    ruleKey,
    text,
    activation,
    explicitDurable,
    risk: cleanToken(input.risk || inferRisk(text, tags), 40),
    scope,
    tags,
    machinePolicy: ownerKnowledgeMachinePolicyForRuleKey(ruleKey),
    timeAnomaly: sourceTime.anomaly,
    source: {
      kind: sourceKind,
      id: sourceId,
      at: sourceAt,
      actorUser,
      deviceId: cleanText(input.deviceId || options.deviceId || '', 180),
    },
    contentHash,
    createdAt: sourceAt,
    publishedAt: activation === 'active' ? sourceAt : null,
  };
}

export function ownerKnowledgeBundleFingerprint(rules) {
  const rows = (Array.isArray(rules) ? rules : [])
    .filter(rule => rule && rule.activation === 'active')
    .map(rule => ({ruleKey: rule.ruleKey, versionId: rule.versionId, contentHash: rule.contentHash}))
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey) || a.versionId.localeCompare(b.versionId));
  return hash(JSON.stringify(rows));
}

function contextTerms(context = {}) {
  const serialized = cleanText([
    context.question,
    context.message,
    context.command,
    ...(Array.isArray(context.intents) ? context.intents : []),
    ...(Array.isArray(context.stores) ? context.stores : []),
    ...(Array.isArray(context.productRefs) ? context.productRefs : []),
    context.targets && typeof context.targets === 'object' ? JSON.stringify(context.targets) : '',
  ].filter(Boolean).join('\n'), 12_000).toLowerCase();
  const tags = inferOwnerKnowledgeTags(serialized);
  return {serialized, tags: new Set(tags)};
}

export function selectRelevantOwnerKnowledgeRules(rules, context = {}, {limit = 12} = {}) {
  const {serialized, tags} = contextTerms(context);
  const currentByKey = new Map();
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.activation !== 'active' || !rule.ruleKey || !rule.text) continue;
    const existing = currentByKey.get(rule.ruleKey);
    if (!existing || String(rule.publishedAt || rule.createdAt || '') > String(existing.publishedAt || existing.createdAt || '')) {
      currentByKey.set(rule.ruleKey, rule);
    }
  }
  return [...currentByKey.values()]
    .map(rule => {
      let score = rule.ruleKey === 'authority.owner-one-way-knowledge' ? 1 : 0;
      for (const tag of Array.isArray(rule.tags) ? rule.tags : []) {
        if (tags.has(tag)) score += 20;
      }
      for (const token of String(rule.ruleKey).split(/[.:-]+/)) {
        if (token.length >= 3 && serialized.includes(token.toLowerCase())) score += 4;
      }
      if (rule.machinePolicy) score += 1;
      return {rule, score};
    })
    .filter(({score}) => score > 0)
    .sort((a, b) => b.score - a.score
      || String(b.rule.publishedAt || b.rule.createdAt || '').localeCompare(String(a.rule.publishedAt || a.rule.createdAt || ''))
      || a.rule.ruleKey.localeCompare(b.rule.ruleKey))
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 12)))
    .map(({rule}) => rule);
}

export function formatOwnerKnowledgeRulesForPrompt(rules) {
  const rows = (Array.isArray(rules) ? rules : []).filter(rule => rule?.text);
  if (!rows.length) return '暂无与本次任务直接相关的负责人长期规则；按受控执行边界处理，不得从同事会话自行创造长期规则。';
  return rows.map((rule, index) => `${index + 1}. ${cleanText(rule.text, 900)}`).join('\n');
}

export function actorCanPublishOwnerKnowledge(actor, authorityId = 'dushengyi') {
  if (!actor) return false;
  if (actor.knowledgePublisher === true) return true;
  return String(actor.role || '').toLowerCase() === 'knowledge_device'
    && cleanToken(actor.knowledgeAuthorityId || '', 120) === cleanToken(authorityId, 120);
}

export function createOwnerKnowledgeDeviceCredential(deviceId = '') {
  const id = cleanToken(deviceId || `device-${crypto.randomBytes(8).toString('hex')}`, 96);
  if (!id) throw new TypeError('deviceId is required');
  const secret = crypto.randomBytes(32).toString('base64url');
  return {
    deviceId: id,
    token: `okd.${id}.${secret}`,
    tokenHash: hash(`owner-knowledge-device:${id}:${secret}`),
  };
}

export function parseOwnerKnowledgeDeviceToken(value) {
  const match = /^okd\.([a-z0-9_.:@-]{3,96})\.([A-Za-z0-9_-]{32,})$/.exec(String(value || '').trim());
  if (!match) return null;
  return {
    deviceId: match[1],
    tokenHash: hash(`owner-knowledge-device:${match[1]}:${match[2]}`),
  };
}

export function timingSafeOwnerKnowledgeHashEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
