#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'link-ops-gateway-'));
const repository = createLinkOpsJsonRepository({rootDir: temp});
const gateway = createLinkOpsStoreGateway({repository});
const owner = 'partner-a';
const now = new Date().toISOString();

try {
  let chats = await gateway.replaceChatStore({
    version: 1,
    updatedAt: now,
    memoryPolicy: {maxMessages: 40},
    sessions: [{
      id: 'session-a',
      ownerUser: owner,
      requestedByUser: owner,
      status: 'chatting',
      title: '第一条会话',
      createdAt: now,
      updatedAt: now,
      messages: [{id: 'message-a', role: 'user', content: '查询今天销售', at: now}],
    }],
  }, {actorUser: owner});
  assert.equal(chats.sessions.length, 1);
  assert.equal(chats.sessions[0].messages.length, 1);

  const sessionRevision = chats.sessions[0].repositoryRevision;
  chats = await gateway.replaceChatStore({
    ...chats,
    updatedAt: new Date(Date.now() + 1_000).toISOString(),
    sessions: [{
      ...chats.sessions[0],
      title: '销售追踪',
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
      messages: [
        ...chats.sessions[0].messages,
        {id: 'message-b', role: 'assistant', content: '已查询', at: new Date(Date.now() + 1_000).toISOString()},
      ],
    }],
  }, {actorUser: owner});
  assert.equal(chats.sessions[0].title, '销售追踪');
  assert.equal(chats.sessions[0].messages.length, 2);
  assert.ok(chats.sessions[0].repositoryRevision > sessionRevision);

  await assert.rejects(
    gateway.replaceChatStore({
      ...chats,
      sessions: [{
        ...chats.sessions[0],
        messages: chats.sessions[0].messages.map(message => message.id === 'message-a'
          ? {...message, content: '被篡改'}
          : message),
      }],
    }, {actorUser: owner}),
    error => error?.code === 'LINK_OPS_GATEWAY_CONFLICT'
  );

  let tasks = await gateway.replaceTaskStore({
    version: 1,
    updatedAt: now,
    tasks: [{
      id: 'task-a',
      ownerUser: owner,
      requestedByUser: owner,
      status: 'draft',
      chatSessionId: 'session-a',
      command: '维护链接',
      targets: {sourceStores: ['DL'], writeStores: ['DL'], productRefs: ['SKU-A']},
      createdAt: now,
      updatedAt: now,
    }],
  }, {actorUser: owner});
  assert.equal(tasks.tasks.length, 1);
  const taskRevision = tasks.tasks[0].repositoryRevision;

  tasks = await gateway.replaceTaskStore({
    ...tasks,
    updatedAt: new Date(Date.now() + 2_000).toISOString(),
    tasks: [{...tasks.tasks[0], status: 'confirmed', updatedAt: new Date(Date.now() + 2_000).toISOString()}],
  }, {actorUser: owner});
  assert.equal(tasks.tasks[0].status, 'confirmed');
  assert.ok(tasks.tasks[0].repositoryRevision > taskRevision);

  let actionState = await gateway.replaceActionState({
    version: 1,
    updatedAt: now,
    actions: {'DL|inventory|SKU-A': {status: 'review', note: '待确认', updatedByUser: owner, updatedAt: now}},
  }, {actorUser: owner});
  assert.equal(actionState.actions['DL|inventory|SKU-A'].status, 'review');

  actionState = await gateway.replaceActionState({version: 1, updatedAt: now, actions: {}}, {actorUser: owner});
  assert.deepEqual(Object.keys(actionState.actions), []);

  tasks = await gateway.replaceTaskStore({version: 1, updatedAt: now, tasks: []}, {actorUser: owner});
  chats = await gateway.replaceChatStore({version: 1, updatedAt: now, sessions: []}, {actorUser: owner});
  assert.equal(tasks.tasks.length, 0);
  assert.equal(chats.sessions.length, 0);

  const health = await gateway.health();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'json');
  console.log('link_ops_store_gateway: row-level snapshot diff, append-only chat, revisions, actions, and deletes passed');
} finally {
  await gateway.close();
  await fs.rm(temp, {recursive: true, force: true});
}
