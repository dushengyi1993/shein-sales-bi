#!/usr/bin/env node
/**
 * Isolated smoke for the BI automation chat command parser.
 *
 * The user-facing workflow is one chat input:
 * - read-only questions should answer in chat;
 * - explicit write actions should create a current-session task;
 * - copy/fill-link commands must infer source/target/product context instead of
 *   immediately claiming that an OpenAPI payload is missing.
 *
 * This test starts a local temporary portal, logs in with a temporary owner
 * account, sends copy/maintenance-like chat commands, and checks only
 * service-side inference. It never calls SHEIN or an external LLM. It also
 * covers the real browser path where the frontend sends askAgent=true; explicit
 * write actions must still bypass the old read-only advice branch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-chat-inference-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(name, value) {
  const file = path.join(tmpRoot, name);
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

async function req(baseUrl, urlPath, {method = 'GET', cookie = '', body = null} = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(cookie ? {cookie} : {}),
      ...(body ? {'content-type': 'application/json'} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function includesStore(xs, store) {
  return asArray(xs).map(x => String(x).toUpperCase()).includes(store);
}

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_chat_inference',
    password: 'owner-chat-pass',
    displayName: 'Owner Chat Inference',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
  users: {},
});
const openapiConfigFile = await writeJson('openapi.json', {stores: {}});
const whitelistFile = await writeJson('whitelist.json', {enabled: false, rules: []});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1',
  '--port', String(port),
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
child.stdout.on('data', d => { stdout += d.toString(); });
child.stderr.on('data', d => { stderr += d.toString(); });

const result = {ok: false, tmpRoot, baseUrl, checks: [], summary: {}};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited code=${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server not ready\nstdout=${stdout}\nstderr=${stderr}`);
}

try {
  await waitReady();
  const login = await req(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_chat_inference', password: 'owner-chat-pass'},
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const command = '帮我把DL的505缝纫机再补一个链接，直接复制DL现有的曝光最高的那条链接';
  const chat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: command, askAgent: false},
  });
  const autoTask = chat.json?.autoTask || {};
  const targets = autoTask.targets || {};
  result.summary = {
    chatStatus: chat.status,
    taskId: autoTask.id || '',
    taskStatus: autoTask.status || '',
    intents: autoTask.intents || [],
    targets,
    sessionId: chat.json?.session?.id || '',
    autoTaskMessageId: asArray(chat.json?.session?.messages).find(m => m?.role === 'assistant')?.meta?.autoTaskId || '',
  };

  check('chat status', chat.status, 200);
  check('auto task created', Boolean(autoTask.id), true);
  check('auto task status confirmed', autoTask.status, 'confirmed');
  check('auto task is current-session task', autoTask.chatSessionId, chat.json?.session?.id || '');
  check('copy intent inferred', asArray(autoTask.intents), xs => xs.includes('copy_product_draft'));
  check('target store inferred', targets.stores, xs => includesStore(xs, 'DL'));
  check('write store inferred', targets.writeStores, xs => includesStore(xs, 'DL'));
  check('same-store source inferred', targets.sourceStores, xs => includesStore(xs, 'DL'));
  check('numeric product ref inferred', targets.productRefs, xs => asArray(xs).some(x => /^505\b/i.test(String(x))));
  check('assistant message points to auto task', result.summary.autoTaskMessageId, autoTask.id);

  const missingListingCommand = '请处理 TZ · 天舟的 SM-505A电动缝纫机：TZ 缺上架链接：SM-505A电动缝纫机。先说明将影响哪些店铺和链接、当前缺口与下一步。';
  const missingListingChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: missingListingCommand, askAgent: true},
  });
  const missingListingTask = missingListingChat.json?.autoTask || {};
  result.summary.missingListingTask = {
    id: missingListingTask.id || '',
    intents: missingListingTask.intents || [],
    targets: missingListingTask.targets || {},
  };
  check('missing-on-shelf-link browser command status', missingListingChat.status, 200);
  check('missing-on-shelf-link creates controlled task', Boolean(missingListingTask.id), true);
  check('missing-on-shelf-link infers copy intent', missingListingTask.intents, xs => asArray(xs).includes('copy_product_draft'));
  check('missing-on-shelf-link target is TZ only', missingListingTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'TZ'));
  check('missing-on-shelf-link does not use empty TZ as source', missingListingTask?.targets?.sourceStores, xs => asArray(xs).length === 0);
  check('missing-on-shelf-link searches all stores for source', missingListingTask?.targets?.sourceScope, 'all_stores');
  check('missing-on-shelf-link keeps SM-505A product ref', missingListingTask?.targets?.productRefs, xs => asArray(xs).some(x => /SM-505A/i.test(String(x))));

  const scopedSourceCommand = '帮我给dl的505缝纫机再补一条链接。直接复制所有店铺里流量最高的那条链接。';
  const scopedChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: scopedSourceCommand, askAgent: false},
  });
  const scopedTask = scopedChat.json?.autoTask || {};
  const scopedTargets = scopedTask.targets || {};
  result.summary.scopedSourceTaskId = scopedTask.id || '';
  result.summary.scopedSourceTargets = scopedTargets;
  check('all-store source command status', scopedChat.status, 200);
  check('all-store source task created', Boolean(scopedTask.id), true);
  check('all-store source command target remains DL only', scopedTargets.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('all-store source command write remains DL only', scopedTargets.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('all-store source command records all-store source scope', scopedTargets.sourceScope, 'all_stores');
  check('all-store source command does not expand sourceStores to 19 stores', scopedTargets.sourceStores, xs => asArray(xs).length === 0);

  const chatDataBeforeOverride = JSON.parse(await fs.readFile(chatFile, 'utf8'));
  chatDataBeforeOverride.sessions = asArray(chatDataBeforeOverride.sessions).map(session => {
    if (String(session.id || '') !== String(scopedChat.json?.session?.id || '')) return session;
    return {
      ...session,
      messages: [
        ...asArray(session.messages),
        {
          id: 'assistant_mentions_qy_source',
          role: 'assistant',
          content: '我选中的源链接：QY 店 · sv25082869650540305 · SM-505A电动缝纫机。目标仍然是 DL 店。',
          at: new Date().toISOString(),
        },
      ],
    };
  });
  await fs.writeFile(chatFile, `${JSON.stringify(chatDataBeforeOverride, null, 2)}\n`, 'utf8');

  const sourceTitleChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '标题直接复制QY那条链接的呀', askAgent: false},
  });
  const sourceTitleTask = sourceTitleChat.json?.autoTask || {};
  result.summary.sourceTitleStatus = sourceTitleChat.status;
  result.summary.sourceTitleIntents = sourceTitleTask.intents || [];
  result.summary.sourceTitleTargets = sourceTitleTask.targets || {};
  check('source-title supplement status', sourceTitleChat.status, 200);
  check('source-title supplement keeps copy intent', sourceTitleTask.intents, xs => asArray(xs).includes('copy_product_draft'));
  check('source-title supplement is not update-title action', sourceTitleTask.intents, xs => !asArray(xs).includes('update_title'));
  check('source-title supplement target remains DL only', sourceTitleTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('source-title supplement write remains DL only', sourceTitleTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('source-title supplement can remember QY as source only', sourceTitleTask?.targets?.sourceStores, xs => includesStore(xs, 'QY'));

  const overrideChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '输入电流按1200mA', askAgent: false},
  });
  const overrideTargets = overrideChat.json?.session?.targets || {};
  const inputCurrentOverride = asArray(overrideTargets.attributeOverrides).find(row => Number(row?.attribute_id) === 1002323);
  const overrideAutoTask = overrideChat.json?.autoTask || {};
  const overrideAutoTaskOverride = asArray(overrideAutoTask?.targets?.attributeOverrides).find(row => Number(row?.attribute_id) === 1002323);
  result.summary.inputCurrentOverride = inputCurrentOverride || null;
  result.summary.overrideAutoTaskId = overrideAutoTask?.id || '';
  check('manual input-current message status', overrideChat.status, 200);
  check('manual input-current override saved on session', inputCurrentOverride?.attribute_extra_value || '', '1200');
  check('manual input-current override merged into current task', overrideAutoTaskOverride?.attribute_extra_value || '', '1200');
  check('manual input-current update marks task for repreflight', overrideAutoTask?.execution?.state || '', 'needs_repreflight');
  check('assistant-mentioned source store does not become target store', overrideAutoTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('assistant-mentioned source store does not become write store', overrideAutoTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('assistant-mentioned QY is not treated as target', overrideAutoTask?.targets?.stores, xs => !includesStore(xs, 'QY'));

  const genericFieldChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: '帮我给DX的SK-9000空气炸锅补一条链接', askAgent: false},
  });
  const genericTaskId = genericFieldChat.json?.autoTask?.id || '';
  let genericTasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  genericTasks.tasks = asArray(genericTasks.tasks).map(task => {
    if (String(task.id || '') !== String(genericTaskId || '')) return task;
    return {
      ...task,
      status: 'waiting_review',
      lifecycle: {
        status: 'publish_pre_valid_failed',
        lifecycleStatus: 'publish_pre_valid_failed',
      },
      execution: {
        ...(task.execution || {}),
        state: 'publish_pre_valid_failed',
        preflight: {ok: false, blockers: ['商品属性：额定功率(1009999)必填'], warnings: []},
        openApiProductExecutors: [{
          storeKey: 'DX',
          state: 'publish_pre_valid_failed',
          publishResult: {
            code: '0',
            info: {
              success: false,
              pre_valid_result: [{form_name: '商品属性', messages: ['额定功率(1009999)必填']}],
            },
          },
        }],
      },
    };
  });
  await fs.writeFile(taskFile, `${JSON.stringify(genericTasks, null, 2)}\n`, 'utf8');
  const contextualOverrideChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: genericFieldChat.json?.session?.id, message: '按800W算', askAgent: false},
  });
  const contextualTask = contextualOverrideChat.json?.autoTask || {};
  const contextualOverride = asArray(contextualTask?.targets?.attributeOverrides).find(row => Number(row?.attribute_id) === 1009999);
  result.summary.contextualRequiredAttribute = contextualOverride || null;
  check('contextual required-attribute supplement status', contextualOverrideChat.status, 200);
  check('contextual required-attribute override saved', contextualOverride?.attribute_extra_value || '', '800W');
  check('contextual required-attribute label saved', contextualOverride?.label || '', '额定功率');
  check('contextual required-attribute target remains DX', contextualTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DX'));

  const realBrowserSupplementChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '标题直接复制QY那条链接的呀。然后电流是1200mA', askAgent: true},
  });
  const realBrowserTask = realBrowserSupplementChat.json?.autoTask || {};
  const realBrowserMessages = asArray(realBrowserSupplementChat.json?.session?.messages);
  const realBrowserAnswer = realBrowserMessages[realBrowserMessages.length - 1]?.content || '';
  const realBrowserOverride = asArray(realBrowserTask?.targets?.attributeOverrides).find(row => Number(row?.attribute_id) === 1002323);
  result.summary.realBrowserSupplementStatus = realBrowserSupplementChat.status;
  result.summary.realBrowserSupplementAnswer = realBrowserAnswer;
  result.summary.realBrowserSupplementTargets = realBrowserTask?.targets || {};
  check('real-browser supplement status', realBrowserSupplementChat.status, 200);
  check('real-browser supplement keeps BI state machine task', Boolean(realBrowserTask.id), true);
  check('real-browser supplement keeps copy intent', realBrowserTask.intents, xs => asArray(xs).includes('copy_product_draft'));
  check('real-browser supplement does not become update-title action', realBrowserTask.intents, xs => !asArray(xs).includes('update_title'));
  check('real-browser supplement target remains DL only', realBrowserTask?.targets?.stores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('real-browser supplement write remains DL only', realBrowserTask?.targets?.writeStores, xs => asArray(xs).length === 1 && includesStore(xs, 'DL'));
  check('real-browser supplement keeps QY as source only', realBrowserTask?.targets?.sourceStores, xs => includesStore(xs, 'QY'));
  check('real-browser supplement saves input current', realBrowserOverride?.attribute_extra_value || '', '1200');
  check('real-browser supplement does not leak old cross-entry wording', realBrowserAnswer, x => !/飞书|回到 BI 自动化运营页|只读建议|当前飞书|account_and_merchant_mismatch|DL\/QY 店/.test(String(x)));

  const naturalExecuteChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '可以执行，提交吧', askAgent: false},
  });
  const naturalExecuteMessages = asArray(naturalExecuteChat.json?.session?.messages);
  const naturalExecuteAnswer = naturalExecuteMessages[naturalExecuteMessages.length - 1]?.content || '';
  result.summary.naturalExecuteStatus = naturalExecuteChat.status;
  result.summary.naturalExecuteAnswer = naturalExecuteAnswer;
  check('natural-language execute message status', naturalExecuteChat.status, 200);
  check('natural-language execute without eligible task does not submit', naturalExecuteAnswer, x => /我先不提交/.test(String(x)));
  check('natural-language execute tells user to continue in chat on blockers', naturalExecuteAnswer, x => /聊天里/.test(String(x)));

  const forceEligible = task => ({
    ...task,
    status: 'waiting_review',
    intents: ['copy_product_draft'],
    targets: {
      ...(task.targets || {}),
      stores: ['DL'],
      writeStores: ['DL'],
      productRefs: ['505'],
    },
    execution: {
      ...(task.execution || {}),
      state: 'openapi_product_preflight_ready',
      preflight: {ok: true, blockers: [], warnings: []},
      openApiProductExecutors: [
        {
          storeKey: 'DL',
          mode: 'dry-run',
          payload: {payloadHash: `hash-${task.id || 'task'}`},
        },
      ],
    },
  });

  let tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  tasks.tasks = asArray(tasks.tasks).map(t => String(t.id || '') === String(scopedTask.id || '') ? forceEligible(t) : t);
  await fs.writeFile(taskFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  const uniqueEligibleChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '可以执行，提交吧', askAgent: false},
  });
  const uniqueEligibleMessages = asArray(uniqueEligibleChat.json?.session?.messages);
  const uniqueEligibleAnswer = uniqueEligibleMessages[uniqueEligibleMessages.length - 1]?.content || '';
  result.summary.uniqueEligibleStatus = uniqueEligibleChat.status;
  result.summary.uniqueEligibleAnswer = uniqueEligibleAnswer;
  check('natural-language execute unique eligible status', uniqueEligibleChat.status, 200);
  check('natural-language execute unique eligible attempts current task', uniqueEligibleAnswer, x => /收到，我按你这句/.test(String(x)));

  tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  tasks.tasks = asArray(tasks.tasks).map(t => String(t.id || '') === String(scopedTask.id || '') ? forceEligible(t) : t);
  await fs.writeFile(taskFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  const terseExecuteChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '干吧', askAgent: false},
  });
  const terseExecuteMessages = asArray(terseExecuteChat.json?.session?.messages);
  const terseExecuteAnswer = terseExecuteMessages[terseExecuteMessages.length - 1]?.content || '';
  result.summary.terseExecuteStatus = terseExecuteChat.status;
  result.summary.terseExecuteAnswer = terseExecuteAnswer;
  check('natural-language terse execute status', terseExecuteChat.status, 200);
  check('natural-language terse execute is handled by BI execution branch', terseExecuteAnswer, x => /收到，我按你这句“干吧”继续处理/.test(String(x)));
  check('natural-language terse execute does not leak old cross-entry wording', terseExecuteAnswer, x => !/飞书|回到 BI 自动化运营页|只读建议|创建任务/.test(String(x)));

  tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  tasks.tasks = asArray(tasks.tasks).map(t => forceEligible({...t, chatSessionId: scopedChat.json?.session?.id || t.chatSessionId}));
  await fs.writeFile(taskFile, `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
  const ambiguousExecuteChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {sessionId: scopedChat.json?.session?.id, message: '提交吧', askAgent: false},
  });
  const ambiguousExecuteMessages = asArray(ambiguousExecuteChat.json?.session?.messages);
  const ambiguousExecuteAnswer = ambiguousExecuteMessages[ambiguousExecuteMessages.length - 1]?.content || '';
  result.summary.ambiguousExecuteStatus = ambiguousExecuteChat.status;
  result.summary.ambiguousExecuteAnswer = ambiguousExecuteAnswer;
  check('natural-language execute ambiguous status', ambiguousExecuteChat.status, 200);
  check('natural-language execute refuses multiple eligible tasks', ambiguousExecuteAnswer, x => /不能猜你要执行哪一个/.test(String(x)));

  const legacyNoAutoTaskChat = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {
      message: '帮我给DL的505缝纫机再补第三条链接，直接复制DL现有曝光最高的那条链接。',
      askAgent: false,
      noAutoTask: true,
    },
  });
  const legacyNoAutoTask = legacyNoAutoTaskChat.json?.autoTask || {};
  result.summary.legacyNoAutoTaskStatus = legacyNoAutoTaskChat.status;
  result.summary.legacyNoAutoTaskId = legacyNoAutoTask.id || '';
  check('legacy noAutoTask explicit action status', legacyNoAutoTaskChat.status, 200);
  check('legacy noAutoTask cannot bypass action handling', Boolean(legacyNoAutoTask.id), true);

  tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  check('task file has five tasks including missing-link and generic field tasks', asArray(tasks.tasks).length, 5);
  result.ok = result.checks.every(x => x.pass);
} finally {
  child.kill('SIGTERM');
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
