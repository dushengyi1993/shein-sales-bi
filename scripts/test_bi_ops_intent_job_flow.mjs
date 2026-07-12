#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-intent-job-flow-'));
const portalDir = path.join(temp, 'portal');
const authFile = path.join(temp, 'users.json');
const roleFile = path.join(temp, 'roles.json');
const htpasswdFile = path.join(temp, 'htpasswd');
const stateFile = path.join(temp, 'actions.json');
const taskFile = path.join(temp, 'tasks.json');
const chatFile = path.join(temp, 'chats.json');
const runtimeFile = path.join(temp, 'runtime.json');
const sessionSecretFile = path.join(temp, 'session-secret');
const auditFile = path.join(temp, 'audit.jsonl');
const fakeCodexJs = path.join(temp, 'fake-codex.mjs');
const fakeCodexBin = process.execPath;

function validPlan() {
  return {
    version: 1,
    requestType: 'action',
    intents: ['update_inventory'],
    stores: ['DL'],
    sourceStores: [],
    productRefs: [],
    parameters: {
      timeRange: '', dateFrom: '', dateTo: '', metrics: [], groupBy: '', comparison: '', rankDirection: '',
      limit: null, title: '', inventory: 88, supplyPrice: null, productPrice: null, currency: '',
      discountRate: null, discountPrice: null, quantity: null, activityId: '', startAt: '', endAt: '',
      sourceScope: '', standardGoodsSn: '', attributeOverrides: [], imageInstruction: '', actionNote: '',
    },
    ambiguity: {hasAmbiguity: false, reasons: [], clarifyingQuestions: []},
    risk: {level: 'medium', writeRequested: true, requiresHumanConfirmation: true, reasons: ['库存修改需人工确认。']},
    confidence: 0.97,
    summary: '把 DL 的 505 库存改为 88；只完成结构化规划，不直接提交。',
  };
}

function downgradedMissingLinkPlan() {
  const plan = validPlan();
  return {
    ...plan,
    requestType: 'query',
    intents: ['copy_product_draft'],
    stores: ['TZ'],
    productRefs: ['SM-505A'],
    parameters: {
      ...plan.parameters,
      inventory: null,
      sourceScope: 'all_stores',
      standardGoodsSn: 'SM-505A',
    },
    ambiguity: {
      hasAmbiguity: true,
      reasons: ['模型误把“先说明”理解成只读查询。'],
      clarifyingQuestions: ['请提供来源店铺或来源链接标识。'],
    },
    risk: {level: 'none', writeRequested: false, requiresHumanConfirmation: false, reasons: []},
    confidence: 0.62,
    summary: '这是一次只读核查，需要用户另行提供来源链接。',
  };
}

