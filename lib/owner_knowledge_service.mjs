import {
  OWNER_KNOWLEDGE_RECORD_TYPES,
  actorCanPublishOwnerKnowledge,
  createOwnerKnowledgeDeviceCredential,
  formatOwnerKnowledgeRulesForPrompt,
  normalizeOwnerKnowledgeExperience,
  ownerKnowledgeBundleFingerprint,
  ownerKnowledgeMachinePolicyForRuleKey,
  parseOwnerKnowledgeDeviceToken,
  selectRelevantOwnerKnowledgeRules,
  timingSafeOwnerKnowledgeHashEqual,
} from './owner_knowledge_policy.mjs';
import {linkOpsPayloadHash} from './link_ops_repository.mjs';
import {buildOwnerKnowledgeDistribution} from './owner_knowledge_distribution.mjs';

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

function ownerKnowledgeRuleTime(value) {
  const parsed = Date.parse(String(value?.publishedAt || value?.source?.at || value?.createdAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
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
    machinePolicy: ownerKnowledgeMachinePolicyForRuleKey(String(record.ruleKey || '')),
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

export function createOwnerKnowledgeService({repository, authorityId = 'dushengyi', distributionPublisher = null} = {}) {
  if (!repository || typeof repository.getRecord !== 'function' || typeof repository.putRecord !== 'function') {
    throw new TypeError('owner knowledge service requires a Link Ops repository with record methods');
  }
  const principal = cleanPrincipal(authorityId);

  function publicDistribution(record, {activeFingerprint = ''} = {}) {
    if (!record || typeof record !== 'object') {
      return {
        enabled: Boolean(distributionPublisher),
        ready: false,
        current: false,
        source: distributionPublisher ? 'github' : 'runtime',
        sourceCommit: '',
        branch: distributionPublisher?.branch || '',
        fingerprint: '',
        activeFingerprint,
        ruleCount: 0,
        bundlePath: '',
        bundleSha256: '',
        publishedAt: null,
      };
    }
    const source = String(record.source || (distributionPublisher ? 'github' : 'runtime'));
    return {
      enabled: Boolean(distributionPublisher),
      ready: Boolean(record.fingerprint && record.bundleSha256 && Array.isArray(record.rules)),
      current: Boolean(record.fingerprint && record.fingerprint === activeFingerprint && (!distributionPublisher || source === 'github')),
      source,
      sourceCommit: String(record.sourceCommit || ''),
      branch: String(record.branch || ''),
      fingerprint: String(record.fingerprint || ''),
      activeFingerprint,
      ruleCount: Number(record.ruleCount || 0),
      bundlePath: String(record.bundlePath || ''),
      bundleSha256: String(record.bundleSha256 || ''),
      publishedAt: record.publishedAt ? String(record.publishedAt) : null,
      distributionRevision: Number(record.repositoryRevision || 0),
      error: record.error ? String(record.error).slice(0, 500) : '',
    };
  }

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
      if (existing?.versionId === experience.versionId) return {record: existing, changed: false, ignoredStale: false};
      if (existing && ownerKnowledgeRuleTime(experience) <= ownerKnowledgeRuleTime(existing)) {
        return {record: existing, changed: false, ignoredStale: true};
      }
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
        return {record, changed: true, ignoredStale: false};
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

  function distributionRecord(publication) {
    return {
      version: 1,
      authorityId: principal,
      source: String(publication.source || 'runtime'),
      sourceCommit: String(publication.sourceCommit || ''),
      branch: String(publication.branch || ''),
      fingerprint: String(publication.manifest?.fingerprint || publication.bundle?.fingerprint || ''),
      ruleCount: Number(publication.manifest?.ruleCount ?? publication.bundle?.ruleCount ?? 0),
      bundlePath: String(publication.manifest?.bundlePath || ''),
      bundleSha256: String(publication.manifest?.bundleSha256 || ''),
      publishedAt: String(publication.manifest?.publishedAt || publication.bundle?.publishedAt || new Date().toISOString()),
      rules: Array.isArray(publication.bundle?.rules) ? publication.bundle.rules : [],
      updatedAt: new Date().toISOString(),
    };
  }

  async function persistDistributionRecord(recordType, recordId, publication, actorUser, status) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await repository.getRecord(recordType, recordId);
      const record = {...distributionRecord(publication), activationStatus: status};
      if (existing?.fingerprint === record.fingerprint && existing?.sourceCommit === record.sourceCommit && existing?.activationStatus === status) return existing;
      try {
        return await repository.putRecord(
          recordType,
          recordId,
          record,
          {
            expectedRevision: existing?.repositoryRevision ?? null,
            ownerUser: principal,
            actorUser,
            status,
            idempotencyKey: `owner-knowledge-distribution:${recordType}:${recordId}:${record.fingerprint}:${record.sourceCommit || record.source}:${existing?.repositoryRevision || 0}`,
          }
        );
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 3) throw error;
      }
    }
    throw new Error('owner knowledge distribution update exhausted retries');
  }

  async function persistCurrentDistribution(publication, actorUser) {
    return await persistDistributionRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distribution, 'current', publication, actorUser, 'active');
  }

  async function persistPendingDistribution(publication, actorUser) {
    const sourceCommit = String(publication?.sourceCommit || '');
    if (publication?.source !== 'github' || !/^[a-f0-9]{40,64}$/i.test(sourceCommit)) throw new Error('GitHub distribution requires a verified remote source commit');
    return await persistDistributionRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distributionPending, sourceCommit, publication, actorUser, 'pending');
  }

  async function ensureDistribution({actorUser = 'owner-knowledge-distributor', force = false, _attempt = 0} = {}) {
    const active = await getActiveBundle({}, {all: true});
    const activeFingerprint = active.globalFingerprint || active.fingerprint;
    const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distribution, 'current');
    const existingPublic = publicDistribution(existing, {activeFingerprint});
    const expectedSource = distributionPublisher ? 'github' : 'runtime';
    if (!force && existingPublic.current && existingPublic.ready && existingPublic.source === expectedSource) return existingPublic;
    try {
      const publication = distributionPublisher
        ? await distributionPublisher.publish(active)
        : (() => {
            const built = buildOwnerKnowledgeDistribution(active);
            return {
              source: 'runtime',
              branch: '',
              sourceCommit: `runtime:${built.bundle.fingerprint}`,
              manifest: built.manifest,
              bundle: built.bundle,
              changed: existing?.fingerprint !== built.bundle.fingerprint,
            };
          })();
      const publicationFingerprint = String(publication.manifest?.fingerprint || publication.bundle?.fingerprint || '');
      const latestBeforePersist = await getActiveBundle({}, {all: true});
      const latestBeforeFingerprint = latestBeforePersist.globalFingerprint || latestBeforePersist.fingerprint;
      if (publicationFingerprint !== latestBeforeFingerprint) {
        if (_attempt >= 3) throw new Error('owner knowledge active bundle changed repeatedly during distribution');
        return await ensureDistribution({actorUser, force: true, _attempt: _attempt + 1});
      }
      if (distributionPublisher) {
        await persistPendingDistribution(publication, cleanActor(actorUser));
        return await distributionManifest();
      }
      const stored = await persistCurrentDistribution(publication, cleanActor(actorUser));
      const latestAfterPersist = await getActiveBundle({}, {all: true});
      const latestAfterFingerprint = latestAfterPersist.globalFingerprint || latestAfterPersist.fingerprint;
      if (publicationFingerprint !== latestAfterFingerprint) {
        if (_attempt >= 3) throw new Error('owner knowledge active bundle changed after distribution persistence');
        return await ensureDistribution({actorUser, force: true, _attempt: _attempt + 1});
      }
      return publicDistribution(stored, {activeFingerprint: latestAfterFingerprint});
    } catch (error) {
      return {
        ...existingPublic,
        current: false,
        activeFingerprint,
        pending: true,
        error: String(error?.message || error).slice(0, 500),
      };
    }
  }

  async function distributionManifest() {
    const [active, record, pendingRows] = await Promise.all([
      getActiveBundle({}, {all: true}),
      repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distribution, 'current'),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.distributionPending, {ownerUser: principal, status: 'pending', limit: 1_000}),
    ]);
    const activeFingerprint = active.globalFingerprint || active.fingerprint;
    const pending = pendingRows
      .map(row => row.record)
      .filter(row => row?.activationStatus === 'pending' && row?.fingerprint === activeFingerprint)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    return {
      ...publicDistribution(record, {activeFingerprint}),
      pending: Boolean(pending),
      pendingSourceCommit: String(pending?.sourceCommit || ''),
      pendingFingerprint: String(pending?.fingerprint || ''),
    };
  }

  async function distributionBundle() {
    const manifest = await distributionManifest();
    const record = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distribution, 'current');
    if (!manifest.ready || !record) return {manifest, rules: []};
    return {
      manifest,
      schemaVersion: 1,
      authorityId: principal,
      fingerprint: manifest.fingerprint,
      publishedAt: manifest.publishedAt,
      ruleCount: manifest.ruleCount,
      rules: Array.isArray(record.rules) ? record.rules : [],
    };
  }

  async function activatePendingDistribution({sourceCommit = '', fingerprint = '', bundleSha256 = '', actorUser = 'github-actions'} = {}) {
    const commit = String(sourceCommit || '').trim().toLowerCase();
    const expectedFingerprint = String(fingerprint || '').trim().toLowerCase();
    const expectedBundleSha = String(bundleSha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{64}$/.test(expectedFingerprint) || !/^[a-f0-9]{64}$/.test(expectedBundleSha)) {
      const error = new Error('GitHub distribution activation payload is invalid');
      error.status = 400;
      error.code = 'OWNER_KNOWLEDGE_ACTIVATION_INVALID';
      throw error;
    }
    const existingCurrent = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distribution, 'current');
    if (existingCurrent?.sourceCommit === commit && existingCurrent?.fingerprint === expectedFingerprint && existingCurrent?.bundleSha256 === expectedBundleSha) {
      const active = await getActiveBundle({}, {all: true});
      const activeFingerprint = active.globalFingerprint || active.fingerprint;
      if (activeFingerprint !== expectedFingerprint) {
        const error = new Error('GitHub distribution activation is stale relative to the current owner rules');
        error.status = 409;
        error.code = 'OWNER_KNOWLEDGE_ACTIVATION_STALE';
        throw error;
      }
      return publicDistribution(existingCurrent, {activeFingerprint});
    }
    const pending = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distributionPending, commit);
    if (!pending || pending.activationStatus !== 'pending') {
      const error = new Error('GitHub distribution activation has no matching pending publication');
      error.status = 404;
      error.code = 'OWNER_KNOWLEDGE_ACTIVATION_PENDING_NOT_FOUND';
      throw error;
    }
    if (pending.fingerprint !== expectedFingerprint || pending.bundleSha256 !== expectedBundleSha) {
      const error = new Error('GitHub distribution activation hash does not match pending publication');
      error.status = 409;
      error.code = 'OWNER_KNOWLEDGE_ACTIVATION_HASH_MISMATCH';
      throw error;
    }
    const active = await getActiveBundle({}, {all: true});
    const activeFingerprint = active.globalFingerprint || active.fingerprint;
    if (activeFingerprint !== expectedFingerprint) {
      const error = new Error('GitHub distribution activation is stale relative to the current owner rules');
      error.status = 409;
      error.code = 'OWNER_KNOWLEDGE_ACTIVATION_STALE';
      throw error;
    }
    const publication = {
      source: 'github',
      sourceCommit: commit,
      branch: pending.branch,
      manifest: {
        fingerprint: pending.fingerprint,
        ruleCount: pending.ruleCount,
        bundlePath: pending.bundlePath,
        bundleSha256: pending.bundleSha256,
        publishedAt: pending.publishedAt,
      },
      bundle: {
        fingerprint: pending.fingerprint,
        ruleCount: pending.ruleCount,
        publishedAt: pending.publishedAt,
        rules: pending.rules,
      },
    };
    const stored = await persistCurrentDistribution(publication, cleanActor(actorUser));
    await repository.putRecord(
      OWNER_KNOWLEDGE_RECORD_TYPES.distributionPending,
      commit,
      {...pending, activationStatus: 'activated', activatedAt: new Date().toISOString()},
      {
        expectedRevision: pending.repositoryRevision ?? null,
        ownerUser: principal,
        actorUser: cleanActor(actorUser),
        status: 'activated',
        idempotencyKey: `owner-knowledge-distribution-activated:${commit}:${pending.repositoryRevision || 0}`,
      }
    ).catch(() => null);
    return publicDistribution(stored, {activeFingerprint});
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
        ignoredStale: Boolean(current?.ignoredStale),
      });
    }
    const bundle = activeChanged
      ? await rebuildBundle(publisher)
      : await getActiveBundle();
    const distribution = await ensureDistribution({actorUser: publisher});
    return {
      ok: true,
      authorityId: principal,
      results,
      bundle: {fingerprint: bundle.globalFingerprint || bundle.fingerprint, ruleCount: bundle.allRuleCount ?? bundle.rules.length},
      distribution,
    };
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
    const [versions, current, devices, bundle, distribution] = await Promise.all([
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.version, {ownerUser: principal, limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {ownerUser: principal, status: 'active', limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.device, {ownerUser: principal, limit: 1_000}),
      getActiveBundle({}, {all: true}),
      distributionManifest(),
    ]);
    return {
      authorityId: principal,
      activeRules: current.length,
      candidates: versions.filter(row => row.record?.activation === 'candidate').length,
      versions: versions.length,
      activeDevices: devices.filter(row => row.record?.status === 'active').length,
      fingerprint: bundle.globalFingerprint || bundle.fingerprint,
      distribution,
      updatedAt: new Date().toISOString(),
    };
  }

  return Object.freeze({
    authorityId: principal,
    ingest,
    getActiveBundle,
    promptContext,
    ensureDistribution,
    distributionManifest,
    distributionBundle,
    activatePendingDistribution,
    issueDevice,
    authenticateBearer,
    status,
  });
}
