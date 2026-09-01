import crypto from 'node:crypto';
import {
  closeWarehousePg,
  createWarehousePgPool,
  withPgClient,
  withPgTransaction,
  WarehousePgConfigurationError,
} from './warehouse_pg.mjs';

export const LINK_OPS_MIGRATION_VERSION = '20260711_001_link_ops_runtime';
export const LINK_OPS_JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'succeeded',
  'failed',
  'uncertain_write',
]);

const JOB_STATUS_SET = new Set(LINK_OPS_JOB_STATUSES);
const REPOSITORY_FIELDS = new Set([
  'repositoryRevision',
  'repositoryPayloadHash',
  'repositorySortOrder',
  'repositorySequenceNo',
]);
const DEFAULT_SAFE_RETRY_WRITE_BOUNDARIES = Object.freeze([
  'none',
  'read_only',
  'planned',
  'preflight_complete',
]);

export class LinkOpsRepositoryError extends Error {
  constructor(message, {code = 'LINK_OPS_REPOSITORY', cause, details} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = 'LinkOpsRepositoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class LinkOpsValidationError extends LinkOpsRepositoryError {
  constructor(message, details) {
    super(message, {code: 'LINK_OPS_VALIDATION', details});
    this.name = 'LinkOpsValidationError';
  }
}

export class LinkOpsNotFoundError extends LinkOpsRepositoryError {
  constructor(entityType, entityId) {
    super(`${entityType} ${entityId} was not found`, {
      code: 'LINK_OPS_NOT_FOUND',
      details: {entityType, entityId},
    });
    this.name = 'LinkOpsNotFoundError';
  }
}

export class LinkOpsRevisionConflictError extends LinkOpsRepositoryError {
  constructor(entityType, entityId, expectedRevision, currentRevision = null) {
    super(`${entityType} ${entityId} revision conflict`, {
      code: 'LINK_OPS_REVISION_CONFLICT',
      details: {entityType, entityId, expectedRevision, currentRevision},
    });
    this.name = 'LinkOpsRevisionConflictError';
  }
}

export class LinkOpsIdempotencyConflictError extends LinkOpsRepositoryError {
  constructor(scope, idempotencyKey) {
    super(`Idempotency key was reused with a different request in ${scope}`, {
      code: 'LINK_OPS_IDEMPOTENCY_CONFLICT',
      details: {scope, idempotencyKey},
    });
    this.name = 'LinkOpsIdempotencyConflictError';
  }
}

export class LinkOpsImportConflictError extends LinkOpsRepositoryError {
  constructor(entityType, entityId, incomingHash, storedHash) {
    super(`Import conflict for ${entityType} ${entityId}: the stored payload hash differs`, {
      code: 'LINK_OPS_IMPORT_CONFLICT',
      details: {entityType, entityId, incomingHash, storedHash},
    });
    this.name = 'LinkOpsImportConflictError';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value, label = 'value') {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new LinkOpsValidationError(`${label} must be JSON serializable`, {cause: error?.message});
  }
  if (serialized === undefined) throw new LinkOpsValidationError(`${label} must be JSON serializable`);
  return JSON.parse(serialized);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(jsonClone(value)));
}

export function linkOpsPayloadHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function stripLinkOpsRepositoryMetadata(record) {
  if (!isPlainObject(record)) throw new LinkOpsValidationError('record must be a JSON object');
  return Object.fromEntries(
    Object.entries(jsonClone(record, 'record')).filter(([key]) => !REPOSITORY_FIELDS.has(key))
  );
}

function decorateRecord(record, revision, payloadHash, metadata = {}) {
  const decorated = {
    ...jsonClone(record, 'record'),
    repositoryRevision: Number(revision),
    repositoryPayloadHash: String(payloadHash || ''),
  };
  if (Number.isSafeInteger(Number(metadata.sortOrder))) {
    decorated.repositorySortOrder = Number(metadata.sortOrder);
  }
  if (Number.isSafeInteger(Number(metadata.sequenceNo))) {
    decorated.repositorySequenceNo = Number(metadata.sequenceNo);
  }
  return decorated;
}

function parseJsonColumn(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return jsonClone(fallback);
  if (typeof value === 'string') return JSON.parse(value);
  return jsonClone(value);
}

function requiredText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new LinkOpsValidationError(`${label} is required`);
  return normalized;
}

function optionalText(value) {
  return String(value ?? '').trim();
}

function positiveRevision(value, label = 'expectedRevision') {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new LinkOpsValidationError(`${label} must be a positive integer`);
  }
  return revision;
}

function boundedInteger(value, {fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER, label = 'value'} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new LinkOpsValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function timestampOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new LinkOpsValidationError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function timestampFromRecord(record, keys, label) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return timestampOrNull(record[key], label);
    }
  }
  return null;
}

function textArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => optionalText(item)).filter(Boolean))];
}

function recordOwner(record, fallback = '') {
  return requiredText(
    fallback
    || record.ownerUser
    || record.ownership?.ownerUser
    || record.requestedByUser
    || record.createdByUser,
    'ownerUser'
  );
}

function recordActor(record, fallback = '') {
  return optionalText(
    record.actorUser
    || record.updatedByUser
    || record.createdByUser
    || record.requestedByUser
    || record.ownership?.ownerUser
    || fallback
  );
}

function taskChatSessionId(record) {
  return optionalText(record.chatSessionId || record.chat?.sessionId || record.sessionId) || null;
}

function taskTargetArrays(record) {
  const targets = isPlainObject(record.targets) ? record.targets : {};
  const writeStores = textArray(targets.writeStores || targets.targetStores || targets.stores);
  return {
    intents: textArray(record.intents),
    sourceStores: textArray(targets.sourceStores),
    writeStores,
    productRefs: textArray(targets.productRefs),
  };
}

function sessionRecordWithoutMessages(record) {
  const clean = stripLinkOpsRepositoryMetadata(record);
  delete clean.messages;
  return clean;
}

function normalizeMessageRecord(message, label = 'message') {
  const clean = recordWithoutRepositoryMetadata(message);
  const messageId = requiredText(clean.id || clean.messageId, `${label}.id`);
  clean.id = messageId;
  delete clean.messageId;
  const role = requiredText(clean.role, `${label}.role`);
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
    throw new LinkOpsValidationError(`Unsupported message role: ${role}`);
  }
  return {
    clean,
    messageId,
    role,
    status: optionalText(clean.status) || 'created',
    createdAt: timestampFromRecord(clean, ['at', 'createdAt'], `${label}.at`),
    updatedAt: timestampFromRecord(clean, ['updatedAt', 'at', 'createdAt'], `${label}.updatedAt`),
    payloadHash: linkOpsPayloadHash(clean),
  };
}

function normalizeDesiredMessages(messages, label = 'messages') {
  if (!Array.isArray(messages)) throw new LinkOpsValidationError(`${label} must be an array`);
  const normalized = messages.map((message, index) => normalizeMessageRecord(message, `${label}[${index}]`));
  const ids = new Set();
  for (const message of normalized) {
    if (ids.has(message.messageId)) {
      throw new LinkOpsValidationError(`Duplicate message id: ${message.messageId}`);
    }
    ids.add(message.messageId);
  }
  return normalized;
}

function assertStrictMessageAppend(currentMessages, desiredMessages, sessionId) {
  if (desiredMessages.length < currentMessages.length) {
    throw new LinkOpsRepositoryError(`Chat session ${sessionId} messages are append-only`, {
      code: 'LINK_OPS_APPEND_ONLY_CONFLICT',
      details: {sessionId, currentCount: currentMessages.length, desiredCount: desiredMessages.length},
    });
  }
  for (let index = 0; index < currentMessages.length; index += 1) {
    const current = rowToRecord(currentMessages[index]);
    const desired = desiredMessages[index];
    const currentId = requiredText(current?.id || current?.messageId, `current message ${index}.id`);
    if (currentId !== desired.messageId
      || linkOpsPayloadHash(recordWithoutRepositoryMetadata(current)) !== desired.payloadHash) {
      throw new LinkOpsRepositoryError(`Chat message ${currentId} is append-only and cannot be edited or reordered`, {
        code: 'LINK_OPS_APPEND_ONLY_CONFLICT',
        details: {sessionId, messageId: currentId, index},
      });
    }
  }
}

function recordWithoutRepositoryMetadata(record) {
  return stripLinkOpsRepositoryMetadata(record);
}

