import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LINK_OPS_JOB_STATUSES,
  LINK_OPS_MIGRATION_VERSION,
  LinkOpsIdempotencyConflictError,
  LinkOpsImportConflictError,
  LinkOpsNotFoundError,
  LinkOpsRepositoryError,
  LinkOpsRevisionConflictError,
  LinkOpsValidationError,
  linkOpsPayloadHash,
  stripLinkOpsRepositoryMetadata,
} from './link_ops_repository.mjs';

const JOB_STATUS_SET = new Set(LINK_OPS_JOB_STATUSES);
const DAY_MS = 24 * 60 * 60 * 1000;
// History remains live only while it is inside both gates. The event window is
// deliberately longer for audit; idempotency keeps a bounded retry horizon.
const JSON_EVENT_RETENTION_MAX_AGE_MS = 180 * DAY_MS;
const JSON_EVENT_RETENTION_MAX_ENTRIES = 10_000;
const JSON_IDEMPOTENCY_RETENTION_MAX_AGE_MS = 30 * DAY_MS;
const JSON_IDEMPOTENCY_RETENTION_MAX_ENTRIES = 5_000;
const LOCK_TRANSIENT_CREATE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new LinkOpsValidationError(`${label} is required`);
  return normalized;
}

function optionalText(value) {
  return String(value ?? '').trim();
}

function revision(value, label = 'expectedRevision') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new LinkOpsValidationError(`${label} must be a positive integer`);
  return number;
}

function integer(value, {fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER, label = 'value'} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new LinkOpsValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function ownerOf(record, fallback = '') {
  return requiredText(
    fallback
    || record.ownerUser
    || record.ownership?.ownerUser
    || record.requestedByUser
    || record.createdByUser,
    'ownerUser'
  );
}

function actorOf(record, fallback = '') {
  return optionalText(
    record.actorUser
    || record.updatedByUser
    || record.createdByUser
    || record.requestedByUser
    || record.ownership?.ownerUser
    || fallback
  );
}

function cleanRecord(record) {
  if (!plainObject(record)) throw new LinkOpsValidationError('record must be a JSON object');
  return stripLinkOpsRepositoryMetadata(record);
}

function normalizeMessageRecord(message, label = 'message') {
  const clean = cleanRecord(message);
  const messageId = requiredText(clean.id || clean.messageId, `${label}.id`);
  clean.id = messageId;
  delete clean.messageId;
  const role = requiredText(clean.role, `${label}.role`);
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
    throw new LinkOpsValidationError(`Unsupported message role: ${role}`);
  }
  return {clean, messageId, payloadHash: linkOpsPayloadHash(clean)};
}

function normalizeDesiredMessages(messages, label = 'messages') {
  if (!Array.isArray(messages)) throw new LinkOpsValidationError(`${label} must be an array`);
  const normalized = messages.map((message, index) => normalizeMessageRecord(message, `${label}[${index}]`));
  const ids = new Set();
  for (const message of normalized) {
    if (ids.has(message.messageId)) throw new LinkOpsValidationError(`Duplicate message id: ${message.messageId}`);
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
    const current = publicRecord(currentMessages[index]);
    const currentId = requiredText(current?.id || current?.messageId, `current message ${index}.id`);
    const desired = desiredMessages[index];
    if (currentId !== desired.messageId || linkOpsPayloadHash(cleanRecord(current)) !== desired.payloadHash) {
      throw new LinkOpsRepositoryError(`Chat message ${currentId} is append-only and cannot be edited or reordered`, {
        code: 'LINK_OPS_APPEND_ONLY_CONFLICT',
        details: {sessionId, messageId: currentId, index},
      });
    }
  }
}

function storedRecord(record, nextRevision = 1) {
  const clean = cleanRecord(record);
  return {
    ...clean,
    repositoryRevision: nextRevision,
    repositoryPayloadHash: linkOpsPayloadHash(clean),
  };
}

function publicRecord(record) {
  if (!record) return null;
  const clean = cleanRecord(record);
  const storedHash = optionalText(record.repositoryPayloadHash);
  const computedHash = linkOpsPayloadHash(clean);
  return {
    ...clean,
    repositoryRevision: Number.isSafeInteger(Number(record.repositoryRevision)) && Number(record.repositoryRevision) > 0
      ? Number(record.repositoryRevision)
      : 1,
    repositoryPayloadHash: storedHash === computedHash ? storedHash : computedHash,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockOwnerToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Parses lock owner metadata written by acquireFileLock. Returns null when the
// content is not a well-formed JSON lock record; a lock record must carry a
// usable createdAt (newer records also carry a random owner token). Foreign or
// corrupt content is treated as an unknown owner and is never deleted.
function parseLockOwner(text) {
  if (typeof text !== 'string') return null;
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  const createdAtMs = historyTimestamp(value.createdAt);
  if (createdAtMs === null) return null;
  return {
    token: typeof value.token === 'string' && /^[0-9a-f]{32}$/.test(value.token) ? value.token : null,
    createdAtMs,
    pid: Number.isSafeInteger(Number(value.pid)) ? Number(value.pid) : null,
  };
}

// Reads the current owner of a lock path together with coarse identity
// (mtimeMs/size). Returns null when the entry is gone, an object with
// `unknown: true` when the entry exists but cannot be identified as a
// well-formed stale candidate, or the parsed owner metadata otherwise.
async function readLockOwner(lockFile, fsImpl) {
  const stat = await fsImpl.stat(lockFile).catch(() => null);
  if (!stat) return null;
  const text = await fsImpl.readFile(lockFile, 'utf8').catch(() => null);
  if (text === null) return {unknown: true, mtimeMs: stat.mtimeMs ?? null, size: stat.size ?? null};
  const metadata = parseLockOwner(text);
  if (metadata === null && text.trim() !== '') {
    return {unknown: true, mtimeMs: stat.mtimeMs ?? null, size: stat.size ?? null};
  }
  return {
    ...(metadata || {token: null, createdAtMs: null, pid: null}),
    mtimeMs: stat.mtimeMs ?? null,
    size: stat.size ?? null,
  };
}

async function handleCloseSafe(handle) {
  if (!handle || typeof handle.close !== 'function') return;
  await handle.close().catch(() => {});
}

// Proves that the directory can accept new entries. Used only to classify an
// EPERM/EBUSY/EACCES create failure that would otherwise be ambiguous between
// transient lock contention and a real directory/ACL permission error.
async function directoryWriteProbe(directory, fsImpl) {
  const probe = path.join(directory, `.bi-lock-probe-${lockOwnerToken()}.lockprobe`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle = null;
    try {
      handle = await fsImpl.open(probe, 'wx', 0o600);
      await handle.writeFile('probe');
      if (typeof handle.sync === 'function') await handle.sync().catch(() => {});
    } catch {
      await handleCloseSafe(handle);
      await fsImpl.unlink(probe).catch(() => {});
      if (attempt < 2) await sleep(10 + attempt * 10);
      continue;
    }
    await handleCloseSafe(handle);
    await fsImpl.unlink(probe).catch(() => {});
    return true;
  }
  return false;
}

// Classifies an open('wx') failure. EEXIST is always contention. On Windows a
// parallel open/unlink against the same path can surface as EPERM/EBUSY/EACCES
// even while the lock file exists; those codes are contention only when a lock
// entry is visible or the directory is provably writable. Everything else is a
// real error that must fail closed instead of spinning or being masked.
async function proveLockContention(lockFile, code, fsImpl) {
  if (code === 'EEXIST') return true;
  if (!LOCK_TRANSIENT_CREATE_CODES.has(code)) return false;
  const stat = await fsImpl.stat(lockFile).catch(() => null);
  if (stat) return !stat.isDirectory();
  return directoryWriteProbe(path.dirname(lockFile), fsImpl);
}

// Removes a stale lock entry only after it was observed stale twice and
// unchanged in between. Never touches foreign content or an entry that was
// replaced by a fresh owner between the two observations.
async function recoverStaleLock(lockFile, {staleMs, fsImpl}) {
  const first = await readLockOwner(lockFile, fsImpl);
  if (!first || first.unknown) return false;
  const ageMs = Math.max(
    first.createdAtMs === null ? 0 : Date.now() - first.createdAtMs,
    first.mtimeMs === null ? 0 : Date.now() - first.mtimeMs
  );
  if (ageMs <= staleMs) return false;
  const second = await readLockOwner(lockFile, fsImpl);
  if (!second || second.unknown) return false;
  const unchanged = second.token === first.token
    && second.createdAtMs === first.createdAtMs
    && (first.mtimeMs === null || second.mtimeMs === null || second.mtimeMs === first.mtimeMs)
    && (first.size === null || second.size === null || second.size === first.size);
  if (!unchanged) return false;
  try {
    await fsImpl.unlink(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  return true;
}

// Best-effort removal of a lock we have proven to own. A committed operation
// must not fail over cleanup: transient Windows sharing/AV holds are retried,
// and any remaining file is reclaimed later through stale recovery. Ownership
// is re-verified immediately before every unlink attempt: while we wait out a
// transient failure another process may recover our stale lock and replace it
// with a successor's file, and deleting that file by path would silently break
// the mutex.
async function unlinkOwnedLock(lockFile, expectedToken, fsImpl) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = await readLockOwner(lockFile, fsImpl);
    if (!owner || owner.unknown || owner.token !== expectedToken) return;
    try {
      await fsImpl.unlink(lockFile);
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (attempt < 3) {
        await sleep(20 + attempt * 25);
        continue;
      }
      return;
    }
  }
}

export async function acquireFileLock(file, {timeoutMs, staleMs, fsImpl = fs}) {
  const lockFile = `${file}.lock`;
  const started = Date.now();
  await fsImpl.mkdir(path.dirname(file), {recursive: true});
  const token = lockOwnerToken();
  let handle = null;
  while (true) {
    let claimed = null;
    try {
      claimed = await fsImpl.open(lockFile, 'wx', 0o600);
    } catch (error) {
      const code = String(error?.code || '');
      if (code !== 'EEXIST' && !LOCK_TRANSIENT_CREATE_CODES.has(code)) throw error;
      if (!(await proveLockContention(lockFile, code, fsImpl))) throw error;
      if (Date.now() - started >= timeoutMs) {
        throw new LinkOpsRepositoryError(`Timed out waiting for JSON repository lock: ${lockFile}`, {
          code: 'LINK_OPS_JSON_LOCK_TIMEOUT',
        });
      }
      if (!(await recoverStaleLock(lockFile, {staleMs, fsImpl}))) {
        await sleep(15 + Math.floor(Math.random() * 25));
      }
      continue;
    }
    try {
      await claimed.writeFile(JSON.stringify({token, pid: process.pid, createdAt: nowIso(), target: file}));
      if (typeof claimed.sync === 'function') await claimed.sync().catch(() => {});
    } catch (writeError) {
      // Created the path but could not mark ownership: remove the unclaimed
      // entry so it cannot block the repository, then surface the failure.
      await handleCloseSafe(claimed);
      await fsImpl.unlink(lockFile).catch(() => {});
      throw writeError;
    }
    handle = claimed;
    break;
  }
  return async () => {
    await handleCloseSafe(handle);
    // unlinkOwnedLock re-verifies ownership before every unlink attempt, so a
    // stale recovery that replaces our lock during a retry can never be hit.
    await unlinkOwnedLock(lockFile, token, fsImpl);
  };
}

async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return clone(fallback);
    throw error;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!plainObject(value)) throw new Error('top-level JSON value must be an object');
    return value;
  } catch (error) {
    throw new LinkOpsRepositoryError(`Invalid JSON repository file ${file}: ${error.message}`, {
      code: 'LINK_OPS_JSON_PARSE',
      cause: error,
    });
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const transientRenameCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let renamed = false;
  try {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await fs.rename(temporary, file);
        renamed = true;
        break;
      } catch (error) {
        if (!transientRenameCodes.has(String(error?.code || '')) || attempt === 8) throw error;
        // Windows antivirus/indexing can briefly retain the destination handle.
        // Retry the atomic replace; never unlink the committed file as a fallback.
        await sleep(Math.min(400, (12 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 20)));
      }
    }
  } finally {
    if (!renamed) await fs.unlink(temporary).catch(() => {});
  }
}

