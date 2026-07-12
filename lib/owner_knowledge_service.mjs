import {
  OWNER_KNOWLEDGE_RECORD_TYPES,
  actorCanPublishOwnerKnowledge,
  createOwnerKnowledgeDeviceCredential,
  formatOwnerKnowledgeRulesForPrompt,
  normalizeOwnerKnowledgeExperience,
  ownerKnowledgeBundleFingerprint,
  parseOwnerKnowledgeDeviceToken,
  selectRelevantOwnerKnowledgeRules,
  timingSafeOwnerKnowledgeHashEqual,
} from './owner_knowledge_policy.mjs';
import {linkOpsPayloadHash} from './link_ops_repository.mjs';

function cleanPrincipal(value) {
  return String(value || 'dushengyi').normalize('NFKC').trim().toLowerCase() || 'dushengyi';
}

function cleanActor(value) {
  return String(value || '').normalize('NFKC').trim().slice(0, 180);
}

function isRevisionConflict(error) {
  return String(error?.code || '') === 'LINK_OPS_REVISION_CONFLICT';
}

function isAlreadyExists(error) {
  return String(error?.code || '') === 'LINK_OPS_ALREADY_EXISTS'
    || /already exists|duplicate key/i.test(String(error?.message || ''));
}

function publicRule(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    version: Number(record.version || 1) || 1,
    ruleId: String(record.ruleId || ''),
    versionId: String(record.versionId || ''),
    ruleKey: String(record.ruleKey || ''),
    text: String(record.text || ''),
    activation: String(record.activation || ''),
    explicitDurable: Boolean(record.explicitDurable),
    risk: String(record.risk || ''),
    scope: Array.isArray(record.scope) ? record.scope.map(String) : [],
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    machinePolicy: record.machinePolicy && typeof record.machinePolicy === 'object' ? record.machinePolicy : null,
    source: record.source && typeof record.source === 'object' ? {
      kind: String(record.source.kind || ''),
      id: String(record.source.id || ''),
      at: String(record.source.at || ''),
      actorUser: String(record.source.actorUser || ''),
      deviceId: String(record.source.deviceId || ''),
    } : {},
    contentHash: String(record.contentHash || ''),
    createdAt: String(record.createdAt || ''),
    publishedAt: record.publishedAt ? String(record.publishedAt) : null,
  };
}

