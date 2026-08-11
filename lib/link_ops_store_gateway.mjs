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

function repositoryOrder(record, fallback) {
  const order = Number(record?.repositorySortOrder);
  return Number.isSafeInteger(order) && order >= 0 ? order : fallback;
}

function gatewayError(message, details = {}) {
  return new LinkOpsRepositoryError(message, {
    code: 'LINK_OPS_GATEWAY_CONFLICT',
    details,
  });
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
    const current = await repository.getMeta(metaKey, null);
    if (current && sameRecord(current, next)) return current;
    return repository.putMeta(metaKey, next, {
      expectedRevision: current?.repositoryRevision ?? null,
      actorUser,
      status: 'active',
    });
  }

  async function readTaskStore(options = {}) {
    return repository.getTaskStore({limit: MAX_TASKS, ...options});
  }

  async function replaceTaskStore(nextStore, {actorUser = ''} = {}) {
    const tasks = Array.isArray(nextStore?.tasks) ? nextStore.tasks : null;
    if (!tasks) throw new LinkOpsValidationError('task store tasks must be an array');
    if (tasks.length > MAX_TASKS) throw new LinkOpsValidationError(`task store exceeds ${MAX_TASKS} rows`);

    const currentStore = await readTaskStore();
    const currentById = new Map(currentStore.tasks.map((task, index) => [entityId(task, 'task'), {task, index}]));
    const nextIds = new Set();

    for (let index = 0; index < tasks.length; index += 1) {
      const task = cleanRecord(tasks[index], `tasks[${index}]`);
      const id = entityId(task, 'task');
      if (nextIds.has(id)) throw new LinkOpsValidationError(`Duplicate task id: ${id}`);
      nextIds.add(id);
      const current = currentById.get(id);
      const ownerUser = ownerForRecord(task, actorUser);
      if (!current) {
        await repository.createTask(task, {
          ownerUser,
          actorUser,
          sortOrder: index,
          idempotencyKey: stableIdempotencyKey('task-create', id, task),
        });
        continue;
      }
      const orderChanged = repositoryOrder(current.task, current.index) !== index;
      if (!sameRecord(current.task, task) || orderChanged) {
        await repository.updateTask(id, task, {
          expectedRevision: current.task.repositoryRevision,
          ownerUser,
          actorUser,
          sortOrder: index,
          idempotencyKey: stableIdempotencyKey('task-update', id, {
            expectedRevision: current.task.repositoryRevision,
            task,
            sortOrder: index,
          }),
        });
      }
    }

    for (const [id, {task}] of currentById) {
      if (nextIds.has(id)) continue;
      await repository.deleteTask(id, {
        expectedRevision: task.repositoryRevision,
        actorUser,
        idempotencyKey: stableIdempotencyKey('task-delete', id, {
          expectedRevision: task.repositoryRevision,
        }),
      });
    }

    await syncMeta('task_store', cleanEnvelope(nextStore, 'tasks'), {actorUser});
    return readTaskStore();
  }

  /**
   * Atomic single-task CAS update. Unlike replaceTaskStore (which re-reads the
   * current store and can silently absorb concurrent changes), this writes
   * exactly one task through repository.updateTask with the caller-locked
   * expectedRevision; both the PostgreSQL and JSON repositories enforce the
   * revision predicate inside their transaction/file lock and throw
   * LinkOpsRevisionConflictError when it no longer matches. The store envelope
   * meta is refreshed afterwards without touching any task rows.
   */
  async function updateTaskRecord(taskId, task, {expectedRevision, actorUser = '', envelope = null} = {}) {
    const id = requiredText(taskId, 'taskId');
    const clean = cleanRecord(task, 'task');
    const ownerUser = ownerForRecord(task, actorUser);
    const updated = await repository.updateTask(id, clean, {
      expectedRevision,
      ownerUser,
      actorUser,
      idempotencyKey: stableIdempotencyKey('task-update', id, {
        expectedRevision,
        task: clean,
      }),
    });
    if (envelope && isPlainObject(envelope)) {
      await syncMeta('task_store', cleanEnvelope(envelope, 'tasks'), {actorUser});
    }
    return updated;
  }

  async function readChatStore(options = {}) {
    return repository.getSessionStore({limit: MAX_SESSIONS, includeMessages: true, ...options});
  }

  function assertMessagesAreAppendOnly(currentMessages, nextMessages, sessionId) {
    const currentById = new Map(currentMessages.map(message => [entityId(message, 'message'), message]));
    for (let index = 0; index < nextMessages.length; index += 1) {
      const message = cleanRecord(nextMessages[index], `session ${sessionId} messages[${index}]`);
      const id = entityId(message, 'message');
      const current = currentById.get(id);
      if (current && !sameRecord(current, message)) {
        throw gatewayError(`Chat message ${id} is append-only and cannot be edited`, {sessionId, messageId: id});
      }
    }
  }

  async function replaceChatStore(nextStore, {actorUser = ''} = {}) {
    const sessions = Array.isArray(nextStore?.sessions) ? nextStore.sessions : null;
    if (!sessions) throw new LinkOpsValidationError('chat store sessions must be an array');
    if (sessions.length > MAX_SESSIONS) throw new LinkOpsValidationError(`chat store exceeds ${MAX_SESSIONS} rows`);

    const currentStore = await readChatStore();
    const currentById = new Map(currentStore.sessions.map((session, index) => [entityId(session, 'session'), {session, index}]));
    const nextIds = new Set();

    for (let index = 0; index < sessions.length; index += 1) {
      const source = cleanRecord(sessions[index], `sessions[${index}]`);
      const messages = Array.isArray(source.messages) ? source.messages.map(message => cleanRecord(message)) : [];
      const id = entityId(source, 'session');
      if (nextIds.has(id)) throw new LinkOpsValidationError(`Duplicate session id: ${id}`);
      nextIds.add(id);
      const current = currentById.get(id);
      const ownerUser = ownerForRecord(source, actorUser);

      if (!current) {
        await repository.createSession({...source, messages}, {
          ownerUser,
          actorUser,
          sortOrder: index,
          idempotencyKey: stableIdempotencyKey('session-create', id, {session: cleanSession(source), messages}),
        });
        continue;
      }

      const currentMessages = Array.isArray(current.session.messages) ? current.session.messages : [];
      assertMessagesAreAppendOnly(currentMessages, messages, id);
      const orderChanged = repositoryOrder(current.session, current.index) !== index;
      if (!sameSession(current.session, source) || orderChanged) {
        const updated = await repository.updateSession(id, cleanSession(source), {
          expectedRevision: current.session.repositoryRevision,
          ownerUser,
          actorUser,
          sortOrder: index,
          idempotencyKey: stableIdempotencyKey('session-update', id, {
            expectedRevision: current.session.repositoryRevision,
            session: cleanSession(source),
            sortOrder: index,
          }),
        });
        current.session.repositoryRevision = updated.repositoryRevision;
      }

      const currentMessageIds = new Set(currentMessages.map(message => entityId(message, 'message')));
      let sequenceNo = currentMessages.length;
      for (const message of messages) {
        const messageId = entityId(message, 'message');
        if (currentMessageIds.has(messageId)) continue;
        await repository.appendMessage(id, message, {
          ownerUser,
          actorUser,
          sequenceNo,
          idempotencyKey: stableIdempotencyKey('message-append', messageId, {sessionId: id, message}),
        });
        sequenceNo += 1;
      }
    }

    for (const [id, {session}] of currentById) {
      if (nextIds.has(id)) continue;
      const latest = await repository.getSession(id, {includeMessages: false});
      await repository.deleteSession(id, {
        expectedRevision: latest?.repositoryRevision ?? session.repositoryRevision,
        actorUser,
        idempotencyKey: stableIdempotencyKey('session-delete', id, {
          expectedRevision: latest?.repositoryRevision ?? session.repositoryRevision,
        }),
      });
    }

    await syncMeta('session_store', cleanEnvelope(nextStore, 'sessions'), {actorUser});
    return readChatStore();
  }

  async function readActionState() {
    return repository.getActionState();
  }

  async function replaceActionState(nextStore, {actorUser = ''} = {}) {
    const actions = isPlainObject(nextStore?.actions) ? nextStore.actions : null;
    if (!actions) throw new LinkOpsValidationError('action state actions must be a JSON object');
    const entries = Object.entries(actions);
    if (entries.length > MAX_ACTIONS) throw new LinkOpsValidationError(`action state exceeds ${MAX_ACTIONS} rows`);

    const currentStore = await readActionState();
    const currentActions = isPlainObject(currentStore.actions) ? currentStore.actions : {};
    const nextKeys = new Set(entries.map(([key]) => requiredText(key, 'action key')));

    for (const [key, value] of entries) {
      const record = cleanRecord(value, `action ${key}`);
      const current = currentActions[key];
      if (current && sameRecord(current, record)) continue;
      await repository.putActionRecord(key, record, {
        expectedRevision: current?.repositoryRevision ?? null,
        ownerUser: ownerForRecord(record, actorUser),
        actorUser,
        status: String(record.status || ''),
        idempotencyKey: stableIdempotencyKey(current ? 'action-update' : 'action-create', key, {
          expectedRevision: current?.repositoryRevision ?? null,
          record,
        }),
      });
    }

    for (const [key, current] of Object.entries(currentActions)) {
      if (nextKeys.has(key)) continue;
      await repository.deleteRecord('action_state', key, {
        expectedRevision: current.repositoryRevision,
        actorUser,
        idempotencyKey: stableIdempotencyKey('action-delete', key, {
          expectedRevision: current.repositoryRevision,
        }),
      });
    }

    await syncMeta('action_store', cleanEnvelope(nextStore, 'actions'), {actorUser});
    if (typeof repository.flushLegacyActionState === 'function') {
      await repository.flushLegacyActionState();
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
    updateTaskRecord,
    readChatStore,
    replaceChatStore,
    readActionState,
    replaceActionState,
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