function repositoryState(store) {
  if (!plainObject(store._repository)) store._repository = {};
  if (!plainObject(store._repository.idempotency)) store._repository.idempotency = {};
  if (!Array.isArray(store._repository.events)) store._repository.events = [];
  if (!plainObject(store._repository.metaRevisions)) store._repository.metaRevisions = {};
  return store._repository;
}

function historyTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function retainHistoryEntries(entries, {maxAgeMs, maxEntries, createdAt}, nowMs) {
  const cutoff = nowMs - maxAgeMs;
  const withinAge = entries.filter(entry => {
    const timestamp = historyTimestamp(createdAt(entry));
    // Legacy records without a usable timestamp fail closed into the count
    // window instead of silently losing an idempotency or audit record.
    return timestamp === null || timestamp >= cutoff;
  });
  return withinAge.length > maxEntries
    ? withinAge.slice(withinAge.length - maxEntries)
    : withinAge;
}

function compactRepositoryHistory(store, nowMs = Date.now()) {
  const state = repositoryState(store);
  const retainedEvents = retainHistoryEntries(state.events, {
    maxAgeMs: JSON_EVENT_RETENTION_MAX_AGE_MS,
    maxEntries: JSON_EVENT_RETENTION_MAX_ENTRIES,
    createdAt: event => event?.createdAt,
  }, nowMs);
  const retainedIdempotency = retainHistoryEntries(Object.entries(state.idempotency), {
    maxAgeMs: JSON_IDEMPOTENCY_RETENTION_MAX_AGE_MS,
    maxEntries: JSON_IDEMPOTENCY_RETENTION_MAX_ENTRIES,
    createdAt: ([, record]) => record?.createdAt,
  }, nowMs);
  state.events = retainedEvents;
  state.idempotency = Object.fromEntries(retainedIdempotency);
}

