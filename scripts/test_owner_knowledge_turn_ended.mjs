#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-turn-ended-'));
try {
  const payload = {
    type: 'agent-turn-complete',
    'thread-id': 'thread-1',
    'turn-id': 'turn-1',
    cwd: root,
    client: 'test',
    'input-messages': ['以后所有巡检任务完成后，都要在 Codex 任务和飞书群同时提交结论与附件。'],
    'last-assistant-message': '已完成。',
  };
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'owner_knowledge_turn_ended.mjs'), 'notify', JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {...process.env, CODEX_HOME: temp, SHEIN_OWNER_KNOWLEDGE_PROJECT_ROOT: root, SHEIN_OWNER_KNOWLEDGE_DISABLE_AUTO_PROCESS: '1'},
  });
  assert.equal(result.status, 0, result.stderr);
  const pending = path.join(temp, 'owner-knowledge', 'completion-spool', 'pending', 'thread-1__turn-1.json');
  const first = JSON.parse(await fs.readFile(pending, 'utf8'));
  assert.equal(first.threadId, 'thread-1');
  assert.match(first.inputMessages[0], /同时提交结论与附件/);
  const replay = spawnSync(process.execPath, [path.join(root, 'scripts', 'owner_knowledge_turn_ended.mjs'), 'notify', JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {...process.env, CODEX_HOME: temp, SHEIN_OWNER_KNOWLEDGE_PROJECT_ROOT: root, SHEIN_OWNER_KNOWLEDGE_DISABLE_AUTO_PROCESS: '1'},
  });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal((await fs.readdir(path.dirname(pending))).length, 1, 'thread and turn identity is idempotent');
  console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_turn_ended'}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
