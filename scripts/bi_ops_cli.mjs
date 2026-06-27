#!/usr/bin/env node
/**
 * SHEIN BI Ops CLI.
 *
 * A small client for Codex Desktop / local operators to drive the cloud BI
 * automation workbench through the same account, permission, and audit boundary
 * as the web UI. It never stores plaintext passwords; `login` stores only the
 * server session cookie in the user's profile or in `--session-file`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.SHEIN_BI_BASE_URL || 'https://shein-bi.dushengyi.xyz';
const DEFAULT_SESSION_FILE = process.env.SHEIN_BI_OPS_SESSION_FILE
  || path.join(os.homedir(), '.shein-bi', 'ops-session.json');
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

function parseArgs(argv) {
  const args = {
    command: '',
    baseUrl: DEFAULT_BASE_URL,
    sessionFile: DEFAULT_SESSION_FILE,
    username: process.env.SHEIN_BI_USERNAME || '',
    password: process.env.SHEIN_BI_PASSWORD || '',
    taskId: '',
    text: '',
    stores: [],
    sourceStores: [],
    writeStores: [],
    products: [],
    operation: '',
    mode: 'dry-run',
    confirm: '',
    status: '',
    note: '',
    limit: 40,
    json: true,
    passwordStdin: false,
    requireRealSubmit: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || '').trim();
    else if (a === '--session-file') args.sessionFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--username' || a === '-u') args.username = String(argv[++i] || '').trim();
    else if (a === '--password' || a === '-p') args.password = String(argv[++i] || '');
    else if (a === '--password-stdin') args.passwordStdin = true;
    else if (a === '--task-id' || a === '--id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--text' || a === '--command') args.text = String(argv[++i] || '').trim();
    else if (a === '--store' || a === '--stores') args.stores.push(...splitList(argv[++i]));
    else if (a === '--source-store' || a === '--source-stores' || a === '--read-store' || a === '--read-stores') args.sourceStores.push(...splitList(argv[++i]));
    else if (a === '--target-store' || a === '--target-stores' || a === '--write-store' || a === '--write-stores') args.writeStores.push(...splitList(argv[++i]));
    else if (a === '--product' || a === '--products' || a === '--ref') args.products.push(...splitList(argv[++i]));
    else if (a === '--operation' || a === '--action' || a === '--intent') args.operation = normalizeOperationName(argv[++i]);
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--status') args.status = String(argv[++i] || '').trim();
    else if (a === '--note') args.note = String(argv[++i] || '').trim();
    else if (a === '--limit') args.limit = Number(argv[++i] || 40);
    else if (a === '--pretty') args.json = false;
    else if (a === '--require-real-submit' || a === '--require-execute') args.requireRealSubmit = true;
    else if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (!args.command) {
      args.command = a;
    } else {
      rest.push(a);
    }
  }
  if (!args.text && rest.length) args.text = rest.join(' ').trim();
  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.command ||= 'help';
  return args;
}

function normalizeOperationName(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = new Map([
    ['copy', 'copy_product_draft'],
    ['copy_product', 'copy_product_draft'],
    ['copy_draft', 'copy_product_draft'],
    ['create_link', 'copy_product_draft'],
    ['publish', 'copy_product_draft'],
    ['retire', 'retire_link'],
    ['retire_product', 'retire_link'],
    ['down', 'retire_link'],
    ['off_shelf', 'retire_link'],
    ['offline', 'retire_link'],
    ['title', 'update_title'],
    ['image', 'update_images'],
    ['images', 'update_images'],
    ['photo', 'update_images'],
    ['photos', 'update_images'],
  ]);
  return aliases.get(lower) || lower;
}

function splitList(value) {
  return String(value || '')
    .split(/[,\s/]+/)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

function help() {
  return `SHEIN BI Ops CLI

Usage:
  node scripts/bi_ops_cli.mjs login --username <账号> --password <密码>
  node scripts/bi_ops_cli.mjs doctor
  node scripts/bi_ops_cli.mjs doctor --operation copy_product_draft --target-stores HL
  node scripts/bi_ops_cli.mjs doctor --operation retire_link --stores DL --require-real-submit
  node scripts/bi_ops_cli.mjs me
  node scripts/bi_ops_cli.mjs capabilities
  node scripts/bi_ops_cli.mjs tasks
  node scripts/bi_ops_cli.mjs create --text "把 520a 在 DL 生成下架预检" --stores DL --products 520a
  node scripts/bi_ops_cli.mjs create --text "复制 CX 的 SM-961 到 HL" --source-stores CX --target-stores HL --products SM-961
  node scripts/bi_ops_cli.mjs preflight --task-id <id>
  node scripts/bi_ops_cli.mjs execute --task-id <id> --confirm ${SUBMIT_CONFIRM_TEXT}
  node scripts/bi_ops_cli.mjs resolve --task-id <id> --status done --note "人工确认已闭环"
  node scripts/bi_ops_cli.mjs audit --task-id <id>
  node scripts/bi_ops_cli.mjs logout

Codex App example:
  请调用 node scripts/bi_ops_cli.mjs create --stores DL --products 520a --text "把 DL 的 520a 做下架预检"

Options:
  --base-url       默认 ${DEFAULT_BASE_URL}
  --session-file   默认 ${DEFAULT_SESSION_FILE}
  --source-stores  跨店复制时只读来源店铺
  --target-stores  跨店复制时真实写入目标店铺；不填则沿用 --stores
  --operation      doctor 用；可填 copy_product_draft / retire_link / update_title / update_images
  --require-real-submit  doctor 用；要求所选店铺+动作已可真实提交，否则退出非 0

Safety:
  - 密码只用于 login 请求，不写入 session 文件。
  - doctor 只做本机/云端连通性和权限自检，不创建任务、不触发预检、不执行 SHEIN 写。
  - 所有任务创建/预检/执行/审计都走云端账号权限和审计。
  - execute 仍需服务端确认任务已预检通过，并且确认文本精确匹配。
  - resolve 只用于已提交待回读/需人工处理任务的人工核销；服务端只允许全店管理账号执行。`;
}

async function readSession(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function writeSession(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
}

async function readStdinText() {
  let out = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function promptLine(prompt) {
  process.stdout.write(prompt);
  const text = await readStdinText();
  return text.split(/\r?\n/)[0] || '';
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return promptLine(prompt);
  }
  return await new Promise(resolve => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (value.length) value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    process.stdin.on('data', onData);
  });
}

function cookieFromSetCookie(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(';')[0].trim();
}

async function request(args, pathname, {method = 'GET', body, auth = true} = {}) {
  const headers = {'accept': 'application/json', 'user-agent': 'shein-bi-ops-cli/1.0'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const session = await readSession(args.sessionFile);
    if (session.cookie) headers.cookie = session.cookie;
  }
  const res = await fetch(`${args.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {raw: text};
  }
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return {json, res};
}

function print(data, pretty = false) {
  if (!pretty) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data?.tasks)) {
    for (const task of data.tasks) {
      console.log(`${task.id}\t${task.status}\t${(task.targets?.stores || []).join('/')}\t${task.preview?.summary || task.command || ''}`);
    }
    return;
  }
  if (Array.isArray(data?.rows) && data?.counts) {
    const safe = data?.safety?.safeWriteOperations || {};
    const whitelist = data?.safety?.realSubmitWhitelist || {};
    console.log(`OpenAPI 总账：${data.counts.authorized || 0}/${data.counts.total || data.rows.length} 已授权，${data.counts.readReady || 0} 只读可用，${data.counts.writeConfirmable || 0} 店有真实提交适配器`);
    console.log(`真实写总闸门：${safe.enabled ? '开启' : '关闭'}；真实写试点白名单：${whitelist.enabled ? `开启(${whitelist.ruleCount || 0}条)` : '关闭'}；真实提交仍必须命中 人 + 店 + 动作 白名单`);
    for (const row of data.rows) {
      const actions = (Array.isArray(row.actionCapabilities) ? row.actionCapabilities : [])
        .map(action => {
          const state = action.realSubmitSupported ? '可真提交' : (action.precheckSupported ? '仅预检' : '任务池');
          const blockers = Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
            ? `；缺口=${action.realSubmitBlockers.join('/')}`
            : '';
          return `${action.label}:${state}${blockers}`;
        })
        .join(' | ');
      const wl = row.realSubmitWhitelist || {};
      const wlText = wl.enabled ? (wl.configured ? `白名单命中${wl.matchedRuleCount || 0}` : '白名单未命中') : '白名单关闭';
      console.log(`${row.storeKey}\t${row.status || '-'}\t${wlText}\t${actions}`);
    }
    return;
  }
  if (Array.isArray(data?.checks) && data?.generatedAt) {
    console.log(`BI Ops Doctor：${data.ok ? '通过' : '未通过'}  ${data.baseUrl || ''}`);
    if (data.user) {
      console.log(`当前账号：${data.user.username || '-'} · ${data.user.displayName || '-'} · ${data.user.role || '-'}`);
      console.log(`写权限：${Array.isArray(data.user.writeStores) ? data.user.writeStores.join(',') : '-'}`);
    }
    if (data.counts) {
      console.log(`OpenAPI：${data.counts.authorized || 0}/${data.counts.total || 0} 已授权，${data.counts.readReady || 0} 只读可用，${data.counts.writeConfirmable || 0} 可真实提交`);
    }
    const safe = data.safety?.safeWriteOperations || {};
    const whitelist = data.safety?.realSubmitWhitelist || {};
    console.log(`真实写：总闸门=${safe.enabled ? '开启' : '关闭'}，试点白名单=${whitelist.enabled ? `开启(${whitelist.ruleCount || 0}条)` : '关闭'}，静默写=${data.safety?.canSilentWrite ? '是' : '否'}`);
    if (data.requestedActionReadiness) {
      const readiness = data.requestedActionReadiness;
      console.log(`动作诊断：${readiness.operation} · ${readiness.requireRealSubmit ? '要求真实提交' : '要求可 dry-run'} · dry-run=${readiness.allCanDryRun ? '是' : '否'} · 真实提交=${readiness.allCanRealSubmitAfterPreflight ? '是' : '否'}`);
      for (const item of readiness.items || []) {
        const blockerText = Array.isArray(item.blockers) && item.blockers.length ? `；阻断=${item.blockers.join('/')}` : '';
        console.log(`  - ${item.storeKey}: 建任务=${item.canCreateTask ? '是' : '否'}，dry-run=${item.canDryRun ? '是' : '否'}，真实提交=${item.canRealSubmitAfterPreflight ? '是' : '否'}${blockerText}`);
      }
    }
    for (const check of data.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.label}${check.error ? `：${check.error}` : ''}`);
    }
    console.log(data.nextStep || '');
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function taskTargets(args) {
  const targets = {};
  if (args.stores.length) targets.stores = [...new Set(args.stores)];
  if (args.sourceStores.length) targets.sourceStores = [...new Set(args.sourceStores)];
  if (args.writeStores.length) targets.writeStores = [...new Set(args.writeStores)];
  if (args.products.length) targets.productRefs = [...new Set(args.products)];
  return targets;
}

function hasStoreAccess(user, field, storeKey) {
  const list = Array.isArray(user?.[field]) ? user[field].map(x => String(x || '').trim().toUpperCase()).filter(Boolean) : [];
  return list.includes('*') || list.includes(String(storeKey || '').trim().toUpperCase());
}

function requestedDoctorStores(args, capabilitiesJson) {
  const explicit = [...new Set([
    ...(args.writeStores || []),
    ...(args.stores || []),
  ].map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  if (explicit.length) return explicit;
  if (!args.operation) return [];
  return (Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [])
    .map(row => String(row.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
}

function buildActionReadiness(args, meJson, capabilitiesJson) {
  if (!args.operation) return null;
  const rows = Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [];
  const rowsByStore = new Map(rows.map(row => [String(row.storeKey || '').trim().toUpperCase(), row]));
  const user = meJson?.user || {};
  const sourceStores = [...new Set((args.sourceStores || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const stores = requestedDoctorStores(args, capabilitiesJson);
  const items = stores.map(storeKey => {
    const row = rowsByStore.get(storeKey) || null;
    const actions = Array.isArray(row?.actionCapabilities) ? row.actionCapabilities : [];
    const action = actions.find(x => String(x.key || x.intent || '').trim() === args.operation) || null;
    const accountCanWrite = hasStoreAccess(user, 'writeStores', storeKey);
    const accountCanReadTargets = hasStoreAccess(user, 'readStores', storeKey);
    const unreadableSources = sourceStores.filter(src => !hasStoreAccess(user, 'readStores', src));
    const sourceReadable = unreadableSources.length === 0;
    const precheckSupported = Boolean(action?.precheckSupported);
    const realSubmitSupported = Boolean(action?.realSubmitSupported);
    const blockers = [];
    if (!row) blockers.push('能力总账里没有这个店铺');
    if (row && !action) blockers.push(`能力总账里没有动作 ${args.operation}`);
    if (!accountCanReadTargets) blockers.push('当前账号没有目标店铺读权限');
    if (!accountCanWrite) blockers.push('当前账号没有目标店铺写权限');
    if (!sourceReadable) blockers.push(`当前账号没有来源店铺读权限：${unreadableSources.join(',')}`);
    if (action && !precheckSupported) blockers.push('该动作当前不支持自动预检');
    if (action && precheckSupported && !realSubmitSupported) blockers.push(...(Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
      ? action.realSubmitBlockers
      : ['该动作当前只支持 dry-run/预检，不支持真实提交']));
    const canCreateTask = accountCanWrite && accountCanReadTargets && sourceReadable;
    const canDryRun = canCreateTask && precheckSupported;
    const canRealSubmitAfterPreflight = canDryRun && realSubmitSupported;
    return {
      storeKey,
      operation: args.operation,
      accountCanWrite,
      accountCanReadTargets,
      sourceStores,
      sourceReadable,
      precheckSupported,
      realSubmitSupported,
      canCreateTask,
      canDryRun,
      canRealSubmitAfterPreflight,
      state: action?.state || '',
      reason: action?.reason || row?.note || '',
      nextStep: action?.nextStep || '',
      blockers: [...new Set(blockers)],
    };
  });
  const allCanRealSubmit = items.length > 0 && items.every(x => x.canRealSubmitAfterPreflight);
  const allCanDryRun = items.length > 0 && items.every(x => x.canDryRun);
  return {
    operation: args.operation,
    requestedStores: stores,
    requireRealSubmit: args.requireRealSubmit,
    allCanDryRun,
    allCanRealSubmitAfterPreflight: allCanRealSubmit,
    okForRequestedLevel: args.requireRealSubmit ? allCanRealSubmit : allCanDryRun,
    items,
  };
}

async function doctorCheck(label, fn, {critical = true} = {}) {
  try {
    const value = await fn();
    return {label, ok: true, critical, ...value};
  } catch (err) {
    return {
      label,
      ok: false,
      critical,
      error: err?.message || String(err),
      status: err?.status || null,
      response: err?.response ? {
        ok: err.response.ok,
        error: err.response.error || '',
        status: err.response.status || null,
      } : null,
    };
  }
}

async function runDoctor(args) {
  const checks = [];
  const nodeMajor = Number(String(process.versions.node || '').split('.')[0] || 0);
  const session = await readSession(args.sessionFile);
  let sessionText = '';
  try {
    sessionText = await fs.readFile(args.sessionFile, 'utf8');
  } catch {}

  checks.push({
    label: 'local-node',
    ok: nodeMajor >= 20,
    critical: true,
    node: process.version,
    message: nodeMajor >= 20 ? 'Node.js 版本符合建议要求。' : '建议安装 Node.js 20 或更高版本。',
  });
  checks.push({
    label: 'session-file',
    ok: Boolean(session.cookie),
    critical: true,
    sessionFile: args.sessionFile,
    exists: Boolean(sessionText),
    baseUrl: session.baseUrl || '',
    savedAt: session.savedAt || '',
    storesPlaintextPassword: /"password"\s*:|password=|owner-cli-pass|operator-cli-pass/i.test(sessionText),
  });
  if (checks.at(-1).storesPlaintextPassword) checks.at(-1).ok = false;

  let meJson = null;
  let capabilitiesJson = null;
  checks.push(await doctorCheck('auth-me', async () => {
    const {json} = await request(args, '/api/auth/me');
    meJson = json;
    const user = json.user || {};
    return {
      username: user.username || '',
      displayName: user.displayName || '',
      role: user.role || '',
      readStores: user.readStores || [],
      writeStores: user.writeStores || [],
    };
  }));
  checks.push(await doctorCheck('openapi-capabilities', async () => {
    const {json} = await request(args, '/api/openapi-capabilities');
    capabilitiesJson = json;
    return {
      totalStores: json.counts?.total || json.rows?.length || 0,
      authorizedStores: json.counts?.authorized || 0,
      readReadyStores: json.counts?.readReady || 0,
      writeConfirmableStores: json.counts?.writeConfirmable || 0,
      safeWriteEnabled: Boolean(json.safety?.safeWriteOperations?.enabled),
      realSubmitWhitelistEnabled: Boolean(json.safety?.realSubmitWhitelist?.enabled),
      canSilentWrite: Boolean(json.safety?.canSilentWrite),
    };
  }));
  checks.push(await doctorCheck('task-pool', async () => {
    const {json} = await request(args, '/api/link-ops-tasks?limit=1');
    return {
      reachable: true,
      taskCountVisible: Array.isArray(json.data?.tasks) ? json.data.tasks.length : 0,
    };
  }));

  const actionReadiness = buildActionReadiness(args, meJson, capabilitiesJson);
  if (actionReadiness) {
    checks.push({
      label: args.requireRealSubmit ? 'action-real-submit-readiness' : 'action-dry-run-readiness',
      ok: actionReadiness.okForRequestedLevel,
      critical: Boolean(args.requireRealSubmit),
      operation: actionReadiness.operation,
      requestedStores: actionReadiness.requestedStores,
      allCanDryRun: actionReadiness.allCanDryRun,
      allCanRealSubmitAfterPreflight: actionReadiness.allCanRealSubmitAfterPreflight,
    });
  }

  const ok = checks.every(check => check.ok || !check.critical);
  return {
    ok,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    sessionFile: args.sessionFile,
    user: meJson?.user || null,
    safety: capabilitiesJson?.safety ? {
      safeWriteOperations: capabilitiesJson.safety.safeWriteOperations,
      realSubmitWhitelist: capabilitiesJson.safety.realSubmitWhitelist,
      canSilentWrite: Boolean(capabilitiesJson.safety.canSilentWrite),
    } : null,
    counts: capabilitiesJson?.counts || null,
    requestedActionReadiness: actionReadiness,
    checks,
    nextStep: ok
      ? (actionReadiness
        ? (actionReadiness.okForRequestedLevel
          ? '所选账号/店铺/动作达到请求的可用级别；真实提交仍必须先 dry-run、进入待复核、输入确认文本并通过服务端回读。'
          : '本机 CLI 连通正常，但所选账号/店铺/动作没有达到请求的可用级别；查看 requestedActionReadiness.items[].blockers。')
        : '本机 CLI 到云端 BI 的账号、权限和只读接口自检通过。创建/预检/执行仍按服务端权限、确认文本和审计边界执行。')
      : '按 failed checks 处理：通常是未登录、session 过期、Node 版本过低或云端接口不可达。',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(help());
    return;
  }
  if (args.command === 'login') {
    if (!args.username && process.stdin.isTTY) args.username = (await promptLine('BI账号: ')).trim();
    if (args.passwordStdin) args.password = (await readStdinText()).trim();
    if (!args.password && process.stdin.isTTY) args.password = await promptHidden('BI密码: ');
    if (!args.username || !args.password) throw new Error('login requires --username and --password, SHEIN_BI_USERNAME/SHEIN_BI_PASSWORD, or interactive input');
    const {json, res} = await request(args, '/api/login', {
      method: 'POST',
      auth: false,
      body: {username: args.username, password: args.password},
    });
    const cookie = cookieFromSetCookie(res.headers);
    if (!cookie) throw new Error('Login succeeded but Set-Cookie was missing');
    await writeSession(args.sessionFile, {
      baseUrl: args.baseUrl,
      cookie,
      user: json.user,
      savedAt: new Date().toISOString(),
      note: 'Session cookie only; plaintext password is never stored.',
    });
    print({ok: true, user: json.user, sessionFile: args.sessionFile});
    return;
  }
  if (args.command === 'logout') {
    await request(args, '/api/logout', {method: 'POST'}).catch(() => null);
    await fs.rm(args.sessionFile, {force: true}).catch(() => {});
    print({ok: true, sessionFile: args.sessionFile, loggedOut: true});
    return;
  }
  if (args.command === 'doctor') {
    const report = await runDoctor(args);
    print(report, !args.json);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args.command === 'me') {
    const {json} = await request(args, '/api/auth/me');
    print(json);
    return;
  }
  if (args.command === 'capabilities') {
    const {json} = await request(args, '/api/openapi-capabilities');
    print(json, !args.json);
    return;
  }
  if (args.command === 'tasks') {
    const {json} = await request(args, `/api/link-ops-tasks?limit=${encodeURIComponent(args.limit)}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'create') {
    if (!args.text) throw new Error('create requires --text');
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'POST',
      body: {command: args.text, source: 'codex_desktop_cli', targets: taskTargets(args)},
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'preflight') {
    if (!args.taskId) throw new Error('preflight requires --task-id');
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli'},
    });
    print({ok: true, task: json.task, execution: json.execution});
    return;
  }
  if (args.command === 'execute') {
    if (!args.taskId) throw new Error('execute requires --task-id');
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) throw new Error(`execute requires --confirm ${SUBMIT_CONFIRM_TEXT}`);
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'execute', confirm: args.confirm, source: 'codex_desktop_cli'},
    });
    print({ok: true, task: json.task, execution: json.execution});
    return;
  }
  if (args.command === 'resolve') {
    if (!args.taskId) throw new Error('resolve requires --task-id');
    const status = args.status || 'done';
    if (!['done', 'archived'].includes(status)) throw new Error('resolve --status must be done or archived');
    if (!args.note) throw new Error('resolve requires --note to explain the manual decision');
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'PATCH',
      body: {id: args.taskId, status, note: args.note, event: 'manual_lifecycle_resolve_cli'},
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'audit') {
    if (!args.taskId) throw new Error('audit requires --task-id');
    const {json} = await request(args, `/api/link-ops-audit?taskId=${encodeURIComponent(args.taskId)}&limit=${encodeURIComponent(args.limit)}`);
    print(json);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch(err => {
  const out = {
    ok: false,
    error: err?.message || String(err),
    status: err?.status || null,
    response: err?.response || null,
  };
  console.error(JSON.stringify(out, null, 2));
  process.exitCode = 1;
});