function eventRecord(event) {
  const payload = plainObject(event.payload) ? clone(event.payload) : {};
  return {
    eventId: event.eventId || `evt_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
    eventKey: optionalText(event.eventKey) || null,
    aggregateType: requiredText(event.aggregateType, 'aggregateType'),
    aggregateId: requiredText(event.aggregateId, 'aggregateId'),
    eventType: requiredText(event.eventType, 'eventType'),
    ownerUser: optionalText(event.ownerUser),
    actorUser: optionalText(event.actorUser),
    status: optionalText(event.status),
    chatSessionId: optionalText(event.chatSessionId) || null,
    taskId: optionalText(event.taskId) || null,
    jobId: optionalText(event.jobId) || null,
    payload,
    payloadHash: linkOpsPayloadHash(payload),
    createdAt: event.createdAt || nowIso(),
  };
}

function appendLocalEvent(store, event) {
  const state = repositoryState(store);
  const row = eventRecord(event);
  if (row.eventKey && state.events.some(item => item.eventKey === row.eventKey)) return row;
  state.events.push(row);
  return row;
}

function idempotencyLookup(store, scope, key, requestHash) {
  if (!key) return null;
  const state = repositoryState(store);
  const composite = `${scope}\u0000${key}`;
  const prior = state.idempotency[composite];
  if (!prior) return null;
  if (prior.requestHash !== requestHash) throw new LinkOpsIdempotencyConflictError(scope, key);
  return clone(prior.response);
}

function idempotencyStore(store, scope, key, requestHash, response) {
  if (!key) return;
  repositoryState(store).idempotency[`${scope}\u0000${key}`] = {
    requestHash,
    response: clone(response),
    createdAt: nowIso(),
  };
}

function envelopeWithoutRepository(store, arrayKey) {
  return Object.fromEntries(Object.entries(store).filter(([key]) => key !== '_repository' && key !== arrayKey));
}

export function createLinkOpsJsonRepository({
  rootDir = process.cwd(),
  taskFile = path.join(rootDir, 'state', 'bi_link_ops_tasks.json'),
  sessionFile = path.join(rootDir, 'state', 'bi_link_ops_chats.json'),
  actionFile = path.join(rootDir, 'state', 'bi_action_state.json'),
  runtimeFile = path.join(rootDir, 'state', 'bi_link_ops_runtime.json'),
  legacyActionMirrorWriter = writeJsonAtomic,
  lockTimeoutMs = 10_000,
  staleLockMs = 120_000,
} = {}) {
  if (typeof legacyActionMirrorWriter !== 'function') {
    throw new LinkOpsValidationError('legacyActionMirrorWriter must be a function');
  }
  const files = {
    task: path.resolve(taskFile),
    session: path.resolve(sessionFile),
    action: path.resolve(actionFile),
    runtime: path.resolve(runtimeFile),
  };
  const lockOptions = {
    timeoutMs: integer(lockTimeoutMs, {fallback: 10_000, min: 100, max: 300_000, label: 'lockTimeoutMs'}),
    staleMs: integer(staleLockMs, {fallback: 120_000, min: 1_000, max: 86_400_000, label: 'staleLockMs'}),
  };
  const defaults = {
    task: {version: 1, updatedAt: null, tasks: []},
    session: {version: 1, updatedAt: null, sessions: []},
    action: {version: 1, updatedAt: null, actions: {}},
    runtime: {version: 1, updatedAt: null, jobs: [], records: {}, importBatches: [], migrations: [], meta: {}},
  };

  async function read(kind) {
    const store = await readJson(files[kind], defaults[kind]);
    repositoryState(store);
    return store;
  }

  async function mutate(kind, callback) {
    const release = await acquireFileLock(files[kind], lockOptions);
    try {
      const store = await read(kind);
      const compactionNow = Date.now();
      compactRepositoryHistory(store, compactionNow);
      const result = await callback(store);
      // The callback may append both an event and an idempotency response. Keep
      // those writes and compaction in the same locked atomic replacement.
      compactRepositoryHistory(store, compactionNow);
      await writeJsonAtomic(files[kind], store);
      return result;
    } finally {
      await release();
    }
  }

  async function close() {}

  async function health() {
    const [tasks, sessions, actions, runtime] = await Promise.all([read('task'), read('session'), read('action'), read('runtime')]);
    return {
      ok: true,
      mode: 'json',
      tasks: Array.isArray(tasks.tasks) ? tasks.tasks.length : 0,
      sessions: Array.isArray(sessions.sessions) ? sessions.sessions.length : 0,
      messages: Array.isArray(sessions.sessions)
        ? sessions.sessions.reduce((total, session) => total + (Array.isArray(session.messages) ? session.messages.length : 0), 0)
        : 0,
      records: plainObject(actions.actions) ? Object.keys(actions.actions).length : 0,
      jobs: Array.isArray(runtime.jobs) ? runtime.jobs.length : 0,
      events: Array.isArray(runtime._repository?.events) ? runtime._repository.events.length : 0,
      migrationVersion: Array.isArray(runtime.migrations) && runtime.migrations.length
        ? runtime.migrations[runtime.migrations.length - 1].version
        : null,
    };
  }

  async function getTaskStore({ownerUser = '', status = '', chatSessionId = '', limit = 1_000, offset = 0} = {}) {
    const store = await read('task');
    const maxRows = integer(limit, {fallback: 1_000, min: 1, max: 10_000, label: 'limit'});
    const skip = integer(offset, {fallback: 0, min: 0, max: 10_000_000, label: 'offset'});
    const tasks = (Array.isArray(store.tasks) ? store.tasks : [])
      .map(publicRecord)
      .filter(task => !ownerUser || ownerOf(task) === ownerUser)
      .filter(task => !status || optionalText(task.status) === status)
      .filter(task => !chatSessionId || optionalText(task.chatSessionId || task.chat?.sessionId) === chatSessionId)
      .slice(skip, skip + maxRows);
    return {...envelopeWithoutRepository(store, 'tasks'), version: Number(store.version || 1) || 1, tasks};
  }

  async function getTask(taskId) {
    const id = requiredText(taskId, 'taskId');
    return (await getTaskStore({limit: 10_000})).tasks.find(task => optionalText(task.id || task.taskId) === id) || null;
  }

  async function createTask(task, {idempotencyKey = '', ownerUser = '', actorUser = '', sortOrder = 0} = {}) {
    const clean = cleanRecord(task);
    const id = requiredText(clean.id || clean.taskId, 'task.id');
    clean.id = id;
    delete clean.taskId;
    const owner = ownerOf(clean, ownerUser);
    const actor = actorOf(clean, actorUser || owner);
    const idem = optionalText(idempotencyKey);
    const scope = `task:create:${owner}`;
    const order = integer(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'create_task', task: clean, sortOrder: order});
    return mutate('task', store => {
      if (!Array.isArray(store.tasks)) throw new LinkOpsValidationError('task store tasks must be an array');
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicRecord(replay);
      if (store.tasks.some(row => optionalText(row.id || row.taskId) === id)) {
        throw new LinkOpsRepositoryError(`task ${id} already exists`, {code: 'LINK_OPS_ALREADY_EXISTS'});
      }
      const created = storedRecord(clean, 1);
      store.tasks.splice(Math.min(order, store.tasks.length), 0, created);
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: 'task', aggregateId: id, eventType: 'task_created', ownerUser: owner,
        actorUser: actor, status: clean.status, chatSessionId: clean.chatSessionId, taskId: id,
        payload: {revision: 1, payloadHash: created.repositoryPayloadHash},
      });
      idempotencyStore(store, scope, idem, requestHash, created);
      return publicRecord(created);
    });
  }

  async function updateTask(taskId, task, {expectedRevision, idempotencyKey = '', ownerUser = '', actorUser = '', sortOrder = null} = {}) {
    const id = requiredText(taskId, 'taskId');
    const expected = revision(expectedRevision);
    const clean = cleanRecord(task);
    if (optionalText(clean.id || clean.taskId) && optionalText(clean.id || clean.taskId) !== id) {
      throw new LinkOpsValidationError('task.id cannot change');
    }
    clean.id = id;
    delete clean.taskId;
    const owner = ownerOf(clean, ownerUser);
    const actor = actorOf(clean, actorUser || owner);
    const idem = optionalText(idempotencyKey);
    const scope = `task:update:${id}`;
    const order = sortOrder === null || sortOrder === undefined
      ? null
      : integer(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'update_task', expectedRevision: expected, task: clean, sortOrder: order});
    return mutate('task', store => {
      if (!Array.isArray(store.tasks)) throw new LinkOpsValidationError('task store tasks must be an array');
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicRecord(replay);
      const index = store.tasks.findIndex(row => optionalText(row.id || row.taskId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('task', id);
      const current = publicRecord(store.tasks[index]);
      if (current.repositoryRevision !== expected) {
        throw new LinkOpsRevisionConflictError('task', id, expected, current.repositoryRevision);
      }
      const updated = storedRecord(clean, expected + 1);
      store.tasks.splice(index, 1);
      store.tasks.splice(order === null ? Math.min(index, store.tasks.length) : Math.min(order, store.tasks.length), 0, updated);
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: 'task', aggregateId: id, eventType: 'task_updated', ownerUser: owner,
        actorUser: actor, status: clean.status, chatSessionId: clean.chatSessionId, taskId: id,
        payload: {previousRevision: expected, revision: expected + 1, payloadHash: updated.repositoryPayloadHash},
      });
      idempotencyStore(store, scope, idem, requestHash, updated);
      return publicRecord(updated);
    });
  }

  async function deleteTask(taskId, {expectedRevision, actorUser = '', idempotencyKey = ''} = {}) {
    const id = requiredText(taskId, 'taskId');
    const expected = revision(expectedRevision);
    const idem = optionalText(idempotencyKey);
    const scope = `task:delete:${id}`;
    const requestHash = linkOpsPayloadHash({operation: 'delete_task', id, expectedRevision: expected, actorUser});
    return mutate('task', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return replay;
      const index = (store.tasks || []).findIndex(row => optionalText(row.id || row.taskId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('task', id);
      const current = publicRecord(store.tasks[index]);
      if (current.repositoryRevision !== expected) throw new LinkOpsRevisionConflictError('task', id, expected, current.repositoryRevision);
      store.tasks.splice(index, 1);
      store.updatedAt = nowIso();
      const response = {id, deleted: true, revision: expected + 1, deletedAt: store.updatedAt};
      appendLocalEvent(store, {
        aggregateType: 'task', aggregateId: id, eventType: 'task_deleted', ownerUser: ownerOf(current),
        actorUser, status: 'deleted', taskId: id, payload: response,
      });
      idempotencyStore(store, scope, idem, requestHash, response);
      return response;
    });
  }

  function publicSession(record, includeMessages = true) {
    if (!record) return null;
    const clean = cleanRecord(record);
    const messages = Array.isArray(clean.messages) ? clean.messages : [];
    delete clean.messages;
    const session = publicRecord({...clean, repositoryRevision: record.repositoryRevision, repositoryPayloadHash: record.repositoryPayloadHash});
    if (includeMessages) session.messages = messages.map(publicRecord);
    return session;
  }

  async function getSessionStore({ownerUser = '', status = '', limit = 300, offset = 0, includeMessages = true} = {}) {
    const store = await read('session');
    const maxRows = integer(limit, {fallback: 300, min: 1, max: 3_000, label: 'limit'});
    const skip = integer(offset, {fallback: 0, min: 0, max: 10_000_000, label: 'offset'});
    const sessions = (Array.isArray(store.sessions) ? store.sessions : [])
      .map(row => publicSession(row, includeMessages))
      .filter(session => !ownerUser || ownerOf(session) === ownerUser)
      .filter(session => !status || optionalText(session.status) === status)
      .slice(skip, skip + maxRows);
    return {...envelopeWithoutRepository(store, 'sessions'), version: Number(store.version || 1) || 1, sessions};
  }

  async function getSession(chatSessionId, {includeMessages = true} = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const store = await read('session');
    const row = (store.sessions || []).find(session => optionalText(session.id || session.sessionId) === id);
    return publicSession(row, includeMessages);
  }

  async function createSession(session, {idempotencyKey = '', ownerUser = '', actorUser = '', sortOrder = 0} = {}) {
    const source = cleanRecord(session);
    const id = requiredText(source.id || source.sessionId, 'session.id');
    source.id = id;
    delete source.sessionId;
    const inputMessages = normalizeDesiredMessages(
      Array.isArray(source.messages) ? source.messages : [],
      'session.messages'
    );
    source.messages = inputMessages.map(message => storedRecord(message.clean, 1));
    const baseForHash = {...source};
    delete baseForHash.messages;
    const owner = ownerOf(baseForHash, ownerUser);
    const actor = actorOf(baseForHash, actorUser || owner);
    const idem = optionalText(idempotencyKey);
    const scope = `session:create:${owner}`;
    const order = integer(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({
      operation: 'create_session',
      session: baseForHash,
      messages: inputMessages.map(message => message.clean),
      sortOrder: order,
    });
    return mutate('session', store => {
      if (!Array.isArray(store.sessions)) throw new LinkOpsValidationError('session store sessions must be an array');
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicSession(replay);
      if (store.sessions.some(row => optionalText(row.id || row.sessionId) === id)) {
        throw new LinkOpsRepositoryError(`session ${id} already exists`, {code: 'LINK_OPS_ALREADY_EXISTS'});
      }
      const existingMessageIds = new Set(
        store.sessions.flatMap(row => (row.messages || []).map(message => optionalText(message.id || message.messageId)))
      );
      for (const message of inputMessages) {
        if (existingMessageIds.has(message.messageId)) {
          throw new LinkOpsRepositoryError(`message ${message.messageId} already exists`, {
            code: 'LINK_OPS_ALREADY_EXISTS',
            details: {entityType: 'message', entityId: message.messageId},
          });
        }
      }
      const stored = storedRecord(baseForHash, 1);
      stored.messages = source.messages;
      store.sessions.splice(Math.min(order, store.sessions.length), 0, stored);
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: 'session', aggregateId: id, eventType: 'session_created', ownerUser: owner,
        actorUser: actor, status: source.status, chatSessionId: id,
        payload: {revision: 1, payloadHash: stored.repositoryPayloadHash, messageCount: inputMessages.length},
      });
      for (let index = 0; index < inputMessages.length; index += 1) {
        const messageId = inputMessages[index].messageId;
        appendLocalEvent(store, {
          aggregateType: 'message', aggregateId: messageId, eventType: 'message_appended', ownerUser: owner,
          actorUser: actor, chatSessionId: id,
          payload: {revision: 1, sequenceNo: index, payloadHash: source.messages[index].repositoryPayloadHash},
        });
      }
      idempotencyStore(store, scope, idem, requestHash, stored);
      return publicSession(stored);
    });
  }

  async function updateSession(chatSessionId, session, {expectedRevision, idempotencyKey = '', ownerUser = '', actorUser = '', sortOrder = null} = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const expected = revision(expectedRevision);
    const clean = cleanRecord(session);
    if (optionalText(clean.id || clean.sessionId) && optionalText(clean.id || clean.sessionId) !== id) {
      throw new LinkOpsValidationError('session.id cannot change');
    }
    clean.id = id;
    delete clean.sessionId;
    delete clean.messages;
    const owner = ownerOf(clean, ownerUser);
    const actor = actorOf(clean, actorUser || owner);
    const idem = optionalText(idempotencyKey);
    const scope = `session:update:${id}`;
    const order = sortOrder === null || sortOrder === undefined
      ? null
      : integer(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({operation: 'update_session', expectedRevision: expected, session: clean, sortOrder: order});
    return mutate('session', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicSession(replay);
      const index = (store.sessions || []).findIndex(row => optionalText(row.id || row.sessionId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('session', id);
      const current = publicSession(store.sessions[index]);
      if (current.repositoryRevision !== expected) {
        throw new LinkOpsRevisionConflictError('session', id, expected, current.repositoryRevision);
      }
      const updated = storedRecord(clean, expected + 1);
      updated.messages = Array.isArray(store.sessions[index].messages) ? store.sessions[index].messages : [];
      store.sessions.splice(index, 1);
      store.sessions.splice(order === null ? Math.min(index, store.sessions.length) : Math.min(order, store.sessions.length), 0, updated);
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: 'session', aggregateId: id, eventType: 'session_updated', ownerUser: owner,
        actorUser: actor, status: clean.status, chatSessionId: id,
        payload: {previousRevision: expected, revision: expected + 1, payloadHash: updated.repositoryPayloadHash},
      });
      idempotencyStore(store, scope, idem, requestHash, updated);
      return publicSession(updated);
    });
  }

  async function updateSessionWithMessages(chatSessionId, session, {
    expectedRevision,
    idempotencyKey = '',
    ownerUser = '',
    actorUser = '',
    sortOrder = null,
  } = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const expected = revision(expectedRevision);
    const source = cleanRecord(session);
    const desiredMessages = normalizeDesiredMessages(
      Array.isArray(source.messages) ? source.messages : [],
      `session ${id} messages`
    );
    delete source.messages;
    if (optionalText(source.id || source.sessionId) && optionalText(source.id || source.sessionId) !== id) {
      throw new LinkOpsValidationError('session.id cannot change');
    }
    source.id = id;
    delete source.sessionId;
    const owner = ownerOf(source, ownerUser);
    const actor = actorOf(source, actorUser || owner);
    const idem = optionalText(idempotencyKey);
    const scope = `session:update-with-messages:${id}`;
    const order = sortOrder === null || sortOrder === undefined
      ? null
      : integer(sortOrder, {fallback: 0, min: 0, label: 'sortOrder'});
    const requestHash = linkOpsPayloadHash({
      operation: 'update_session_with_messages',
      expectedRevision: expected,
      session: source,
      messages: desiredMessages.map(message => message.clean),
      sortOrder: order,
    });

    return mutate('session', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicSession(replay);
      const index = (store.sessions || []).findIndex(row => optionalText(row.id || row.sessionId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('session', id);
      const current = publicSession(store.sessions[index]);
      if (current.repositoryRevision !== expected) {
        throw new LinkOpsRevisionConflictError('session', id, expected, current.repositoryRevision);
      }
      const currentMessages = Array.isArray(store.sessions[index].messages)
        ? store.sessions[index].messages
        : [];
      assertStrictMessageAppend(currentMessages, desiredMessages, id);

      const updated = storedRecord(source, expected + 1);
      updated.messages = currentMessages;
      store.sessions.splice(index, 1);
      const nextIndex = order === null ? Math.min(index, store.sessions.length) : Math.min(order, store.sessions.length);
      store.sessions.splice(nextIndex, 0, updated);
      appendLocalEvent(store, {
        aggregateType: 'session',
        aggregateId: id,
        eventType: 'session_updated',
        ownerUser: owner,
        actorUser: actor,
        status: source.status,
        chatSessionId: id,
        payload: {
          previousRevision: expected,
          revision: expected + 1,
          payloadHash: updated.repositoryPayloadHash,
        },
      });

      for (const message of desiredMessages.slice(currentMessages.length)) {
        const duplicate = (store.sessions || []).some(sessionRow =>
          (sessionRow.messages || []).some(row => optionalText(row.id || row.messageId) === message.messageId)
        );
        if (duplicate) {
          throw new LinkOpsRepositoryError(`message ${message.messageId} already exists`, {
            code: 'LINK_OPS_ALREADY_EXISTS',
            details: {entityType: 'message', entityId: message.messageId},
          });
        }
        const inserted = storedRecord(message.clean, 1);
        const sequenceNo = updated.messages.length;
        updated.messages.push(inserted);
        appendLocalEvent(store, {
          aggregateType: 'message',
          aggregateId: message.messageId,
          eventType: 'message_appended',
          ownerUser: ownerOf(message.clean, owner),
          actorUser: actorOf(message.clean, actor || owner),
          status: message.clean.status,
          chatSessionId: id,
          payload: {revision: 1, sequenceNo, payloadHash: inserted.repositoryPayloadHash},
        });
      }
      store.updatedAt = nowIso();
      idempotencyStore(store, scope, idem, requestHash, updated);
      return publicSession(updated);
    });
  }

  async function listMessages(chatSessionId) {
    const session = await getSession(chatSessionId);
    if (!session) throw new LinkOpsNotFoundError('session', chatSessionId);
    return session.messages || [];
  }

  async function appendMessage(chatSessionId, message, {idempotencyKey = '', ownerUser = '', actorUser = '', sequenceNo = null} = {}) {
    const sessionId = requiredText(chatSessionId, 'chatSessionId');
    const clean = cleanRecord(message);
    const messageId = requiredText(clean.id || clean.messageId, 'message.id');
    clean.id = messageId;
    delete clean.messageId;
    const role = requiredText(clean.role, 'message.role');
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) throw new LinkOpsValidationError(`Unsupported message role: ${role}`);
    const idem = optionalText(idempotencyKey);
    const scope = `message:create:${sessionId}`;
    const requestHash = linkOpsPayloadHash({operation: 'append_message', sessionId, message: clean});
    return mutate('session', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicRecord(replay);
      const sessionIndex = (store.sessions || []).findIndex(row => optionalText(row.id || row.sessionId) === sessionId);
      if (sessionIndex < 0) throw new LinkOpsNotFoundError('session', sessionId);
      const current = store.sessions[sessionIndex];
      if (!Array.isArray(current.messages)) current.messages = [];
      if (current.messages.some(row => optionalText(row.id || row.messageId) === messageId)) {
        throw new LinkOpsRepositoryError(`message ${messageId} already exists`, {code: 'LINK_OPS_ALREADY_EXISTS'});
      }
      const owner = ownerOf(clean, ownerUser || ownerOf(publicSession(current)));
      const actor = actorOf(clean, actorUser || owner);
      const order = sequenceNo === null || sequenceNo === undefined
        ? current.messages.length
        : integer(sequenceNo, {fallback: current.messages.length, min: 0, label: 'sequenceNo'});
      if (order !== current.messages.length) {
        throw new LinkOpsRepositoryError(`Chat session ${sessionId} messages are append-only`, {
          code: 'LINK_OPS_APPEND_ONLY_CONFLICT',
          details: {sessionId, expectedSequenceNo: current.messages.length, requestedSequenceNo: order},
        });
      }
      const inserted = storedRecord(clean, 1);
      current.messages.push(inserted);
      const currentSession = publicSession(current, false);
      const sessionClean = cleanRecord(currentSession);
      const nextSession = storedRecord(sessionClean, currentSession.repositoryRevision + 1);
      nextSession.messages = current.messages;
      store.sessions[sessionIndex] = nextSession;
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: 'message', aggregateId: messageId, eventType: 'message_appended', ownerUser: owner,
        actorUser: actor, status: clean.status, chatSessionId: sessionId,
        payload: {revision: 1, sequenceNo: order, payloadHash: inserted.repositoryPayloadHash},
      });
      idempotencyStore(store, scope, idem, requestHash, inserted);
      return publicRecord(inserted);
    });
  }

  async function deleteSession(chatSessionId, {expectedRevision, actorUser = '', idempotencyKey = ''} = {}) {
    const id = requiredText(chatSessionId, 'chatSessionId');
    const expected = revision(expectedRevision);
    const idem = optionalText(idempotencyKey);
    const scope = `session:delete:${id}`;
    const requestHash = linkOpsPayloadHash({operation: 'delete_session', id, expectedRevision: expected, actorUser});
    return mutate('session', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return replay;
      const index = (store.sessions || []).findIndex(row => optionalText(row.id || row.sessionId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('session', id);
      const current = publicSession(store.sessions[index]);
      if (current.repositoryRevision !== expected) throw new LinkOpsRevisionConflictError('session', id, expected, current.repositoryRevision);
      store.sessions.splice(index, 1);
      store.updatedAt = nowIso();
      const response = {id, deleted: true, revision: expected + 1, deletedAt: store.updatedAt};
      appendLocalEvent(store, {
        aggregateType: 'session', aggregateId: id, eventType: 'session_deleted', ownerUser: ownerOf(current),
        actorUser, status: 'deleted', chatSessionId: id, payload: response,
      });
      idempotencyStore(store, scope, idem, requestHash, response);
      return response;
    });
  }

  // Runtime data deliberately lives in one file: every queue, event, import, meta,
  // and generic-record mutation therefore has a single lock and atomic commit.
  function runtimeState(store) {
    if (!Array.isArray(store.jobs)) store.jobs = [];
    if (!plainObject(store.records)) store.records = {};
    if (!Array.isArray(store.importBatches)) store.importBatches = [];
    if (!Array.isArray(store.migrations)) store.migrations = [];
    if (!plainObject(store.meta)) store.meta = {};
    return store;
  }

  function publicJob(row) {
    if (!row) return null;
    const clean = cleanRecord(row);
    return {
      ...publicRecord(row), jobId: requiredText(clean.id || clean.jobId, 'job.id'),
      taskId: optionalText(clean.taskId) || null, chatSessionId: optionalText(clean.chatSessionId || clean.sessionId) || null,
      ownerUser: optionalText(clean.ownerUser), actorUser: optionalText(clean.actorUser),
      status: optionalText(clean.status), idempotencyKey: optionalText(clean.idempotencyKey),
      leaseOwner: optionalText(clean.leaseOwner), leaseExpiresAt: clean.leaseExpiresAt || null,
      heartbeatAt: clean.heartbeatAt || null, writeBoundary: optionalText(clean.writeBoundary) || 'none',
      payloadHash: optionalText(clean.payloadHash) || linkOpsPayloadHash(clean.payload !== undefined ? clean.payload : clean),
      result: plainObject(clean.result) ? clone(clean.result) : {}, error: plainObject(clean.error) ? clone(clean.error) : {},
      attempt: integer(clean.attempt, {fallback: 0, min: 0, label: 'attempt'}), queuedAt: clean.queuedAt || null,
      startedAt: clean.startedAt || null, finishedAt: clean.finishedAt || null,
    };
  }

  function recordBucket(store, type) {
    runtimeState(store);
    if (!plainObject(store.records[type])) store.records[type] = {};
    return store.records[type];
  }

  async function getMeta(metaKey, fallback = null) {
    const key = requiredText(metaKey, 'metaKey');
    const store = runtimeState(await read('runtime'));
    return store.meta[key] ? publicRecord(store.meta[key]) : fallback;
  }

  async function putMeta(metaKey, record, {expectedRevision = null, ownerUser = '', actorUser = '', status = 'active', importMode = false} = {}) {
    const key = requiredText(metaKey, 'metaKey'); const clean = cleanRecord(record); const hash = linkOpsPayloadHash(clean);
    return mutate('runtime', store => {
      runtimeState(store); const current = store.meta[key] && publicRecord(store.meta[key]);
      if (importMode && current) {
        if (current.repositoryPayloadHash !== hash) throw new LinkOpsImportConflictError('meta', key, hash, current.repositoryPayloadHash);
        return {...current, importSkipped: true};
      }
      if (current && (expectedRevision === null || expectedRevision === undefined)) {
        throw new LinkOpsRevisionConflictError('meta', key, null, current.repositoryRevision);
      }
      if (current && current.repositoryRevision !== revision(expectedRevision)) throw new LinkOpsRevisionConflictError('meta', key, expectedRevision, current.repositoryRevision);
      if (!current && expectedRevision !== null && expectedRevision !== undefined) throw new LinkOpsNotFoundError('meta', key);
      const stored = storedRecord(clean, (current?.repositoryRevision || 0) + 1);
      store.meta[key] = stored; store.updatedAt = nowIso(); return publicRecord(stored);
    });
  }

  async function getRecord(recordType, recordId, {includeDeleted = false} = {}) {
    const type = requiredText(recordType, 'recordType'); const id = requiredText(recordId, 'recordId');
    const store = runtimeState(await read('runtime')); const row = store.records[type]?.[id];
    return row && (includeDeleted || !row.deletedAt) ? publicRecord(row) : null;
  }

  async function listRecords(recordType, {ownerUser = '', status = '', chatSessionId = '', limit = 10_000} = {}) {
    const type = requiredText(recordType, 'recordType'); const max = integer(limit, {fallback: 10_000, min: 1, max: 100_000, label: 'limit'});
    const store = runtimeState(await read('runtime'));
    return Object.entries(store.records[type] || {}).map(([recordId, row]) => ({recordId, record: publicRecord(row)}))
      .filter(({record}) => !record.deletedAt && (!ownerUser || ownerOf(record) === ownerUser) && (!status || optionalText(record.status) === status) && (!chatSessionId || optionalText(record.chatSessionId) === chatSessionId))
      .sort((a, b) => optionalText(b.record.updatedAt).localeCompare(optionalText(a.record.updatedAt)) || a.recordId.localeCompare(b.recordId)).slice(0, max);
  }

  async function putRecord(recordType, recordId, record, {expectedRevision = null, idempotencyKey = '', ownerUser = '', actorUser = '', status = '', chatSessionId = '', importBatchId = null} = {}) {
    const type = requiredText(recordType, 'recordType'); const id = requiredText(recordId, 'recordId'); const clean = cleanRecord(record);
    const owner = ownerOf(clean, ownerUser); const actor = actorOf(clean, actorUser || owner); const idem = optionalText(idempotencyKey);
    const operation = expectedRevision === null || expectedRevision === undefined ? 'create' : 'update'; const scope = `record:${type}:${operation}:${id}`;
    const requestHash = linkOpsPayloadHash({operation, type, id, expectedRevision, record: clean});
    return mutate('runtime', store => {
      const bucket = recordBucket(store, type); const replay = idempotencyLookup(store, scope, idem, requestHash); if (replay) return publicRecord(replay);
      const current = bucket[id] && publicRecord(bucket[id]);
      if (operation === 'create' && current && !current.deletedAt) throw new LinkOpsRepositoryError(`${type} ${id} already exists`, {code: 'LINK_OPS_ALREADY_EXISTS'});
      if (operation === 'update' && !current) throw new LinkOpsNotFoundError(type, id);
      if (operation === 'update' && current.repositoryRevision !== revision(expectedRevision)) throw new LinkOpsRevisionConflictError(type, id, expectedRevision, current.repositoryRevision);
      const stored = storedRecord({
        ...clean,
        ownerUser: owner,
        actorUser: actor,
        status: optionalText(status || clean.status),
        chatSessionId: optionalText(chatSessionId || clean.chatSessionId) || null,
        importBatchId,
      }, (current?.repositoryRevision || 0) + 1);
      bucket[id] = stored;
      store.updatedAt = nowIso();
      appendLocalEvent(store, {
        aggregateType: type,
        aggregateId: id,
        eventType: importBatchId ? `${type}_imported` : `${type}_${operation}d`,
        ownerUser: owner,
        actorUser: actor,
        status: stored.status,
        chatSessionId: stored.chatSessionId,
        payload: {
          revision: stored.repositoryRevision,
          payloadHash: stored.repositoryPayloadHash,
          importBatchId,
        },
      });
      idempotencyStore(store, scope, idem, requestHash, stored); return publicRecord(stored);
    });
  }

  async function deleteRecord(recordType, recordId, {
    expectedRevision,
    actorUser = '',
    idempotencyKey = '',
  } = {}) {
    const type = requiredText(recordType, 'recordType');
    const id = requiredText(recordId, 'recordId');
    const expected = revision(expectedRevision);
    const actor = optionalText(actorUser);
    const idem = optionalText(idempotencyKey);
    const scope = `record:${type}:delete:${id}`;
    const requestHash = linkOpsPayloadHash({
      operation: 'delete_record',
      type,
      id,
      expectedRevision: expected,
      actor,
    });
    return mutate('runtime', store => {
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return replay;
      const bucket = recordBucket(store, type);
      const current = bucket[id] && publicRecord(bucket[id]);
      if (!current || current.deletedAt) throw new LinkOpsNotFoundError(type, id);
      if (current.repositoryRevision !== expected) {
        throw new LinkOpsRevisionConflictError(type, id, expected, current.repositoryRevision);
      }
      const deletedAt = nowIso();
      const stored = storedRecord({
        ...cleanRecord(bucket[id]),
        status: 'deleted',
        actorUser: actor,
        deletedAt,
        updatedAt: deletedAt,
      }, expected + 1);
      bucket[id] = stored;
      store.updatedAt = deletedAt;
      const response = {id, recordType: type, deleted: true, revision: expected + 1, deletedAt};
      appendLocalEvent(store, {
        aggregateType: type,
        aggregateId: id,
        eventType: `${type}_deleted`,
        ownerUser: optionalText(current.ownerUser),
        actorUser: actor,
        status: 'deleted',
        chatSessionId: optionalText(current.chatSessionId) || null,
        payload: response,
      });
      idempotencyStore(store, scope, idem, requestHash, response);
      return response;
    });
  }

  async function ensureLegacyActionStateImported() {
    const current = await read('runtime');
    if (current._repository?.legacyActionStateImported) return false;
    const legacy = await read('action');
    return mutate('runtime', store => {
      const state = repositoryState(store);
      if (state.legacyActionStateImported) return false;
      const bucket = recordBucket(store, 'action_state');
      const actions = plainObject(legacy.actions) ? legacy.actions : {};
      for (const [key, value] of Object.entries(actions)) {
        if (!plainObject(value) || bucket[key]) continue;
        const clean = cleanRecord(value);
        const ownerUser = optionalText(
          clean.ownerUser
          || clean.updatedByUser
          || clean.createdByUser
          || 'legacy-action-state'
        );
        const stored = storedRecord({...clean, ownerUser}, 1);
        bucket[key] = stored;
        appendLocalEvent(store, {
          aggregateType: 'action_state',
          aggregateId: key,
          eventType: 'action_state_legacy_imported',
          ownerUser,
          actorUser: 'system:legacy-import',
          status: optionalText(clean.status),
          payload: {revision: 1, payloadHash: stored.repositoryPayloadHash},
        });
      }
      if (!store.meta.action_store) {
        store.meta.action_store = storedRecord(envelopeWithoutRepository(legacy, 'actions'), 1);
      }
      state.legacyActionStateImported = true;
      store.updatedAt = nowIso();
      return true;
    });
  }

  async function getActionState() {
    await ensureLegacyActionStateImported();
    const [envelope, entries] = await Promise.all([getMeta('action_store', {version: 1, updatedAt: null}), listRecords('action_state')]);
    return {...cleanRecord(envelope), version: Number(envelope.version || 1) || 1, actions: Object.fromEntries(entries.map(entry => [entry.recordId, entry.record]))};
  }
  async function putActionRecord(actionKey, record, options = {}) { return putRecord('action_state', actionKey, record, options); }

  async function applyActionChanges(changes, {actorUser = '', idempotencyKey = ''} = {}) {
    if (!Array.isArray(changes)) throw new LinkOpsValidationError('action changes must be an array');
    if (changes.length > 20_000) throw new LinkOpsValidationError('action changes exceed 20000 rows');
    const actor = optionalText(actorUser);
    const keys = new Set();
    const normalized = changes.map((change, index) => {
      if (!plainObject(change)) throw new LinkOpsValidationError(`action changes[${index}] must be a JSON object`);
      const key = requiredText(change.key, `action changes[${index}].key`);
      if (keys.has(key)) throw new LinkOpsValidationError(`Duplicate action key: ${key}`);
      keys.add(key);
      const deleting = change.delete === true;
      if (deleting && change.record !== undefined) {
        throw new LinkOpsValidationError(`action ${key} delete change cannot include record`);
      }
      const expectedRevision = deleting
        ? revision(change.expectedRevision, `action ${key}.expectedRevision`)
        : (change.expectedRevision === null || change.expectedRevision === undefined
          ? null
          : revision(change.expectedRevision, `action ${key}.expectedRevision`));
      return deleting
        ? {key, delete: true, expectedRevision}
        : {key, delete: false, expectedRevision, record: cleanRecord(change.record)};
    });
    const idem = optionalText(idempotencyKey);
    const scope = 'record:action_state:batch';
    const requestHash = linkOpsPayloadHash({operation: 'action_batch', changes: normalized, actor});

    await ensureLegacyActionStateImported();
    return mutate('runtime', store => {
      const bucket = recordBucket(store, 'action_state');
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return replay;

      for (const change of normalized) {
        const current = bucket[change.key] && publicRecord(bucket[change.key]);
        const active = current && !current.deletedAt;
        if (change.expectedRevision === null) {
          if (current) {
            throw new LinkOpsRepositoryError(`action_state ${change.key} already exists`, {
              code: 'LINK_OPS_ALREADY_EXISTS',
              details: {entityType: 'action_state', entityId: change.key},
            });
          }
          continue;
        }
        if (!active) throw new LinkOpsNotFoundError('action_state', change.key);
        if (current.repositoryRevision !== change.expectedRevision) {
          throw new LinkOpsRevisionConflictError(
            'action_state',
            change.key,
            change.expectedRevision,
            current.repositoryRevision
          );
        }
      }

      const resultByKey = new Map();
      for (const change of normalized) {
        const current = bucket[change.key] && publicRecord(bucket[change.key]);
        if (change.delete) {
          const deletedAt = nowIso();
          const stored = storedRecord({
            ...cleanRecord(bucket[change.key]),
            status: 'deleted',
            actorUser: actor,
            deletedAt,
            updatedAt: deletedAt,
          }, change.expectedRevision + 1);
          bucket[change.key] = stored;
          const response = {
            key: change.key,
            delete: true,
            revision: stored.repositoryRevision,
            deletedAt,
          };
          appendLocalEvent(store, {
            aggregateType: 'action_state',
            aggregateId: change.key,
            eventType: 'action_state_deleted',
            ownerUser: optionalText(current.ownerUser),
            actorUser: actor,
            status: 'deleted',
            chatSessionId: optionalText(current.chatSessionId) || null,
            payload: response,
          });
          resultByKey.set(change.key, response);
          continue;
        }

        const owner = ownerOf(change.record, current?.ownerUser || actor);
        const recordActorUser = actorOf(change.record, actor || owner);
        const stored = storedRecord({
          ...change.record,
          ownerUser: owner,
          actorUser: recordActorUser,
          status: optionalText(change.record.status),
          chatSessionId: optionalText(change.record.chatSessionId) || null,
        }, (current?.repositoryRevision || 0) + 1);
        bucket[change.key] = stored;
        appendLocalEvent(store, {
          aggregateType: 'action_state',
          aggregateId: change.key,
          eventType: change.expectedRevision === null ? 'action_state_created' : 'action_state_updated',
          ownerUser: owner,
          actorUser: recordActorUser,
          status: stored.status,
          chatSessionId: stored.chatSessionId,
          payload: {revision: stored.repositoryRevision, payloadHash: stored.repositoryPayloadHash},
        });
        resultByKey.set(change.key, {key: change.key, delete: false, record: publicRecord(stored)});
      }
      store.updatedAt = nowIso();
      const response = {changes: normalized.map(change => resultByKey.get(change.key))};
      idempotencyStore(store, scope, idem, requestHash, response);
      return response;
    });
  }

  async function flushLegacyActionState() {
    const actionState = await getActionState();
    const mirror = {
      ...envelopeWithoutRepository(actionState, 'actions'),
      version: Number(actionState.version || 1) || 1,
      actions: Object.fromEntries(
        Object.entries(actionState.actions || {}).map(([key, value]) => [key, cleanRecord(value)])
      ),
    };
    try {
      await legacyActionMirrorWriter(files.action, mirror);
    } catch (error) {
      // The runtime file is authoritative and was committed before this derived
      // legacy projection is attempted. Surface a retryable projection state,
      // but never turn a mirror-only failure into an ambiguous entity failure.
      return {
        ...mirror,
        legacyMirrorFlush: {
          ok: false,
          status: 'pending',
          authoritativeSource: 'runtime',
          actionBatchRetryRequired: false,
          projectionRetrySafe: true,
          error: {
            code: optionalText(error?.code) || 'LINK_OPS_LEGACY_MIRROR_WRITE_FAILED',
            message: optionalText(error?.message) || 'Legacy action mirror write failed',
          },
        },
      };
    }
    return mirror;
  }

  async function getJob(jobId) {
    const id = requiredText(jobId, 'jobId');
    const store = runtimeState(await read('runtime'));
    return publicJob(store.jobs.find(row => optionalText(row.id || row.jobId) === id));
  }

  async function listJobs({status = '', ownerUser = '', taskId = '', limit = 500} = {}) {
    const max = integer(limit, {fallback: 500, min: 1, max: 10_000, label: 'limit'});
    const store = runtimeState(await read('runtime'));
    return store.jobs
      .map(publicJob)
      .filter(job => (!status || job.status === status)
        && (!ownerUser || job.ownerUser === ownerUser)
        && (!taskId || job.taskId === taskId))
      .sort((a, b) => optionalText(b.queuedAt).localeCompare(optionalText(a.queuedAt))
        || a.jobId.localeCompare(b.jobId))
      .slice(0, max);
  }

  async function enqueueJob(job, {idempotencyKey = '', ownerUser = '', actorUser = ''} = {}) {
    const clean = cleanRecord(job);
    const id = requiredText(clean.id || clean.jobId, 'job.id');
    const owner = ownerOf(clean, ownerUser);
    const actor = actorOf(clean, actorUser || owner);
    const idem = requiredText(idempotencyKey || clean.idempotencyKey, 'idempotencyKey');
    const payloadHash = clean.payloadHash || linkOpsPayloadHash(
      clean.payload !== undefined ? clean.payload : clean
    );
    const requestHash = linkOpsPayloadHash({operation: 'enqueue_job', job: clean, payloadHash});

    return mutate('runtime', store => {
      runtimeState(store);
      const scope = `job:enqueue:${owner}`;
      const replay = idempotencyLookup(store, scope, idem, requestHash);
      if (replay) return publicJob(replay);
      if (store.jobs.some(row => optionalText(row.id || row.jobId) === id)) {
        throw new LinkOpsRepositoryError(`job ${id} already exists`, {
          code: 'LINK_OPS_ALREADY_EXISTS',
        });
      }
      const at = nowIso();
      const stored = storedRecord({
        ...clean,
        id,
        ownerUser: owner,
        actorUser: actor,
        status: 'queued',
        idempotencyKey: idem,
        leaseOwner: '',
        leaseExpiresAt: null,
        heartbeatAt: null,
        writeBoundary: optionalText(clean.writeBoundary) || 'none',
        payloadHash,
        result: {},
        error: {},
        attempt: 0,
        queuedAt: clean.queuedAt || at,
        startedAt: null,
        finishedAt: null,
      }, 1);
      store.jobs.push(stored);
      appendLocalEvent(store, {
        aggregateType: 'job',
        aggregateId: id,
        eventType: 'job_queued',
        ownerUser: owner,
        actorUser: actor,
        status: 'queued',
        chatSessionId: stored.chatSessionId,
        taskId: stored.taskId,
        jobId: id,
        payload: {
          revision: 1,
          payloadHash,
          writeBoundary: stored.writeBoundary,
        },
      });
      idempotencyStore(store, scope, idem, requestHash, stored);
      return publicJob(stored);
    });
  }
  function recoverExpiredJobsInStore(store, {
    limit = 100,
    safeWriteBoundaries = ['none', 'read_only', 'planned', 'preflight_complete'],
    actorUser = 'system:lease-recovery',
  } = {}) {
    runtimeState(store);
    const max = integer(limit, {fallback: 100, min: 1, max: 1_000, label: 'limit'});
    const safe = new Set((Array.isArray(safeWriteBoundaries) ? safeWriteBoundaries : [])
      .map(optionalText)
      .filter(Boolean));
    if (!safe.size) throw new LinkOpsValidationError('safeWriteBoundaries must not be empty');
    const actor = requiredText(actorUser, 'actorUser');
    const now = Date.now();
    const expired = store.jobs
      .map((row, index) => ({row, index, job: publicJob(row)}))
      .filter(({job}) => job.status === 'running'
        && Number.isFinite(new Date(job.leaseExpiresAt).getTime())
        && new Date(job.leaseExpiresAt).getTime() <= now)
      .sort((a, b) => String(a.job.leaseExpiresAt).localeCompare(String(b.job.leaseExpiresAt))
        || a.job.jobId.localeCompare(b.job.jobId))
      .slice(0, max);
    const recovered = [];
    for (const {row, index, job} of expired) {
      const retrySafe = safe.has(job.writeBoundary || 'none');
      const status = retrySafe ? 'queued' : 'uncertain_write';
      const at = nowIso();
      const error = retrySafe ? {} : {
        code: 'LEASE_EXPIRED_AFTER_WRITE_BOUNDARY',
        message: 'Worker lease expired after an external-write boundary; automatic retry is disabled.',
        previousLeaseOwner: job.leaseOwner || '',
        previousLeaseExpiresAt: job.leaseExpiresAt || null,
        writeBoundary: job.writeBoundary || 'none',
      };
      const stored = storedRecord({
        ...cleanRecord(row),
        status,
        actorUser: actor,
        leaseOwner: '',
        leaseExpiresAt: null,
        heartbeatAt: at,
        error,
        finishedAt: retrySafe ? null : at,
        updatedAt: at,
      }, job.repositoryRevision + 1);
      store.jobs[index] = stored;
      appendLocalEvent(store, {
        aggregateType: 'job',
        aggregateId: job.jobId,
        eventType: retrySafe ? 'job_requeued_after_lease_expiry' : 'job_uncertain_write_after_lease_expiry',
        ownerUser: job.ownerUser,
        actorUser: actor,
        status,
        chatSessionId: job.chatSessionId,
        taskId: job.taskId,
        jobId: job.jobId,
        payload: {
          revision: job.repositoryRevision + 1,
          writeBoundary: job.writeBoundary,
          retrySafe,
          previousLeaseOwner: job.leaseOwner || '',
        },
      });
      recovered.push(publicJob(stored));
    }
    return recovered;
  }

  async function recoverExpiredJobs(options = {}) {
    return mutate('runtime', store => recoverExpiredJobsInStore(store, options));
  }

  async function claimJob({workerId, leaseMs = 60_000, ownerUser = ''} = {}) {
    const worker = requiredText(workerId, 'workerId');
    const lease = integer(leaseMs, {fallback: 60_000, min: 1_000, max: 86_400_000, label: 'leaseMs'});
    return mutate('runtime', store => {
      runtimeState(store);
      recoverExpiredJobsInStore(store);
      const now = Date.now();
      const row = store.jobs
        .filter(job => optionalText(job.status) === 'queued'
          && (!ownerUser || optionalText(job.ownerUser) === ownerUser))
        .sort((a, b) => optionalText(a.queuedAt).localeCompare(optionalText(b.queuedAt)))[0];
      if (!row) return null;
      const current = publicJob(row);
      const at = nowIso();
      const stored = storedRecord({
        ...cleanRecord(row),
        status: 'running',
        leaseOwner: worker,
        leaseExpiresAt: new Date(now + lease).toISOString(),
        heartbeatAt: at,
        startedAt: current.startedAt || at,
        attempt: current.attempt + 1,
      }, current.repositoryRevision + 1);
      const index = store.jobs.indexOf(row);
      store.jobs[index] = stored;
      appendLocalEvent(store, {
        aggregateType: 'job',
        aggregateId: current.jobId,
        eventType: 'job_claimed',
        ownerUser: current.ownerUser,
        actorUser: worker,
        status: 'running',
        chatSessionId: current.chatSessionId,
        taskId: current.taskId,
        jobId: current.jobId,
        payload: {
          revision: current.repositoryRevision + 1,
          leaseOwner: worker,
          leaseExpiresAt: stored.leaseExpiresAt,
          attempt: current.attempt + 1,
          payloadHash: current.payloadHash,
        },
      });
      return publicJob(stored);
    });
  }
  async function updateLeasedJob(jobId, {
    leaseOwner,
    expectedRevision,
    leaseMs = 60000,
    writeBoundary,
    payloadHash,
    finish,
  } = {}) {
    const id = requiredText(jobId, 'jobId');
    const owner = requiredText(leaseOwner, 'leaseOwner');
    const expected = revision(expectedRevision);
    const lease = integer(leaseMs, {
      fallback: 60000,
      min: 1000,
      max: 86400000,
      label: 'leaseMs',
    });

    return mutate('runtime', store => {
      runtimeState(store);
      const index = store.jobs.findIndex(row => optionalText(row.id || row.jobId) === id);
      if (index < 0) throw new LinkOpsNotFoundError('job', id);
      const current = publicJob(store.jobs[index]);
      if (current.status !== 'running'
        || current.leaseOwner !== owner
        || current.repositoryRevision !== expected
        || !current.leaseExpiresAt
        || new Date(current.leaseExpiresAt).getTime() <= Date.now()
        || (payloadHash && current.payloadHash !== payloadHash)) {
        throw new LinkOpsRevisionConflictError('job', id, expected, current.repositoryRevision);
      }
      const at = nowIso();
      const changed = {
        ...cleanRecord(store.jobs[index]),
        heartbeatAt: at,
      };
      if (writeBoundary !== undefined) {
        changed.writeBoundary = requiredText(writeBoundary, 'writeBoundary');
      }
      if (finish) {
        changed.status = finish.status;
        changed.result = clone(finish.result);
        changed.error = clone(finish.error);
        changed.actorUser = finish.actorUser;
        changed.leaseOwner = '';
        changed.leaseExpiresAt = null;
        changed.finishedAt = at;
      } else {
        changed.leaseExpiresAt = new Date(Date.now() + lease).toISOString();
      }
      const stored = storedRecord(changed, expected + 1);
      store.jobs[index] = stored;
      if (writeBoundary !== undefined) {
        appendLocalEvent(store, {
          aggregateType: 'job',
          aggregateId: id,
          eventType: 'job_write_boundary_advanced',
          ownerUser: current.ownerUser,
          actorUser: owner,
          status: 'running',
          chatSessionId: current.chatSessionId,
          taskId: current.taskId,
          jobId: id,
          payload: {
            revision: expected + 1,
            writeBoundary: changed.writeBoundary,
            payloadHash: current.payloadHash,
          },
        });
      }
      if (finish) {
        appendLocalEvent(store, {
          aggregateType: 'job',
          aggregateId: id,
          eventType: `job_${finish.status}`,
          ownerUser: current.ownerUser,
          actorUser: finish.actorUser,
          status: finish.status,
          chatSessionId: current.chatSessionId,
          taskId: current.taskId,
          jobId: id,
          payload: {
            revision: expected + 1,
            payloadHash: current.payloadHash,
            writeBoundary: changed.writeBoundary,
            result: changed.result,
            error: changed.error,
          },
        });
      }
      return publicJob(stored);
    });
  }
  async function heartbeatJob(jobId, options = {}) { return updateLeasedJob(jobId, options); }
  async function advanceJobWriteBoundary(jobId, writeBoundary, options = {}) {
    const hash = optionalText(options.payloadHash);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new LinkOpsValidationError('payloadHash must be a lowercase SHA-256 hash');
    }
    return updateLeasedJob(jobId, {...options, writeBoundary, payloadHash: hash});
  }

  async function finishJob(jobId, {
    status,
    leaseOwner,
    expectedRevision,
    result = {},
    error = {},
    actorUser = '',
  } = {}) {
    const finalStatus = requiredText(status, 'status');
    if (!['succeeded', 'failed', 'uncertain_write'].includes(finalStatus)) {
      throw new LinkOpsValidationError(
        'finishJob status must be succeeded, failed, or uncertain_write'
      );
    }
    if (!plainObject(result) || !plainObject(error)) {
      throw new LinkOpsValidationError('job result and error must be JSON objects');
    }
    return updateLeasedJob(jobId, {
      leaseOwner,
      expectedRevision,
      finish: {
        status: finalStatus,
        result,
        error,
        actorUser: optionalText(actorUser) || leaseOwner,
      },
    });
  }

  async function appendEvent(event) {
    return mutate('runtime', store => {
      runtimeState(store);
      const before = store._repository.events.length;
      const row = appendLocalEvent(store, event);
      return clone(store._repository.events.length === before
        ? store._repository.events.find(item => item.eventKey === row.eventKey)
        : row);
    });
  }

  async function listEvents({
    aggregateType = '',
    aggregateId = '',
    taskId = '',
    jobId = '',
    afterEventId = 0,
    limit = 1000,
  } = {}) {
    const after = integer(afterEventId, {fallback: 0, min: 0, label: 'afterEventId'});
    const max = integer(limit, {fallback: 1000, min: 1, max: 100000, label: 'limit'});
    const store = runtimeState(await read('runtime'));
    return store._repository.events
      .map((row, index) => ({...clone(row), eventId: String(row.eventId || index + 1), _index: index + 1}))
      .filter(row => row._index > after
        && (!aggregateType || row.aggregateType === aggregateType)
        && (!aggregateId || row.aggregateId === aggregateId)
        && (!taskId || row.taskId === taskId)
        && (!jobId || row.jobId === jobId))
      .slice(0, max)
      .map(({_index, ...row}) => row);
  }

  async function applyMigrationSql(migrationSql, {
    version = LINK_OPS_MIGRATION_VERSION,
    migrationHash = linkOpsPayloadHash(String(migrationSql || '')),
  } = {}) {
    requiredText(migrationSql, 'migrationSql');
    const v = requiredText(version, 'version');
    if (!/^[0-9a-f]{64}$/.test(migrationHash)) {
      throw new LinkOpsValidationError('migrationHash must be a lowercase SHA-256 hash');
    }
    return mutate('runtime', store => {
      runtimeState(store);
      const row = {
        version: v,
        migrationHash,
        appliedAt: nowIso(),
        appliedBy: 'json',
        details: {},
      };
      const i = store.migrations.findIndex(item => item.version === v);
      if (i >= 0) store.migrations[i] = row;
      else store.migrations.push(row);
      return clone(row);
    });
  }

  async function getMigration(version = LINK_OPS_MIGRATION_VERSION) {
    const store = runtimeState(await read('runtime'));
    return clone(store.migrations.find(row => row.version === requiredText(version, 'version')) || null);
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
    const hash = optionalText(manifestHash);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new LinkOpsValidationError('manifestHash must be a lowercase SHA-256 hash');
    }
    if (!plainObject(manifest) || !plainObject(counts)) {
      throw new LinkOpsValidationError('manifest and counts must be JSON objects');
    }
    return mutate('runtime', store => {
      runtimeState(store);
      const prior = store.importBatches.find(row => row.batchId === id || row.idempotencyKey === idem);
      if (prior) {
        if (prior.manifestHash !== hash || prior.idempotencyKey !== idem) {
          throw new LinkOpsImportConflictError('import_batch', id, hash, prior.manifestHash);
        }
        return {...clone(prior), skipped: true};
      }
      const row = {
        batchId: id,
        idempotencyKey: idem,
        migrationVersion: version,
        sourceKind: requiredText(sourceKind, 'sourceKind'),
        status: 'running',
        actorUser: optionalText(actorUser),
        manifestHash: hash,
        manifest: clone(manifest),
        counts: clone(counts),
        error: {},
        startedAt: nowIso(),
        finishedAt: null,
      };
      store.importBatches.push(row);
      return {...clone(row), skipped: false};
    });
  }

  async function finishImportBatch(batchId, {status, counts = {}, error = {}} = {}) {
    const id = requiredText(batchId, 'batchId');
    const finalStatus = requiredText(status, 'status');
    if (!['succeeded', 'failed'].includes(finalStatus)) {
      throw new LinkOpsValidationError('Import batch final status must be succeeded or failed');
    }
    if (!plainObject(counts) || !plainObject(error)) {
      throw new LinkOpsValidationError('counts and error must be JSON objects');
    }
    return mutate('runtime', store => {
      runtimeState(store);
      const row = store.importBatches.find(item => item.batchId === id
        && ['prepared', 'running'].includes(item.status));
      if (!row) throw new LinkOpsNotFoundError('import_batch', id);
      row.status = finalStatus;
      row.counts = clone(counts);
      row.error = clone(error);
      row.finishedAt = nowIso();
      return clone(row);
    });
  }

  async function getStoredHashes(entityType, ids, {recordType = ''} = {}) {
    const type = requiredText(entityType, 'entityType');
    if (!Array.isArray(ids)) throw new LinkOpsValidationError('ids must be an array');
    const values = [...new Set(ids.map((id, index) => requiredText(id, `ids[${index}]`)))];
    const snapshot = await exportSnapshot();
    const map = new Map();
    const entries = type === 'task'
      ? snapshot.taskStore.tasks
      : type === 'session'
        ? snapshot.sessionStore.sessions
        : type === 'message'
          ? snapshot.sessionStore.sessions.flatMap(session => session.messages || [])
          : type === 'meta'
            ? Object.entries(snapshot.runtime.meta).map(([id, record]) => ({...record, id}))
            : type === 'record'
              ? Object.entries((await read('runtime')).records[requiredText(recordType, 'recordType')] || {})
                .map(([id, record]) => ({...record, id}))
              : null;
    if (!entries) {
      throw new LinkOpsValidationError(`Unsupported import entity type: ${type}`);
    }
    for (const item of entries) {
      const id = optionalText(item.id || item.taskId || item.sessionId || item.messageId);
      if (values.includes(id)) map.set(id, publicRecord(item).repositoryPayloadHash);
    }
    return map;
  }

  async function importMeta(metaKey, record, options = {}) {
    const stored = await putMeta(metaKey, record, {...options, importMode: true});
    return {
      record: stored,
      skipped: Boolean(stored.importSkipped),
      payloadHash: stored.repositoryPayloadHash,
    };
  }

  async function importTask(task, options = {}) {
    const clean = cleanRecord(task);
    const id = requiredText(clean.id || clean.taskId, 'task.id');
    const hash = linkOpsPayloadHash(clean);
    const current = await getTask(id);
    if (current) {
      if (current.repositoryPayloadHash !== hash) {
        throw new LinkOpsImportConflictError('task', id, hash, current.repositoryPayloadHash);
      }
      return {record: current, skipped: true, payloadHash: hash};
    }
    const record = await createTask(clean, {
      ownerUser: options.ownerUser,
      actorUser: options.actorUser,
    });
    return {record, skipped: false, payloadHash: hash};
  }

  async function importSession(session, options = {}) {
    const clean = cleanRecord(session);
    delete clean.messages;
    const id = requiredText(clean.id || clean.sessionId, 'session.id');
    const hash = linkOpsPayloadHash(clean);
    const current = await getSession(id, {includeMessages: false});
    if (current) {
      if (current.repositoryPayloadHash !== hash) {
        throw new LinkOpsImportConflictError('session', id, hash, current.repositoryPayloadHash);
      }
      return {record: current, skipped: true, payloadHash: hash};
    }
    const record = await createSession(clean, {
      ownerUser: options.ownerUser,
      actorUser: options.actorUser,
    });
    return {record, skipped: false, payloadHash: hash};
  }

  async function importMessage(chatSessionId, message, options = {}) {
    const clean = cleanRecord(message);
    const id = requiredText(clean.id || clean.messageId, 'message.id');
    const hash = linkOpsPayloadHash(clean);
    const messages = await listMessages(chatSessionId);
    const current = messages.find(row => optionalText(row.id || row.messageId) === id);
    if (current) {
      if (current.repositoryPayloadHash !== hash) {
        throw new LinkOpsImportConflictError('message', id, hash, current.repositoryPayloadHash);
      }
      return {record: current, skipped: true, payloadHash: hash};
    }
    const record = await appendMessage(chatSessionId, clean, {
      ownerUser: options.ownerUser,
      actorUser: options.actorUser,
      sequenceNo: options.sequenceNo,
    });
    return {record, skipped: false, payloadHash: hash};
  }

  async function importRecord(recordType, recordId, record, options = {}) {
    const hash = linkOpsPayloadHash(cleanRecord(record));
    const current = await getRecord(recordType, recordId);
    if (current) {
      if (current.repositoryPayloadHash !== hash) {
        throw new LinkOpsImportConflictError(recordType, recordId, hash, current.repositoryPayloadHash);
      }
      return {record: current, skipped: true, payloadHash: hash};
    }
    const stored = await putRecord(recordType, recordId, record, {
      ...options,
      importBatchId: requiredText(options.batchId, 'batchId'),
    });
    return {record: stored, skipped: false, payloadHash: hash};
  }

  async function exportSnapshot() {
    const [taskStore, sessionStore, actionState, runtime] = await Promise.all([
      getTaskStore({limit: 10000}),
      getSessionStore({limit: 3000, includeMessages: true}),
      getActionState(),
      read('runtime'),
    ]);
    const state = runtimeState(runtime);
    return {
      taskStore: {
        ...taskStore,
        tasks: taskStore.tasks.map(cleanRecord),
      },
      sessionStore: {
        ...sessionStore,
        sessions: sessionStore.sessions.map(session => ({
          ...cleanRecord(session),
          messages: (session.messages || []).map(cleanRecord),
        })),
      },
      actionState: {
        ...actionState,
        actions: Object.fromEntries(
          Object.entries(actionState.actions).map(([key, value]) => [key, cleanRecord(value)])
        ),
      },
      runtime: {
        version: Number(state.version || 1) || 1,
        exportedAt: nowIso(),
        jobs: state.jobs.map(cleanRecord),
        events: clone(state._repository.events),
        migrations: clone(state.migrations),
        importBatches: clone(state.importBatches),
        meta: Object.fromEntries(
          Object.entries(state.meta).map(([key, value]) => [key, cleanRecord(value)])
        ),
      },
    };
  }

  return Object.freeze({
    mode: 'json',
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
    flushLegacyActionState,
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