function pollutingActionPlan() {
  const plan = validPlan();
  return {
    ...plan,
    intents: ['update_inventory', 'update_product_price'],
    stores: ['DL', 'TZ'],
    productRefs: ['SKU-BASE', 'INJECTED-SKU'],
    parameters: {
      ...plan.parameters,
      inventory: 999,
      productPrice: 0.01,
      standardGoodsSn: 'INJECTED-SKU',
    },
    risk: {level: 'high', writeRequested: true, requiresHumanConfirmation: true, reasons: ['模型尝试扩大动作和店铺。']},
    confidence: 0.99,
    summary: '把 DL/TZ 的 SKU-BASE 和 INJECTED-SKU 库存、售价一起修改。',
  };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

await fs.mkdir(portalDir, {recursive: true});
await Promise.all([
  fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>intent job test</title>', 'utf8'),
  writeJson(authFile, {users: [
    {username: 'alice', password: 'alice-pass', role: 'operator', ownerKey: 'ALICE', readStores: ['DL', 'TZ'], writeStores: ['DL', 'TZ']},
    {username: 'bob', password: 'bob-pass', role: 'operator', ownerKey: 'BOB', readStores: ['DL'], writeStores: ['DL']},
  ]}),
  writeJson(roleFile, {defaults: {operator: {readStores: [], writeStores: []}}, users: {}}),
  fs.writeFile(htpasswdFile, '', 'utf8'),
  writeJson(stateFile, {version: 1, updatedAt: null, actions: {}}),
  writeJson(taskFile, {version: 1, updatedAt: null, tasks: []}),
  writeJson(chatFile, {version: 1, updatedAt: null, sessions: []}),
  writeJson(runtimeFile, {version: 1, updatedAt: null, jobs: [], records: {}, importBatches: [], migrations: [], meta: {}}),
]);

await fs.writeFile(fakeCodexJs, `
import fs from 'node:fs/promises';
const args=process.argv.slice(2);
const output=args[args.indexOf('--output-last-message')+1];
let prompt='';
for await (const chunk of process.stdin) prompt+=chunk.toString('utf8');
if(prompt.includes('STALE-1')) await new Promise(resolve=>setTimeout(resolve,800));
const result=prompt.includes('缺上架链接')
  ? ${JSON.stringify(JSON.stringify(downgradedMissingLinkPlan()))}
  : prompt.includes('POLLUTE-1')
    ? ${JSON.stringify(JSON.stringify(pollutingActionPlan()))}
    : ${JSON.stringify(JSON.stringify(validPlan()))};
await fs.writeFile(output, result, 'utf8');
`, 'utf8');

const port = await freePort();
const child = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1', '--port', String(port), '--dir', portalDir,
  '--auth-file', authFile, '--access-roles-file', roleFile, '--htpasswd-file', htpasswdFile,
  '--session-secret-file', sessionSecretFile, '--state-file', stateFile,
  '--link-ops-task-file', taskFile, '--link-ops-chat-file', chatFile, '--link-ops-runtime-file', runtimeFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '1',
    SHEIN_BI_JOB_WORKER_ENABLED: '1',
    SHEIN_BI_JOB_POLL_MS: '100',
    SHEIN_BI_JOB_LEASE_MS: '60000',
    SHEIN_OPENAPI_CONFIG_FILE: path.join(temp, 'missing-openapi.json'),
    SHEIN_BI_CODEX_BIN: fakeCodexBin,
    SHEIN_BI_CODEX_ARGS_PREFIX_JSON: JSON.stringify([fakeCodexJs]),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
const base = `http://127.0.0.1:${port}`;

async function waitReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`portal exited ${child.exitCode}\n${stdout}\n${stderr}`);
    try {
      const response = await fetch(`${base}/login`);
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`portal did not start\n${stdout}\n${stderr}`);
}

