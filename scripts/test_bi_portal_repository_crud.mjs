#!/usr/bin/env node
import assert from 'node:assert/strict';
import {__testHooks} from './serve_bi_portal.mjs';

const {
  linkOpsRepositoryHttpDetails,
  createLinkOpsTaskRecord,
  updateLinkOpsTaskRecord,
  deleteLinkOpsTaskRecord,
  createLinkOpsChatRecord,
  updateLinkOpsChatRecord,
  deleteLinkOpsChatThenCleanup,
  buildLinkOpsActionChanges,
  applyLinkOpsActionChanges,
  settleLinkOpsPostCommit,
} = __testHooks;

function repositoryError(code, message) {
  return Object.assign(new Error(message), {code, status: code === 'LINK_OPS_REVISION_CONFLICT' ? 409 : 400});
}

function persisted(record, revision, extra = {}) {
  return {
    ...record,
    repositoryRevision: revision,
    repositoryPayloadHash: `payload-${record.id || record.key}-${revision}`,
    repositoryMetadata: {mode: 'fake', revision},
    ...extra,
  };
}

function createFakeGateway() {
  const tasks = new Map();
  const sessions = new Map();
  const actions = new Map();
  const calls = [];
  const assertRevision = (row, expected, label) => {
    if (!row || Number(row.repositoryRevision) !== Number(expected)) {
      throw repositoryError('LINK_OPS_REVISION_CONFLICT', `${label} stale revision`);
    }
  };
  return {
    calls,
    tasks,
    sessions,
    actions,
    async createTaskRecord(task) {
      calls.push(['task-create', task.id]);
      if (tasks.has(task.id)) throw repositoryError('LINK_OPS_REVISION_CONFLICT', 'task exists');
      const row = persisted(task, 1);
      tasks.set(task.id, row);
      return row;
    },
    async updateTaskRecord(id, task, {expectedRevision}) {
      calls.push(['task-update', id, expectedRevision]);
      const current = tasks.get(id);
      assertRevision(current, expectedRevision, 'task');
      const row = persisted(task, current.repositoryRevision + 1);
      tasks.set(id, row);
      return row;
    },
    async deleteTaskRecord(id, {expectedRevision}) {
      calls.push(['task-delete', id, expectedRevision]);
      const current = tasks.get(id);
      assertRevision(current, expectedRevision, 'task');
      const row = persisted(current, current.repositoryRevision + 1, {repositoryDeleted: true});
      tasks.delete(id);
      return row;
    },
    async createChatSessionRecord(session) {
      calls.push(['chat-create', session.id]);
      if (sessions.has(session.id)) throw repositoryError('LINK_OPS_REVISION_CONFLICT', 'chat exists');
      const row = persisted(session, 1);
      sessions.set(session.id, row);
      return row;
    },
    async updateChatSessionRecord(id, session, {expectedRevision}) {
      calls.push(['chat-update', id, expectedRevision]);
      const current = sessions.get(id);
      assertRevision(current, expectedRevision, 'chat');
      const row = persisted(session, current.repositoryRevision + 1);
      sessions.set(id, row);
      return row;
    },
    async deleteChatSessionRecord(id, {expectedRevision}) {
      calls.push(['chat-delete-commit', id, expectedRevision]);
      const current = sessions.get(id);
      assertRevision(current, expectedRevision, 'chat');
      const row = persisted(current, current.repositoryRevision + 1, {repositoryDeleted: true});
      sessions.delete(id);
      return row;
    },
    async applyActionChanges(changes) {
      calls.push(['action-batch', changes.map(change => change.key)]);
      const seen = new Set();
      for (const change of changes) {
        if (seen.has(change.key)) throw repositoryError('LINK_OPS_VALIDATION', `Duplicate action key: ${change.key}`);
        seen.add(change.key);
        const current = actions.get(change.key);
        if (change.delete) assertRevision(current, change.expectedRevision, `action ${change.key}`);
        else if (change.expectedRevision === null) {
          if (current) throw repositoryError('LINK_OPS_REVISION_CONFLICT', `action ${change.key} exists`);
        } else assertRevision(current, change.expectedRevision, `action ${change.key}`);
      }
      for (const change of changes) {
        if (change.delete) actions.delete(change.key);
        else {
          const revision = (actions.get(change.key)?.repositoryRevision || 0) + 1;
          actions.set(change.key, persisted({...change.record, id: change.key, key: change.key}, revision));
        }
      }
      return {version: 1, actions: Object.fromEntries(actions)};
    },
  };
}