function rowToRecord(row) {
  if (!row) return null;
  return decorateRecord(parseJsonColumn(row.record), row.revision, row.payload_hash, {
    sortOrder: row.sort_order,
    sequenceNo: row.sequence_no,
  });
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    eventId: String(row.event_id),
    eventKey: row.event_key || null,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    ownerUser: row.owner_user,
    actorUser: row.actor_user,
    status: row.status,
    chatSessionId: row.chat_session_id,
    taskId: row.task_id,
    jobId: row.job_id,
    payload: parseJsonColumn(row.payload),
    payloadHash: row.payload_hash,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    ...rowToRecord(row),
    jobId: row.job_id,
    taskId: row.task_id,
    chatSessionId: row.chat_session_id,
    ownerUser: row.owner_user,
    actorUser: row.actor_user,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    writeBoundary: row.write_boundary,
    payloadHash: row.payload_hash,
    result: parseJsonColumn(row.result),
    error: parseJsonColumn(row.error),
    attempt: Number(row.attempt || 0),
    queuedAt: row.queued_at ? new Date(row.queued_at).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

async function queryCurrentRevision(client, table, idColumn, entityId, extraWhere = '', extraValues = []) {
  const result = await client.query(
    `SELECT revision FROM ${table} WHERE ${idColumn} = $1${extraWhere}`,
    [entityId, ...extraValues]
  );
  return result.rows?.[0]?.revision === undefined ? null : Number(result.rows[0].revision);
}

async function appendEventInTransaction(client, event) {
  const payload = isPlainObject(event.payload) ? jsonClone(event.payload) : {};
  const payloadHash = linkOpsPayloadHash(payload);
  const result = await client.query({
    name: 'link-ops-append-event',
    text: `/* link_ops:append_event */
      INSERT INTO ops.link_ops_event(
        event_key, aggregate_type, aggregate_id, event_type,
        owner_user, actor_user, status, chat_session_id, task_id, job_id,
        payload, payload_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      RETURNING *`,
    values: [
      optionalText(event.eventKey) || null,
      requiredText(event.aggregateType, 'aggregateType'),
      requiredText(event.aggregateId, 'aggregateId'),
      requiredText(event.eventType, 'eventType'),
      optionalText(event.ownerUser),
      optionalText(event.actorUser),
      optionalText(event.status),
      optionalText(event.chatSessionId) || null,
      optionalText(event.taskId) || null,
      optionalText(event.jobId) || null,
      JSON.stringify(payload),
      payloadHash,
    ],
  });
  return rowToEvent(result.rows?.[0]);
}

async function readIdempotency(client, scope, idempotencyKey) {
  if (!idempotencyKey) return null;
  const result = await client.query({
    name: 'link-ops-read-idempotency',
    text: `/* link_ops:read_idempotency */
      SELECT request_hash, entity_type, entity_id, response
      FROM ops.link_ops_idempotency
      WHERE scope=$1 AND idempotency_key=$2
      FOR UPDATE`,
    values: [scope, idempotencyKey],
  });
  return result.rows?.[0] || null;
}

async function writeIdempotency(client, {scope, idempotencyKey, requestHash, entityType, entityId, response}) {
  if (!idempotencyKey) return;
  await client.query({
    name: 'link-ops-write-idempotency',
    text: `/* link_ops:write_idempotency */
      INSERT INTO ops.link_ops_idempotency(
        scope, idempotency_key, request_hash, entity_type, entity_id, response
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    values: [scope, idempotencyKey, requestHash, entityType, entityId, JSON.stringify(response || {})],
  });
}

function replayIdempotent(prior, requestHash, scope, idempotencyKey) {
  if (!prior) return null;
  if (prior.request_hash !== requestHash) {
    throw new LinkOpsIdempotencyConflictError(scope, idempotencyKey);
  }
  const response = parseJsonColumn(prior.response);
  if (response.record && response.revision && response.payloadHash) {
    return decorateRecord(response.record, response.revision, response.payloadHash);
  }
  return response;
}

function idempotencyResponse(record) {
  const clean = recordWithoutRepositoryMetadata(record);
  return {
    record: clean,
    revision: record.repositoryRevision,
    payloadHash: record.repositoryPayloadHash,
  };
}

function ensureHash(value, label = 'payloadHash') {
  const hash = optionalText(value);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new LinkOpsValidationError(`${label} must be a lowercase SHA-256 hash`);
  return hash;
}

export function createLinkOpsPostgresRepository({pool, client, env = process.env} = {}) {
  if (pool && client) throw new TypeError('Pass either pool or client, not both');
  const ownsPool = !pool && !client;
  const source = pool || client || createWarehousePgPool({env});

  async function transaction(lockKey, callback, options = {}) {
    return withPgTransaction(source, callback, {
      advisoryLockKey: `link-ops:${lockKey}`,
      ...options,
    });
  }

  async function close() {
    if (ownsPool) await closeWarehousePg(source);
  }

  async function health() {
    return withPgClient(source, async queryClient => {
      const result = await queryClient.query(`/* link_ops:health */
        SELECT
          (SELECT count(*)::bigint FROM ops.link_ops_session WHERE deleted_at IS NULL) AS sessions,
          (SELECT count(*)::bigint FROM ops.link_ops_message) AS messages,
          (SELECT count(*)::bigint FROM ops.link_ops_task WHERE deleted_at IS NULL) AS tasks,
          (SELECT count(*)::bigint FROM ops.link_ops_job) AS jobs,
          (SELECT count(*)::bigint FROM ops.link_ops_event) AS events,
          (SELECT max(version) FROM ops.link_ops_migration) AS migration_version`);
      const row = result.rows?.[0] || {};
      return {
        ok: true,
        mode: 'postgres',
        sessions: Number(row.sessions || 0),
        messages: Number(row.messages || 0),
        tasks: Number(row.tasks || 0),
        jobs: Number(row.jobs || 0),
        events: Number(row.events || 0),
        migrationVersion: row.migration_version || null,
      };
    });
  }

  async function getMeta(metaKey, fallback = null, {queryClient = null} = {}) {
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-meta',
        text: '/* link_ops:get_meta */ SELECT * FROM ops.link_ops_meta WHERE meta_key=$1',
        values: [requiredText(metaKey, 'metaKey')],
      });
      return result.rows?.[0] ? rowToRecord(result.rows[0]) : fallback;
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function putMeta(metaKey, record, {
    expectedRevision = null,
    ownerUser = '',
    actorUser = '',
    status = 'active',
    importMode = false,
  } = {}) {
    const key = requiredText(metaKey, 'metaKey');
    const clean = recordWithoutRepositoryMetadata(record);
    const payloadHash = linkOpsPayloadHash(clean);
    return transaction(`meta:${key}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-meta',
        text: '/* link_ops:lock_meta */ SELECT * FROM ops.link_ops_meta WHERE meta_key=$1 FOR UPDATE',
        values: [key],
      });
      const row = existing.rows?.[0];
      if (importMode && row) {
        if (row.payload_hash !== payloadHash) {
          throw new LinkOpsImportConflictError('meta', key, payloadHash, row.payload_hash);
        }
        return {...rowToRecord(row), importSkipped: true};
      }
      if (row) {
        if (expectedRevision === null || expectedRevision === undefined) {
          throw new LinkOpsRevisionConflictError('meta', key, null, Number(row.revision));
        }
        const revision = positiveRevision(expectedRevision);
        if (Number(row.revision) !== revision) {
          throw new LinkOpsRevisionConflictError('meta', key, revision, Number(row.revision));
        }
        const updated = await activeClient.query({
          name: 'link-ops-update-meta',
          text: `/* link_ops:update_meta */
            UPDATE ops.link_ops_meta SET
              owner_user=$2, actor_user=$3, status=$4, record=$5::jsonb,
              payload_hash=$6, revision=revision+1, updated_at=clock_timestamp()
            WHERE meta_key=$1 AND revision=$7
            RETURNING *`,
          values: [key, optionalText(ownerUser), optionalText(actorUser), optionalText(status), JSON.stringify(clean), payloadHash, revision],
        });
        return rowToRecord(updated.rows[0]);
      }
      if (expectedRevision !== null && expectedRevision !== undefined) {
        throw new LinkOpsNotFoundError('meta', key);
      }
      const inserted = await activeClient.query({
        name: 'link-ops-insert-meta',
        text: `/* link_ops:insert_meta */
          INSERT INTO ops.link_ops_meta(meta_key,owner_user,actor_user,status,record,payload_hash)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6)
          RETURNING *`,
        values: [key, optionalText(ownerUser), optionalText(actorUser), optionalText(status), JSON.stringify(clean), payloadHash],
      });
      return rowToRecord(inserted.rows[0]);
    });
  }

  async function getTask(taskId, {includeDeleted = false, queryClient = null} = {}) {
    const id = requiredText(taskId, 'taskId');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-task',
        text: `/* link_ops:get_task */
          SELECT * FROM ops.link_ops_task
          WHERE task_id=$1${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        values: [id],
      });
      return rowToRecord(result.rows?.[0]);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function getTaskStore({
    ownerUser = '',
    actorUser = '',
    status = '',
    chatSessionId = '',
    limit = 1_000,
    offset = 0,
    queryClient = null,
  } = {}) {
    const maxRows = boundedInteger(limit, {fallback: 1_000, min: 1, max: 10_000, label: 'limit'});
    const skipRows = boundedInteger(offset, {fallback: 0, min: 0, max: 10_000_000, label: 'offset'});
    const run = async activeClient => {
      const clauses = ['deleted_at IS NULL'];
      const values = [];
      const add = (column, value) => {
        if (!optionalText(value)) return;
        values.push(optionalText(value));
        clauses.push(`${column}=$${values.length}`);
      };
      add('owner_user', ownerUser);
      add('actor_user', actorUser);
      add('status', status);
      add('chat_session_id', chatSessionId);
      values.push(maxRows, skipRows);
      const rows = await activeClient.query({
        name: 'link-ops-list-tasks',
        text: `/* link_ops:list_tasks */
          SELECT * FROM ops.link_ops_task
          WHERE ${clauses.join(' AND ')}
          ORDER BY sort_order ASC, updated_at DESC, task_id
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      });
      const meta = await getMeta('task_store', null, {queryClient: activeClient});
      const envelope = meta ? recordWithoutRepositoryMetadata(meta) : {version: 1, updatedAt: null};
      const firstUpdated = rows.rows?.[0]?.updated_at ? new Date(rows.rows[0].updated_at).toISOString() : null;
      return {
        ...envelope,
        version: Number(envelope.version || 1) || 1,
        updatedAt: firstUpdated || envelope.updatedAt || null,
        tasks: (rows.rows || []).map(rowToRecord),
      };
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function createTask(task, {
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = 0,
    importBatchId = null,
  } = {}) {
    const clean = recordWithoutRepositoryMetadata(task);
    const taskId = requiredText(clean.id || clean.taskId, 'task.id');
    clean.id = taskId;
    delete clean.taskId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const chatSessionId = taskChatSessionId(clean);
    const arrays = taskTargetArrays(clean);
    const createdAt = timestampFromRecord(clean, ['createdAt'], 'task.createdAt');
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'task.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `task:create:${owner}`;
    const normalizedSortOrder = boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'create_task', task: clean, sortOrder: normalizedSortOrder});
    return transaction(`task:${taskId}:${idem || 'create'}`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-create-task',
        text: `/* link_ops:create_task */
          INSERT INTO ops.link_ops_task(
            task_id,owner_user,actor_user,status,chat_session_id,
            intents,source_stores,write_stores,product_refs,
            idempotency_key,sort_order,record,payload_hash,import_batch_id,
            created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[],
            $10,$11,$12::jsonb,$13,$14,
            COALESCE($15::timestamptz,clock_timestamp()),
            COALESCE($16::timestamptz,$15::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [
          taskId, owner, actor, statusValue, chatSessionId,
          arrays.intents, arrays.sourceStores, arrays.writeStores, arrays.productRefs,
          idem || null, normalizedSortOrder,
          JSON.stringify(clean), payloadHash, importBatchId || null, createdAt, updatedAt,
        ],
      });
      const created = rowToRecord(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'task', aggregateId: taskId, eventType: importBatchId ? 'task_imported' : 'task_created',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId, taskId,
        payload: {revision: created.repositoryRevision, payloadHash, importBatchId: importBatchId || null},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'task', entityId: taskId,
        response: idempotencyResponse(created),
      });
      return created;
    });
  }

  async function updateTask(taskId, task, {
    expectedRevision,
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = null,
  } = {}) {
    const id = requiredText(taskId, 'taskId');
    const revision = positiveRevision(expectedRevision);
    const clean = recordWithoutRepositoryMetadata(task);
    const embeddedId = optionalText(clean.id || clean.taskId);
    if (embeddedId && embeddedId !== id) throw new LinkOpsValidationError('task.id cannot change');
    clean.id = id;
    delete clean.taskId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const chatSessionId = taskChatSessionId(clean);
    const arrays = taskTargetArrays(clean);
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'task.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `task:update:${id}`;
    const nextSortOrder = sortOrder === null || sortOrder === undefined
      ? null
      : boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'update_task', expectedRevision: revision, task: clean, sortOrder: nextSortOrder});
    return transaction(`task:${id}:update`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-update-task',
        text: `/* link_ops:update_task */
          UPDATE ops.link_ops_task SET
            owner_user=$2,actor_user=$3,status=$4,chat_session_id=$5,
            intents=$6::text[],source_stores=$7::text[],write_stores=$8::text[],product_refs=$9::text[],
            record=$10::jsonb,payload_hash=$11,sort_order=COALESCE($12::bigint,sort_order),
            revision=revision+1,updated_at=COALESCE($13::timestamptz,clock_timestamp())
          WHERE task_id=$1 AND revision=$14 AND deleted_at IS NULL
          RETURNING *`,
        values: [
          id, owner, actor, statusValue, chatSessionId,
          arrays.intents, arrays.sourceStores, arrays.writeStores, arrays.productRefs,
          JSON.stringify(clean), payloadHash, nextSortOrder, updatedAt, revision,
        ],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_task', 'task_id', id, ' AND deleted_at IS NULL');
        if (currentRevision === null) throw new LinkOpsNotFoundError('task', id);
        throw new LinkOpsRevisionConflictError('task', id, revision, currentRevision);
      }
      const updated = rowToRecord(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'task', aggregateId: id, eventType: 'task_updated', ownerUser: owner,
        actorUser: actor, status: statusValue, chatSessionId, taskId: id,
        payload: {previousRevision: revision, revision: updated.repositoryRevision, payloadHash},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'task', entityId: id,
        response: idempotencyResponse(updated),
      });
      return updated;
    });
  }

  async function deleteTask(taskId, {expectedRevision, actorUser = '', idempotencyKey = ''} = {}) {
    const id = requiredText(taskId, 'taskId');
    const revision = positiveRevision(expectedRevision);
    const actor = optionalText(actorUser);
    const idem = optionalText(idempotencyKey);
    const scope = `task:delete:${id}`;
    const requestHash = linkOpsPayloadHash({operation: 'delete_task', id, expectedRevision: revision, actor});
    return transaction(`task:${id}:delete`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-delete-task',
        text: `/* link_ops:delete_task */
          UPDATE ops.link_ops_task SET
            actor_user=$3,status='deleted',deleted_at=clock_timestamp(),
            updated_at=clock_timestamp(),revision=revision+1
          WHERE task_id=$1 AND revision=$2 AND deleted_at IS NULL
          RETURNING *`,
        values: [id, revision, actor],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_task', 'task_id', id, ' AND deleted_at IS NULL');
        if (currentRevision === null) throw new LinkOpsNotFoundError('task', id);
        throw new LinkOpsRevisionConflictError('task', id, revision, currentRevision);
      }
      const row = result.rows[0];
      const response = {
        id,
        deleted: true,
        revision: Number(row.revision),
        deletedAt: new Date(row.deleted_at).toISOString(),
      };
      await appendEventInTransaction(activeClient, {
        aggregateType: 'task', aggregateId: id, eventType: 'task_deleted', ownerUser: row.owner_user,
        actorUser: actor, status: 'deleted', chatSessionId: row.chat_session_id, taskId: id,
        payload: response,
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'task', entityId: id, response,
      });
      return response;
    });
  }

  async function listMessages(chatSessionId, {queryClient = null} = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-list-messages',
        text: `/* link_ops:list_messages */
          SELECT * FROM ops.link_ops_message
          WHERE chat_session_id=$1
          ORDER BY sequence_no ASC, created_at ASC, message_id ASC`,
        values: [sessionId],
      });
      return (result.rows || []).map(rowToRecord);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function getSession(chatSessionId, {
    includeDeleted = false,
    includeMessages = true,
    queryClient = null,
  } = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-session',
        text: `/* link_ops:get_session */
          SELECT * FROM ops.link_ops_session
          WHERE session_id=$1${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        values: [sessionId],
      });
      if (!result.rows?.[0]) return null;
      const session = rowToRecord(result.rows[0]);
      if (includeMessages) session.messages = await listMessages(sessionId, {queryClient: activeClient});
      return session;
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function getSessionStore({
    ownerUser = '',
    status = '',
    limit = 300,
    offset = 0,
    includeMessages = true,
    queryClient = null,
  } = {}) {
    const maxRows = boundedInteger(limit, {fallback: 300, min: 1, max: 3_000, label: 'limit'});
    const skipRows = boundedInteger(offset, {fallback: 0, min: 0, max: 10_000_000, label: 'offset'});
    const run = async activeClient => {
      const clauses = ['deleted_at IS NULL'];
      const values = [];
      if (optionalText(ownerUser)) {
        values.push(optionalText(ownerUser));
        clauses.push(`owner_user=$${values.length}`);
      }
      if (optionalText(status)) {
        values.push(optionalText(status));
        clauses.push(`status=$${values.length}`);
      }
      values.push(maxRows, skipRows);
      const rows = await activeClient.query({
        name: 'link-ops-list-sessions',
        text: `/* link_ops:list_sessions */
          SELECT * FROM ops.link_ops_session
          WHERE ${clauses.join(' AND ')}
          ORDER BY sort_order ASC, updated_at DESC, session_id
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      });
      const sessions = (rows.rows || []).map(rowToRecord);
      if (includeMessages && sessions.length) {
        const ids = rows.rows.map(row => row.session_id);
        const messages = await activeClient.query({
          name: 'link-ops-list-session-messages',
          text: `/* link_ops:list_session_messages */
            SELECT * FROM ops.link_ops_message
            WHERE chat_session_id = ANY($1::text[])
            ORDER BY chat_session_id, sequence_no ASC, created_at ASC, message_id ASC`,
          values: [ids],
        });
        const grouped = new Map(ids.map(id => [id, []]));
        for (const row of messages.rows || []) grouped.get(row.chat_session_id)?.push(rowToRecord(row));
        for (let index = 0; index < sessions.length; index += 1) {
          sessions[index].messages = grouped.get(ids[index]) || [];
        }
      }
      const meta = await getMeta('session_store', null, {queryClient: activeClient});
      const envelope = meta ? recordWithoutRepositoryMetadata(meta) : {version: 1, updatedAt: null};
      const firstUpdated = rows.rows?.[0]?.updated_at ? new Date(rows.rows[0].updated_at).toISOString() : null;
      return {
        ...envelope,
        version: Number(envelope.version || 1) || 1,
        updatedAt: firstUpdated || envelope.updatedAt || null,
        sessions,
      };
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function createSession(session, {
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = 0,
    importBatchId = null,
  } = {}) {
    const sourceRecord = recordWithoutRepositoryMetadata(session);
    const messages = normalizeDesiredMessages(
      Array.isArray(sourceRecord.messages) ? sourceRecord.messages : [],
      'session.messages'
    );
    const clean = sessionRecordWithoutMessages(sourceRecord);
    const sessionId = requiredText(clean.id || clean.sessionId, 'session.id');
    clean.id = sessionId;
    delete clean.sessionId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const title = optionalText(clean.title);
    const createdAt = timestampFromRecord(clean, ['createdAt'], 'session.createdAt');
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'session.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `session:create:${owner}`;
    const normalizedSortOrder = boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({
      operation: 'create_session',
      session: clean,
      messages: messages.map(message => message.clean),
      sortOrder: normalizedSortOrder,
    });
    return transaction(`session:${sessionId}:${idem || 'create'}`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-create-session',
        text: `/* link_ops:create_session */
          INSERT INTO ops.link_ops_session(
            session_id,owner_user,actor_user,status,title,idempotency_key,sort_order,
            record,payload_hash,import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,
            COALESCE($11::timestamptz,clock_timestamp()),
            COALESCE($12::timestamptz,$11::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [
          sessionId, owner, actor, statusValue, title, idem || null,
          normalizedSortOrder,
          JSON.stringify(clean), payloadHash, importBatchId || null, createdAt, updatedAt,
        ],
      });
      const inserted = rowToRecord(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'session', aggregateId: sessionId,
        eventType: importBatchId ? 'session_imported' : 'session_created',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {
          revision: inserted.repositoryRevision,
          payloadHash,
          importBatchId: importBatchId || null,
          messageCount: messages.length,
        },
      });

      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const messageOwner = recordOwner(message.clean, owner);
        const messageActor = recordActor(message.clean, actor || messageOwner);
        const result = await activeClient.query({
          name: 'link-ops-create-session-message',
          text: `/* link_ops:create_session_message */
            INSERT INTO ops.link_ops_message(
              message_id,chat_session_id,owner_user,actor_user,role,status,sequence_no,
              idempotency_key,record,payload_hash,import_batch_id,created_at,updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,
              COALESCE($12::timestamptz,clock_timestamp()),
              COALESCE($13::timestamptz,$12::timestamptz,clock_timestamp())
            ) RETURNING *`,
          values: [
            message.messageId,
            sessionId,
            messageOwner,
            messageActor,
            message.role,
            message.status,
            index,
            `session-create:${sessionId}:${message.messageId}`,
            JSON.stringify(message.clean),
            message.payloadHash,
            importBatchId || null,
            message.createdAt,
            message.updatedAt,
          ],
        });
        const storedMessage = rowToRecord(result.rows[0]);
        await appendEventInTransaction(activeClient, {
          aggregateType: 'message',
          aggregateId: message.messageId,
          eventType: importBatchId ? 'message_imported' : 'message_appended',
          ownerUser: messageOwner,
          actorUser: messageActor,
          status: message.status,
          chatSessionId: sessionId,
          payload: {
            revision: storedMessage.repositoryRevision,
            payloadHash: message.payloadHash,
            sequenceNo: index,
            importBatchId: importBatchId || null,
          },
        });
      }

      const complete = await getSession(sessionId, {queryClient: activeClient});
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'session', entityId: sessionId,
        response: idempotencyResponse(complete),
      });
      return complete;
    });
  }

  async function updateSession(chatSessionId, session, {
    expectedRevision,
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = null,
  } = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const revision = positiveRevision(expectedRevision);
    const clean = sessionRecordWithoutMessages(session);
    const embeddedId = optionalText(clean.id || clean.sessionId);
    if (embeddedId && embeddedId !== sessionId) throw new LinkOpsValidationError('session.id cannot change');
    clean.id = sessionId;
    delete clean.sessionId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const title = optionalText(clean.title);
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'session.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `session:update:${sessionId}`;
    const nextSortOrder = sortOrder === null || sortOrder === undefined
      ? null
      : boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'update_session', expectedRevision: revision, session: clean, sortOrder: nextSortOrder});
    return transaction(`session:${sessionId}:update`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-update-session',
        text: `/* link_ops:update_session */
          UPDATE ops.link_ops_session SET
            owner_user=$2,actor_user=$3,status=$4,title=$5,record=$6::jsonb,
            payload_hash=$7,sort_order=COALESCE($8::bigint,sort_order),revision=revision+1,
            updated_at=COALESCE($9::timestamptz,clock_timestamp())
          WHERE session_id=$1 AND revision=$10 AND deleted_at IS NULL
          RETURNING *`,
        values: [sessionId, owner, actor, statusValue, title, JSON.stringify(clean), payloadHash, nextSortOrder, updatedAt, revision],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_session', 'session_id', sessionId, ' AND deleted_at IS NULL');
        if (currentRevision === null) throw new LinkOpsNotFoundError('session', sessionId);
        throw new LinkOpsRevisionConflictError('session', sessionId, revision, currentRevision);
      }
      const updated = rowToRecord(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'session', aggregateId: sessionId, eventType: 'session_updated',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {previousRevision: revision, revision: updated.repositoryRevision, payloadHash},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'session', entityId: sessionId,
        response: idempotencyResponse(updated),
      });
      updated.messages = await listMessages(sessionId, {queryClient: activeClient});
      return updated;
    });
  }

  /**
   * Atomically applies one session CAS update together with every newly
   * appended message. The caller supplies the complete desired message list;
   * the persisted list must be its exact prefix. Existing messages are never
   * edited, reordered, or removed. The session row lock serializes this path
   * with appendMessage across all processes using the repository.
   */
  async function updateSessionWithMessages(chatSessionId, session, {
    expectedRevision,
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = null,
  } = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const expected = positiveRevision(expectedRevision);
    const source = recordWithoutRepositoryMetadata(session);
    const desiredMessages = normalizeDesiredMessages(
      Array.isArray(source.messages) ? source.messages : [],
      `session ${sessionId} messages`
    );
    const clean = sessionRecordWithoutMessages(source);
    const embeddedId = optionalText(clean.id || clean.sessionId);
    if (embeddedId && embeddedId !== sessionId) throw new LinkOpsValidationError('session.id cannot change');
    clean.id = sessionId;
    delete clean.sessionId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const title = optionalText(clean.title);
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'session.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `session:update-with-messages:${sessionId}`;
    const nextSortOrder = sortOrder === null || sortOrder === undefined
      ? null
      : boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({
      operation: 'update_session_with_messages',
      expectedRevision: expected,
      session: clean,
      messages: desiredMessages.map(message => message.clean),
      sortOrder: nextSortOrder,
    });

    return transaction(`session:${sessionId}:update-with-messages`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;

      const locked = await activeClient.query({
        name: 'link-ops-lock-session-with-messages',
        text: `/* link_ops:lock_session_with_messages */
          SELECT * FROM ops.link_ops_session
          WHERE session_id=$1 AND deleted_at IS NULL
          FOR UPDATE`,
        values: [sessionId],
      });
      const currentRow = locked.rows?.[0];
      if (!currentRow) throw new LinkOpsNotFoundError('session', sessionId);
      const currentRevision = Number(currentRow.revision);
      if (currentRevision !== expected) {
        throw new LinkOpsRevisionConflictError('session', sessionId, expected, currentRevision);
      }

      const currentMessagesResult = await activeClient.query({
        name: 'link-ops-list-locked-session-messages',
        text: `/* link_ops:list_locked_session_messages */
          SELECT * FROM ops.link_ops_message
          WHERE chat_session_id=$1
          ORDER BY sequence_no ASC, created_at ASC, message_id ASC`,
        values: [sessionId],
      });
      const currentMessageRows = currentMessagesResult.rows || [];
      assertStrictMessageAppend(currentMessageRows, desiredMessages, sessionId);

      const updatedResult = await activeClient.query({
        name: 'link-ops-update-session-with-messages',
        text: `/* link_ops:update_session_with_messages */
          UPDATE ops.link_ops_session SET
            owner_user=$2,actor_user=$3,status=$4,title=$5,record=$6::jsonb,
            payload_hash=$7,sort_order=COALESCE($8::bigint,sort_order),revision=revision+1,
            updated_at=COALESCE($9::timestamptz,clock_timestamp())
          WHERE session_id=$1 AND revision=$10 AND deleted_at IS NULL
          RETURNING *`,
        values: [sessionId, owner, actor, statusValue, title, JSON.stringify(clean), payloadHash, nextSortOrder, updatedAt, expected],
      });
      if (!updatedResult.rowCount) {
        throw new LinkOpsRevisionConflictError('session', sessionId, expected, currentRevision);
      }
      const updated = rowToRecord(updatedResult.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'session',
        aggregateId: sessionId,
        eventType: 'session_updated',
        ownerUser: owner,
        actorUser: actor,
        status: statusValue,
        chatSessionId: sessionId,
        payload: {previousRevision: expected, revision: updated.repositoryRevision, payloadHash},
      });

      let nextSequence = currentMessageRows.reduce(
        (maximum, row) => Math.max(maximum, Number(row.sequence_no)),
        -1
      ) + 1;
      for (const message of desiredMessages.slice(currentMessageRows.length)) {
        const messageOwner = recordOwner(message.clean, owner);
        const messageActor = recordActor(message.clean, actor || messageOwner);
        const result = await activeClient.query({
          name: 'link-ops-batch-append-message',
          text: `/* link_ops:batch_append_message */
            INSERT INTO ops.link_ops_message(
              message_id,chat_session_id,owner_user,actor_user,role,status,sequence_no,
              idempotency_key,record,payload_hash,created_at,updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,
              COALESCE($11::timestamptz,clock_timestamp()),
              COALESCE($12::timestamptz,$11::timestamptz,clock_timestamp())
            ) RETURNING *`,
          values: [
            message.messageId,
            sessionId,
            messageOwner,
            messageActor,
            message.role,
            message.status,
            nextSequence,
            `${idem || requestHash}:${message.messageId}`,
            JSON.stringify(message.clean),
            message.payloadHash,
            message.createdAt,
            message.updatedAt,
          ],
        });
        const inserted = rowToRecord(result.rows[0]);
        await appendEventInTransaction(activeClient, {
          aggregateType: 'message',
          aggregateId: message.messageId,
          eventType: 'message_appended',
          ownerUser: messageOwner,
          actorUser: messageActor,
          status: message.status,
          chatSessionId: sessionId,
          payload: {
            revision: inserted.repositoryRevision,
            payloadHash: message.payloadHash,
            sequenceNo: nextSequence,
          },
        });
        nextSequence += 1;
      }

      const complete = await getSession(sessionId, {queryClient: activeClient});
      await writeIdempotency(activeClient, {
        scope,
        idempotencyKey: idem,
        requestHash,
        entityType: 'session',
        entityId: sessionId,
        response: idempotencyResponse(complete),
      });
      return complete;
    });
  }

  async function appendMessage(chatSessionId, message, {
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sequenceNo = null,
    importBatchId = null,
  } = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const clean = recordWithoutRepositoryMetadata(message);
    const messageId = requiredText(clean.id || clean.messageId, 'message.id');
    clean.id = messageId;
    delete clean.messageId;
    const role = requiredText(clean.role, 'message.role');
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
      throw new LinkOpsValidationError(`Unsupported message role: ${role}`);
    }
    const statusValue = optionalText(clean.status) || 'created';
    const createdAt = timestampFromRecord(clean, ['at', 'createdAt'], 'message.at');
    const updatedAt = timestampFromRecord(clean, ['updatedAt', 'at', 'createdAt'], 'message.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const scope = `message:create:${sessionId}`;
    const requestHash = linkOpsPayloadHash({operation: 'append_message', sessionId, message: clean});
    return transaction(`session:${sessionId}:message`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const session = await activeClient.query({
        name: 'link-ops-lock-message-session',
        text: `/* link_ops:lock_message_session */
          SELECT * FROM ops.link_ops_session
          WHERE session_id=$1 AND deleted_at IS NULL
          FOR UPDATE`,
        values: [sessionId],
      });
      if (!session.rows?.[0]) throw new LinkOpsNotFoundError('session', sessionId);
      const sessionRow = session.rows[0];
      const owner = recordOwner(clean, ownerUser || sessionRow.owner_user);
      const actor = recordActor(clean, actorUser || owner || sessionRow.actor_user);
      const sequence = await activeClient.query({
        name: 'link-ops-next-message-sequence',
        text: `/* link_ops:next_message_sequence */
          SELECT COALESCE(max(sequence_no), -1) + 1 AS sequence_no
          FROM ops.link_ops_message WHERE chat_session_id=$1`,
        values: [sessionId],
      });
      const appendSequence = Number(sequence.rows?.[0]?.sequence_no || 0);
      let nextSequence = appendSequence;
      if (sequenceNo !== null && sequenceNo !== undefined) {
        nextSequence = boundedInteger(sequenceNo, {fallback: 0, min: 0, label: 'sequenceNo'});
        if (nextSequence !== appendSequence) {
          throw new LinkOpsRepositoryError(`Chat session ${sessionId} messages are append-only`, {
            code: 'LINK_OPS_APPEND_ONLY_CONFLICT',
            details: {sessionId, expectedSequenceNo: appendSequence, requestedSequenceNo: nextSequence},
          });
        }
      }
      const result = await activeClient.query({
        name: 'link-ops-append-message',
        text: `/* link_ops:append_message */
          INSERT INTO ops.link_ops_message(
            message_id,chat_session_id,owner_user,actor_user,role,status,sequence_no,
            idempotency_key,record,payload_hash,import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,
            COALESCE($12::timestamptz,clock_timestamp()),
            COALESCE($13::timestamptz,$12::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [
          messageId, sessionId, owner, actor, role, statusValue, nextSequence, idem || null,
          JSON.stringify(clean), payloadHash, importBatchId || null, createdAt, updatedAt,
        ],
      });
      const inserted = rowToRecord(result.rows[0]);
      await activeClient.query({
        name: 'link-ops-touch-session-for-message',
        text: `/* link_ops:touch_session_for_message */
          UPDATE ops.link_ops_session
          SET revision=revision+1, actor_user=$2, updated_at=clock_timestamp()
          WHERE session_id=$1`,
        values: [sessionId, actor],
      });
      await appendEventInTransaction(activeClient, {
        aggregateType: 'message', aggregateId: messageId, eventType: importBatchId ? 'message_imported' : 'message_appended',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {revision: inserted.repositoryRevision, payloadHash, sequenceNo: nextSequence, importBatchId: importBatchId || null},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'message', entityId: messageId,
        response: idempotencyResponse(inserted),
      });
      return inserted;
    });
  }

  async function deleteSession(chatSessionId, {expectedRevision, actorUser = '', idempotencyKey = ''} = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const revision = positiveRevision(expectedRevision);
    const actor = optionalText(actorUser);
    const idem = optionalText(idempotencyKey);
    const scope = `session:delete:${sessionId}`;
    const requestHash = linkOpsPayloadHash({operation: 'delete_session', sessionId, expectedRevision: revision, actor});
    return transaction(`session:${sessionId}:delete`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-delete-session',
        text: `/* link_ops:delete_session */
          UPDATE ops.link_ops_session SET
            actor_user=$3,status='deleted',deleted_at=clock_timestamp(),
            updated_at=clock_timestamp(),revision=revision+1
          WHERE session_id=$1 AND revision=$2 AND deleted_at IS NULL
          RETURNING *`,
        values: [sessionId, revision, actor],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_session', 'session_id', sessionId, ' AND deleted_at IS NULL');
        if (currentRevision === null) throw new LinkOpsNotFoundError('session', sessionId);
        throw new LinkOpsRevisionConflictError('session', sessionId, revision, currentRevision);
      }
      const row = result.rows[0];
      const response = {
        id: sessionId,
        deleted: true,
        revision: Number(row.revision),
        deletedAt: new Date(row.deleted_at).toISOString(),
      };
      await appendEventInTransaction(activeClient, {
        aggregateType: 'session', aggregateId: sessionId, eventType: 'session_deleted',
        ownerUser: row.owner_user, actorUser: actor, status: 'deleted', chatSessionId: sessionId,
        payload: response,
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'session', entityId: sessionId, response,
      });
      return response;
    });
  }

  async function getRecord(recordType, recordId, {includeDeleted = false, queryClient = null} = {}) {
    const type = requiredText(recordType, 'recordType');
    const id = requiredText(recordId, 'recordId');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-record',
        text: `/* link_ops:get_record */
          SELECT * FROM ops.link_ops_record
          WHERE record_type=$1 AND record_id=$2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        values: [type, id],
      });
      return rowToRecord(result.rows?.[0]);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function listRecords(recordType, {
    ownerUser = '',
    status = '',
    chatSessionId = '',
    limit = 10_000,
    queryClient = null,
  } = {}) {
    const type = requiredText(recordType, 'recordType');
    const maxRows = boundedInteger(limit, {fallback: 10_000, min: 1, max: 100_000, label: 'limit'});
    const run = async activeClient => {
      const values = [type];
      const clauses = ['record_type=$1', 'deleted_at IS NULL'];
      const add = (column, value) => {
        if (!optionalText(value)) return;
        values.push(optionalText(value));
        clauses.push(`${column}=$${values.length}`);
      };
      add('owner_user', ownerUser);
      add('status', status);
      add('chat_session_id', chatSessionId);
      values.push(maxRows);
      const result = await activeClient.query({
        // The WHERE shape changes with optional filters. Keeping one prepared
        // statement name here makes node-postgres reject a later shape on the
        // same pooled connection ("prepared statements must be unique").
        // Leave this dynamic query unnamed so every filter combination is safe.
        text: `/* link_ops:list_records */
          SELECT * FROM ops.link_ops_record
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC, record_id
          LIMIT $${values.length}`,
        values,
      });
      return (result.rows || []).map(row => ({recordId: row.record_id, record: rowToRecord(row)}));
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function putRecord(recordType, recordId, record, {
    expectedRevision = null,
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    status = '',
    chatSessionId = '',
    importBatchId = null,
  } = {}) {
    const type = requiredText(recordType, 'recordType');
    const id = requiredText(recordId, 'recordId');
    const clean = recordWithoutRepositoryMetadata(record);
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(status || clean.status);
    const sessionId = optionalText(chatSessionId || clean.chatSessionId) || null;
    const createdAt = timestampFromRecord(clean, ['createdAt'], `${type}.createdAt`);
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], `${type}.updatedAt`);
    const payloadHash = linkOpsPayloadHash(clean);
    const idem = optionalText(idempotencyKey);
    const operation = expectedRevision === null || expectedRevision === undefined ? 'create' : 'update';
    const scope = `record:${type}:${operation}:${id}`;
    const requestHash = linkOpsPayloadHash({operation, type, id, expectedRevision, record: clean});
    return transaction(`record:${type}:${id}`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      let result;
      if (operation === 'create') {
        result = await activeClient.query({
          name: 'link-ops-create-record',
          text: `/* link_ops:create_record */
            INSERT INTO ops.link_ops_record(
              record_type,record_id,owner_user,actor_user,status,chat_session_id,
              idempotency_key,record,payload_hash,import_batch_id,created_at,updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,
              COALESCE($11::timestamptz,clock_timestamp()),
              COALESCE($12::timestamptz,$11::timestamptz,clock_timestamp())
            ) RETURNING *`,
          values: [type, id, owner, actor, statusValue, sessionId, idem || null, JSON.stringify(clean), payloadHash, importBatchId || null, createdAt, updatedAt],
        });
      } else {
        const revision = positiveRevision(expectedRevision);
        result = await activeClient.query({
          name: 'link-ops-update-record',
          text: `/* link_ops:update_record */
            UPDATE ops.link_ops_record SET
              owner_user=$3,actor_user=$4,status=$5,chat_session_id=$6,
              record=$7::jsonb,payload_hash=$8,revision=revision+1,
              updated_at=COALESCE($9::timestamptz,clock_timestamp())
            WHERE record_type=$1 AND record_id=$2 AND revision=$10 AND deleted_at IS NULL
            RETURNING *`,
          values: [type, id, owner, actor, statusValue, sessionId, JSON.stringify(clean), payloadHash, updatedAt, revision],
        });
        if (!result.rowCount) {
          const current = await activeClient.query({
            name: 'link-ops-current-record-revision',
            text: `/* link_ops:current_record_revision */
              SELECT revision FROM ops.link_ops_record
              WHERE record_type=$1 AND record_id=$2 AND deleted_at IS NULL`,
            values: [type, id],
          });
          const currentRevision = current.rows?.[0] ? Number(current.rows[0].revision) : null;
          if (currentRevision === null) throw new LinkOpsNotFoundError(type, id);
          throw new LinkOpsRevisionConflictError(type, id, revision, currentRevision);
        }
      }
      const stored = rowToRecord(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: type, aggregateId: id,
        eventType: importBatchId ? `${type}_imported` : `${type}_${operation}d`,
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {revision: stored.repositoryRevision, payloadHash, importBatchId: importBatchId || null},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: type, entityId: id,
        response: idempotencyResponse(stored),
      });
      return stored;
    });
  }

  async function deleteRecord(recordType, recordId, {
    expectedRevision,
    actorUser = '',
    idempotencyKey = '',
  } = {}) {
    const type = requiredText(recordType, 'recordType');
    const id = requiredText(recordId, 'recordId');
    const revision = positiveRevision(expectedRevision);
    const actor = optionalText(actorUser);
    const idem = optionalText(idempotencyKey);
    const scope = `record:${type}:delete:${id}`;
    const requestHash = linkOpsPayloadHash({operation: 'delete_record', type, id, expectedRevision: revision, actor});
    return transaction(`record:${type}:${id}:delete`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-delete-record',
        text: `/* link_ops:delete_record */
          UPDATE ops.link_ops_record SET
            actor_user=$4,status='deleted',deleted_at=clock_timestamp(),
            updated_at=clock_timestamp(),revision=revision+1
          WHERE record_type=$1 AND record_id=$2 AND revision=$3 AND deleted_at IS NULL
          RETURNING *`,
        values: [type, id, revision, actor],
      });
      if (!result.rowCount) {
        const current = await activeClient.query({
          name: 'link-ops-current-delete-record-revision',
          text: `/* link_ops:current_delete_record_revision */
            SELECT revision FROM ops.link_ops_record
            WHERE record_type=$1 AND record_id=$2 AND deleted_at IS NULL`,
          values: [type, id],
        });
        const currentRevision = current.rows?.[0] ? Number(current.rows[0].revision) : null;
        if (currentRevision === null) throw new LinkOpsNotFoundError(type, id);
        throw new LinkOpsRevisionConflictError(type, id, revision, currentRevision);
      }
      const row = result.rows[0];
      const response = {
        id,
        recordType: type,
        deleted: true,
        revision: Number(row.revision),
        deletedAt: new Date(row.deleted_at).toISOString(),
      };
      await appendEventInTransaction(activeClient, {
        aggregateType: type,
        aggregateId: id,
        eventType: `${type}_deleted`,
        ownerUser: row.owner_user,
        actorUser: actor,
        status: 'deleted',
        chatSessionId: row.chat_session_id,
        payload: response,
      });
      await writeIdempotency(activeClient, {
        scope,
        idempotencyKey: idem,
        requestHash,
        entityType: type,
        entityId: id,
        response,
      });
      return response;
    });
  }

  async function getActionState({queryClient = null} = {}) {
    const run = async activeClient => {
      const meta = await getMeta('action_store', null, {queryClient: activeClient});
      const envelope = meta ? recordWithoutRepositoryMetadata(meta) : {version: 1, updatedAt: null};
      const entries = await listRecords('action_state', {queryClient: activeClient});
      return {
        ...envelope,
        version: Number(envelope.version || 1) || 1,
        actions: Object.fromEntries(entries.map(entry => [entry.recordId, entry.record])),
      };
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function putActionRecord(actionKey, record, options = {}) {
    return putRecord('action_state', actionKey, record, options);
  }

  /**
   * Applies an explicit action-state batch in one PostgreSQL transaction.
   * Every key is locked and every caller revision is validated before the
   * first entity mutation. Missing keys never imply deletion.
   */
  async function applyActionChanges(changes, {actorUser = '', idempotencyKey = ''} = {}) {
    if (!Array.isArray(changes)) throw new LinkOpsValidationError('action changes must be an array');
    if (changes.length > 20_000) throw new LinkOpsValidationError('action changes exceed 20000 rows');
    const actor = optionalText(actorUser);
    const keys = new Set();
    const normalized = changes.map((change, index) => {
      if (!isPlainObject(change)) throw new LinkOpsValidationError(`action changes[${index}] must be a JSON object`);
      const key = requiredText(change.key, `action changes[${index}].key`);
      if (keys.has(key)) throw new LinkOpsValidationError(`Duplicate action key: ${key}`);
      keys.add(key);
      const deleting = change.delete === true;
      if (deleting && change.record !== undefined) {
        throw new LinkOpsValidationError(`action ${key} delete change cannot include record`);
      }
      const expectedRevision = deleting
        ? positiveRevision(change.expectedRevision, `action ${key}.expectedRevision`)
        : (change.expectedRevision === null || change.expectedRevision === undefined
          ? null
          : positiveRevision(change.expectedRevision, `action ${key}.expectedRevision`));
      if (deleting) return {key, delete: true, expectedRevision};
      const record = recordWithoutRepositoryMetadata(change.record);
      return {key, delete: false, expectedRevision, record};
    });
    const idem = optionalText(idempotencyKey);
    const scope = 'record:action_state:batch';
    const requestHash = linkOpsPayloadHash({operation: 'action_batch', changes: normalized, actor});

    return transaction('action-state:batch', async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      if (!normalized.length) return {changes: []};

      const orderedKeys = [...keys].sort();
      const locked = await activeClient.query({
        name: 'link-ops-lock-action-batch',
        text: `/* link_ops:lock_action_batch */
          SELECT * FROM ops.link_ops_record
          WHERE record_type='action_state' AND record_id = ANY($1::text[])
          ORDER BY record_id
          FOR UPDATE`,
        values: [orderedKeys],
      });
      const currentByKey = new Map((locked.rows || []).map(row => [row.record_id, row]));

      for (const change of normalized) {
        const row = currentByKey.get(change.key);
        const active = row && !row.deleted_at;
        if (change.expectedRevision === null) {
          if (row) {
            throw new LinkOpsRepositoryError(`action_state ${change.key} already exists`, {
              code: 'LINK_OPS_ALREADY_EXISTS',
              details: {entityType: 'action_state', entityId: change.key},
            });
          }
          continue;
        }
        if (!active) throw new LinkOpsNotFoundError('action_state', change.key);
        if (Number(row.revision) !== change.expectedRevision) {
          throw new LinkOpsRevisionConflictError(
            'action_state',
            change.key,
            change.expectedRevision,
            Number(row.revision)
          );
        }
      }

      const resultByKey = new Map();
      for (const change of [...normalized].sort((left, right) => left.key.localeCompare(right.key))) {
        const currentRow = currentByKey.get(change.key);
        if (change.delete) {
          const deleted = await activeClient.query({
            name: 'link-ops-delete-action-batch-record',
            text: `/* link_ops:delete_action_batch_record */
              UPDATE ops.link_ops_record SET
                actor_user=$3,status='deleted',deleted_at=clock_timestamp(),
                updated_at=clock_timestamp(),revision=revision+1
              WHERE record_type='action_state' AND record_id=$1 AND revision=$2 AND deleted_at IS NULL
              RETURNING *`,
            values: [change.key, change.expectedRevision, actor],
          });
          if (!deleted.rowCount) {
            throw new LinkOpsRevisionConflictError('action_state', change.key, change.expectedRevision, null);
          }
          const row = deleted.rows[0];
          const response = {
            key: change.key,
            delete: true,
            revision: Number(row.revision),
            deletedAt: new Date(row.deleted_at).toISOString(),
          };
          await appendEventInTransaction(activeClient, {
            aggregateType: 'action_state',
            aggregateId: change.key,
            eventType: 'action_state_deleted',
            ownerUser: row.owner_user,
            actorUser: actor,
            status: 'deleted',
            chatSessionId: row.chat_session_id,
            payload: response,
          });
          resultByKey.set(change.key, response);
          continue;
        }

        const owner = recordOwner(change.record, currentRow?.owner_user || actor);
        const recordActorUser = recordActor(change.record, actor || owner);
        const statusValue = optionalText(change.record.status);
        const sessionId = optionalText(change.record.chatSessionId) || null;
        const payloadHash = linkOpsPayloadHash(change.record);
        const createdAt = timestampFromRecord(change.record, ['createdAt'], 'action.createdAt');
        const updatedAt = timestampFromRecord(change.record, ['updatedAt'], 'action.updatedAt');
        let storedResult;
        if (change.expectedRevision === null) {
          storedResult = await activeClient.query({
            name: 'link-ops-create-action-batch-record',
            text: `/* link_ops:create_action_batch_record */
              INSERT INTO ops.link_ops_record(
                record_type,record_id,owner_user,actor_user,status,chat_session_id,
                record,payload_hash,created_at,updated_at
              ) VALUES (
                'action_state',$1,$2,$3,$4,$5,$6::jsonb,$7,
                COALESCE($8::timestamptz,clock_timestamp()),
                COALESCE($9::timestamptz,$8::timestamptz,clock_timestamp())
              ) RETURNING *`,
            values: [
              change.key, owner, recordActorUser, statusValue, sessionId,
              JSON.stringify(change.record), payloadHash, createdAt, updatedAt,
            ],
          });
        } else {
          storedResult = await activeClient.query({
            name: 'link-ops-update-action-batch-record',
            text: `/* link_ops:update_action_batch_record */
              UPDATE ops.link_ops_record SET
                owner_user=$2,actor_user=$3,status=$4,chat_session_id=$5,
                record=$6::jsonb,payload_hash=$7,revision=revision+1,
                updated_at=COALESCE($8::timestamptz,clock_timestamp())
              WHERE record_type='action_state' AND record_id=$1 AND revision=$9 AND deleted_at IS NULL
              RETURNING *`,
            values: [
              change.key, owner, recordActorUser, statusValue, sessionId,
              JSON.stringify(change.record), payloadHash, updatedAt, change.expectedRevision,
            ],
          });
          if (!storedResult.rowCount) {
            throw new LinkOpsRevisionConflictError('action_state', change.key, change.expectedRevision, null);
          }
        }
        const stored = rowToRecord(storedResult.rows[0]);
        await appendEventInTransaction(activeClient, {
          aggregateType: 'action_state',
          aggregateId: change.key,
          eventType: change.expectedRevision === null ? 'action_state_created' : 'action_state_updated',
          ownerUser: owner,
          actorUser: recordActorUser,
          status: statusValue,
          chatSessionId: sessionId,
          payload: {revision: stored.repositoryRevision, payloadHash},
        });
        resultByKey.set(change.key, {key: change.key, delete: false, record: stored});
      }

      const response = {changes: normalized.map(change => resultByKey.get(change.key))};
      await writeIdempotency(activeClient, {
        scope,
        idempotencyKey: idem,
        requestHash,
        entityType: 'action_state_batch',
        entityId: requestHash,
        response,
      });
      return response;
    });
  }

  async function getJob(jobId, {queryClient = null} = {}) {
    const id = requiredText(jobId, 'jobId');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-job',
        text: '/* link_ops:get_job */ SELECT * FROM ops.link_ops_job WHERE job_id=$1',
        values: [id],
      });
      return rowToJob(result.rows?.[0]);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function listJobs({status = '', ownerUser = '', taskId = '', limit = 500, queryClient = null} = {}) {
    const maxRows = boundedInteger(limit, {fallback: 500, min: 1, max: 10_000, label: 'limit'});
    const run = async activeClient => {
      const clauses = ['TRUE'];
      const values = [];
      const add = (column, value) => {
        if (!optionalText(value)) return;
        values.push(optionalText(value));
        clauses.push(`${column}=$${values.length}`);
      };
      add('status', status);
      add('owner_user', ownerUser);
      add('task_id', taskId);
      values.push(maxRows);
      const result = await activeClient.query({
        name: 'link-ops-list-jobs',
        text: `/* link_ops:list_jobs */
          SELECT * FROM ops.link_ops_job
          WHERE ${clauses.join(' AND ')}
          ORDER BY queued_at DESC, job_id
          LIMIT $${values.length}`,
        values,
      });
      return (result.rows || []).map(rowToJob);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function recoverExpiredJobs({
    limit = 100,
    safeWriteBoundaries = DEFAULT_SAFE_RETRY_WRITE_BOUNDARIES,
    actorUser = 'system:lease-recovery',
  } = {}) {
    const maxRows = boundedInteger(limit, {fallback: 100, min: 1, max: 1_000, label: 'limit'});
    const safeBoundaries = textArray(safeWriteBoundaries);
    if (!safeBoundaries.length) throw new LinkOpsValidationError('safeWriteBoundaries must not be empty');
    const actor = requiredText(actorUser, 'actorUser');
    return transaction('job-queue-recovery', async activeClient => {
      const expired = await activeClient.query({
        name: 'link-ops-lock-expired-jobs',
        text: `/* link_ops:lock_expired_jobs */
          SELECT * FROM ops.link_ops_job
          WHERE status='running' AND lease_expires_at <= clock_timestamp()
          ORDER BY lease_expires_at ASC, job_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        values: [maxRows],
      });
      const recovered = [];
      for (const row of expired.rows || []) {
        const retrySafe = safeBoundaries.includes(String(row.write_boundary || 'none'));
        const nextStatus = retrySafe ? 'queued' : 'uncertain_write';
        const recoveryError = retrySafe ? {} : {
          code: 'LEASE_EXPIRED_AFTER_WRITE_BOUNDARY',
          message: 'Worker lease expired after an external-write boundary; automatic retry is disabled.',
          previousLeaseOwner: row.lease_owner || '',
          previousLeaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
          writeBoundary: row.write_boundary || 'none',
        };
        const result = await activeClient.query({
          name: 'link-ops-recover-expired-job',
          text: `/* link_ops:recover_expired_job */
            UPDATE ops.link_ops_job SET
              status=$2,actor_user=$3,lease_owner='',lease_expires_at=NULL,
              heartbeat_at=clock_timestamp(),error=$4::jsonb,
              finished_at=CASE WHEN $2='uncertain_write' THEN clock_timestamp() ELSE NULL END,
              revision=revision+1,updated_at=clock_timestamp()
            WHERE job_id=$1 AND status='running'
            RETURNING *`,
          values: [row.job_id, nextStatus, actor, JSON.stringify(recoveryError)],
        });
        if (!result.rowCount) continue;
        const job = rowToJob(result.rows[0]);
        await appendEventInTransaction(activeClient, {
          aggregateType: 'job',
          aggregateId: job.jobId,
          eventType: retrySafe ? 'job_requeued_after_lease_expiry' : 'job_uncertain_write_after_lease_expiry',
          ownerUser: job.ownerUser,
          actorUser: actor,
          status: nextStatus,
          chatSessionId: job.chatSessionId,
          taskId: job.taskId,
          jobId: job.jobId,
          payload: {
            revision: job.repositoryRevision,
            writeBoundary: job.writeBoundary,
            retrySafe,
            previousLeaseOwner: row.lease_owner || '',
          },
        });
        recovered.push(job);
      }
      return recovered;
    });
  }

  async function enqueueJob(job, {
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
  } = {}) {
    const clean = recordWithoutRepositoryMetadata(job);
    const jobId = requiredText(clean.id || clean.jobId, 'job.id');
    clean.id = jobId;
    delete clean.jobId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const idem = requiredText(idempotencyKey || clean.idempotencyKey, 'idempotencyKey');
    const taskId = optionalText(clean.taskId) || null;
    const sessionId = optionalText(clean.chatSessionId || clean.sessionId) || null;
    const writeBoundary = optionalText(clean.writeBoundary) || 'none';
    const payloadHash = clean.payloadHash
      ? ensureHash(clean.payloadHash)
      : linkOpsPayloadHash(clean.payload !== undefined ? clean.payload : clean);
    const queuedAt = timestampFromRecord(clean, ['queuedAt', 'createdAt'], 'job.queuedAt');
    const createdAt = timestampFromRecord(clean, ['createdAt', 'queuedAt'], 'job.createdAt');
    const scope = `job:enqueue:${owner}`;
    const requestHash = linkOpsPayloadHash({operation: 'enqueue_job', job: clean, payloadHash});
    return transaction(`job-idempotency:${owner}:${idem}`, async activeClient => {
      const prior = await readIdempotency(activeClient, scope, idem);
      const replay = replayIdempotent(prior, requestHash, scope, idem);
      if (replay) return replay;
      const result = await activeClient.query({
        name: 'link-ops-enqueue-job',
        text: `/* link_ops:enqueue_job */
          INSERT INTO ops.link_ops_job(
            job_id,task_id,chat_session_id,owner_user,actor_user,status,idempotency_key,
            write_boundary,payload_hash,record,queued_at,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,'queued',$6,$7,$8,$9::jsonb,
            COALESCE($10::timestamptz,clock_timestamp()),
            COALESCE($11::timestamptz,$10::timestamptz,clock_timestamp()),
            COALESCE($11::timestamptz,$10::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [jobId, taskId, sessionId, owner, actor, idem, writeBoundary, payloadHash, JSON.stringify(clean), queuedAt, createdAt],
      });
      const created = rowToJob(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'job', aggregateId: jobId, eventType: 'job_queued', ownerUser: owner,
        actorUser: actor, status: 'queued', chatSessionId: sessionId, taskId, jobId,
        payload: {revision: created.repositoryRevision, payloadHash, writeBoundary},
      });
      await writeIdempotency(activeClient, {
        scope, idempotencyKey: idem, requestHash, entityType: 'job', entityId: jobId,
        response: idempotencyResponse(created),
      });
      return created;
    });
  }

  async function claimJob({workerId, leaseMs = 60_000, ownerUser = ''} = {}) {
    const worker = requiredText(workerId, 'workerId');
    const lease = boundedInteger(leaseMs, {fallback: 60_000, min: 1_000, max: 86_400_000, label: 'leaseMs'});
    await recoverExpiredJobs();
    return transaction('job-queue-claim', async activeClient => {
      const values = [worker, lease];
      const ownerClause = optionalText(ownerUser) ? ' AND owner_user=$3' : '';
      if (ownerClause) values.push(optionalText(ownerUser));
      const result = await activeClient.query({
        name: 'link-ops-claim-job',
        text: `/* link_ops:claim_job */
          WITH candidate AS (
            SELECT job_id
            FROM ops.link_ops_job
            WHERE status='queued'${ownerClause}
            ORDER BY queued_at ASC, job_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE ops.link_ops_job AS job SET
            status='running',lease_owner=$1,
            lease_expires_at=clock_timestamp()+($2::bigint * interval '1 millisecond'),
            heartbeat_at=clock_timestamp(),started_at=COALESCE(started_at,clock_timestamp()),
            attempt=attempt+1,revision=revision+1,updated_at=clock_timestamp()
          FROM candidate
          WHERE job.job_id=candidate.job_id
          RETURNING job.*`,
        values,
      });
      if (!result.rowCount) return null;
      const claimed = rowToJob(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'job', aggregateId: claimed.jobId, eventType: 'job_claimed',
        ownerUser: claimed.ownerUser, actorUser: worker, status: 'running',
        chatSessionId: claimed.chatSessionId, taskId: claimed.taskId, jobId: claimed.jobId,
        payload: {
          revision: claimed.repositoryRevision,
          leaseOwner: worker,
          leaseExpiresAt: claimed.leaseExpiresAt,
          attempt: claimed.attempt,
          payloadHash: claimed.payloadHash,
        },
      });
      return claimed;
    });
  }

  async function heartbeatJob(jobId, {leaseOwner, expectedRevision, leaseMs = 60_000} = {}) {
    const id = requiredText(jobId, 'jobId');
    const owner = requiredText(leaseOwner, 'leaseOwner');
    const revision = positiveRevision(expectedRevision);
    const lease = boundedInteger(leaseMs, {fallback: 60_000, min: 1_000, max: 86_400_000, label: 'leaseMs'});
    return transaction(`job:${id}:heartbeat`, async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-heartbeat-job',
        text: `/* link_ops:heartbeat_job */
          UPDATE ops.link_ops_job SET
            heartbeat_at=clock_timestamp(),
            lease_expires_at=clock_timestamp()+($4::bigint * interval '1 millisecond'),
            revision=revision+1,updated_at=clock_timestamp()
          WHERE job_id=$1 AND status='running' AND lease_owner=$2 AND revision=$3
            AND lease_expires_at > clock_timestamp()
          RETURNING *`,
        values: [id, owner, revision, lease],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_job', 'job_id', id);
        if (currentRevision === null) throw new LinkOpsNotFoundError('job', id);
        throw new LinkOpsRevisionConflictError('job', id, revision, currentRevision);
      }
      return rowToJob(result.rows[0]);
    });
  }

  async function advanceJobWriteBoundary(jobId, writeBoundary, {
    leaseOwner,
    expectedRevision,
    payloadHash,
  } = {}) {
    const id = requiredText(jobId, 'jobId');
    const boundary = requiredText(writeBoundary, 'writeBoundary');
    const owner = requiredText(leaseOwner, 'leaseOwner');
    const revision = positiveRevision(expectedRevision);
    const hash = ensureHash(payloadHash);
    return transaction(`job:${id}:write-boundary`, async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-advance-job-write-boundary',
        text: `/* link_ops:advance_job_write_boundary */
          UPDATE ops.link_ops_job SET
            write_boundary=$4,heartbeat_at=clock_timestamp(),
            revision=revision+1,updated_at=clock_timestamp()
          WHERE job_id=$1 AND status='running' AND lease_owner=$2
            AND revision=$3 AND payload_hash=$5
            AND lease_expires_at > clock_timestamp()
          RETURNING *`,
        values: [id, owner, revision, boundary, hash],
      });
      if (!result.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_job', 'job_id', id);
        if (currentRevision === null) throw new LinkOpsNotFoundError('job', id);
        throw new LinkOpsRevisionConflictError('job', id, revision, currentRevision);
      }
      const updated = rowToJob(result.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'job', aggregateId: id, eventType: 'job_write_boundary_advanced',
        ownerUser: updated.ownerUser, actorUser: owner, status: 'running',
        chatSessionId: updated.chatSessionId, taskId: updated.taskId, jobId: id,
        payload: {revision: updated.repositoryRevision, writeBoundary: boundary, payloadHash: hash},
      });
      return updated;
    });
  }

  async function finishJob(jobId, {
    status,
    leaseOwner,
    expectedRevision,
    result = {},
    error = {},
    actorUser = '',
  } = {}) {
    const id = requiredText(jobId, 'jobId');
    const finalStatus = requiredText(status, 'status');
    if (!['succeeded', 'failed', 'uncertain_write'].includes(finalStatus)) {
      throw new LinkOpsValidationError('finishJob status must be succeeded, failed, or uncertain_write');
    }
    const owner = requiredText(leaseOwner, 'leaseOwner');
    const revision = positiveRevision(expectedRevision);
    if (!isPlainObject(result) || !isPlainObject(error)) throw new LinkOpsValidationError('job result and error must be JSON objects');
    const actor = optionalText(actorUser) || owner;
    return transaction(`job:${id}:finish`, async activeClient => {
      const updated = await activeClient.query({
        name: 'link-ops-finish-job',
        text: `/* link_ops:finish_job */
          UPDATE ops.link_ops_job SET
            status=$4,result=$5::jsonb,error=$6::jsonb,actor_user=$7,
            lease_owner='',lease_expires_at=NULL,heartbeat_at=clock_timestamp(),
            finished_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
          WHERE job_id=$1 AND status='running' AND lease_owner=$2 AND revision=$3
            AND lease_expires_at > clock_timestamp()
          RETURNING *`,
        values: [id, owner, revision, finalStatus, JSON.stringify(result), JSON.stringify(error), actor],
      });
      if (!updated.rowCount) {
        const currentRevision = await queryCurrentRevision(activeClient, 'ops.link_ops_job', 'job_id', id);
        if (currentRevision === null) throw new LinkOpsNotFoundError('job', id);
        throw new LinkOpsRevisionConflictError('job', id, revision, currentRevision);
      }
      const job = rowToJob(updated.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'job', aggregateId: id, eventType: `job_${finalStatus}`,
        ownerUser: job.ownerUser, actorUser: actor, status: finalStatus,
        chatSessionId: job.chatSessionId, taskId: job.taskId, jobId: id,
        payload: {
          revision: job.repositoryRevision,
          payloadHash: job.payloadHash,
          writeBoundary: job.writeBoundary,
          result: jsonClone(result),
          error: jsonClone(error),
        },
      });
      return job;
    });
  }

  async function appendEvent(event) {
    const aggregateType = requiredText(event?.aggregateType, 'aggregateType');
    const aggregateId = requiredText(event?.aggregateId, 'aggregateId');
    return transaction(`event:${aggregateType}:${aggregateId}`, activeClient => appendEventInTransaction(activeClient, event));
  }

  async function listEvents({
    aggregateType = '',
    aggregateId = '',
    taskId = '',
    jobId = '',
    afterEventId = 0,
    limit = 1_000,
    queryClient = null,
  } = {}) {
    const maxRows = boundedInteger(limit, {fallback: 1_000, min: 1, max: 100_000, label: 'limit'});
    const after = boundedInteger(afterEventId, {fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER, label: 'afterEventId'});
    const run = async activeClient => {
      const clauses = ['event_id > $1'];
      const values = [after];
      const add = (column, value) => {
        if (!optionalText(value)) return;
        values.push(optionalText(value));
        clauses.push(`${column}=$${values.length}`);
      };
      add('aggregate_type', aggregateType);
      add('aggregate_id', aggregateId);
      add('task_id', taskId);
      add('job_id', jobId);
      values.push(maxRows);
      const result = await activeClient.query({
        name: 'link-ops-list-events',
        text: `/* link_ops:list_events */
          SELECT * FROM ops.link_ops_event
          WHERE ${clauses.join(' AND ')}
          ORDER BY event_id ASC
          LIMIT $${values.length}`,
        values,
      });
      return (result.rows || []).map(rowToEvent);
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function applyMigrationSql(migrationSql, {
    version = LINK_OPS_MIGRATION_VERSION,
    migrationHash = linkOpsPayloadHash(String(migrationSql || '')),
  } = {}) {
    const sql = requiredText(migrationSql, 'migrationSql');
    const migrationVersion = requiredText(version, 'version');
    const hash = ensureHash(migrationHash, 'migrationHash');
    return withPgClient(source, async activeClient => {
      await activeClient.query(sql);
      const result = await activeClient.query({
        name: 'link-ops-record-migration-hash',
        text: `/* link_ops:record_migration_hash */
          UPDATE ops.link_ops_migration
          SET migration_hash=$2, applied_at=clock_timestamp(), applied_by=current_user
          WHERE version=$1
          RETURNING *`,
        values: [migrationVersion, hash],
      });
      if (!result.rowCount) {
        throw new LinkOpsRepositoryError(`Migration ${migrationVersion} did not register itself`, {
          code: 'LINK_OPS_MIGRATION_NOT_REGISTERED',
        });
      }
      return result.rows[0];
    });
  }

  async function getMigration(version = LINK_OPS_MIGRATION_VERSION, {queryClient = null} = {}) {
    const migrationVersion = requiredText(version, 'version');
    const run = async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-get-migration',
        text: '/* link_ops:get_migration */ SELECT * FROM ops.link_ops_migration WHERE version=$1',
        values: [migrationVersion],
      });
      return result.rows?.[0] || null;
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function beginImportBatch({
    batchId,
    idempotencyKey,
    migrationVersion = LINK_OPS_MIGRATION_VERSION,
    manifestHash,
    manifest,
    actorUser = '',
    sourceKind = 'json',
    counts = {},
  }) {
    const id = requiredText(batchId, 'batchId');
    const idem = requiredText(idempotencyKey, 'idempotencyKey');
    const version = requiredText(migrationVersion, 'migrationVersion');
    const hash = ensureHash(manifestHash, 'manifestHash');
    if (!isPlainObject(manifest) || !isPlainObject(counts)) {
      throw new LinkOpsValidationError('manifest and counts must be JSON objects');
    }
    return transaction(`import-batch:${idem}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-import-batch',
        text: `/* link_ops:lock_import_batch */
          SELECT * FROM ops.link_ops_import_batch
          WHERE idempotency_key=$1 OR batch_id=$2
          FOR UPDATE`,
        values: [idem, id],
      });
      if (existing.rows?.[0]) {
        const row = existing.rows[0];
        if (row.manifest_hash !== hash || row.idempotency_key !== idem) {
          throw new LinkOpsImportConflictError('import_batch', id, hash, row.manifest_hash);
        }
        return {...row, skipped: true};
      }
      const inserted = await activeClient.query({
        name: 'link-ops-begin-import-batch',
        text: `/* link_ops:begin_import_batch */
          INSERT INTO ops.link_ops_import_batch(
            batch_id,idempotency_key,migration_version,source_kind,status,actor_user,
            manifest_hash,manifest,counts,started_at
          ) VALUES ($1,$2,$3,$4,'running',$5,$6,$7::jsonb,$8::jsonb,clock_timestamp())
          RETURNING *`,
        values: [id, idem, version, requiredText(sourceKind, 'sourceKind'), optionalText(actorUser), hash, JSON.stringify(manifest), JSON.stringify(counts)],
      });
      return {...inserted.rows[0], skipped: false};
    });
  }

  async function finishImportBatch(batchId, {
    status,
    counts = {},
    error = {},
  } = {}) {
    const id = requiredText(batchId, 'batchId');
    const finalStatus = requiredText(status, 'status');
    if (!['succeeded', 'failed'].includes(finalStatus)) {
      throw new LinkOpsValidationError('Import batch final status must be succeeded or failed');
    }
    if (!isPlainObject(counts) || !isPlainObject(error)) {
      throw new LinkOpsValidationError('counts and error must be JSON objects');
    }
    return transaction(`import-batch:${id}`, async activeClient => {
      const result = await activeClient.query({
        name: 'link-ops-finish-import-batch',
        text: `/* link_ops:finish_import_batch */
          UPDATE ops.link_ops_import_batch SET
            status=$2,counts=$3::jsonb,error=$4::jsonb,
            finished_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE batch_id=$1 AND status IN ('prepared','running')
          RETURNING *`,
        values: [id, finalStatus, JSON.stringify(counts), JSON.stringify(error)],
      });
      if (!result.rowCount) throw new LinkOpsNotFoundError('import_batch', id);
      return result.rows[0];
    });
  }

  async function getStoredHashes(entityType, ids, {recordType = '', queryClient = null} = {}) {
    const type = requiredText(entityType, 'entityType');
    if (!Array.isArray(ids)) throw new LinkOpsValidationError('ids must be an array');
    const normalizedIds = [...new Set(ids.map((id, index) => requiredText(id, `ids[${index}]`)))];
    if (!normalizedIds.length) return new Map();
    if (normalizedIds.length > 100_000) throw new LinkOpsValidationError('ids exceeds 100000 records');
    const specs = {
      task: ['ops.link_ops_task', 'task_id'],
      session: ['ops.link_ops_session', 'session_id'],
      message: ['ops.link_ops_message', 'message_id'],
      meta: ['ops.link_ops_meta', 'meta_key'],
    };
    const run = async activeClient => {
      if (type === 'record') {
        const dynamicType = requiredText(recordType, 'recordType');
        const result = await activeClient.query({
          name: 'link-ops-stored-record-hashes',
          text: `/* link_ops:stored_record_hashes */
            SELECT record_id AS entity_id,payload_hash
            FROM ops.link_ops_record
            WHERE record_type=$1 AND record_id=ANY($2::text[])`,
          values: [dynamicType, normalizedIds],
        });
        return new Map((result.rows || []).map(row => [row.entity_id, row.payload_hash]));
      }
      const spec = specs[type];
      if (!spec) throw new LinkOpsValidationError(`Unsupported import entity type: ${type}`);
      const [table, idColumn] = spec;
      const result = await activeClient.query(
        `/* link_ops:stored_hashes */ SELECT ${idColumn} AS entity_id,payload_hash FROM ${table} WHERE ${idColumn}=ANY($1::text[])`,
        [normalizedIds]
      );
      return new Map((result.rows || []).map(row => [row.entity_id, row.payload_hash]));
    };
    return queryClient ? run(queryClient) : withPgClient(source, run);
  }

  async function importSession(session, {
    batchId,
    ownerUser = '',
    actorUser = '',
    sortOrder = 0,
  } = {}) {
    const clean = sessionRecordWithoutMessages(session);
    const sessionId = requiredText(clean.id || clean.sessionId, 'session.id');
    clean.id = sessionId;
    delete clean.sessionId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const title = optionalText(clean.title);
    const createdAt = timestampFromRecord(clean, ['createdAt'], 'session.createdAt');
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'session.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const importBatchId = requiredText(batchId, 'batchId');
    return transaction(`import:session:${sessionId}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-import-session',
        text: '/* link_ops:lock_import_session */ SELECT * FROM ops.link_ops_session WHERE session_id=$1 FOR UPDATE',
        values: [sessionId],
      });
      if (existing.rows?.[0]) {
        const storedHash = existing.rows[0].payload_hash;
        if (storedHash !== payloadHash) throw new LinkOpsImportConflictError('session', sessionId, payloadHash, storedHash);
        return {record: rowToRecord(existing.rows[0]), skipped: true, payloadHash};
      }
      const inserted = await activeClient.query({
        name: 'link-ops-import-session',
        text: `/* link_ops:import_session */
          INSERT INTO ops.link_ops_session(
            session_id,owner_user,actor_user,status,title,sort_order,record,payload_hash,
            import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
            COALESCE($10::timestamptz,clock_timestamp()),
            COALESCE($11::timestamptz,$10::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [sessionId, owner, actor, statusValue, title, boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'}), JSON.stringify(clean), payloadHash, importBatchId, createdAt, updatedAt],
      });
      const record = rowToRecord(inserted.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'session', aggregateId: sessionId, eventType: 'session_imported',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {revision: record.repositoryRevision, payloadHash, importBatchId},
      });
      return {record, skipped: false, payloadHash};
    });
  }

  async function importMessage(chatSessionId, message, {
    batchId,
    ownerUser = '',
    actorUser = '',
    sequenceNo = 0,
  } = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const clean = recordWithoutRepositoryMetadata(message);
    const messageId = requiredText(clean.id || clean.messageId, 'message.id');
    clean.id = messageId;
    delete clean.messageId;
    const role = requiredText(clean.role, 'message.role');
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) throw new LinkOpsValidationError(`Unsupported message role: ${role}`);
    const statusValue = optionalText(clean.status) || 'created';
    const createdAt = timestampFromRecord(clean, ['at', 'createdAt'], 'message.at');
    const updatedAt = timestampFromRecord(clean, ['updatedAt', 'at', 'createdAt'], 'message.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const importBatchId = requiredText(batchId, 'batchId');
    return transaction(`import:message:${messageId}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-import-message',
        text: '/* link_ops:lock_import_message */ SELECT * FROM ops.link_ops_message WHERE message_id=$1 FOR UPDATE',
        values: [messageId],
      });
      if (existing.rows?.[0]) {
        const storedHash = existing.rows[0].payload_hash;
        if (storedHash !== payloadHash) throw new LinkOpsImportConflictError('message', messageId, payloadHash, storedHash);
        return {record: rowToRecord(existing.rows[0]), skipped: true, payloadHash};
      }
      const session = await activeClient.query({
        name: 'link-ops-lock-import-message-session',
        text: '/* link_ops:lock_import_message_session */ SELECT * FROM ops.link_ops_session WHERE session_id=$1 AND deleted_at IS NULL FOR UPDATE',
        values: [sessionId],
      });
      if (!session.rows?.[0]) throw new LinkOpsNotFoundError('session', sessionId);
      const owner = recordOwner(clean, ownerUser || session.rows[0].owner_user);
      const actor = recordActor(clean, actorUser || owner);
      const order = boundedInteger(sequenceNo, {fallback: 0, min: 0, label: 'sequenceNo'});
      const inserted = await activeClient.query({
        name: 'link-ops-import-message',
        text: `/* link_ops:import_message */
          INSERT INTO ops.link_ops_message(
            message_id,chat_session_id,owner_user,actor_user,role,status,sequence_no,
            record,payload_hash,import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,
            COALESCE($11::timestamptz,clock_timestamp()),
            COALESCE($12::timestamptz,$11::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [messageId, sessionId, owner, actor, role, statusValue, order, JSON.stringify(clean), payloadHash, importBatchId, createdAt, updatedAt],
      });
      await activeClient.query({
        name: 'link-ops-touch-import-session-message',
        text: `/* link_ops:touch_import_session_message */
          UPDATE ops.link_ops_session SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp())
          WHERE session_id=$1`,
        values: [sessionId],
      });
      const record = rowToRecord(inserted.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'message', aggregateId: messageId, eventType: 'message_imported',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {revision: record.repositoryRevision, payloadHash, sequenceNo: order, importBatchId},
      });
      return {record, skipped: false, payloadHash};
    });
  }

  async function importTask(task, {
    batchId,
    ownerUser = '',
    actorUser = '',
    sortOrder = 0,
  } = {}) {
    const clean = recordWithoutRepositoryMetadata(task);
    const taskId = requiredText(clean.id || clean.taskId, 'task.id');
    clean.id = taskId;
    delete clean.taskId;
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(clean.status);
    const chatSessionId = taskChatSessionId(clean);
    const arrays = taskTargetArrays(clean);
    const createdAt = timestampFromRecord(clean, ['createdAt'], 'task.createdAt');
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], 'task.updatedAt');
    const payloadHash = linkOpsPayloadHash(clean);
    const importBatchId = requiredText(batchId, 'batchId');
    return transaction(`import:task:${taskId}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-import-task',
        text: '/* link_ops:lock_import_task */ SELECT * FROM ops.link_ops_task WHERE task_id=$1 FOR UPDATE',
        values: [taskId],
      });
      if (existing.rows?.[0]) {
        const storedHash = existing.rows[0].payload_hash;
        if (storedHash !== payloadHash) throw new LinkOpsImportConflictError('task', taskId, payloadHash, storedHash);
        return {record: rowToRecord(existing.rows[0]), skipped: true, payloadHash};
      }
      const inserted = await activeClient.query({
        name: 'link-ops-import-task',
        text: `/* link_ops:import_task */
          INSERT INTO ops.link_ops_task(
            task_id,owner_user,actor_user,status,chat_session_id,
            intents,source_stores,write_stores,product_refs,sort_order,
            record,payload_hash,import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[],$10,
            $11::jsonb,$12,$13,
            COALESCE($14::timestamptz,clock_timestamp()),
            COALESCE($15::timestamptz,$14::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [taskId, owner, actor, statusValue, chatSessionId, arrays.intents, arrays.sourceStores, arrays.writeStores, arrays.productRefs, boundedInteger(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'}), JSON.stringify(clean), payloadHash, importBatchId, createdAt, updatedAt],
      });
      const record = rowToRecord(inserted.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: 'task', aggregateId: taskId, eventType: 'task_imported',
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId, taskId,
        payload: {revision: record.repositoryRevision, payloadHash, importBatchId},
      });
      return {record, skipped: false, payloadHash};
    });
  }

  async function importRecord(recordType, recordId, record, {
    batchId,
    ownerUser = '',
    actorUser = '',
    status = '',
    chatSessionId = '',
  } = {}) {
    const type = requiredText(recordType, 'recordType');
    const id = requiredText(recordId, 'recordId');
    const clean = recordWithoutRepositoryMetadata(record);
    const owner = recordOwner(clean, ownerUser);
    const actor = recordActor(clean, actorUser || owner);
    const statusValue = optionalText(status || clean.status);
    const sessionId = optionalText(chatSessionId || clean.chatSessionId) || null;
    const createdAt = timestampFromRecord(clean, ['createdAt'], `${type}.createdAt`);
    const updatedAt = timestampFromRecord(clean, ['updatedAt'], `${type}.updatedAt`);
    const payloadHash = linkOpsPayloadHash(clean);
    const importBatchId = requiredText(batchId, 'batchId');
    return transaction(`import:record:${type}:${id}`, async activeClient => {
      const existing = await activeClient.query({
        name: 'link-ops-lock-import-record',
        text: `/* link_ops:lock_import_record */
          SELECT * FROM ops.link_ops_record
          WHERE record_type=$1 AND record_id=$2 FOR UPDATE`,
        values: [type, id],
      });
      if (existing.rows?.[0]) {
        const storedHash = existing.rows[0].payload_hash;
        if (storedHash !== payloadHash) throw new LinkOpsImportConflictError(type, id, payloadHash, storedHash);
        return {record: rowToRecord(existing.rows[0]), skipped: true, payloadHash};
      }
      const inserted = await activeClient.query({
        name: 'link-ops-import-record',
        text: `/* link_ops:import_record */
          INSERT INTO ops.link_ops_record(
            record_type,record_id,owner_user,actor_user,status,chat_session_id,
            record,payload_hash,import_batch_id,created_at,updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
            COALESCE($10::timestamptz,clock_timestamp()),
            COALESCE($11::timestamptz,$10::timestamptz,clock_timestamp())
          ) RETURNING *`,
        values: [type, id, owner, actor, statusValue, sessionId, JSON.stringify(clean), payloadHash, importBatchId, createdAt, updatedAt],
      });
      const stored = rowToRecord(inserted.rows[0]);
      await appendEventInTransaction(activeClient, {
        aggregateType: type, aggregateId: id, eventType: `${type}_imported`,
        ownerUser: owner, actorUser: actor, status: statusValue, chatSessionId: sessionId,
        payload: {revision: stored.repositoryRevision, payloadHash, importBatchId},
      });
      return {record: stored, skipped: false, payloadHash};
    });
  }

  async function importMeta(metaKey, record, options = {}) {
    const stored = await putMeta(metaKey, record, {...options, importMode: true});
    return {
      record: stored,
      skipped: Boolean(stored.importSkipped),
      payloadHash: stored.repositoryPayloadHash,
    };
  }

  async function exportSnapshot() {
    return transaction('export-snapshot', async activeClient => {
      const [
        metaRows,
        taskRows,
        sessionRows,
        messageRows,
        actionRows,
        jobRows,
        eventRows,
        migrationRows,
        importBatchRows,
      ] = await Promise.all([
        activeClient.query('/* link_ops:export_meta */ SELECT * FROM ops.link_ops_meta ORDER BY meta_key'),
        activeClient.query(`/* link_ops:export_tasks */
          SELECT * FROM ops.link_ops_task WHERE deleted_at IS NULL
          ORDER BY sort_order ASC, updated_at DESC, task_id`),
        activeClient.query(`/* link_ops:export_sessions */
          SELECT * FROM ops.link_ops_session WHERE deleted_at IS NULL
          ORDER BY sort_order ASC, updated_at DESC, session_id`),
        activeClient.query(`/* link_ops:export_messages */
          SELECT * FROM ops.link_ops_message
          ORDER BY chat_session_id, sequence_no ASC, created_at ASC, message_id`),
        activeClient.query(`/* link_ops:export_action_records */
          SELECT * FROM ops.link_ops_record
          WHERE record_type='action_state' AND deleted_at IS NULL
          ORDER BY updated_at DESC, record_id`),
        activeClient.query('/* link_ops:export_jobs */ SELECT * FROM ops.link_ops_job ORDER BY queued_at, job_id'),
        activeClient.query('/* link_ops:export_events */ SELECT * FROM ops.link_ops_event ORDER BY event_id'),
        activeClient.query('/* link_ops:export_migrations */ SELECT * FROM ops.link_ops_migration ORDER BY version'),
        activeClient.query('/* link_ops:export_import_batches */ SELECT * FROM ops.link_ops_import_batch ORDER BY created_at, batch_id'),
      ]);
      const meta = new Map((metaRows.rows || []).map(row => [row.meta_key, recordWithoutRepositoryMetadata(rowToRecord(row))]));
      const messages = new Map((sessionRows.rows || []).map(row => [row.session_id, []]));
      for (const row of messageRows.rows || []) {
        if (messages.has(row.chat_session_id)) {
          messages.get(row.chat_session_id).push(recordWithoutRepositoryMetadata(rowToRecord(row)));
        }
      }
      const tasks = (taskRows.rows || []).map(row => recordWithoutRepositoryMetadata(rowToRecord(row)));
      const sessions = (sessionRows.rows || []).map(row => ({
        ...recordWithoutRepositoryMetadata(rowToRecord(row)),
        messages: messages.get(row.session_id) || [],
      }));
      const taskEnvelope = meta.get('task_store') || {version: 1, updatedAt: null};
      const sessionEnvelope = meta.get('session_store') || {version: 1, updatedAt: null};
      const actionEnvelope = meta.get('action_store') || {version: 1, updatedAt: null};
      const actions = Object.fromEntries((actionRows.rows || []).map(row => [
        row.record_id,
        recordWithoutRepositoryMetadata(rowToRecord(row)),
      ]));
      return {
        taskStore: {...taskEnvelope, version: Number(taskEnvelope.version || 1) || 1, tasks},
        sessionStore: {...sessionEnvelope, version: Number(sessionEnvelope.version || 1) || 1, sessions},
        actionState: {...actionEnvelope, version: Number(actionEnvelope.version || 1) || 1, actions},
        runtime: {
          version: 1,
          exportedAt: new Date().toISOString(),
          jobs: (jobRows.rows || []).map(row => recordWithoutRepositoryMetadata(rowToJob(row))),
          events: (eventRows.rows || []).map(rowToEvent),
          migrations: (migrationRows.rows || []).map(row => ({
            version: row.version,
            migrationHash: row.migration_hash,
            appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
            appliedBy: row.applied_by,
            details: parseJsonColumn(row.details),
          })),
          importBatches: (importBatchRows.rows || []).map(row => ({
            batchId: row.batch_id,
            idempotencyKey: row.idempotency_key,
            migrationVersion: row.migration_version,
            sourceKind: row.source_kind,
            status: row.status,
            actorUser: row.actor_user,
            manifestHash: row.manifest_hash,
            manifest: parseJsonColumn(row.manifest),
            counts: parseJsonColumn(row.counts),
            error: parseJsonColumn(row.error),
            startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
            finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
          })),
          meta: Object.fromEntries(meta),
        },
      };
    }, {isolationLevel: 'repeatable read', readOnly: true});
  }

  return Object.freeze({
    mode: 'postgres',
    close,
    health,
    applyMigrationSql,
    getMigration,
    getMeta,
    putMeta,
    getTask,
    getTaskStore,
    createTask,
    updateTask,
    deleteTask,
    getSession,
    getSessionStore,
    createSession,
    updateSession,
    updateSessionWithMessages,
    deleteSession,
    listMessages,
    appendMessage,
    getRecord,
    listRecords,
    putRecord,
    deleteRecord,
    getActionState,
    putActionRecord,
    applyActionChanges,
    getJob,
    listJobs,
    enqueueJob,
    recoverExpiredJobs,
    claimJob,
    heartbeatJob,
    advanceJobWriteBoundary,
    finishJob,
    appendEvent,
    listEvents,
    beginImportBatch,
    finishImportBatch,
    getStoredHashes,
    importMeta,
    importSession,
    importMessage,
    importTask,
    importRecord,
    exportSnapshot,
  });
}

/**
 * Configured PostgreSQL entry point. PostgreSQL mode deliberately has no JSON
 * fallback: a database connection/configuration failure is surfaced to the
 * caller so writes fail closed. JSON compatibility is explicit via
 * createLinkOpsJsonRepository() from link_ops_json_repository.mjs.
 */
export function createLinkOpsRepository(options = {}) {
  const mode = optionalText(options.mode || options.env?.SHEIN_LINK_OPS_REPOSITORY_MODE || process.env.SHEIN_LINK_OPS_REPOSITORY_MODE || 'postgres').toLowerCase();
  if (mode !== 'postgres') {
    throw new WarehousePgConfigurationError(
      `createLinkOpsRepository only accepts postgres mode (received ${mode || '(empty)'}); import createLinkOpsJsonRepository explicitly for compatibility mode`
    );
  }
  const {mode: _mode, ...postgresOptions} = options;
  return createLinkOpsPostgresRepository(postgresOptions);
}