export function createOwnerKnowledgeService({repository, authorityId = 'dushengyi'} = {}) {
  if (!repository || typeof repository.getRecord !== 'function' || typeof repository.putRecord !== 'function') {
    throw new TypeError('owner knowledge service requires a Link Ops repository with record methods');
  }
  const principal = cleanPrincipal(authorityId);

  async function createVersionIfMissing(experience, actorUser) {
    const current = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.version, experience.versionId);
    if (current) return {record: current, created: false};
    try {
      const record = await repository.putRecord(
        OWNER_KNOWLEDGE_RECORD_TYPES.version,
        experience.versionId,
        experience,
        {
          ownerUser: principal,
          actorUser,
          status: experience.activation,
          idempotencyKey: `owner-knowledge-version:${experience.versionId}`,
        }
      );
      return {record, created: true};
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.version, experience.versionId);
      if (!existing || existing.contentHash !== experience.contentHash) throw error;
      return {record: existing, created: false};
    }
  }

  async function publishCurrent(experience, actorUser) {
    const pointerId = experience.ruleId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.current, pointerId);
      if (existing?.versionId === experience.versionId) return {record: existing, changed: false};
      const next = {
        ...publicRule(experience),
        authorityId: principal,
        supersedesVersionId: String(existing?.versionId || ''),
        updatedAt: new Date().toISOString(),
      };
      try {
        const record = await repository.putRecord(
          OWNER_KNOWLEDGE_RECORD_TYPES.current,
          pointerId,
          next,
          {
            expectedRevision: existing?.repositoryRevision ?? null,
            ownerUser: principal,
            actorUser,
            status: 'active',
            idempotencyKey: `owner-knowledge-current:${pointerId}:${experience.versionId}:${existing?.repositoryRevision || 0}`,
          }
        );
        return {record, changed: true};
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 3) throw error;
      }
    }
    throw new Error('owner knowledge current pointer update exhausted retries');
  }

  async function rebuildBundle(actorUser) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rows = await repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {
        ownerUser: principal,
        status: 'active',
        limit: 10_000,
      });
      const rules = rows.map(row => publicRule(row.record)).filter(Boolean)
        .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
      const fingerprint = ownerKnowledgeBundleFingerprint(rules);
      const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.bundle, 'active');
      if (existing?.fingerprint === fingerprint) {
        return {fingerprint, rules, revision: existing.repositoryRevision || null, changed: false};
      }
      const record = {
        version: 1,
        authorityId: principal,
        fingerprint,
        ruleVersionIds: rules.map(rule => rule.versionId),
        ruleCount: rules.length,
        updatedAt: new Date().toISOString(),
      };
      try {
        const stored = await repository.putRecord(
          OWNER_KNOWLEDGE_RECORD_TYPES.bundle,
          'active',
          record,
          {
            expectedRevision: existing?.repositoryRevision ?? null,
            ownerUser: principal,
            actorUser,
            status: 'active',
            idempotencyKey: `owner-knowledge-bundle:${fingerprint}:${existing?.repositoryRevision || 0}`,
          }
        );
        return {fingerprint, rules, revision: stored.repositoryRevision || null, changed: true};
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 3) throw error;
      }
    }
    throw new Error('owner knowledge bundle update exhausted retries');
  }

  async function ingest(experiences, {actor, actorUser = '', sourceKind = '', deviceId = ''} = {}) {
    if (!actorCanPublishOwnerKnowledge(actor, principal)) {
      const error = new Error('当前身份无权发布负责人长期规则');
      error.code = 'OWNER_KNOWLEDGE_PUBLISH_FORBIDDEN';
      error.status = 403;
      throw error;
    }
    const publisher = cleanActor(actorUser || actor?.username || `knowledge-device:${deviceId}`);
    const incoming = Array.isArray(experiences) ? experiences : [experiences];
    if (!incoming.length || incoming.length > 200) throw new TypeError('owner knowledge batch must contain 1-200 experiences');
    const results = [];
    let activeChanged = false;
    for (let index = 0; index < incoming.length; index += 1) {
      const experience = normalizeOwnerKnowledgeExperience(incoming[index], {
        actorUser: publisher,
        sourceKind: incoming[index]?.sourceKind || sourceKind,
        deviceId,
      });
      const version = await createVersionIfMissing(experience, publisher);
      let current = null;
      if (experience.activation === 'active') {
        current = await publishCurrent(experience, publisher);
        activeChanged = activeChanged || current.changed;
      }
      results.push({
        ruleId: experience.ruleId,
        versionId: experience.versionId,
        ruleKey: experience.ruleKey,
        activation: experience.activation,
        created: version.created,
        published: Boolean(current),
        changed: Boolean(current?.changed),
      });
    }
    const bundle = activeChanged
      ? await rebuildBundle(publisher)
      : await getActiveBundle();
    return {ok: true, authorityId: principal, results, bundle: {fingerprint: bundle.globalFingerprint || bundle.fingerprint, ruleCount: bundle.allRuleCount ?? bundle.rules.length}};
  }

  async function getActiveBundle(context = {}, {limit = 12, all = false} = {}) {
    const rows = await repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {
      ownerUser: principal,
      status: 'active',
      limit: 10_000,
    });
    const allRules = rows.map(row => publicRule(row.record)).filter(Boolean);
    const rules = all ? allRules : selectRelevantOwnerKnowledgeRules(allRules, context, {limit});
    const globalFingerprint = ownerKnowledgeBundleFingerprint(allRules);
    const fingerprint = ownerKnowledgeBundleFingerprint(rules);
    return {authorityId: principal, fingerprint, globalFingerprint, rules, allRuleCount: allRules.length};
  }

  async function promptContext(context = {}, options = {}) {
    const bundle = await getActiveBundle(context, options);
    return {...bundle, text: formatOwnerKnowledgeRulesForPrompt(bundle.rules)};
  }

  async function issueDevice({actor, actorUser = '', deviceId = '', deviceName = ''} = {}) {
    if (!actorCanPublishOwnerKnowledge(actor, principal) || String(actor?.role || '').toLowerCase() === 'knowledge_device') {
      const error = new Error('只有负责人本人登录 BI 后才能登记同步设备');
      error.code = 'OWNER_KNOWLEDGE_DEVICE_ENROLL_FORBIDDEN';
      error.status = 403;
      throw error;
    }
    const credential = createOwnerKnowledgeDeviceCredential(deviceId);
    const publisher = cleanActor(actorUser || actor?.username);
    const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.device, credential.deviceId);
    const record = {
      version: 1,
      authorityId: principal,
      deviceId: credential.deviceId,
      deviceName: String(deviceName || credential.deviceId).normalize('NFKC').trim().slice(0, 180),
      tokenHash: credential.tokenHash,
      status: 'active',
      enrolledBy: publisher,
      enrolledAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    const stored = await repository.putRecord(
      OWNER_KNOWLEDGE_RECORD_TYPES.device,
      credential.deviceId,
      record,
      {
        expectedRevision: existing?.repositoryRevision ?? null,
        ownerUser: principal,
        actorUser: publisher,
        status: 'active',
        idempotencyKey: `owner-knowledge-device:${credential.deviceId}:${linkOpsPayloadHash(record).slice(0, 24)}`,
      }
    );
    return {
      authorityId: principal,
      deviceId: credential.deviceId,
      deviceName: record.deviceName,
      token: credential.token,
      enrolledAt: record.enrolledAt,
      repositoryRevision: stored.repositoryRevision || null,
    };
  }

  async function authenticateBearer(value) {
    const parsed = parseOwnerKnowledgeDeviceToken(value);
    if (!parsed) return null;
    const record = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.device, parsed.deviceId);
    if (!record || record.status !== 'active' || record.authorityId !== principal) return null;
    if (!timingSafeOwnerKnowledgeHashEqual(record.tokenHash, parsed.tokenHash)) return null;
    return {
      username: `knowledge-device:${parsed.deviceId}`,
      displayName: record.deviceName || parsed.deviceId,
      role: 'knowledge_device',
      readStores: [],
      writeStores: [],
      ownerKey: '',
      knowledgePublisher: true,
      knowledgeAuthorityId: principal,
      knowledgeDeviceId: parsed.deviceId,
      source: 'owner-knowledge-device',
    };
  }

  async function status() {
    const [versions, current, devices, bundle] = await Promise.all([
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.version, {ownerUser: principal, limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {ownerUser: principal, status: 'active', limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.device, {ownerUser: principal, limit: 1_000}),
      getActiveBundle({}, {all: true}),
    ]);
    return {
      authorityId: principal,
      activeRules: current.length,
      candidates: versions.filter(row => row.record?.activation === 'candidate').length,
      versions: versions.length,
      activeDevices: devices.filter(row => row.record?.status === 'active').length,
      fingerprint: bundle.globalFingerprint || bundle.fingerprint,
      updatedAt: new Date().toISOString(),
    };
  }

  return Object.freeze({
    authorityId: principal,
    ingest,
    getActiveBundle,
    promptContext,
    issueDevice,
    authenticateBearer,
    status,
  });
}