async function main() {
  const gateway = createFakeGateway();
  const args = {linkOpsStoreGateway: gateway};

  const createdTask = await createLinkOpsTaskRecord(args, {id: 'task-1', status: 'draft'}, 'tester');
  assert.equal(createdTask.repositoryRevision, 1);
  assert.equal(createdTask.repositoryMetadata.mode, 'fake');
  const updatedTask = await updateLinkOpsTaskRecord(args, createdTask, {...createdTask, status: 'confirmed'}, 'tester');
  assert.equal(updatedTask.repositoryRevision, 2);
  assert.equal(updatedTask.status, 'confirmed');
  await assert.rejects(
    updateLinkOpsTaskRecord(args, createdTask, {...createdTask, status: 'stale'}, 'tester'),
    error => error.code === 'LINK_OPS_REVISION_CONFLICT' && linkOpsRepositoryHttpDetails(error)?.status === 409,
  );
  const deletedTask = await deleteLinkOpsTaskRecord(args, updatedTask, 'tester');
  assert.equal(deletedTask.repositoryDeleted, true);
  assert.equal(gateway.tasks.has('task-1'), false);

  const createdChat = await createLinkOpsChatRecord(args, {id: 'chat-1', messages: []}, 'tester');
  const updatedChat = await updateLinkOpsChatRecord(args, createdChat, {
    ...createdChat,
    messages: [{id: 'message-1', role: 'user', content: 'hello'}],
  }, 'tester');
  assert.equal(updatedChat.repositoryRevision, 2);
  assert.equal(updatedChat.repositoryMetadata.mode, 'fake');
  const ordering = [];
  const originalDelete = gateway.deleteChatSessionRecord.bind(gateway);
  gateway.deleteChatSessionRecord = async (...input) => {
    const result = await originalDelete(...input);
    ordering.push('repository-commit');
    return result;
  };
  const chatDeletion = await deleteLinkOpsChatThenCleanup(args, updatedChat, {
    actorUser: 'tester',
    cleanup: async () => ordering.push('codex-file-cleanup'),
  });
  assert.deepEqual(ordering, ['repository-commit', 'codex-file-cleanup']);
  assert.equal(chatDeletion.persisted.repositoryDeleted, true);

  const chatForConflict = await createLinkOpsChatRecord(args, {id: 'chat-stale', messages: []}, 'tester');
  const chatAfterConflictWinner = await updateLinkOpsChatRecord(args, chatForConflict, {...chatForConflict, title: 'winner'}, 'tester');
  let cleanupCalled = false;
  await assert.rejects(
    deleteLinkOpsChatThenCleanup(args, chatForConflict, {cleanup: async () => { cleanupCalled = true; }}),
    error => error.code === 'LINK_OPS_REVISION_CONFLICT',
  );
  assert.equal(cleanupCalled, false, 'Codex files must remain untouched before repository delete commits');
  assert.equal(gateway.sessions.get('chat-stale').repositoryRevision, chatAfterConflictWinner.repositoryRevision);

  const actionCreates = buildLinkOpsActionChanges({actions: {}}, [
    {key: 'DL:item-1', status: 'done', owner: 'A'},
    {key: 'JSH:item-2', status: 'review', note: 'check'},
  ], {updatedAt: '2026-08-18T00:00:00.000Z', updatedBy: 'Tester', updatedByUser: 'tester'});
  const actionState = await applyLinkOpsActionChanges(args, actionCreates, 'tester');
  assert.deepEqual(Object.keys(actionState.actions).sort(), ['DL:item-1', 'JSH:item-2']);
  assert.equal(gateway.calls.filter(call => call[0] === 'action-batch').length, 1, 'multi-key action change must be one atomic call');
  assert.throws(
    () => buildLinkOpsActionChanges(actionState, [
      {key: 'DL:item-1', status: 'done'},
      {key: 'DL:item-1', status: 'review'},
    ]),
    error => error.code === 'LINK_OPS_VALIDATION' && linkOpsRepositoryHttpDetails(error)?.status === 400,
  );
  const actionDeletes = buildLinkOpsActionChanges(actionState, [{key: 'DL:item-1', status: 'open', owner: '', note: ''}]);
  assert.deepEqual(actionDeletes, [{key: 'DL:item-1', delete: true, expectedRevision: 1}]);
  const afterDelete = await applyLinkOpsActionChanges(args, actionDeletes, 'tester');
  assert.equal(Object.hasOwn(afterDelete.actions, 'DL:item-1'), false);

  const postCommitTask = await createLinkOpsTaskRecord(args, {id: 'task-post-commit', status: 'draft'}, 'tester');
  const updateCallsBefore = gateway.calls.filter(call => call[0] === 'task-update').length;
  const persistedPostCommitTask = await updateLinkOpsTaskRecord(args, postCommitTask, {...postCommitTask, status: 'confirmed'}, 'tester');
  const settled = await settleLinkOpsPostCommit(persistedPostCommitTask, [async () => {
    throw Object.assign(new Error('audit unavailable'), {code: 'AUDIT_DOWN'});
  }]);
  assert.equal(settled.committed, true);
  assert.equal(settled.postCommitPending, true);
  assert.equal(settled.persisted.repositoryRevision, 2);
  assert.equal(settled.persisted.repositoryMetadata.mode, 'fake');
  assert.equal(gateway.calls.filter(call => call[0] === 'task-update').length, updateCallsBefore + 1, 'post-commit failure must not retry the write');

  console.log(JSON.stringify({
    ok: true,
    taskCrud: true,
    chatCrudAndDeleteOrdering: true,
    actionAtomicAndDuplicate400: true,
    staleRevision409: true,
    postCommitNoRetry: true,
    persistedRevisionAndMetadata: true,
  }));
}

await main();
