import {
  LinkOpsRepositoryError,
  LinkOpsValidationError,
  createLinkOpsRepository,
  linkOpsPayloadHash,
  stripLinkOpsRepositoryMetadata,
} from './link_ops_repository.mjs';
import {createLinkOpsJsonRepository} from './link_ops_json_repository.mjs';

const MAX_TASKS = 10_000;
const MAX_SESSIONS = 3_000;
const MAX_ACTIONS = 20_000;

/**
 * Max CAS attempts when synchronizing a derived store envelope. The envelope
 * (task_store/session_store/action_store) is mirror metadata only; entity
 * rows are the source of truth. A concurrent writer can advance the envelope
 * between our getMeta read and the putMeta CAS, so a small bounded re-read
 * retry absorbs that race instead of exposing it as a whole-operation failure.
 */
const META_SYNC_MAX_ATTEMPTS = 3;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new LinkOpsValidationError(`${label} is required`);
  return text;
}

function cleanRecord(value, label = 'record') {
  if (!isPlainObject(value)) throw new LinkOpsValidationError(`${label} must be a JSON object`);
  return stripLinkOpsRepositoryMetadata(value);
}

function cleanSession(value) {
  const record = cleanRecord(value, 'session');
  delete record.messages;
  return record;
}

function cleanEnvelope(value, listKey) {
  if (!isPlainObject(value)) throw new LinkOpsValidationError(`${listKey} store must be a JSON object`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== listKey && !key.startsWith('repository'))
  );
}

function sameRecord(left, right) {
  return linkOpsPayloadHash(cleanRecord(left)) === linkOpsPayloadHash(cleanRecord(right));
}

function sameSession(left, right) {
  return linkOpsPayloadHash(cleanSession(left)) === linkOpsPayloadHash(cleanSession(right));
}

function stableIdempotencyKey(operation, entityId, payload) {
  const digest = linkOpsPayloadHash(payload);
  return `${operation}:${String(entityId)}:${digest.slice(0, 32)}`;
}

function entityId(record, kind) {
  return requiredText(record?.id || record?.[`${kind}Id`], `${kind}.id`);
}

function ownerForRecord(record, fallback = '') {
  return requiredText(
    fallback
    || record?.ownerUser
    || record?.ownership?.ownerUser
    || record?.ownership?.actorKey
    || record?.ownership?.username
    || record?.requestedByUser
    || record?.createdByUser
    || '',
    'ownerUser'
  );
}

function callerRevision(record, label = 'repositoryRevision') {
  const revision = Number(record?.repositoryRevision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new LinkOpsValidationError(`${label} must be a positive integer from the caller snapshot`);
  }
  return revision;
}

function gatewayError(message, details = {}) {
  return new LinkOpsRepositoryError(message, {
    code: 'LINK_OPS_GATEWAY_CONFLICT',
    details,
  });
}

/**
 * Distinct, internal signal raised only after META_SYNC_MAX_ATTEMPTS CAS
 * attempts against the same derived envelope all lost to concurrent writers.
 * Post-commit callers catch this exact class so already-committed entity rows
 * never appear as a failed whole operation. Genuine entity or other conflicts
 * are never converted to this error.
 */
class LinkOpsMetaSyncConflictError extends LinkOpsRepositoryError {
  constructor(message, details = {}) {
    super(message, {
      code: 'LINK_OPS_META_SYNC_CONFLICT',
      details,
    });
    this.name = 'LinkOpsMetaSyncConflictError';
  }
}

function metaSyncFailure(message, details = {}) {
  return new LinkOpsMetaSyncConflictError(message, details);
}

function isMetaEnvelopeConflict(error, metaKey) {
  if (!error || error.code !== 'LINK_OPS_REVISION_CONFLICT') return false;
  // Absorb only a revision conflict that is unambiguously the derived envelope
  // for THIS key: meta entity type AND exact key match (strict AND). A
  // same-key entity conflict or any other key must fail closed and never
  // become a recoverable meta-only condition.
  return error.details?.entityType === 'meta' && error.details?.entityId === metaKey;
}

function isMetaSyncFailure(error, metaKey) {
  return error instanceof LinkOpsMetaSyncConflictError
    && error.details?.metaKey === metaKey;
}

/**
 * Compatibility gateway for the existing portal's snapshot-shaped state.
 * PostgreSQL mode never stores a whole document: every diff is persisted via
 * row-level repository methods with optimistic revisions and idempotency keys.
 */
