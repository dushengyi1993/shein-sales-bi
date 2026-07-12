import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectOwnerKnowledgeEvents, redactOwnerKnowledgeSensitiveText} from '../lib/owner_knowledge_local_collector.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-collector-'));
const codexHome = path.join(temp, '.codex');
const projectRoot = path.join(temp, 'Shein销售统计');
const notesDir = path.join(codexHome, 'memories', 'extensions', 'ad_hoc', 'notes');
const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '12');
await fs.mkdir(notesDir, {recursive: true});
await fs.mkdir(sessionsDir, {recursive: true});

try {
  await fs.writeFile(path.join(notesDir, 'rule.md'), [
    '# 规则',
    '',
    `- cwd: \`${projectRoot}\``,
    '',
    '## 记忆',
    '',
    '- 默认先做资料检查，再允许真实提交。',
    '- password=super-secret 不得同步凭证。',
  ].join('\n'));

  const sessionFile = path.join(sessionsDir, 'rollout-test.jsonl');
  const rows = [
    {type: 'turn_context', payload: {cwd: projectRoot}},
    {type: 'event_msg', payload: {type: 'user_message', message: '以后同事的操作不能反向覆盖我的负责人规则。'}},
    {type: 'event_msg', payload: {type: 'agent_message', phase: 'final_answer', message: '本次失败的根因是字段校验缺失，后续应补测试。'}},
    {type: 'turn_context', payload: {cwd: path.join(temp, 'OtherProject')}},
    {type: 'event_msg', payload: {type: 'user_message', message: '以后这个其他项目也默认同步。'}},
  ];
  await fs.writeFile(sessionFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

  const first = await collectOwnerKnowledgeEvents({codexHome, projectRoot, state: {}});
  assert.equal(first.events.some(event => /先做资料检查/.test(event.text) && event.activation === 'active'), true);
  assert.equal(first.events.some(event => /不能反向覆盖/.test(event.text) && event.activation === 'active'), true);
  assert.equal(first.events.some(event => /字段校验缺失/.test(event.text) && event.activation === 'candidate'), true);
  assert.equal(first.events.some(event => /其他项目/.test(event.text)), false);
  assert.equal(first.events.some(event => /super-secret/.test(event.text)), false, 'secrets are redacted before upload');
  assert.equal(first.events.some(event => /\[REDACTED\]/.test(event.text)), true);

  const second = await collectOwnerKnowledgeEvents({codexHome, projectRoot, state: first.nextState});
  assert.equal(second.events.length, 0, 'unchanged memory and session offsets are idempotent');

  await fs.appendFile(sessionFile, [
    JSON.stringify({type: 'turn_context', payload: {cwd: projectRoot}}),
    JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: '以后商品发布必须保留审计和回读。'}}),
  ].join('\n') + '\n');
  const third = await collectOwnerKnowledgeEvents({codexHome, projectRoot, state: second.nextState});
  assert.equal(third.events.length, 1);
  assert.match(third.events[0].text, /审计和回读/);
  assert.equal(third.events[0].activation, 'active');

  const redactedAuthorization = redactOwnerKnowledgeSensitiveText('Authorization=Bearer abcdefghijklmnop');
  assert.equal(redactedAuthorization.includes('abcdefghijklmnop'), false);
  assert.match(redactedAuthorization, /\[REDACTED\]/);
  console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_local_collector', first: first.summary, third: third.summary}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
