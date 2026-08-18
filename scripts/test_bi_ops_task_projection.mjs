#!/usr/bin/env node
/**
 * User-facing task projection smoke.
 *
 * The automation page must not receive raw historical execution internals.
 * This deliberately seeds a task with old V1/Feishu/confirm-token/technical
 * wording and verifies /api/link-ops-tasks only returns a safe progress summary.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  DESCRIPTION_SOURCE_PROOF,
  descriptionBindingRequestKey,
  sha256StableJson,
  sha256Utf8,
} from '../lib/link_ops_product_descriptions.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-task-projection-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  try { json = text ? JSON.parse(text) : null; } catch {}
  return {status: res.status, headers: res.headers, text, json};
}

const result = {ok: false, tmpRoot, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

function assertNoRawTaskLeak(label, json) {
  const raw = JSON.stringify(json || {});
  check(`${label} raw task history stripped`, raw, x => !/"history"\s*:/.test(x) && !/"executionHistory"\s*:/.test(x));
  check(`${label} request metadata stripped`, raw, x => !/"requestMeta"\s*:/.test(x) && !/userAgent|should-not-leak/.test(x));
  check(`${label} internal confirm and unsafe hash stripped`, raw, x => {
    const hashes = [...x.matchAll(/"payloadHash":"([^"]*)"/g)].map(match => match[1]);
    return !/SHEIN_OPENAPI_SUBMIT|abc123-should-not-leak|confirmTextPresent|realSubmitWhitelistChecks/.test(x)
      && hashes.every(hash => hash === '' || /^[a-f0-9]{64}$/.test(hash));
  });
  check(`${label} old cross-entry wording stripped`, raw, x => !/飞书|只读建议|回到 BI|dry-run|dry_run|payload hash|store identity mismatch|account_and_merchant_mismatch|查看审计|HL 仓库列表/.test(x));
  return raw;
}

// A self-consistent descriptionMaterialBinding plus matching publish payload
// (fresh from publish-assets) and the replaced payload that publish-assets
// leaves behind. The server projection must report the first as a valid lock
// and the second as a stale lock after a legal publish-assets mutation.
const lockOkLines = {
  ar: ['عربي سطر واحد', 'عربي سطر اثنان', 'عربي سطر ثلاثة', 'عربي سطر أربعة', 'عربي سطر خمسة'],
  en: ['Lock ok line one', 'Lock ok line two', 'Lock ok line three', 'Lock ok line four', 'Lock ok line five'],
  'zh-cn': ['锁定有效一', '锁定有效二', '锁定有效三', '锁定有效四', '锁定有效五'],
};
const staleLines = {
  ar: ['عربي جديد واحد', 'عربي جديد اثنان', 'عربي جديد ثلاثة', 'عربي جديد أربعة', 'عربي جديد خمسة'],
  en: ['Replaced line one', 'Replaced line two', 'Replaced line three', 'Replaced line four', 'Replaced line five'],
  'zh-cn': ['替换一', '替换二', '替换三', '替换四', '替换五'],
};
function descriptionRows(lines) {
  return Object.entries(lines)
    .filter(([language]) => language === 'ar' || language === 'en')
    .map(([language, rows]) => ({language, name: rows.join('\n')}));
}
function buildLockedDescriptionBinding({taskId, targetStore, baseTaskRevision, lines, payload, imageBindingFingerprint = ''}) {
  const hashes = Object.fromEntries(Object.entries(lines).map(([language, rows]) => [language, sha256Utf8(rows.join('\n'))]));
  const sourceFileSha256 = 'a'.repeat(64);
  const contentSha256 = sha256Utf8([sourceFileSha256, hashes.ar, hashes.en, hashes['zh-cn']].join('\n'));
  return {
    schemaVersion: 1,
    kind: 'copy_product_draft',
    sourceApproved: true,
    authority: 'human_reviewed_source',
    sourceProof: DESCRIPTION_SOURCE_PROOF,
    payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
    sourceLabel: 'reviewed-publish.html',
    sourceFileSha256,
    sourceByteLength: 1234,
    baseTaskRevision,
    boundAt: '2026-08-14T00:00:00.000Z',
    boundByUser: 'owner_projection',
    targetStore,
    publishLanguages: ['ar', 'en'],
    lineCounts: {ar: 5, en: 5, 'zh-cn': 5},
    hashes,
    newPayloadHash: sha256StableJson(payload),
    contentSha256,
    bindingRequestKey: descriptionBindingRequestKey({
      taskId,
      targetStore,
      baseTaskRevision,
      contentSha256,
      sourceProof: DESCRIPTION_SOURCE_PROOF,
    }),
    imageBindingFingerprint,
  };
}
const lockOkPayload = {
  category_id: 123456,
  product_type_id: 789,
  skc_list: [{supplier_code: 'SM-505A', sku_list: [{cost_info: {currency: 'SAR', cost_price: '88.00'}, stock_info_list: [{inventory_num: 50}]}]}],
  multi_language_desc_list: descriptionRows(lockOkLines),
};
const stalePayload = {
  category_id: 123456,
  product_type_id: 789,
  skc_list: [{supplier_code: 'SM-505A', sku_list: [{cost_info: {currency: 'SAR', cost_price: '88.00'}, stock_info_list: [{inventory_num: 50}]}]}],
  multi_language_desc_list: descriptionRows(staleLines),
};
const lockOkBinding = buildLockedDescriptionBinding({
  taskId: 'lot_projection_lock_ok_0003',
  targetStore: 'DL',
  baseTaskRevision: 9,
  lines: lockOkLines,
  payload: lockOkPayload,
});
const staleAfterPublishAssetsBinding = buildLockedDescriptionBinding({
  taskId: 'lot_projection_pubassets_stale_0004',
  targetStore: 'DL',
  baseTaskRevision: 8,
  lines: lockOkLines,
  payload: lockOkPayload,
  imageBindingFingerprint: 'a'.repeat(64),
});

let portal = null;
let fakeOpenApi = null;
try {
  const authFile = await writeJson('auth.json', {
    users: [{
      username: 'owner_projection',
      password: 'owner-projection-pass',
      displayName: 'Owner Projection',
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
  const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
  await fs.writeFile(htpasswdFile, '', 'utf8');
  const portalDir = path.join(tmpRoot, 'portal');
  await fs.mkdir(portalDir, {recursive: true});
  await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>BI Ops Projection Test</title>', 'utf8');
  await writeJson('portal/data.json', {generatedAt: new Date().toISOString(), data: {}});
  const taskFile = await writeJson('tasks.json', {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: [{
      id: 'lot_projection_0001',
      title: 'DX SK-1234 改库存',
      command: '把 DX 的 SK-1234 库存改成 100',
      status: 'waiting_review',
      progress: 42,
      chatSessionId: 'los_projection_0001',
      requestedBy: 'Owner Projection',
      requestedByUser: 'owner_projection',
      requestMeta: {ip: '127.0.0.1', userAgent: 'should-not-leak'},
      intents: ['update_inventory'],
      targets: {
        stores: ['DX'],
        writeStores: ['DX'],
        sourceStores: ['QY'],
        productRefs: ['SK-1234'],
      },
      preflight: {
        ok: false,
        blockers: ['store identity mismatch store=DX profile=dx expected=GS7676443 actual=bad'],
        warnings: ['SHEIN_OPENAPI_SUBMIT dry-run payload hash 当前飞书 只读建议'],
      },
      execution: {
        mode: 'controlled_openapi',
        state: 'link_maintenance_preflight_ready',
        preflight: {
          ok: true,
          blockers: [],
          warnings: ['查看审计 payload hash', '库存策略已按用户规则生成草稿库存 100，但正式 OpenAPI 可能还需要仓库 ID，执行前必须用 HL 仓库列表补齐。'],
        },
        writeAudit: {
          requestedMode: 'execute',
          submitted: false,
          confirmTextPresent: true,
          realSubmitWhitelistChecks: [{ruleId: 'secret'}],
          executeAllowed: true,
        },
        linkMaintenancePrechecks: [{
          storeKey: 'DX',
          state: 'ready_for_submit',
          payload: {
            payloadHash: 'abc123-should-not-leak',
            summary: {operations: ['update_inventory']},
          },
          adapterEvidence: {matchedLinksCount: 1},
          publishResult: {code: '0', msg: 'dry-run payload hash'},
        }],
      },
      lifecycle: {lifecycleStatus: 'link_maintenance_preflight_ready'},
      descriptionMaterialBinding: {
        kind: 'copy_product_draft',
        targetStore: 'DX',
        sourceLabel: 'reviewed-source.html',
        sourceFileSha256: '1'.repeat(64),
        sourceByteLength: 1234,
        sourceProof: 'server_verified_html_section_s09',
        contentSha256: '2'.repeat(64),
        publishLanguages: ['ar', 'en'],
        lineCounts: {ar: 5, en: 5, 'zh-cn': 5},
        hashes: {ar: '3'.repeat(64), en: '4'.repeat(64), 'zh-cn': '5'.repeat(64)},
        newPayloadHash: '6'.repeat(64),
        payloadHashAlgorithm: 'sha256-stable-json-v1',
        baseTaskRevision: 7,
        bindingRequestKey: '7'.repeat(64),
      },
      history: [{event: 'old_bad_text', note: '当前飞书是只读建议通道，回到 BI，输入 SHEIN_OPENAPI_SUBMIT'}],
      executionHistory: [{event: 'old_internal', message: 'account_and_merchant_mismatch payload hash'}],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      id: 'lot_projection_copy_0002',
      title: 'DL 505 补链接旧任务',
      command: '标题直接复制QY那条链接的呀。然后电流是1200mA',
      status: 'waiting_review',
      progress: 85,
      chatSessionId: 'los_projection_copy_0002',
      requestedBy: 'Owner Projection',
      requestedByUser: 'owner_projection',
      intents: ['copy_product_draft'],
      targets: {
        stores: ['DL', 'QY'],
        writeStores: ['DL'],
        sourceStores: ['QY'],
        sourceScope: 'all_stores',
        productRefs: ['505', 'SM-505A', 'sv25082869650540305'],
        attributeOverrides: [{attribute_id: 1002323, label: '输入电流', attribute_extra_value: '1200', display_value: '1200mA', attribute_unit: 'mA'}],
      },
      execution: {
        mode: 'openapi_product_executor',
        state: 'openapi_product_preflight_ready',
        preflight: {
          ok: true,
          blockers: [],
          warnings: ['库存策略已按用户规则生成草稿库存 100，但正式 OpenAPI 可能还需要仓库 ID，执行前必须用 HL 仓库列表补齐。'],
        },
        openApiProductExecutors: [{
          storeKey: 'DL',
          sourceStore: 'QY',
          sourceSkc: 'sv25082869650540305',
          state: 'ready_for_submit',
          safety: {executeRequiresConfirm: 'SHEIN_OPENAPI_SUBMIT'},
        }],
      },
      lifecycle: {lifecycleStatus: 'openapi_product_preflight_ready'},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      id: 'lot_projection_lock_ok_0003',
      title: 'DL 锁定有效描述绑定投影',
      status: 'waiting_review',
      progress: 10,
      requestedBy: 'Owner Projection',
      requestedByUser: 'owner_projection',
      intents: ['copy_product_draft'],
      targets: {stores: ['DL'], writeStores: ['DL'], sourceStores: ['QY'], productRefs: ['SM-505A']},
      openapiPublishPayload: lockOkPayload,
      descriptionMaterialBinding: lockOkBinding,
      repositoryRevision: 11,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, {
      id: 'lot_projection_pubassets_stale_0004',
      title: 'DL publish-assets 后旧描述锁投影过期',
      status: 'waiting_review',
      progress: 10,
      requestedBy: 'Owner Projection',
      requestedByUser: 'owner_projection',
      intents: ['copy_product_draft'],
      targets: {stores: ['DL'], writeStores: ['DL'], sourceStores: ['QY'], productRefs: ['SM-505A']},
      openapiPublishPayload: stalePayload,
      publishAssetBinding: {
        schemaVersion: 1,
        kind: 'copy_product_draft',
        sourceApproved: true,
        authority: 'human_reviewed_source',
        targetStore: 'DL',
        boundAt: '2026-08-14T01:00:00.000Z',
        boundByUser: 'owner_projection',
        bindingFingerprint: 'b'.repeat(64),
        imageCount: 5,
        images: [],
      },
      descriptionMaterialBinding: staleAfterPublishAssetsBinding,
      repositoryRevision: 13,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  });
  const chatFile = await writeJson('chats.json', {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: [{
      id: 'los_projection_0001',
      version: 1,
      status: 'chatting',
      title: '旧助手消息投影',
      autoTitle: true,
      codexSessionId: 'raw-codex-session-should-not-leak',
      requestMeta: {ip: '127.0.0.1', userAgent: 'should-not-leak'},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{
        id: 'msg_user_projection',
        role: 'user',
        content: '把 DX 的 SK-1234 库存改成 100',
        at: new Date().toISOString(),
      }, {
        id: 'msg_assistant_projection',
        role: 'assistant',
        content: '当前飞书是只读建议通道，请回到 BI 输入 SHEIN_OPENAPI_SUBMIT，payload hash abc123-should-not-leak，查看审计。',
        at: new Date().toISOString(),
        meta: {mode: 'old', codexSessionId: 'raw-codex-session-should-not-leak', autoTaskId: 'lot_projection_0001'},
      }],
    }],
  });
  const stateFile = await writeJson('action_state.json', {version: 1, updatedAt: null, actions: {}});
  const auditFile = path.join(tmpRoot, 'audit.jsonl');
  const sessionSecretFile = path.join(tmpRoot, 'session_secret');
  await provisionBiSessionSecret(sessionSecretFile);
  const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
  const fakeOpenApiPort = await freePort();
  fakeOpenApi = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify({code: '0', msg: 'projection-test', info: {}, data: {}}));
  });
  await new Promise((resolve, reject) => {
    fakeOpenApi.once('error', reject);
    fakeOpenApi.listen(fakeOpenApiPort, '127.0.0.1', resolve);
  });
  const openapiConfigFile = await writeJson('openapi.json', {
    environment: 'projection-test',
    market: 'SA',
    cooperationMode: '半托管',
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakeOpenApiPort}/openapi`},
    stores: [{
      storeKey: 'DX',
      enabled: true,
      openKeyId: 'dummy-open-key',
      secretKey: 'dummy-secret',
    }, {
      storeKey: 'HL',
      enabled: true,
      openKeyId: 'dummy-open-key-hl',
      secretKey: 'dummy-secret-hl',
    }],
    safeWriteOperations: {
      enabled: true,
      requireDryRun: true,
      allowedOperations: ['update_inventory'],
      allowedStores: ['DX'],
    },
  });
  const whitelistFile = await writeJson('whitelist.json', {
    enabled: true,
    rules: [{
      id: 'dx-inventory-owner',
      enabled: true,
      realSubmit: true,
      stores: ['DX'],
      operations: ['update_inventory'],
      allowedUsers: ['owner_projection'],
      allowedRoles: ['owner'],
    }],
  });
  const probeFile = await writeJson('probe.json', {
    generatedAt: new Date().toISOString(),
    counts: {ok: 2, total: 2},
    results: [
      {storeKey: 'DX', ok: true, status: 'read_probe_ok'},
      {storeKey: 'HL', ok: true, status: 'read_probe_ok'},
    ],
  });
  const portalPort = await freePort();
  const baseUrl = `http://127.0.0.1:${portalPort}`;
  portal = spawn(process.execPath, [
    'scripts/serve_bi_portal.mjs',
    '--host', '127.0.0.1',
    '--port', String(portalPort),
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
      SHEIN_OPENAPI_READ_PROBE_SUMMARY_FILE: probeFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  portal.stdout.on('data', data => { stdout += data.toString(); });
  portal.stderr.on('data', data => { stderr += data.toString(); });
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  check('portal ready', ready, true);
  const login = await req(baseUrl, '/api/login', {
    method: 'POST',
    body: {username: 'owner_projection', password: 'owner-projection-pass'},
  });
  const cookie = (login.headers.get('set-cookie') || '').match(/bi_session=[^;]+/)?.[0] || '';
  check('login status', login.status, 200);
  check('login cookie present', Boolean(cookie), true);

  const tasks = await req(baseUrl, '/api/link-ops-tasks?limit=10', {cookie});
  const task = tasks.json?.data?.tasks?.[0] || {};
  check('tasks status', tasks.status, 200);
  check('task id preserved', task.id || '', 'lot_projection_0001');
  check('target store preserved', task.targets?.stores || [], xs => Array.isArray(xs) && xs.includes('DX'));
  check('operation summary preserved', task.execution?.linkMaintenancePrechecks?.[0]?.payload?.summary?.operations || [], xs => Array.isArray(xs) && xs.includes('update_inventory'));
  check('matched link count preserved', task.execution?.linkMaintenancePrechecks?.[0]?.adapterEvidence?.matchedLinksCount, 1);
  check('safe description binding identity is projected for idempotent CLI replay', task.descriptionMaterialBinding || {}, value => (
    value?.baseTaskRevision === 7
    && value?.bindingRequestKey === '7'.repeat(64)
    && value?.contentSha256 === '2'.repeat(64)
    && !Object.prototype.hasOwnProperty.call(value, 'boundByUser')
  ));
  check('description binding lock projection is compact and stale for a bound task', task.descriptionBindingLock, value => (
    value
    && value.ok === false
    && value.stale === true
    && value.baseTaskRevision === 7
    && value.currentRevision === task.repositoryRevision
    && Object.keys(value).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && !Object.prototype.hasOwnProperty.call(value, 'newPayloadHash')
    && !Object.prototype.hasOwnProperty.call(value, 'hashes')
    && !Object.prototype.hasOwnProperty.call(value, 'descriptionMaterialBinding')
  ));
  assertNoRawTaskLeak('GET /api/link-ops-tasks', tasks.json);
  const copyTask = tasks.json?.data?.tasks?.find(row => row?.id === 'lot_projection_copy_0002') || {};
  check('unbound task carries no description binding lock', copyTask.descriptionBindingLock, null);
  const lockOkTask = tasks.json?.data?.tasks?.find(row => row?.id === 'lot_projection_lock_ok_0003') || {};
  check('current description binding lock projection is ok', lockOkTask.descriptionBindingLock, value => (
    value
    && value.ok === true
    && value.stale === false
    && value.baseTaskRevision === 9
    && value.currentRevision === 11
    && Object.keys(value).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && !Object.prototype.hasOwnProperty.call(value, 'newPayloadHash')
    && !Object.prototype.hasOwnProperty.call(value, 'hashes')
    && !Object.prototype.hasOwnProperty.call(value, 'descriptionMaterialBinding')
  ));
  const staleAfterPublishAssetsTask = tasks.json?.data?.tasks?.find(row => row?.id === 'lot_projection_pubassets_stale_0004') || {};
  check('post publish-assets description binding lock projection is stale', staleAfterPublishAssetsTask.descriptionBindingLock, value => (
    value
    && value.ok === false
    && value.stale === true
    && value.baseTaskRevision === 8
    && value.currentRevision === 13
    && Object.keys(value).sort().join(',') === 'baseTaskRevision,currentRevision,ok,stale'
    && !Object.prototype.hasOwnProperty.call(value, 'newPayloadHash')
    && !Object.prototype.hasOwnProperty.call(value, 'hashes')
  ));
  check('old copy task target normalized to write store only', copyTask.targets?.stores || [], xs => Array.isArray(xs) && xs.length === 1 && xs.includes('DL'));
  check('old copy task keeps source store only as source', copyTask.targets?.sourceStores || [], xs => Array.isArray(xs) && xs.length === 1 && xs.includes('QY'));
  check('old copy task hides source SKC from target product refs when product ref exists', copyTask.targets?.productRefs || [], xs => Array.isArray(xs) && xs.includes('505') && xs.includes('SM-505A') && !xs.includes('sv25082869650540305'));

  const caps = await req(baseUrl, '/api/openapi-capabilities', {cookie});
  const dxCap = (caps.json?.rows || []).find(row => String(row?.storeKey || '') === 'DX') || {};
  const dxInventory = (dxCap.actionCapabilities || []).find(action => action.key === 'update_inventory') || {};
  const dxCampaign = (dxCap.actionCapabilities || []).find(action => action.key === 'campaign_signup') || {};
  check('capabilities status', caps.status, 200);
  check('capabilities keeps rows', (caps.json?.rows || []).length, n => Number(n) >= 2);
  check('capabilities keeps actionable booleans', Boolean(dxInventory.realSubmitSupported), true);
  check('capabilities maps action state to client state', dxInventory.state || '', 'ready');
  check('capabilities keeps unavailable action as not available', dxCampaign.state || '', 'not_available');
  check('capabilities strips required confirm text field', JSON.stringify(caps.json || {}), x => !/requiredConfirmText|confirmableState|realSubmitRequirements/.test(x));
  check('capabilities strips internal dry-run/hash wording', JSON.stringify(caps.json || {}), x => !/SHEIN_OPENAPI_SUBMIT|dry[-_ ]?run|payload hash|payloadHash|确认文本|验证器|任务池|飞书|只读建议|回到 BI/.test(x));

  const scopedTasks = await req(baseUrl, '/api/link-ops-tasks?limit=10&sessionId=los_projection_copy_0002', {cookie});
  check('session-scoped task GET status', scopedTasks.status, 200);
  check('session-scoped task GET only returns matching session tasks', scopedTasks.json?.data?.tasks?.map(row => row.id) || [], xs => Array.isArray(xs) && xs.length === 1 && xs[0] === 'lot_projection_copy_0002');
  assertNoRawTaskLeak('GET /api/link-ops-tasks scoped', scopedTasks.json);

  const created = await req(baseUrl, '/api/link-ops-tasks', {
    method: 'POST',
    cookie,
    body: {
      command: '把 DX 的 SK-1234 库存改成 100',
      targets: {stores: ['DX'], writeStores: ['DX'], productRefs: ['SK-1234']},
    },
  });
  check('task POST status', created.status, 200);
  check('task POST projected task id present', Boolean(created.json?.task?.id), true);
  assertNoRawTaskLeak('POST /api/link-ops-tasks', created.json);

  const patched = await req(baseUrl, '/api/link-ops-tasks', {
    method: 'PATCH',
    cookie,
    body: {id: 'lot_projection_0001', progress: 55, event: 'projection_patch'},
  });
  check('task PATCH status', patched.status, 200);
  check('task PATCH projected progress', patched.json?.task?.progress, 55);
  assertNoRawTaskLeak('PATCH /api/link-ops-tasks', patched.json);

  const uploaded = await req(baseUrl, '/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      taskId: 'lot_projection_0001',
      files: [{
        name: 'projection-note.txt',
        type: 'text/plain',
        dataBase64: Buffer.from('projection upload smoke', 'utf8').toString('base64'),
      }, {
        name: 'projection-plan.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dataBase64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]).toString('base64'),
      }],
    },
  });
  if (uploaded.status !== 200) result.assetUploadError = uploaded.json || uploaded.text;
  check('assets POST status', uploaded.status, 200);
  check('assets POST projected asset count', uploaded.json?.assets?.length || 0, 2);
  check('assets POST accepts xlsx as spreadsheet', uploaded.json?.assets?.some?.(a => a.name === 'projection-plan.xlsx' && a.kind === 'spreadsheet'), true);
  check('assets POST hides raw asset sha256/path', JSON.stringify(uploaded.json || {}), x => !/"sha256"\s*:|storedRelativePath|storedName/.test(x));
  assertNoRawTaskLeak('POST /api/link-ops-assets', uploaded.json);

  const sessionUploaded = await req(baseUrl, '/api/link-ops-assets', {
    method: 'POST',
    cookie,
    body: {
      files: [{
        name: 'session-upload-note.txt',
        type: 'text/plain',
        dataBase64: Buffer.from('session level upload smoke', 'utf8').toString('base64'),
      }],
    },
  });
  const uploadedSessionId = String(sessionUploaded.json?.session?.id || '');
  check('session assets POST status', sessionUploaded.status, 200);
  check('session assets POST creates/returns session', Boolean(uploadedSessionId), true);
  check('session assets POST does not require task', sessionUploaded.json?.task, null);
  check('session assets POST projects asset in session', sessionUploaded.json?.session?.assets?.some?.(a => a.name === 'session-upload-note.txt' && a.kind === 'text'), true);
  check('session assets POST writes human chat message', sessionUploaded.json?.session?.messages?.at?.(-1)?.content || '', x => /当前会话资料|已放到当前会话资料/.test(String(x)));
  check('session assets POST hides raw asset sha256/path', JSON.stringify(sessionUploaded.json || {}), x => !/"sha256"\s*:|storedRelativePath|storedName/.test(x));
  assertNoRawTaskLeak('POST /api/link-ops-assets session-only', sessionUploaded.json);

  const chatWithSessionAsset = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {
      sessionId: uploadedSessionId,
      message: '把 DX 的 SK-1234 库存改成 100',
      askAgent: false,
    },
  });
  const sessionAssetTask = chatWithSessionAsset.json?.autoTask || {};
  check('chat after session upload status', chatWithSessionAsset.status, 200);
  check('chat after session upload creates task', Boolean(sessionAssetTask.id), true);
  check('chat after session upload inherits uploaded asset', sessionAssetTask.assets?.some?.(a => a.name === 'session-upload-note.txt' && a.kind === 'text'), true);
  check('chat after session upload keeps asset in session projection', chatWithSessionAsset.json?.session?.assets?.some?.(a => a.name === 'session-upload-note.txt'), true);
  assertNoRawTaskLeak('POST /api/link-ops-chats after session upload', chatWithSessionAsset.json);

  const executed = await req(baseUrl, '/api/link-ops-execute', {
    method: 'POST',
    cookie,
    body: {id: 'lot_projection_0001', mode: 'execute', confirm: 'SHEIN_OPENAPI_SUBMIT'},
  });
  check('execute POST status', executed.status, 200);
  check('execute POST projected task id', executed.json?.task?.id || '', 'lot_projection_0001');
  assertNoRawTaskLeak('POST /api/link-ops-execute', executed.json);

  const chats = await req(baseUrl, '/api/link-ops-chats?limit=10', {cookie});
  const projectionChatSession = (chats.json?.data?.sessions || []).find(row => row?.id === 'los_projection_0001') || {};
  check('chats GET status', chats.status, 200);
  check('chats GET assistant old wording sanitized', JSON.stringify(chats.json || {}), x => !/飞书|只读建议|回到 BI|SHEIN_OPENAPI_SUBMIT|payload hash|查看审计|raw-codex-session/.test(x));
  check('chats GET keeps autoTaskId meta', projectionChatSession?.messages?.[1]?.meta?.autoTaskId || '', 'lot_projection_0001');

  const chatPost = await req(baseUrl, '/api/link-ops-chats', {
    method: 'POST',
    cookie,
    body: {message: '把 DX 的 SK-1234 库存改成 100', askAgent: false},
  });
  check('chats POST status', chatPost.status, 200);
  check('chats POST autoTask projected', Boolean(chatPost.json?.autoTask?.id), true);
  assertNoRawTaskLeak('POST /api/link-ops-chats', chatPost.json);
  result.ok = result.checks.every(row => row.pass);
} finally {
  if (portal) portal.kill('SIGTERM');
  if (fakeOpenApi) await new Promise(resolve => fakeOpenApi.close(resolve));
  await sleep(200);
}

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
