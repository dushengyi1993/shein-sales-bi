#!/usr/bin/env node
/**
 * Adversarial replay for the BI automation chat state machine.
 *
 * This is not a 505 feature test. It replays the class of bad historical chat
 * that previously leaked Feishu/V1/read-only/task-pool wording and polluted
 * target/source inference. The invariant is generic: assistant prose is display
 * only; executable facts come from user messages plus structured task/session
 * state, then every response returned to the browser is projected as plain
 * user-facing progress.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-bad-transcript-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FORBIDDEN = /飞书|只读建议|只读问答|当前飞书|回到\s*BI|V1|SHEIN_OPENAPI_SUBMIT|dry[- ]?run|payload\s*hash|payloadHash|查看审计|验证器|任务池|固定确认码|store identity mismatch|account_and_merchant_mismatch|请到\s*BI\s*自动化运营页|不能在这里直接提交 SHEIN/i;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(relPath, value) {
  const file = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

async function req(baseUrl, urlPath, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body !== undefined ? {'content-type': 'application/json'} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function includesStore(value, store) {
  return asArray(value).map(x => String(x).toUpperCase()).includes(store);
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

function latestAssistantContent(session) {
  const messages = asArray(session?.messages);
  return [...messages].reverse().find(m => m?.role === 'assistant')?.content || '';
}

async function readTasks(taskFile) {
  return JSON.parse(await fs.readFile(taskFile, 'utf8'));
}

async function rawTaskById(taskFile, id) {
  const data = await readTasks(taskFile);
  return asArray(data.tasks).find(t => String(t?.id || '') === String(id || '')) || null;
}

async function seedBadAssistantMessage(chatFile, sessionId) {
  const data = JSON.parse(await fs.readFile(chatFile, 'utf8'));
  data.sessions = asArray(data.sessions).map(session => {
    if (String(session?.id || '') !== String(sessionId || '')) return session;
    return {
      ...session,
      messages: [
        ...asArray(session.messages),
        {
          id: `bad_assistant_${Date.now()}`,
          role: 'assistant',
          at: new Date().toISOString(),
          content: [
            '收到，“干吧”我理解为确认继续补链，但当前飞书聊天是只读建议通道。',
            '请回到 BI 自动化运营页创建任务，在任务池里点预检，输入 SHEIN_OPENAPI_SUBMIT 后查看审计。',
            'payload hash 已锁定；若出现 store identity mismatch / account_and_merchant_mismatch，请人工核销。',
            '我选中的源链接是 QY 店 sv25082869650540305，但目标还是 DL。',
          ].join('\n'),
        },
      ],
    };
  });
  await fs.writeFile(chatFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function forceCopyTaskEligible(taskFile, taskId) {
  const data = await readTasks(taskFile);
  data.tasks = asArray(data.tasks).map(task => {
    if (String(task?.id || '') !== String(taskId || '')) return task;
    return {
      ...task,
      status: 'waiting_review',
      progress: 85,
      intents: ['copy_product_draft'],
      targets: {
        ...(task.targets || {}),
        stores: ['DL'],
        writeStores: ['DL'],
        sourceStores: ['QY'],
        productRefs: ['505', 'SM-505A电动缝纫机'],
      },
      execution: {
        ...(task.execution || {}),
        state: 'openapi_product_preflight_ready',
        preflight: {ok: true, blockers: [], warnings: []},
        openApiProductExecutors: [{
          storeKey: 'DL',
          mode: 'dry-run',
          ok: true,
          payload: {
            payloadHash: `bad-transcript-${taskId}`,
            inferredSource: {sourceStore: 'QY', sourceSkc: 'sv25082869650540305'},
          },
        }],
      },
    };
  });
  await fs.writeFile(taskFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const result = {ok: false, tmpRoot, checks: [], summary: {}};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_bad_transcript',
    password: 'owner-pass',
    displayName: 'Owner Bad Transcript',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_BAD_TRANSCRIPT',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
  users: {},
});
const openapiConfigFile = await writeJson('openapi.json', {stores: [], safeWriteOperations: {enabled: false, requireDryRun: true, allowedOperations: [], allowedStores: []}});
const whitelistFile = await writeJson('whitelist.json', {enabled: false, rules: []});
const portalDir = path.join(tmpRoot, 'portal');
await fs.mkdir(path.join(portalDir, 'sections'), {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Bad Transcript Smoke</title>', 'utf8');
await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({generatedAt: new Date().toISOString(), data: {}}, null, 2), 'utf8');
await fs.writeFile(path.join(portalDir, 'sections', 'linksData.json'), JSON.stringify({
  data: {
    storeLinks: [
      {store_key: 'QY', skc: 'sv25082869650540305', spu: 'spu-qy-505', standard_goods_sn: 'SM-505A电动缝纫机', product_display_name: 'SM-505A电动缝纫机', is_on_shelf: true, shelf_status_name: '已上架', c30_sale_cnt: 70, c7_sale_cnt: 5, goods_uv: 3412, exposure_cnt: 76216},
      {store_key: 'DL', skc: 'sv-dl-existing-505', spu: 'spu-dl-505', standard_goods_sn: 'SM-505A电动缝纫机', product_display_name: 'SM-505A电动缝纫机', is_on_shelf: true, shelf_status_name: '已上架', c30_sale_cnt: 12, c7_sale_cnt: 2, goods_uv: 500},
      {store_key: 'DX', skc: 'sv-dx-sk1234', spu: 'spu-dx-sk1234', standard_goods_sn: 'SK-1234', product_display_name: 'SK-1234测试品', is_on_shelf: true, shelf_status_name: '已上架', c30_sale_cnt: 3, c7_sale_cnt: 1, goods_uv: 100},
    ],
  },
}, null, 2), 'utf8');

const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1',
  '--port', String(port),
  '--dir', portalDir,
  '--auth-file', authFile,
  '--access-roles-file', accessRolesFile,
  '--htpasswd-file', htpasswdFile,
  '--session-secret-file', sessionSecretFile,
  '--state-file', stateFile,
  '--link-ops-task-file', taskFile,
  '--link-ops-chat-file', chatFile,
  '--manual-login-state-file', manualLoginStateFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', data => { stdout += data.toString(); });
child.stderr.on('data', data => { stderr += data.toString(); });

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`portal exited code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`portal not ready\nstdout=${stdout}\nstderr=${stderr}`);
}

try {
  await waitReady();
  const login = await req(baseUrl, '/api/login', {method: 'POST', body: {username: 'owner_bad_transcript', password: 'owner-pass'}});
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const initial = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: '帮我给dl的505缝纫机再补一条链接。直接复制所有店铺里流量最高的那条链接。', askAgent: false},
  });
  const initialTask = initial.json?.autoTask || {};
  const sessionId = initial.json?.session?.id || '';
  result.summary.initial = {status: initial.status, taskId: initialTask.id || '', sessionId};
  check('initial action status', initial.status, 200);
  check('initial creates task', Boolean(initialTask.id), true);
  check('initial target DL only', initialTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('initial write DL only', initialTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));

  await seedBadAssistantMessage(chatFile, sessionId);
  const supplement = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId, message: '标题直接复制QY那条链接的呀。然后电流是1200mA', askAgent: true},
  });
  const supplementTask = supplement.json?.autoTask || {};
  const supplementAnswer = latestAssistantContent(supplement.json?.session);
  const currentOverride = asArray(supplementTask?.targets?.attributeOverrides).find(row => Number(row?.attribute_id) === 1002323);
  const rawAfterSupplement = await rawTaskById(taskFile, supplementTask.id || initialTask.id);
  result.summary.supplement = {
    status: supplement.status,
    answer: supplementAnswer,
    intents: supplementTask.intents || [],
    targets: supplementTask.targets || {},
    rawCommand: rawAfterSupplement?.command || '',
  };
  check('supplement status', supplement.status, 200);
  check('supplement keeps existing task', supplementTask.id || '', initialTask.id || '');
  check('supplement copy intent remains', supplementTask.intents, xs => asArray(xs).includes('copy_product_draft'));
  check('supplement not update-title', supplementTask.intents, xs => !asArray(xs).includes('update_title'));
  check('supplement target DL only', supplementTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('supplement write DL only', supplementTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('supplement source can be QY only', supplementTask?.targets?.sourceStores, xs => includesStore(xs, 'QY'));
  check('supplement input current saved', currentOverride?.attribute_extra_value || '', '1200');
  check('supplement browser answer no legacy leak', supplementAnswer, x => !FORBIDDEN.test(String(x)));
  check('supplement raw command no legacy assistant text', rawAfterSupplement?.command || '', x => !FORBIDDEN.test(String(x)));
  check('projected session no legacy leak', stringify(supplement.json?.session), x => !FORBIDDEN.test(String(x)));

  await seedBadAssistantMessage(chatFile, sessionId);
  await forceCopyTaskEligible(taskFile, supplementTask.id || initialTask.id);
  const confirm = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId, message: '干啊。', askAgent: true},
  });
  const confirmAnswer = latestAssistantContent(confirm.json?.session);
  const rawAfterConfirm = await rawTaskById(taskFile, supplementTask.id || initialTask.id);
  result.summary.confirm = {
    status: confirm.status,
    answer: confirmAnswer,
    taskStatus: rawAfterConfirm?.status || '',
    taskState: rawAfterConfirm?.execution?.state || '',
  };
  check('confirm status', confirm.status, 200);
  check('confirm handled in chat', confirmAnswer, x => /收到|我按你这句|我先不提交|还差|资料/.test(String(x)));
  check('confirm answer no legacy leak', confirmAnswer, x => !FORBIDDEN.test(String(x)));
  check('confirm projected session no legacy leak', stringify(confirm.json?.session), x => !FORBIDDEN.test(String(x)));
  check('confirm raw task still DL target', rawAfterConfirm?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('confirm raw task still DL write', rawAfterConfirm?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('confirm raw task keeps QY as source only', rawAfterConfirm?.targets?.sourceStores, xs => includesStore(xs, 'QY'));
  check('confirm raw task does not learn legacy assistant text', stringify(rawAfterConfirm), x => !/当前飞书聊天是只读建议通道|请回到 BI 自动化运营页|store identity mismatch/.test(String(x)));

  const maintenance = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: '把DX的SK-1234库存改成111', askAgent: true},
  });
  const maintenanceTask = maintenance.json?.autoTask || {};
  const maintenanceAnswer = latestAssistantContent(maintenance.json?.session);
  result.summary.maintenance = {status: maintenance.status, intents: maintenanceTask.intents || [], targets: maintenanceTask.targets || {}, answer: maintenanceAnswer};
  check('non-505 maintenance status', maintenance.status, 200);
  check('non-505 maintenance creates task', Boolean(maintenanceTask.id), true);
  check('non-505 maintenance inventory intent', maintenanceTask.intents, xs => asArray(xs).includes('update_inventory'));
  check('non-505 maintenance target DX only', maintenanceTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DX'));
  check('non-505 maintenance write DX only', maintenanceTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DX'));
  check('non-505 maintenance product ref is clean', maintenanceTask?.targets?.productRefs, xs => asArray(xs).includes('SK-1234') && !asArray(xs).some(x => /库存|改成|111/.test(String(x))));
  check('non-505 maintenance answer no legacy leak', maintenanceAnswer, x => !FORBIDDEN.test(String(x)));

  result.ok = result.checks.every(row => row.pass);
} finally {
  child.kill('SIGTERM');
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
