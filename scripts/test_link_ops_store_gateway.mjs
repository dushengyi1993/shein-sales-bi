#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {
  LinkOpsRevisionConflictError,
  createLinkOpsPostgresRepository,
  linkOpsPayloadHash,
} from '../lib/link_ops_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const owner = 'partner-concurrency';
const now = '2026-08-18T00:00:00.000Z';
const later = '2026-08-18T00:01:00.000Z';

function task(id, extra = {}) {
  return {
    id,
    ownerUser: owner,
    requestedByUser: owner,
    status: 'draft',
    command: '维护链接',
    targets: {sourceStores: ['DL'], writeStores: ['DL'], productRefs: [id]},
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function message(id, content, role = 'user') {
  return {id, role, content, at: now};
}

function session(id, messages = [], extra = {}) {
  return {
    id,
    ownerUser: owner,
    requestedByUser: owner,
    status: 'chatting',
    title: id,
    createdAt: now,
    updatedAt: now,
    messages,
    ...extra,
  };
}

function action(status, note = '') {
  return {ownerUser: owner, updatedByUser: owner, status, note, updatedAt: now};
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-gateway-contract-'));
const repository = createLinkOpsJsonRepository({rootDir: root});
const gateway = createLinkOpsStoreGateway({repository});

try {
  // Two callers read the same task snapshot, then independently create
  // different tasks. Neither stale omission may delete the other's task.
  const initialTasks = await gateway.replaceTaskStore({version: 1, updatedAt: now, tasks: [task('task-base')]}, {actorUser: owner});
  const staleTaskSnapshotA = structuredClone(initialTasks);
  const staleTaskSnapshotB = structuredClone(initialTasks);
  await gateway.replaceTaskStore({
    ...staleTaskSnapshotA,
    tasks: [...staleTaskSnapshotA.tasks, task('task-a')],
  }, {actorUser: owner});
  let tasks = await gateway.replaceTaskStore({
    ...staleTaskSnapshotB,
    tasks: [...staleTaskSnapshotB.tasks, task('task-b')],
  }, {actorUser: owner});
  assert.deepEqual(tasks.tasks.map(row => row.id).sort(), ['task-a', 'task-b', 'task-base']);

  // Compatibility omissions are no-ops, never deletes.
  await gateway.replaceTaskStore({...tasks, tasks: [tasks.tasks.find(row => row.id === 'task-base')]}, {actorUser: owner});
  tasks = await gateway.readTaskStore();
  assert.deepEqual(tasks.tasks.map(row => row.id).sort(), ['task-a', 'task-b', 'task-base']);

  // Explicit update/delete enforce the caller's revision.
  const baseBeforeUpdate = tasks.tasks.find(row => row.id === 'task-base');
  const updatedBase = await gateway.updateTaskRecord('task-base', {
    ...baseBeforeUpdate,
    status: 'confirmed',
    updatedAt: later,
  }, {expectedRevision: baseBeforeUpdate.repositoryRevision, actorUser: owner});
  await assert.rejects(
    gateway.updateTaskRecord('task-base', {...updatedBase, status: 'blocked'}, {
      expectedRevision: baseBeforeUpdate.repositoryRevision,
      actorUser: owner,
    }),
    error => error?.code === 'LINK_OPS_REVISION_CONFLICT'
  );
  await assert.rejects(
    gateway.deleteTaskRecord('task-base', {
      expectedRevision: baseBeforeUpdate.repositoryRevision,
      actorUser: owner,
    }),
    error => error?.code === 'LINK_OPS_REVISION_CONFLICT'
  );

  // A compatibility snapshot containing two entity mutations is rejected
  // before either write lands.
  const beforeMultiTask = await gateway.readTaskStore();
  const multiTaskNext = structuredClone(beforeMultiTask);
  multiTaskNext.tasks = multiTaskNext.tasks.map(row =>
    row.id === 'task-a' || row.id === 'task-b' ? {...row, status: 'confirmed'} : row
  );
  await assert.rejects(
    gateway.replaceTaskStore(multiTaskNext, {actorUser: owner}),
    error => error?.code === 'LINK_OPS_GATEWAY_CONFLICT' && error?.details?.changeCount === 2
  );
  const afterMultiTask = await gateway.readTaskStore();
  assert.equal(afterMultiTask.tasks.find(row => row.id === 'task-a').status, 'draft');
  assert.equal(afterMultiTask.tasks.find(row => row.id === 'task-b').status, 'draft');

  // Chat create and initial messages are one repository mutation.
  let chats = await gateway.replaceChatStore({
    version: 1,
    updatedAt: now,
    sessions: [session('session-main', [message('message-base', 'base')])],
  }, {actorUser: owner});
  assert.equal(chats.sessions[0].messages.length, 1);

  // Two concurrent appends from one revision cannot overwrite one another.
  // One wins, one receives a revision conflict, then a fresh CAS retry merges
  // the rejected message. The original and both appended messages survive.
  const concurrentBase = structuredClone(chats.sessions[0]);
  const desiredA = {...concurrentBase, messages: [...concurrentBase.messages, message('message-a', 'A', 'assistant')]};
  const desiredB = {...concurrentBase, messages: [...concurrentBase.messages, message('message-b', 'B', 'assistant')]};
  const concurrent = await Promise.allSettled([
    gateway.updateChatSessionRecord('session-main', desiredA, {
      expectedRevision: concurrentBase.repositoryRevision,
      actorUser: owner,
    }),
    gateway.updateChatSessionRecord('session-main', desiredB, {
      expectedRevision: concurrentBase.repositoryRevision,
      actorUser: owner,
    }),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'LINK_OPS_REVISION_CONFLICT');
  chats = await gateway.readChatStore();
  let mainSession = chats.sessions.find(row => row.id === 'session-main');
  assert.equal(mainSession.messages[0].id, 'message-base');
  const missingConcurrentMessage = mainSession.messages.some(row => row.id === 'message-a')
    ? message('message-b', 'B', 'assistant')
    : message('message-a', 'A', 'assistant');
  mainSession = await gateway.updateChatSessionRecord('session-main', {
    ...mainSession,
    messages: [...mainSession.messages, missingConcurrentMessage],
  }, {expectedRevision: mainSession.repositoryRevision, actorUser: owner});
  assert.equal(mainSession.messages[0].id, 'message-base');
  assert.deepEqual(new Set(mainSession.messages.map(row => row.id)), new Set(['message-base', 'message-a', 'message-b']));

  // Existing messages cannot be edited, removed, or reordered.
  const beforeAppendOnlyFailures = structuredClone(mainSession);
  await assert.rejects(
    gateway.updateChatSessionRecord('session-main', {
      ...mainSession,
      messages: mainSession.messages.map(row => row.id === 'message-base' ? {...row, content: 'edited'} : row),
    }, {expectedRevision: mainSession.repositoryRevision, actorUser: owner}),
    error => error?.code === 'LINK_OPS_APPEND_ONLY_CONFLICT'
  );
  await assert.rejects(
    gateway.updateChatSessionRecord('session-main', {
      ...mainSession,
      messages: mainSession.messages.slice(1),
    }, {expectedRevision: mainSession.repositoryRevision, actorUser: owner}),
    error => error?.code === 'LINK_OPS_APPEND_ONLY_CONFLICT'
  );
  mainSession = (await gateway.readChatStore()).sessions.find(row => row.id === 'session-main');
  assert.deepEqual(mainSession.messages, beforeAppendOnlyFailures.messages);
  assert.equal(mainSession.repositoryRevision, beforeAppendOnlyFailures.repositoryRevision);

  // JSON atomic rollback: the first new message is staged in memory, the
  // second conflicts with an ID owned by another session, and mutate() writes
  // no file. Session fields, revision, and the first message all roll back.
  await gateway.createChatSessionRecord(session('session-collision', [message('message-collision', 'other')] ), {actorUser: owner});
  const beforeAtomicFailure = (await gateway.readChatStore()).sessions.find(row => row.id === 'session-main');
  await assert.rejects(
    gateway.updateChatSessionRecord('session-main', {
      ...beforeAtomicFailure,
      title: 'must-roll-back',
      messages: [
        ...beforeAtomicFailure.messages,
        message('message-safe-first', 'first'),
        message('message-collision', 'conflict'),
      ],
    }, {expectedRevision: beforeAtomicFailure.repositoryRevision, actorUser: owner}),
    error => error?.code === 'LINK_OPS_ALREADY_EXISTS' && error?.details?.entityType === 'message'
  );
  const afterAtomicFailure = (await gateway.readChatStore()).sessions.find(row => row.id === 'session-main');
  assert.equal(afterAtomicFailure.title, beforeAtomicFailure.title);
  assert.equal(afterAtomicFailure.repositoryRevision, beforeAtomicFailure.repositoryRevision);
  assert.equal(afterAtomicFailure.messages.some(row => row.id === 'message-safe-first'), false);

  // Session omissions do not delete. Two new sessions in one compatibility
  // snapshot are rejected before either create.
  const chatBeforeMulti = await gateway.readChatStore();
  await gateway.replaceChatStore({...chatBeforeMulti, sessions: [afterAtomicFailure]}, {actorUser: owner});
  assert.equal((await gateway.readChatStore()).sessions.some(row => row.id === 'session-collision'), true);
  await assert.rejects(
    gateway.replaceChatStore({
      version: 1,
      updatedAt: now,
      sessions: [...chatBeforeMulti.sessions, session('session-new-a'), session('session-new-b')],
    }, {actorUser: owner}),
    error => error?.code === 'LINK_OPS_GATEWAY_CONFLICT' && error?.details?.changeCount === 2
  );
  const chatAfterMulti = await gateway.readChatStore();
  assert.equal(chatAfterMulti.sessions.some(row => row.id === 'session-new-a'), false);
  assert.equal(chatAfterMulti.sessions.some(row => row.id === 'session-new-b'), false);

  // Action batches are all-or-nothing. One stale key prevents every change;
  // explicit delete succeeds and snapshot omission preserves unrelated keys.
  let actions = await gateway.applyActionChanges([
    {key: 'action-a', expectedRevision: null, record: action('ready', 'A')},
    {key: 'action-b', expectedRevision: null, record: action('ready', 'B')},
  ], {actorUser: owner});
  const actionA = actions.actions['action-a'];
  const actionB = actions.actions['action-b'];
  await assert.rejects(
    gateway.applyActionChanges([
      {key: 'action-a', expectedRevision: actionA.repositoryRevision, record: action('done', 'A2')},
      {key: 'action-b', expectedRevision: actionB.repositoryRevision + 1, record: action('done', 'B2')},
    ], {actorUser: owner}),
    error => error?.code === 'LINK_OPS_REVISION_CONFLICT' && error?.details?.entityId === 'action-b'
  );
  actions = await gateway.readActionState();
  assert.equal(actions.actions['action-a'].status, 'ready');
  assert.equal(actions.actions['action-b'].status, 'ready');
  actions = await gateway.applyActionChanges([
    {key: 'action-a', delete: true, expectedRevision: actionA.repositoryRevision},
  ], {actorUser: owner});
  assert.equal(actions.actions['action-a'], undefined);
  assert.equal(actions.actions['action-b'].status, 'ready');
  actions = await gateway.applyActionChanges([
    {key: 'action-c', expectedRevision: null, record: action('ready', 'C')},
  ], {actorUser: owner});
  await gateway.replaceActionState({version: 1, updatedAt: now, actions: {'action-b': actions.actions['action-b']}}, {actorUser: owner});
  actions = await gateway.readActionState();
  assert.equal(actions.actions['action-c'].status, 'ready');
  await assert.rejects(
    gateway.replaceActionState({
      version: 1,
      updatedAt: later,
      actions: {
        'action-b': {...actions.actions['action-b'], status: 'done'},
        'action-c': {...actions.actions['action-c'], status: 'done'},
      },
    }, {actorUser: owner}),
    error => error?.code === 'LINK_OPS_GATEWAY_CONFLICT' && error?.details?.changeCount === 2
  );
  actions = await gateway.readActionState();
  assert.equal(actions.actions['action-b'].status, 'ready');
  assert.equal(actions.actions['action-c'].status, 'ready');

  const health = await gateway.health();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'json');
} finally {
  await gateway.close();
  await fs.rm(root, {recursive: true, force: true});
}

// A derived metadata envelope can lose every bounded CAS retry after an entity
// commit. The explicit entity API must still resolve with authoritative data.
{
  const metaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-meta-race-'));
  const base = createLinkOpsJsonRepository({rootDir: metaRoot});
  const originalPutMeta = base.putMeta.bind(base);
  let attempts = 0;
  const wrapped = Object.fromEntries(Object.keys(base).map(key => [key, base[key]]));
  wrapped.putMeta = async (key, record, options = {}) => {
    attempts += 1;
    const current = await base.getMeta(key, null);
    await originalPutMeta(key, {version: 900 + attempts, updatedAt: `competitor-${attempts}`}, {
      expectedRevision: current?.repositoryRevision ?? null,
      actorUser: owner,
    });
    return originalPutMeta(key, record, options);
  };
  const metaGateway = createLinkOpsStoreGateway({repository: wrapped});
  try {
    const created = await metaGateway.createTaskRecord(task('meta-survives'), {
      actorUser: owner,
      envelope: {version: 2, updatedAt: later, tasks: []},
    });
    assert.equal(created.id, 'meta-survives');
    assert.equal(attempts, 3);
    assert.equal((await metaGateway.readTaskStore()).tasks[0].id, 'meta-survives');
  } finally {
    await metaGateway.close();
    await fs.rm(metaRoot, {recursive: true, force: true});
  }
}

function pgSessionRow(record, revisionValue) {
  return {
    session_id: record.id,
    owner_user: owner,
    actor_user: owner,
    status: record.status,
    title: record.title,
    sort_order: 0,
    record: JSON.stringify(record),
    revision: revisionValue,
    payload_hash: linkOpsPayloadHash(record),
    created_at: new Date(now),
    updated_at: new Date(now),
    deleted_at: null,
  };
}

function pgMessageRow(record, sequenceNo = 0) {
  return {
    message_id: record.id,
    chat_session_id: 'pg-session',
    owner_user: owner,
    actor_user: owner,
    role: record.role,
    status: 'created',
    sequence_no: sequenceNo,
    record: JSON.stringify(record),
    revision: 1,
    payload_hash: linkOpsPayloadHash(record),
    created_at: new Date(now),
    updated_at: new Date(now),
  };
}

function pgEventRow() {
  return {
    event_id: 1,
    event_key: null,
    aggregate_type: 'test',
    aggregate_id: 'test',
    event_type: 'test',
    owner_user: owner,
    actor_user: owner,
    status: '',
    chat_session_id: null,
    task_id: null,
    job_id: null,
    payload: {},
    payload_hash: linkOpsPayloadHash({}),
    created_at: new Date(now),
  };
}

// PostgreSQL deterministic transaction contract: failure on the second message
// insert rolls back the session update and first insert; COMMIT is impossible.
{
  const trace = [];
  let messageInsertCount = 0;
  const current = session('pg-session', []);
  const client = {
    async query(query) {
      const name = typeof query === 'string' ? query : query.name;
      trace.push(name);
      if (typeof query === 'string') return {rows: [], rowCount: 0};
      if (name === 'link-ops-read-idempotency') return {rows: [], rowCount: 0};
      if (name === 'link-ops-lock-session-with-messages') return {rows: [pgSessionRow(current, 1)], rowCount: 1};
      if (name === 'link-ops-list-locked-session-messages') return {rows: [], rowCount: 0};
      if (name === 'link-ops-update-session-with-messages') return {rows: [pgSessionRow(current, 2)], rowCount: 1};
      if (name === 'link-ops-append-event') return {rows: [pgEventRow()], rowCount: 1};
      if (name === 'link-ops-batch-append-message') {
        messageInsertCount += 1;
        if (messageInsertCount === 2) {
          const error = new Error('forced second message conflict');
          error.code = '23505';
          throw error;
        }
        return {rows: [pgMessageRow(message('pg-message-1', 'first'))], rowCount: 1};
      }
      throw new Error(`Unexpected PostgreSQL query: ${name}`);
    },
  };
  const pg = createLinkOpsPostgresRepository({client});
  await assert.rejects(
    pg.updateSessionWithMessages('pg-session', {
      ...current,
      messages: [message('pg-message-1', 'first'), message('pg-message-2', 'second')],
    }, {expectedRevision: 1, actorUser: owner}),
    error => error?.code === '23505'
  );
  assert.equal(messageInsertCount, 2);
  assert.equal(trace.at(-1), 'ROLLBACK');
  assert.equal(trace.includes('COMMIT'), false);
}

// PostgreSQL action batch validates all locked revisions before its first
// mutation and rolls back the transaction on one stale key.
{
  const trace = [];
  const row = (key, revisionValue) => ({
    record_type: 'action_state',
    record_id: key,
    owner_user: owner,
    actor_user: owner,
    status: 'ready',
    chat_session_id: null,
    record: JSON.stringify(action('ready', key)),
    revision: revisionValue,
    payload_hash: linkOpsPayloadHash(action('ready', key)),
    created_at: new Date(now),
    updated_at: new Date(now),
    deleted_at: null,
  });
  const client = {
    async query(query) {
      const name = typeof query === 'string' ? query : query.name;
      trace.push(name);
      if (typeof query === 'string') return {rows: [], rowCount: 0};
      if (name === 'link-ops-read-idempotency') return {rows: [], rowCount: 0};
      if (name === 'link-ops-lock-action-batch') return {rows: [row('pg-action-a', 1), row('pg-action-b', 2)], rowCount: 2};
      throw new Error(`Unexpected PostgreSQL query: ${name}`);
    },
  };
  const pg = createLinkOpsPostgresRepository({client});
  await assert.rejects(
    pg.applyActionChanges([
      {key: 'pg-action-a', expectedRevision: 1, record: action('done', 'A')},
      {key: 'pg-action-b', expectedRevision: 1, record: action('done', 'B')},
    ], {actorUser: owner}),
    LinkOpsRevisionConflictError
  );
  assert.equal(trace.at(-1), 'ROLLBACK');
  assert.equal(trace.some(name => String(name).includes('action-batch-record')), false);
}

console.log('link_ops_store_gateway: explicit CAS, append-only chat, atomic action batches, and transaction rollback passed');
