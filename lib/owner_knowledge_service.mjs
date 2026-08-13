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
  // Source chronology is authoritative. Approval time must never let an old
  // archived conversation replace a newer correction.
  const parsed = Date.parse(String(value?.source?.at || value?.createdAt || value?.publishedAt || ''));
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

  function publicationMatchesRecord(publication, record) {
    return Boolean(publication && record
      && publication.source === 'github'
      && record.source === 'github'
      && String(publication.sourceCommit || '') === String(record.sourceCommit || '')
      && String(publication.manifest?.fingerprint || publication.bundle?.fingerprint || '') === String(record.fingerprint || '')
      && String(publication.manifest?.bundleSha256 || '') === String(record.bundleSha256 || ''));
  }

  async function markPendingDistributionActivated(commit, actorUser) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pending = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.distributionPending, commit);
      if (!pending || pending.activationStatus !== 'pending') return pending;
      try {
        return await repository.putRecord(
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
        );
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 3) throw error;
      }
    }
    throw new Error('owner knowledge pending activation update exhausted retries');
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
        if (publicationMatchesRecord(publication, existing)) {
          await markPendingDistributionActivated(String(publication.sourceCommit || ''), cleanActor(actorUser));
          return publicDistribution(existing, {activeFingerprint: latestBeforeFingerprint});
        }
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
      .filter(row => !(record
        && row?.sourceCommit === record.sourceCommit
        && row?.fingerprint === record.fingerprint
        && row?.bundleSha256 === record.bundleSha256))
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
      await markPendingDistributionActivated(commit, cleanActor(actorUser));
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
    await markPendingDistributionActivated(commit, cleanActor(actorUser));
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
    for (let index = 0; index < incoming.length; index += 1) {
      const experience = normalizeOwnerKnowledgeExperience({...incoming[index], activation: 'candidate'}, {
        actorUser: publisher,
        sourceKind: incoming[index]?.sourceKind || sourceKind,
        deviceId,
      });
      const version = await createVersionIfMissing(experience, publisher);
      results.push({
        ruleId: experience.ruleId,
        versionId: experience.versionId,
        ruleKey: experience.ruleKey,
        activation: experience.activation,
        created: version.created,
        published: false,
        changed: false,
        ignoredStale: false,
      });
    }
    const bundle = await getActiveBundle();
    const distribution = await distributionManifest();
    return {
      ok: true,
      authorityId: principal,
      results,
      bundle: {fingerprint: bundle.globalFingerprint || bundle.fingerprint, ruleCount: bundle.allRuleCount ?? bundle.rules.length},
      distribution,
    };
  }

  function requirePublisher(actor) {
    if (actorCanPublishOwnerKnowledge(actor, principal)) return;
    const error = new Error('当前身份无权生成或审核负责人长期规则');
    error.code = 'OWNER_KNOWLEDGE_PUBLISH_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  async function createCompletion(check = {}, {actor, actorUser = '', sourceKind = '', deviceId = ''} = {}) {
    requirePublisher(actor);
    const publisher = cleanActor(actorUser || actor?.username || `knowledge-device:${deviceId}`);
    const status = String(check.status || '').trim().toLowerCase();
    if (!['no_rule', 'candidate', 'review_required'].includes(status)) throw new TypeError('任务结束检查状态无效');
    const sourceAt = String(check.sourceAt || check.at || new Date().toISOString());
    const sourceId = String(check.sourceId || check.turnId || check.taskId || '').slice(0, 500);
    const proposed = Array.isArray(check.rules) ? check.rules : [];
    if (status === 'candidate' && !proposed.length) throw new TypeError('候选状态至少需要一条规则');
    if (proposed.length > 50) throw new TypeError('单次任务结束最多提出 50 条候选规则');
    const results = [];
    for (const item of proposed) {
      const experience = normalizeOwnerKnowledgeExperience({...item, activation: 'candidate', sourceAt, sourceId}, {
        actorUser: publisher,
        sourceKind: item?.sourceKind || sourceKind || 'owner_task_completion',
        deviceId,
      });
      const version = await createVersionIfMissing(experience, publisher);
      results.push({ruleId: experience.ruleId, versionId: experience.versionId, ruleKey: experience.ruleKey, created: version.created});
    }
    const identity = String(check.checkId || `${sourceKind}|${sourceId}|${sourceAt}|${status}`);
    const checkId = `okc_${linkOpsPayloadHash(identity).slice(0, 32)}`;
    const record = {
      version: 1,
      checkId,
      authorityId: principal,
      status,
      reason: String(check.reason || '').normalize('NFKC').trim().slice(0, 4_000),
      source: {kind: String(sourceKind || 'owner_task_completion'), id: sourceId, at: sourceAt, actorUser: publisher, deviceId},
      proposedVersionIds: results.map(row => row.versionId),
      createdAt: new Date().toISOString(),
    };
    const existing = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.completion, checkId);
    if (existing) return {ok: true, replayed: true, check: existing, results};
    const stored = await repository.putRecord(OWNER_KNOWLEDGE_RECORD_TYPES.completion, checkId, record, {
      ownerUser: principal,
      actorUser: publisher,
      status,
      idempotencyKey: `owner-knowledge-completion:${checkId}`,
    });
    return {ok: true, replayed: false, check: stored, results};
  }

  async function listReviews({actor, status = 'pending', limit = 500} = {}) {
    requirePublisher(actor);
    const [versions, reviews] = await Promise.all([
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.version, {ownerUser: principal, limit: Math.min(10_000, Math.max(1, Number(limit) || 500))}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.review, {ownerUser: principal, limit: 10_000}),
    ]);
    const decisions = new Map(reviews.map(row => [String(row.record?.versionId || row.id), row.record]));
    return versions.map(row => publicRule(row.record)).filter(Boolean).map(rule => ({
      rule,
      decision: decisions.get(rule.versionId) || null,
      reviewStatus: decisions.get(rule.versionId)?.decision || 'pending',
    })).filter(row => !status || row.reviewStatus === status);
  }

  async function decideRule({versionId = '', decision = '', reason = ''} = {}, {actor, actorUser = ''} = {}) {
    requirePublisher(actor);
    if (String(actor?.role || '').toLowerCase() === 'knowledge_device') {
      const error = new Error('本机采集设备只能提交候选，审核必须由负责人登录 BI 完成');
      error.code = 'OWNER_KNOWLEDGE_REVIEW_FORBIDDEN';
      error.status = 403;
      throw error;
    }
    const choice = String(decision || '').trim().toLowerCase();
    if (!['approved', 'rejected'].includes(choice)) throw new TypeError('审核决定必须是通过或拒绝');
    const candidate = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.version, String(versionId || ''));
    if (!candidate) {
      const error = new Error('候选规则不存在');
      error.status = 404;
      error.code = 'OWNER_KNOWLEDGE_CANDIDATE_NOT_FOUND';
      throw error;
    }
    const publisher = cleanActor(actorUser || actor?.username);
    const reviewId = String(candidate.versionId || versionId);
    const existingReview = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.review, reviewId);
    if (existingReview && existingReview.decision !== choice) {
      const error = new Error('该候选已有相反审核结论，不能静默改写');
      error.status = 409;
      error.code = 'OWNER_KNOWLEDGE_REVIEW_CONFLICT';
      throw error;
    }
    let publication = null;
    if (choice === 'approved') {
      publication = await publishCurrent({...candidate, activation: 'active', publishedAt: new Date().toISOString()}, publisher);
    }
    const review = existingReview || await repository.putRecord(OWNER_KNOWLEDGE_RECORD_TYPES.review, reviewId, {
      version: 1, versionId: reviewId, ruleId: candidate.ruleId, ruleKey: candidate.ruleKey,
      decision: choice, reason: String(reason || '').normalize('NFKC').trim().slice(0, 2_000),
      reviewedBy: publisher, reviewedAt: new Date().toISOString(),
    }, {ownerUser: principal, actorUser: publisher, status: choice, idempotencyKey: `owner-knowledge-review:${reviewId}:${choice}`});
    const bundle = publication?.changed ? await rebuildBundle(publisher) : await getActiveBundle({}, {all: true});
    const distribution = publication?.changed ? await ensureDistribution({actorUser: publisher}) : await distributionManifest();
    return {ok: true, review, publication, bundle: {fingerprint: bundle.globalFingerprint || bundle.fingerprint, ruleCount: bundle.allRuleCount ?? bundle.rules.length}, distribution};
  }

  async function deprecateRule({ruleKey = '', reason = ''} = {}, {actor, actorUser = ''} = {}) {
    requirePublisher(actor);
    if (String(actor?.role || '').toLowerCase() === 'knowledge_device') {
      const error = new Error('废止规则必须由负责人登录 BI 完成');
      error.status = 403;
      error.code = 'OWNER_KNOWLEDGE_REVIEW_FORBIDDEN';
      throw error;
    }
    const rows = await repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {ownerUser: principal, status: 'active', limit: 10_000});
    const target = rows.find(row => String(row.record?.ruleKey || '') === String(ruleKey || ''));
    if (!target) {
      const error = new Error('当前生效规则不存在');
      error.status = 404;
      error.code = 'OWNER_KNOWLEDGE_CURRENT_NOT_FOUND';
      throw error;
    }
    const publisher = cleanActor(actorUser || actor?.username);
    await repository.deleteRecord(OWNER_KNOWLEDGE_RECORD_TYPES.current, target.recordId, {
      expectedRevision: target.record.repositoryRevision,
      actorUser: publisher,
      idempotencyKey: `owner-knowledge-deprecate:${target.recordId}:${target.record.repositoryRevision}`,
    });
    const tombstoneId = `okt_${linkOpsPayloadHash(`${target.recordId}|${target.record.versionId}`).slice(0, 32)}`;
    await repository.putRecord(OWNER_KNOWLEDGE_RECORD_TYPES.tombstone, tombstoneId, {
      version: 1, ruleId: target.record.ruleId, ruleKey: target.record.ruleKey, versionId: target.record.versionId,
      reason: String(reason || '').normalize('NFKC').trim().slice(0, 2_000), deprecatedBy: publisher, deprecatedAt: new Date().toISOString(),
    }, {ownerUser: principal, actorUser: publisher, status: 'deprecated', idempotencyKey: `owner-knowledge-tombstone:${tombstoneId}`});
    const bundle = await rebuildBundle(publisher);
    const distribution = await ensureDistribution({actorUser: publisher});
    return {ok: true, deprecated: {ruleKey: target.record.ruleKey, versionId: target.record.versionId}, bundle: {fingerprint: bundle.fingerprint, ruleCount: bundle.rules.length}, distribution};
  }

  async function reconcileRules(plan = {}, {actor, actorUser = ''} = {}) {
    requirePublisher(actor);
    if (String(actor?.role || '').toLowerCase() === 'knowledge_device') {
      const error = new Error('规则清洗必须由负责人登录身份执行');
      error.status = 403;
      error.code = 'OWNER_KNOWLEDGE_REVIEW_FORBIDDEN';
      throw error;
    }
    const publisher = cleanActor(actorUser || actor?.username);
    const remove = [...new Set(Array.isArray(plan.deprecateVersionIds) ? plan.deprecateVersionIds.map(String) : [])];
    const approve = Array.isArray(plan.approve) ? plan.approve : [];
    const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
    if (remove.length > 500 || approve.length > 100 || candidates.length > 200) throw new TypeError('规则清洗计划超出安全上限');
    const currentRows = await repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {ownerUser: principal, status: 'active', limit: 10_000});
    const byVersion = new Map(currentRows.map(row => [String(row.record?.versionId || ''), row]));
    const missing = remove.filter(versionId => !byVersion.has(versionId));
    if (missing.length) {
      const error = new Error(`清洗计划与当前规则不一致，缺少 ${missing.length} 个版本`);
      error.status = 409;
      error.code = 'OWNER_KNOWLEDGE_RECONCILE_STALE';
      error.missing = missing;
      throw error;
    }
    const deprecated = [];
    for (const versionId of remove) {
      const target = byVersion.get(versionId);
      await repository.deleteRecord(OWNER_KNOWLEDGE_RECORD_TYPES.current, target.recordId, {
        expectedRevision: target.record.repositoryRevision,
        actorUser: publisher,
        idempotencyKey: `owner-knowledge-reconcile-delete:${target.recordId}:${versionId}:${target.record.repositoryRevision}`,
      });
      const tombstoneId = `okt_${linkOpsPayloadHash(`${target.recordId}|${versionId}`).slice(0, 32)}`;
      await repository.putRecord(OWNER_KNOWLEDGE_RECORD_TYPES.tombstone, tombstoneId, {
        version: 1, ruleId: target.record.ruleId, ruleKey: target.record.ruleKey, versionId,
        reason: String(plan.reason || '历史规则全量审计后隔离').slice(0, 2_000), deprecatedBy: publisher, deprecatedAt: new Date().toISOString(),
      }, {ownerUser: principal, actorUser: publisher, status: 'deprecated', idempotencyKey: `owner-knowledge-reconcile-tombstone:${tombstoneId}`});
      deprecated.push({ruleKey: target.record.ruleKey, versionId});
    }
    const approved = [];
    for (const input of approve) {
      const experience = normalizeOwnerKnowledgeExperience({...input, activation: 'candidate'}, {actorUser: publisher, sourceKind: input?.sourceKind || 'owner_explicit_reconcile'});
      await createVersionIfMissing(experience, publisher);
      const publication = await publishCurrent({...experience, activation: 'active', publishedAt: new Date().toISOString()}, publisher);
      const existingReview = await repository.getRecord(OWNER_KNOWLEDGE_RECORD_TYPES.review, experience.versionId);
      if (!existingReview) await repository.putRecord(OWNER_KNOWLEDGE_RECORD_TYPES.review, experience.versionId, {
        version: 1, versionId: experience.versionId, ruleId: experience.ruleId, ruleKey: experience.ruleKey,
        decision: 'approved', reason: '负责人本轮明确确认', reviewedBy: publisher, reviewedAt: new Date().toISOString(),
      }, {ownerUser: principal, actorUser: publisher, status: 'approved', idempotencyKey: `owner-knowledge-reconcile-approve:${experience.versionId}`});
      approved.push({ruleKey: experience.ruleKey, versionId: experience.versionId, changed: publication.changed, ignoredStale: publication.ignoredStale});
    }
    const proposed = [];
    for (const input of candidates) {
      const experience = normalizeOwnerKnowledgeExperience({...input, activation: 'candidate'}, {actorUser: publisher, sourceKind: input?.sourceKind || 'historical_gpt_audit'});
      const version = await createVersionIfMissing(experience, publisher);
      proposed.push({ruleKey: experience.ruleKey, versionId: experience.versionId, created: version.created});
    }
    const bundle = await rebuildBundle(publisher);
    const distribution = await ensureDistribution({actorUser: publisher, force: true});
    return {ok: true, deprecated, approved, candidates: proposed, bundle: {fingerprint: bundle.fingerprint, ruleCount: bundle.rules.length}, distribution};
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
    const [versions, current, devices, completions, reviews, bundle, distribution] = await Promise.all([
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.version, {ownerUser: principal, limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.current, {ownerUser: principal, status: 'active', limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.device, {ownerUser: principal, limit: 1_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.completion, {ownerUser: principal, limit: 100_000}),
      repository.listRecords(OWNER_KNOWLEDGE_RECORD_TYPES.review, {ownerUser: principal, limit: 100_000}),
      getActiveBundle({}, {all: true}),
      distributionManifest(),
    ]);
    const reviewedVersionIds = new Set(reviews.map(row => String(row.record?.versionId || row.id)));
    const pendingCandidates = versions.filter(row => row.record?.activation === 'candidate' && !reviewedVersionIds.has(String(row.record?.versionId || row.id))).length;
    return {
      authorityId: principal,
      activeRules: current.length,
      candidates: pendingCandidates,
      completionChecks: completions.length,
      pendingReviews: pendingCandidates,
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
    createCompletion,
    listReviews,
    decideRule,
    deprecateRule,
    reconcileRules,
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
