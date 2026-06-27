#!/usr/bin/env node
/**
 * End-to-end success-path smoke for copy_product_draft.
 *
 * This starts:
 *   1) an isolated fake SHEIN OpenAPI HTTP server,
 *   2) an isolated BI portal with temporary auth/task/audit/openapi/whitelist
 *      files and safeWriteOperations enabled only inside the temp config.
 *
 * It proves the full success lifecycle without touching real SHEIN:
 *   create task -> attach JSON publish payload -> dry-run locks payload hash
 *   -> execute with SHEIN_OPENAPI_SUBMIT -> fake publish succeeds
 *   -> fake product query returns target supplier SKU/code
 *   -> task auto-closes as submitted_readback_matched/done.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const WEAK_READBACK_ONLY = process.argv.includes('--weak-readback');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-copy-success-smoke-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function b64Json(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64');
}

function extractTaskId(json) {
  return json?.task?.id || json?.data?.tasks?.[0]?.id || '';
}

function writeAuditFromExecute(json) {
  return json?.execution?.writeAudit || json?.task?.execution?.writeAudit || json?.task?.writeAudit || null;
}

function executorEvidenceFromAudit(writeAudit, storeKey = 'HL') {
  const key = String(storeKey || '').trim().toUpperCase();
  return asArray(writeAudit?.executorEvidence).find(row => String(row?.storeKey || '').trim().toUpperCase() === key) || null;
}

function taskLifecycle(json) {
  return json?.task?.lifecycle || json?.task?.execution?.lifecycle || null;
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}

const targetSupplierCode = 'HL-COPY-SUCCESS-SKC';
const targetSupplierSku = 'HL-COPY-SUCCESS-SKU-001';
const publishTraceId = 'trace-copy-success-smoke';
const publishPayload = {
  category_id: 123456,
  product_type_id: 789,
  source_system: 'OpenAPI',
  brand_code: 'BRAND_SMOKE',
  site_list: [{main_site: 'shein', sub_site_list: ['shein-sa']}],
  multi_language_name_list: [{language: 'en', product_name: 'Copy success smoke product'}],
  product_attribute_list: [{attribute_id: 101, attribute_value_id: 202}],
  shelf_way: 2,
  hope_on_sale_date: '2036-06-27 10:00:00',
  skc_list: [{
    supplier_code: targetSupplierCode,
    skc_name: 'SMOKE-COPY-SKC',
    image_info: {
      image_info_list: [{
        image_type: 1,
        image_url: 'https://example.invalid/smoke-main.jpg',
      }],
    },
    sale_attribute: [{attribute_id: 301, attribute_value_id: 401}],
    sku_list: [{
      supplier_sku: targetSupplierSku,
      mall_state: 1,
      height: 10,
      length: 20,
      width: 30,
      weight: 1.5,
      cost_info: {currency: 'SAR', cost_price: '99.00'},
      stock_info_list: [{warehouse_id: 'WH-SMOKE', stock: 100}],
    }],
  }],
};

const fakeOpenApiPort = await getFreePort();
const fakeOpenApiCalls = [];
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await requestBody(req);
  fakeOpenApiCalls.push({method: req.method, path: req.url.split('?')[0], url: req.url, body: body.json || body.text});
  const pathname = req.url.split('?')[0];
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        accountNo: 'GS8313514',
        merchantId: '12224658',
        companyName: '皓兰',
        shopName: 'Copy Success HL',
      },
    });
  }
  if (pathname === '/open-api/goods/product/check-publish-permission') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        canPublishProduct: true,
        reason: '',
      },
    });
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{
        main_site: 'shein',
        main_site_name: 'SHEIN',
        sub_site_list: [{site_abbr: 'shein-sa', site_name: 'SHEIN Saudi Arabia', currency: 'SAR', site_status: 1}],
      }],
    });
  }
  if (pathname === '/open-api/goods/query-brand-list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{brand_code: 'BRAND_SMOKE', brand_name: 'Smoke Brand'}],
    });
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: [{supplier_warehouse_id: 'WH-SMOKE', supplier_warehouse_name: 'Smoke Warehouse', status: 1}],
    });
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    const strongPayload = body.json || {};
    if (strongPayload?.skc_list?.[0]?.supplier_code !== targetSupplierCode) {
      return sendJson(res, {code: '400', msg: 'unexpected supplier code', traceId: publishTraceId}, 200);
    }
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      traceId: publishTraceId,
      info: {taskNo: 'PUB-SMOKE-001'},
    });
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {
      code: '0',
      msg: 'OK',
      info: {
        data: [{
          spuName: 'Smoke SPU',
          skcName: 'SMOKE-COPY-SKC',
          ...(WEAK_READBACK_ONLY ? {} : {
            supplierCode: targetSupplierCode,
            supplierSku: targetSupplierSku,
          }),
          skuCodeList: ['PLATFORM-SKU-SMOKE'],
          productName: 'Copy success smoke product',
        }],
      },
    });
  }
  return sendJson(res, {code: '404', msg: `Unhandled fake endpoint: ${pathname}`}, 404);
});
await new Promise(resolve => fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve));

const authFile = await writeJson('auth.json', {
  users: [{
    username: 'owner_copy_success',
    password: 'owner-pass',
    displayName: 'Owner Copy Success',
    role: 'owner',
    readStores: ['*'],
    writeStores: ['*'],
    ownerKey: 'OWNER_COPY_SUCCESS',
  }, {
    username: 'operator_copy_success',
    password: 'operator-pass',
    displayName: 'Operator Copy Success',
    role: 'operator',
    readStores: ['*'],
    writeStores: ['HL'],
    ownerKey: 'OPERATOR_COPY_SUCCESS',
  }],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    owner: {readStores: ['*'], writeStores: ['*']},
    operator: {readStores: ['*'], writeStores: []},
  },
});
const openapiConfigFile = await writeJson('openapi.json', {
  environment: 'copy-success-smoke',
  cooperationMode: '半托管',
  market: 'SA',
  apiBaseUrls: {
    prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}`,
  },
  stores: [{
    storeKey: 'HL',
    shopName: 'Copy Success HL',
    enabled: true,
    openKeyId: 'dummy-open-key-hl',
    secretKey: 'dummy-secret-hl',
    authorizedAt: '2026-06-27T00:00:00.000+08:00',
  }],
  safeWriteOperations: {
    enabled: true,
    requireDryRun: true,
    allowedOperations: ['copy_product_draft'],
    allowedStores: ['HL'],
  },
});
const whitelistFile = await writeJson('whitelist.json', {
  enabled: true,
  rules: [{
    id: 'owner-hl-copy-success',
    enabled: true,
    realSubmit: true,
    stores: ['HL'],
    operations: ['copy_product_draft'],
    allowedUsers: ['owner_copy_success'],
    allowedOwnerKeys: ['OWNER_COPY_SUCCESS'],
    allowedRoles: ['owner'],
  }],
});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');

const portalPort = await getFreePort();
const portal = spawn(process.execPath, [
  'scripts/serve_bi_portal.mjs',
  '--host', '127.0.0.1',
  '--port', String(portalPort),
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
    SHEIN_LINK_OPS_OPENAPI_EXECUTOR_TIMEOUT_MS: '5000',
    SHEIN_LINK_OPS_READBACK_MAX_PAGES: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portalStdout = '';
let portalStderr = '';
portal.stdout.on('data', d => { portalStdout += d.toString(); });
portal.stderr.on('data', d => { portalStderr += d.toString(); });

const base = `http://127.0.0.1:${portalPort}`;
async function req(pathname, {method = 'GET', cookie = '', body = undefined} = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
      ...(cookie ? {Cookie: cookie} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${portalStdout}\nstderr=${portalStderr}`);
    try {
      const r = await fetch(`${base}/login`, {redirect: 'manual'});
      if (r.status >= 200 && r.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`portal not ready\nstdout=${portalStdout}\nstderr=${portalStderr}`);
}

async function login(username, password) {
  const r = await req('/api/login', {method: 'POST', body: {username, password}});
  const setCookie = r.headers.get('set-cookie') || '';
  const cookie = (setCookie.match(/bi_session=[^;]+/) || [''])[0];
  if (r.status !== 200 || !cookie) throw new Error(`login failed ${username}: status=${r.status} body=${r.text}`);
  return cookie;
}

const result = {ok: false, scenario: WEAK_READBACK_ONLY ? 'weak-readback-only' : 'strong-readback-success', tmpRoot, fakeOpenApiPort, portalPort, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await waitReady();
  const cookie = await login('owner_copy_success', 'owner-pass');
  const operatorCookie = await login('operator_copy_success', 'operator-pass');

  const caps = await req('/api/openapi-capabilities', {cookie});
  const hlRow = asArray(caps.json?.rows).find(row => row.storeKey === 'HL');
  const hlCopy = asArray(hlRow?.actionCapabilities).find(action => action.key === 'copy_product_draft');
  check('capabilities status', caps.status, 200);
  check('HL copy is confirmable in isolated pilot config', Boolean(hlCopy?.realSubmitSupported), true);

  const created = await req('/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      source: 'copy_success_smoke',
      command: '复制上品/补链接 PA4-6L 到 HL',
      targets: {stores: ['HL'], productRefs: ['PA4-6L']},
    },
  });
  const taskId = extractTaskId(created.json);
  check('create task status', created.status, 200);
  check('task id present', Boolean(taskId), true);

  const uploaded = await req('/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId,
      files: [{
        name: 'publish-payload.json',
        type: 'application/json',
        dataBase64: b64Json({publishPayload}),
      }],
    },
  });
  check('upload payload status', uploaded.status, 200);
  check('uploaded one payload asset', asArray(uploaded.json?.assets).length, 1);

  const dryRun = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId, mode: 'dry-run', source: 'copy_success_smoke'},
  });
  const dryRunTask = dryRun.json?.task || {};
  const dryRunEvidence = executorEvidenceFromAudit(dryRun.json?.execution?.writeAudit || dryRunTask?.execution?.writeAudit, 'HL');
  const dryRunPayloadHash = dryRunEvidence?.payloadHash || dryRunTask?.execution?.openApiProductExecutors?.[0]?.payload?.payloadHash || '';
  check('dry-run status', dryRun.status, 200);
  check('dry-run task waiting_review', dryRunTask.status, 'waiting_review');
  check('dry-run locks payload hash', Boolean(dryRunPayloadHash), true);
  check('dry-run does not publish', Boolean(dryRun.json?.execution?.writeAudit?.sheinWriteAttempted), false);

  const executed = await req('/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: taskId, mode: 'execute', confirm: CONFIRM_TEXT, source: 'copy_success_smoke'},
  });
  const writeAudit = writeAuditFromExecute(executed.json);
  const lifecycle = taskLifecycle(executed.json);
  const execEvidence = executorEvidenceFromAudit(writeAudit, 'HL');
  result.summary.executedStatus = executed.status;
  result.summary.taskStatus = executed.json?.task?.status || '';
  result.summary.lifecycleStatus = lifecycle?.status || lifecycle?.lifecycleStatus || '';
  result.summary.writeAudit = {
    requestedRealSubmit: Boolean(writeAudit?.requestedRealSubmit),
    executeAllowed: Boolean(writeAudit?.executeAllowed),
    issuedExecuteToExecutor: Boolean(writeAudit?.issuedExecuteToExecutor),
    sheinWriteAttempted: Boolean(writeAudit?.sheinWriteAttempted),
    actualWriteSubmitted: Boolean(writeAudit?.actualWriteSubmitted),
    lifecycleLocked: Boolean(writeAudit?.lifecycleLocked),
    requiresManualResolve: Boolean(writeAudit?.requiresManualResolve),
    blockerCount: Number(writeAudit?.blockerCount || 0),
  };
  result.summary.execEvidence = execEvidence;
  check('execute status', executed.status, 200);
  check('execute allowed', Boolean(writeAudit?.executeAllowed), true);
  check('execute issued to child executor', Boolean(writeAudit?.issuedExecuteToExecutor), true);
  check('execute attempted SHEIN write against fake server', Boolean(writeAudit?.sheinWriteAttempted), true);
  check('execute actual write submitted flag', Boolean(writeAudit?.actualWriteSubmitted), true);
  if (WEAK_READBACK_ONLY) {
    check('weak-only writeAudit lifecycle locked', Boolean(writeAudit?.lifecycleLocked), true);
    check('weak-only writeAudit requires manual resolve', Boolean(writeAudit?.requiresManualResolve), true);
    check('weak-only task needs manual resolve', executed.json?.task?.status || '', 'needs_manual_resolve');
    check('weak-only lifecycle failed not matched', lifecycle?.status || lifecycle?.lifecycleStatus || '', 'submitted_readback_failed');
    check('weak-only lifecycle locked', Boolean(lifecycle?.locked), true);
    check('weak-only manual resolve required', Boolean(lifecycle?.needsManualResolve), true);
    check('weak-only executor readback not ok', Boolean(execEvidence?.readback?.ok), false);
    check('weak-only readback status', execEvidence?.readback?.status || '', 'weak_match_only');
    check('weak-only no strong matches', Number(execEvidence?.readback?.matchedCount || 0), 0);
    check('weak-only has weak matches', Number(execEvidence?.readback?.weakMatchedCount || 0), n => n >= 1);
  } else {
    check('no blockers after matched readback', Number(writeAudit?.blockerCount || 0), 0);
    check('task auto done after strong readback', executed.json?.task?.status || '', 'done');
    check('lifecycle matched strong readback', lifecycle?.status || lifecycle?.lifecycleStatus || '', 'submitted_readback_matched');
    check('lifecycle not locked', Boolean(lifecycle?.locked), false);
    check('no manual resolve needed', Boolean(lifecycle?.needsManualResolve), false);
    check('executor readback ok', Boolean(execEvidence?.readback?.ok), true);
    check('executor readback status strong matched', execEvidence?.readback?.status || '', 'matched_strong_fingerprint_in_product_query');
    check('executor readback matched count', Number(execEvidence?.readback?.matchedCount || 0), 1);
    check('executor readback weak matched count', Number(execEvidence?.readback?.weakMatchedCount || 0), 0);
  }
  check('execute reused dry-run payload hash', execEvidence?.payloadHash || '', dryRunPayloadHash);
  check('publish trace id retained', execEvidence?.publishResult?.traceId || '', publishTraceId);

  result.summary.fakeOpenApiCallPaths = fakeOpenApiCalls.map(call => call.path);
  check('fake publish endpoint called once', fakeOpenApiCalls.filter(call => call.path === '/open-api/goods/product/publishOrEdit').length, 1);
  check('fake readback endpoint called', fakeOpenApiCalls.some(call => call.path === '/open-api/openapi-business-backend/product/query'), true);

  if (WEAK_READBACK_ONLY) {
    const operatorResolveDenied = await req('/api/link-ops-tasks', {
      method: 'PATCH',
      cookie: operatorCookie,
      body: {
        id: taskId,
        status: 'done',
        note: 'operator should not be able to resolve submitted_readback_failed',
        event: 'manual_lifecycle_resolve_smoke_operator_denied',
      },
    });
    result.summary.operatorResolveDeniedStatus = operatorResolveDenied.status;
    result.summary.operatorResolveDeniedError = operatorResolveDenied.json?.error || '';
    check('operator manual resolve denied status', operatorResolveDenied.status, 403);
    check('operator manual resolve denied reason', operatorResolveDenied.json?.error || '', text => /全店管理账号|人工核销|权限/.test(String(text || '')));

    const ownerResolve = await req('/api/link-ops-tasks', {
      method: 'PATCH',
      cookie,
      body: {
        id: taskId,
        status: 'done',
        note: 'owner manually confirmed weak readback task should be closed in smoke',
        event: 'manual_lifecycle_resolve_smoke_owner_done',
      },
    });
    result.summary.ownerResolveStatus = ownerResolve.status;
    result.summary.ownerResolvedTaskStatus = ownerResolve.json?.task?.status || '';
    result.summary.ownerResolvedLifecycleStatus = ownerResolve.json?.task?.lifecycle?.status || '';
    result.summary.ownerResolvedBy = ownerResolve.json?.task?.lifecycle?.manualResolution?.user || '';
    check('owner manual resolve status', ownerResolve.status, 200);
    check('owner manual resolve task done', ownerResolve.json?.task?.status || '', 'done');
    check('owner manual resolve lifecycle status', ownerResolve.json?.task?.lifecycle?.status || '', 'manual_resolved_done');
    check('owner manual resolve user recorded', ownerResolve.json?.task?.lifecycle?.manualResolution?.user || '', 'owner_copy_success');
    check('owner manual resolve execution history appended', asArray(ownerResolve.json?.task?.executionHistory).some(row => row.event === 'manual_lifecycle_resolve'), true);

    const audit = await req(`/api/link-ops-audit?taskId=${encodeURIComponent(taskId)}&limit=50`, {cookie});
    const auditTypes = asArray(audit.json?.entries).map(entry => entry.type);
    result.summary.auditTypes = auditTypes;
    check('audit query status', audit.status, 200);
    check('audit contains denied operator resolve', auditTypes.includes('link-ops-task-update-denied'), true);
    check('audit contains owner manual resolve update', auditTypes.includes('link-ops-task-update'), true);
  }

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = Array.isArray(tasks.tasks) ? tasks.tasks.length : 0;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('task count', result.summary.taskCount, 1);
  check('audit lines >= expected', result.summary.auditLines, n => n >= (WEAK_READBACK_ONLY ? 8 : 5));

  result.ok = result.checks.every(x => x.pass);
} finally {
  portal.kill();
  await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`copy success smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