export function createLinkOpsStoreGateway({repository}) {
  if (!repository || typeof repository.getTaskStore !== 'function') {
    throw new TypeError('A Link Ops repository is required');
  }

  async function syncMeta(metaKey, envelope, {actorUser = ''} = {}) {
    const next = cleanRecord(envelope, `${metaKey} envelope`);
    let current = await repository.getMeta(metaKey, null);
    for (let attempt = 1; attempt <= META_SYNC_MAX_ATTEMPTS; attempt += 1) {
      if (current && sameRecord(current, next)) return current;
      try {
        return await repository.putMeta(metaKey, next, {
          expectedRevision: current?.repositoryRevision ?? null,
          actorUser,
          status: 'active',
        });
      } catch (error) {
        if (!isMetaEnvelopeConflict(error, metaKey)) throw error;
        current = await repository.getMeta(metaKey, null);
      }
    }
    // Bounded retries exhausted under persistent concurrent envelope writes.
    // Explicit termination: never loop without bound. Surface a distinct,
    // containable meta-only failure so replace* callers can keep the already
    // committed entity rows and return authoritative readback instead of
    // falsely reporting the whole operation as failed.
    if (current && sameRecord(current, next)) return current;
    throw metaSyncFailure(`meta ${metaKey} envelope sync exhausted ${META_SYNC_MAX_ATTEMPTS} CAS attempts`, {
      metaKey,
      attempts: META_SYNC_MAX_ATTEMPTS,
    });
  }

  /**
   * Wraps syncMeta so a meta-only (derived envelope) CAS exhaustion never
   * fails the enclosing replace* operation after its entity rows are already
   * committed. The authoritative readback that follows is the source of truth.
   */
  async function syncMetaGuarded(metaKey, envelope, options = {}) {
    try {
      await syncMeta(metaKey, envelope, options);
    } catch (error) {
      if (!isMetaSyncFailure(error, metaKey)) throw error;
    }
  }

  async function readTaskStore(options = {}) {
    return repository.getTaskStore({limit: MAX_TASKS, ...options});
  }

  async function createTaskRecord(task, {actorUser = '', envelope = null, sortOrder = 0} = {}) {
    const clean = cleanRecord(task, 'task');
    const id = entityId(clean, 'task');
    const ownerUser = ownerForRecord(clean, actorUser);
    const created = await repository.createTask(clean, {
      ownerUser,
      actorUser,
      sortOrder,
      idempotencyKey: stableIdempotencyKey('task-create', id, {task: clean, sortOrder}),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('task_store', cleanEnvelope(envelope, 'tasks'), {actorUser});
    }
    return created;
  }

  /**
   * Atomic single-task CAS update using the revision supplied by the caller's
   * read. The gateway never substitutes a fresh repository revision.
   */
  async function updateTaskRecord(taskId, task, {
    expectedRevision,
    actorUser = '',
    envelope = null,
    sortOrder = null,
  } = {}) {
    const id = requiredText(taskId, 'taskId');
    const clean = cleanRecord(task, 'task');
    const ownerUser = ownerForRecord(task, actorUser);
    const updated = await repository.updateTask(id, clean, {
      expectedRevision,
      ownerUser,
      actorUser,
      sortOrder,
      idempotencyKey: stableIdempotencyKey('task-update', id, {
        expectedRevision,
        task: clean,
        sortOrder,
      }),
    });
    if (envelope && isPlainObject(envelope)) {
      // Entity row already committed above; the derived envelope must not turn
      // a concurrent meta CAS loss into a false whole-operation failure.
      await syncMetaGuarded('task_store', cleanEnvelope(envelope, 'tasks'), {actorUser});
    }
    return updated;
  }

  async function deleteTaskRecord(taskId, {expectedRevision, actorUser = '', envelope = null} = {}) {
    const id = requiredText(taskId, 'taskId');
    const deleted = await repository.deleteTask(id, {
      expectedRevision,
      actorUser,
      idempotencyKey: stableIdempotencyKey('task-delete', id, {expectedRevision}),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('task_store', cleanEnvelope(envelope, 'tasks'), {actorUser});
    }
    return deleted;
  }

  /**
   * Snapshot compatibility is intentionally narrow: omissions are ignored,
   * so an old snapshot cannot delete a concurrent task. At most one explicit
   * create/update is accepted and its caller revision is validated before any
   * write. Callers needing deletion must use deleteTaskRecord.
   */
  async function replaceTaskStore(nextStore, {actorUser = ''} = {}) {
    const tasks = Array.isArray(nextStore?.tasks) ? nextStore.tasks : null;
    if (!tasks) throw new LinkOpsValidationError('task store tasks must be an array');
    if (tasks.length > MAX_TASKS) throw new LinkOpsValidationError(`task store exceeds ${MAX_TASKS} rows`);

    const currentStore = await readTaskStore();
    const currentById = new Map(currentStore.tasks.map(task => [entityId(task, 'task'), task]));
    const seen = new Set();
    const changes = [];
    for (let index = 0; index < tasks.length; index += 1) {
      const source = tasks[index];
      const task = cleanRecord(source, `tasks[${index}]`);
      const id = entityId(task, 'task');
      if (seen.has(id)) throw new LinkOpsValidationError(`Duplicate task id: ${id}`);
      seen.add(id);
      const current = currentById.get(id);
      if (!current) {
        changes.push({type: 'create', id, task, sortOrder: index});
      } else if (!sameRecord(current, task)) {
        changes.push({
          type: 'update',
          id,
          task,
          expectedRevision: callerRevision(source, `task ${id}.repositoryRevision`),
        });
      }
    }
    if (changes.length > 1) {
      throw gatewayError('replaceTaskStore may mutate at most one task; use explicit record APIs', {
        entityType: 'task',
        changeCount: changes.length,
        entityIds: changes.map(change => change.id),
      });
    }

    const envelope = cleanEnvelope(nextStore, 'tasks');
    const change = changes[0];
    if (!change) {
      await syncMetaGuarded('task_store', envelope, {actorUser});
    } else if (change.type === 'create') {
      await createTaskRecord(change.task, {actorUser, envelope, sortOrder: change.sortOrder});
    } else {
      await updateTaskRecord(change.id, change.task, {
        expectedRevision: change.expectedRevision,
        actorUser,
        envelope,
      });
    }
    return readTaskStore();
  }

  async function readChatStore(options = {}) {
    return repository.getSessionStore({limit: MAX_SESSIONS, includeMessages: true, ...options});
  }

  function assertMessagesAreAppendOnly(currentMessages, nextMessages, sessionId) {
    if (nextMessages.length < currentMessages.length) {
      throw gatewayError(`Chat session ${sessionId} messages are append-only and cannot be deleted`, {
        sessionId,
        currentCount: currentMessages.length,
        desiredCount: nextMessages.length,
      });
    }
    for (let index = 0; index < currentMessages.length; index += 1) {
      const current = currentMessages[index];
      const next = nextMessages[index];
      const currentId = entityId(current, 'message');
      const nextId = entityId(next, 'message');
      if (currentId !== nextId || !sameRecord(current, next)) {
        throw gatewayError(`Chat message ${currentId} is append-only and cannot be edited or reordered`, {
          sessionId,
          messageId: currentId,
          index,
        });
      }
    }
    return nextMessages.length > currentMessages.length;
  }

  async function createChatSessionRecord(session, {actorUser = '', envelope = null, sortOrder = 0} = {}) {
    const source = cleanRecord(session, 'session');
    const messages = Array.isArray(source.messages)
      ? source.messages.map((message, index) => cleanRecord(message, `session messages[${index}]`))
      : [];
    const id = entityId(source, 'session');
    const ownerUser = ownerForRecord(source, actorUser);
    const created = await repository.createSession({...cleanSession(source), messages}, {
      ownerUser,
      actorUser,
      sortOrder,
      idempotencyKey: stableIdempotencyKey('session-create', id, {
        session: cleanSession(source),
        messages,
        sortOrder,
      }),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('session_store', cleanEnvelope(envelope, 'sessions'), {actorUser});
    }
    return created;
  }

  async function updateChatSessionRecord(chatSessionId, session, {
    expectedRevision,
    actorUser = '',
    envelope = null,
    sortOrder = null,
  } = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const source = cleanRecord(session, 'session');
    const messages = Array.isArray(source.messages)
      ? source.messages.map((message, index) => cleanRecord(message, `session ${id} messages[${index}]`))
      : [];
    const ownerUser = ownerForRecord(source, actorUser);
    if (typeof repository.updateSessionWithMessages !== 'function') {
      throw new TypeError('Repository does not support atomic session/message updates');
    }
    const updated = await repository.updateSessionWithMessages(id, {...cleanSession(source), messages}, {
      expectedRevision,
      ownerUser,
      actorUser,
      sortOrder,
      idempotencyKey: stableIdempotencyKey('session-update-with-messages', id, {
        expectedRevision,
        session: cleanSession(source),
        messages,
        sortOrder,
      }),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('session_store', cleanEnvelope(envelope, 'sessions'), {actorUser});
    }
    return updated;
  }

  async function deleteChatSessionRecord(chatSessionId, {
    expectedRevision,
    actorUser = '',
    envelope = null,
  } = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const deleted = await repository.deleteSession(id, {
      expectedRevision,
      actorUser,
      idempotencyKey: stableIdempotencyKey('session-delete', id, {expectedRevision}),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('session_store', cleanEnvelope(envelope, 'sessions'), {actorUser});
    }
    return deleted;
  }

  async function replaceChatStore(nextStore, {actorUser = ''} = {}) {
    const sessions = Array.isArray(nextStore?.sessions) ? nextStore.sessions : null;
    if (!sessions) throw new LinkOpsValidationError('chat store sessions must be an array');
    if (sessions.length > MAX_SESSIONS) throw new LinkOpsValidationError(`chat store exceeds ${MAX_SESSIONS} rows`);

    const currentStore = await readChatStore();
    const currentById = new Map(currentStore.sessions.map(session => [entityId(session, 'session'), session]));
    const seen = new Set();
    const changes = [];
    for (let index = 0; index < sessions.length; index += 1) {
      const sourceRecord = sessions[index];
      const source = cleanRecord(sourceRecord, `sessions[${index}]`);
      const messages = Array.isArray(source.messages)
        ? source.messages.map((message, messageIndex) => cleanRecord(message, `sessions[${index}].messages[${messageIndex}]`))
        : [];
      const id = entityId(source, 'session');
      if (seen.has(id)) throw new LinkOpsValidationError(`Duplicate session id: ${id}`);
      seen.add(id);
      const current = currentById.get(id);
      if (!current) {
        changes.push({type: 'create', id, session: {...cleanSession(source), messages}, sortOrder: index});
        continue;
      }
      const currentMessages = Array.isArray(current.messages) ? current.messages : [];
      const messagesAppended = assertMessagesAreAppendOnly(currentMessages, messages, id);
      if (!sameSession(current, source) || messagesAppended) {
        changes.push({
          type: 'update',
          id,
          session: {...cleanSession(source), messages},
          expectedRevision: callerRevision(sourceRecord, `session ${id}.repositoryRevision`),
        });
      }
    }
    if (changes.length > 1) {
      throw gatewayError('replaceChatStore may mutate at most one session; use explicit record APIs', {
        entityType: 'session',
        changeCount: changes.length,
        entityIds: changes.map(change => change.id),
      });
    }

    const envelope = cleanEnvelope(nextStore, 'sessions');
    const change = changes[0];
    if (!change) {
      await syncMetaGuarded('session_store', envelope, {actorUser});
    } else if (change.type === 'create') {
      await createChatSessionRecord(change.session, {actorUser, envelope, sortOrder: change.sortOrder});
    } else {
      await updateChatSessionRecord(change.id, change.session, {
        expectedRevision: change.expectedRevision,
        actorUser,
        envelope,
      });
    }
    return readChatStore();
  }

  async function readActionState() {
    return repository.getActionState();
  }

  async function applyActionChanges(changes, {actorUser = '', envelope = null} = {}) {
    if (!Array.isArray(changes)) throw new LinkOpsValidationError('action changes must be an array');
    if (changes.length > MAX_ACTIONS) throw new LinkOpsValidationError(`action changes exceed ${MAX_ACTIONS} rows`);
    if (typeof repository.applyActionChanges !== 'function') {
      throw new TypeError('Repository does not support atomic action batches');
    }
    const seen = new Set();
    const normalized = changes.map((change, index) => {
      if (!isPlainObject(change)) throw new LinkOpsValidationError(`action changes[${index}] must be a JSON object`);
      const key = requiredText(change.key, `action changes[${index}].key`);
      if (seen.has(key)) throw new LinkOpsValidationError(`Duplicate action key: ${key}`);
      seen.add(key);
      if (change.delete === true) {
        return {key, delete: true, expectedRevision: change.expectedRevision};
      }
      return {
        key,
        delete: false,
        expectedRevision: change.expectedRevision ?? null,
        record: cleanRecord(change.record, `action ${key}`),
      };
    });
    await repository.applyActionChanges(normalized, {
      actorUser,
      idempotencyKey: stableIdempotencyKey('action-batch', 'actions', normalized),
    });

    if (envelope && isPlainObject(envelope)) {
      await syncMetaGuarded('action_store', cleanEnvelope(envelope, 'actions'), {actorUser});
    }
    if (typeof repository.flushLegacyActionState === 'function') {
      await repository.flushLegacyActionState();
    }
    return readActionState();
  }

  async function replaceActionState(nextStore, {actorUser = ''} = {}) {
    const actions = isPlainObject(nextStore?.actions) ? nextStore.actions : null;
    if (!actions) throw new LinkOpsValidationError('action state actions must be a JSON object');
    const entries = Object.entries(actions);
    if (entries.length > MAX_ACTIONS) throw new LinkOpsValidationError(`action state exceeds ${MAX_ACTIONS} rows`);

    const currentStore = await readActionState();
    const currentActions = isPlainObject(currentStore.actions) ? currentStore.actions : {};
    const changes = [];
    for (const [rawKey, source] of entries) {
      const key = requiredText(rawKey, 'action key');
      const record = cleanRecord(source, `action ${key}`);
      const current = currentActions[key];
      if (!current) {
        changes.push({key, expectedRevision: null, record});
      } else if (!sameRecord(current, record)) {
        changes.push({
          key,
          expectedRevision: callerRevision(source, `action ${key}.repositoryRevision`),
          record,
        });
      }
    }
    if (changes.length > 1) {
      throw gatewayError('replaceActionState may mutate at most one action; use applyActionChanges', {
        entityType: 'action_state',
        changeCount: changes.length,
        entityIds: changes.map(change => change.key),
      });
    }

    const envelope = cleanEnvelope(nextStore, 'actions');
    if (changes.length) {
      await applyActionChanges(changes, {actorUser, envelope});
    } else {
      await syncMetaGuarded('action_store', envelope, {actorUser});
    }
    return readActionState();
  }

  return Object.freeze({
    mode: repository.mode,
    repository,
    close: () => repository.close(),
    health: () => repository.health(),
    readTaskStore,
    replaceTaskStore,
    createTaskRecord,
    updateTaskRecord,
    deleteTaskRecord,
    readChatStore,
    replaceChatStore,
    createChatSessionRecord,
    updateChatSessionRecord,
    deleteChatSessionRecord,
    readActionState,
    replaceActionState,
    applyActionChanges,
    getJob: (...args) => repository.getJob(...args),
    listJobs: (...args) => repository.listJobs(...args),
    enqueueJob: (...args) => repository.enqueueJob(...args),
    recoverExpiredJobs: (...args) => repository.recoverExpiredJobs(...args),
    claimJob: (...args) => repository.claimJob(...args),
    heartbeatJob: (...args) => repository.heartbeatJob(...args),
    advanceJobWriteBoundary: (...args) => repository.advanceJobWriteBoundary(...args),
    finishJob: (...args) => repository.finishJob(...args),
    appendEvent: (...args) => repository.appendEvent(...args),
    listEvents: (...args) => repository.listEvents(...args),
  });
}

export function createConfiguredLinkOpsStoreGateway({
  env = process.env,
  rootDir = process.cwd(),
  taskFile,
  sessionFile,
  actionFile,
  runtimeFile,
  repository,
} = {}) {
  if (repository) return createLinkOpsStoreGateway({repository});
  const mode = String(
    env.SHEIN_LINK_OPS_STORE
    || env.SHEIN_LINK_OPS_REPOSITORY_MODE
    || 'json'
  ).trim().toLowerCase();
  if (!['json', 'postgres'].includes(mode)) {
    throw new LinkOpsValidationError(`Unsupported SHEIN_LINK_OPS_STORE mode: ${mode}`);
  }
  const configuredRepository = mode === 'postgres'
    ? createLinkOpsRepository({mode: 'postgres', env})
    : createLinkOpsJsonRepository({rootDir, taskFile, sessionFile, actionFile, runtimeFile});
  return createLinkOpsStoreGateway({repository: configuredRepository});
}