async function login(username, password) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username, password}),
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function api(pathname, {cookie, method = 'GET', body} = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {'Content-Type': 'application/json', ...(cookie ? {Cookie: cookie} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return {status: response.status, json};
}

async function waitForJob(jobId, cookie) {
  let job = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await api(`/api/link-ops-jobs/${encodeURIComponent(jobId)}`, {cookie});
    assert.equal(response.status, 200, JSON.stringify(response.json));
    job = response.json.data;
    if (['succeeded', 'failed', 'uncertain_write'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return job;
}

try {
  await waitReady();
  const alice = await login('alice', 'alice-pass');
  const bob = await login('bob', 'bob-pass');
  const chat = await api('/api/link-ops-chats', {
    cookie: alice,
    method: 'POST',
    body: {message: '把 DL 的 505 库存改成 88', askAgent: false},
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.json));
  assert.ok(chat.json.autoTask?.id);
  const enqueueAudit = await fs.readFile(auditFile, 'utf8').catch(() => '');
  assert.ok(chat.json.job?.id, JSON.stringify({chat: chat.json, enqueueAudit, stdout, stderr}, null, 2));
  assert.equal(chat.json.job.status, 'queued');
  const jobId = chat.json.job.id;

  const denied = await api(`/api/link-ops-jobs/${encodeURIComponent(jobId)}`, {cookie: bob});
  assert.equal(denied.status, 403);

  const job = await waitForJob(jobId, alice);
  assert.equal(job?.status, 'succeeded', JSON.stringify({job, stdout, stderr}));
  assert.equal(job.result.requestType, 'action');
  assert.equal(job.result.applied, true);
  assert.equal(job.result.advisoryOnly, true);
  assert.equal(job.result.chatFeedbackSuppressed, true);

  const tasks = await api(`/api/link-ops-tasks?sessionId=${encodeURIComponent(chat.json.session.id)}&limit=20`, {cookie: alice});
  assert.equal(tasks.status, 200);
  const task = tasks.json.data.tasks.find(row => row.id === chat.json.autoTask.id);
  assert.equal(task.planning.requestType, 'action');
  assert.equal(task.planning.advisory, true);
  assert.equal(task.planning.factsApplied, false);
  assert.equal(task.planning.modelProfile.model, 'gpt-5.6-terra');
  assert.ok(task.intents.includes('update_inventory'));
  assert.ok(task.targets.writeStores.includes('DL'));
  assert.notEqual(task.execution?.state, 'executed');

  const chats = await api('/api/link-ops-chats?limit=20', {cookie: alice});
  const session = chats.json.data.sessions.find(row => row.id === chat.json.session.id);
  assert.ok(!session.messages.some(message => message.meta?.intentPlanJobId === jobId));

  const missingLinkMessage = '请处理 TZ · 天舟的 SM-505A电动缝纫机：TZ 缺上架链接：SM-505A电动缝纫机。先说明将影响哪些店铺和链接、当前缺口与下一步。';
  const missingLinkChat = await api('/api/link-ops-chats', {
    cookie: alice,
    method: 'POST',
    body: {message: missingLinkMessage, askAgent: false},
  });
  assert.equal(missingLinkChat.status, 200, JSON.stringify(missingLinkChat.json));
  assert.ok(missingLinkChat.json.autoTask?.id);
  assert.ok(missingLinkChat.json.job?.id);
  const downgradeJobId = missingLinkChat.json.job.id;
  const downgradeJob = await waitForJob(downgradeJobId, alice);
  assert.equal(downgradeJob?.status, 'succeeded', JSON.stringify({downgradeJob, stdout, stderr}));
  assert.equal(downgradeJob.result.requestType, 'query');
  assert.equal(downgradeJob.result.plannerDowngradeIgnored, true);
  assert.equal(downgradeJob.result.chatFeedbackSuppressed, true);

  const missingLinkTasks = await api(`/api/link-ops-tasks?sessionId=${encodeURIComponent(missingLinkChat.json.session.id)}&limit=20`, {cookie: alice});
  const missingLinkTask = missingLinkTasks.json.data.tasks.find(row => row.id === missingLinkChat.json.autoTask.id);
  assert.ok(missingLinkTask.intents.includes('copy_product_draft'));
  assert.deepEqual(missingLinkTask.targets.writeStores, ['TZ']);
  assert.equal(missingLinkTask.targets.sourceScope, 'all_stores');
  assert.equal(missingLinkTask.planning.requestType, 'action');
  assert.equal(missingLinkTask.planning.ignored, true);
  assert.equal(missingLinkTask.planning.ignoredReason, 'existing_action_cannot_be_downgraded_to_query');
  assert.equal(missingLinkTask.planning.ignoredRequestType, 'query');
  assert.equal(missingLinkTask.execution?.writeAudit?.actualWriteSubmitted, false);

  const missingLinkChats = await api('/api/link-ops-chats?limit=20', {cookie: alice});
  const missingLinkSession = missingLinkChats.json.data.sessions.find(row => row.id === missingLinkChat.json.session.id);
  assert.ok(!missingLinkSession.messages.some(message => message.meta?.intentPlanJobId === downgradeJobId));
  assert.ok(!missingLinkSession.messages.some(message => /请提供来源店铺|只读核查/.test(String(message.content || ''))));

  const pollutingChat = await api('/api/link-ops-chats', {
    cookie: alice,
    method: 'POST',
    body: {message: '把 DL 的 SKU-BASE 库存改成 12，POLLUTE-1', askAgent: false},
  });
  assert.equal(pollutingChat.status, 200, JSON.stringify(pollutingChat.json));
  const pollutingJobId = pollutingChat.json.job?.id;
  assert.ok(pollutingJobId);
  const pollutingBefore = structuredClone(pollutingChat.json.autoTask);
  const pollutingJob = await waitForJob(pollutingJobId, alice);
  assert.equal(pollutingJob?.status, 'succeeded', JSON.stringify({pollutingJob, stdout, stderr}));
  assert.equal(pollutingJob.result.plannerFactsIgnored, true);
  assert.equal(pollutingJob.result.advisoryOnly, true);
  assert.equal(pollutingJob.result.chatFeedbackSuppressed, true);
  const pollutingTasks = await api(`/api/link-ops-tasks?sessionId=${encodeURIComponent(pollutingChat.json.session.id)}&limit=20`, {cookie: alice});
  const pollutingTask = pollutingTasks.json.data.tasks.find(row => row.id === pollutingChat.json.autoTask.id);
  assert.deepEqual(pollutingTask.intents, pollutingBefore.intents);
  assert.deepEqual(pollutingTask.targets, pollutingBefore.targets);
  assert.deepEqual(pollutingTask.execution, pollutingBefore.execution);
  assert.equal(pollutingTask.planning.ignored, true);
  assert.equal(pollutingTask.planning.ignoredReason, 'existing_action_facts_are_authoritative');
  assert.equal(pollutingTask.execution?.writeAudit?.actualWriteSubmitted, false);
  const pollutingChats = await api('/api/link-ops-chats?limit=20', {cookie: alice});
  const pollutingSession = pollutingChats.json.data.sessions.find(row => row.id === pollutingChat.json.session.id);
  assert.ok(!pollutingSession.messages.some(message => message.meta?.intentPlanJobId === pollutingJobId));

  const staleChat = await api('/api/link-ops-chats', {
    cookie: alice,
    method: 'POST',
    body: {message: '把 DL 的 SKU-STALE 库存改成 10，STALE-1', askAgent: false},
  });
  assert.equal(staleChat.status, 200, JSON.stringify(staleChat.json));
  const staleJobId = staleChat.json.job?.id;
  assert.ok(staleJobId);
  const staleUpdate = await api('/api/link-ops-chats', {
    cookie: alice,
    method: 'POST',
    body: {sessionId: staleChat.json.session.id, message: '把 DL 的 SKU-STALE 库存改成 20，继续处理。', askAgent: false},
  });
  assert.equal(staleUpdate.status, 200, JSON.stringify(staleUpdate.json));
  const staleJob = await waitForJob(staleJobId, alice);
  assert.equal(staleJob?.status, 'succeeded', JSON.stringify({staleJob, stdout, stderr}));
  assert.equal(staleJob.result.applied, false);
  assert.equal(staleJob.result.staleIgnored, true);
  assert.equal(staleJob.result.chatFeedbackSuppressed, true);
  const staleChats = await api('/api/link-ops-chats?limit=20', {cookie: alice});
  const staleSession = staleChats.json.data.sessions.find(row => row.id === staleChat.json.session.id);
  assert.ok(!staleSession.messages.some(message => message.meta?.intentPlanJobId === staleJobId));

  console.log('bi_ops_intent_job_flow: queued planning, ownership, advisory-only model guard, stale-job guard, chat suppression, and no authorization bypass passed');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await fs.rm(temp, {recursive: true, force: true});
}
