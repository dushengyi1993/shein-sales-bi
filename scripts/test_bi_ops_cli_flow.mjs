import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {buildOwnerKnowledgeDistribution} from '../lib/owner_knowledge_distribution.mjs';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliSource = await fs.readFile(path.join(ROOT, 'scripts', 'bi_ops_cli.mjs'), 'utf8');
if (!cliSource.includes("process.env.SHEIN_BI_BASE_URL || 'https://sa.dushengyi.cc'")) {
  throw new Error('bi_ops_cli default URL must use the current production BI entry');
}
if (cliSource.includes('shein-bi.dushengyi.xyz')) {
  throw new Error('bi_ops_cli still references the retired BI hostname');
}
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-cli-flow-smoke-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const portalDir = path.join(tmpRoot, 'portal');
const portalSectionsDir = path.join(portalDir, 'sections');
const portalGeneration = '2026-07-28T12:00:00.000+08:00';
await fs.mkdir(portalSectionsDir, {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>CLI flow portal</title>', 'utf8');
await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({
  generatedAt: portalGeneration,
  dates: {
    salesDate: '2026-07-28',
    salesUpdatedAt: '2026-07-28T11:59:00.000+08:00',
    linkDate: '2026-07-28',
    linkUpdatedAt: '2026-07-28T08:30:00.000+08:00',
  },
  stores: [
    {store_key: 'DX', label: 'DX 店'},
    {store_key: 'HL', label: 'HL 店'},
  ],
  productDisplayNames: {'PA4-6L': '测试商品'},
  __sections: {
    mode: 'api',
    generatedAt: portalGeneration,
    keys: ['homeRankings', 'liveSalesToday'],
    loaded: ['core'],
  },
}), 'utf8');
for (const [section, data] of Object.entries({
  homeRankings: {
    rankings: {
      salesSummary: [{period_key: 'day', start_date: '2026-07-28', end_date: '2026-07-28', gross_sales_sar: 300, sales_sar: 300, gross_orders: 3, orders: 3, gross_quantity: 3, quantity: 3}],
      dailyStores: [
        {date: '2026-07-28', store_key: 'DX', gross_sales_sar: 100, sales_sar: 100, gross_orders: 1, orders: 1, gross_quantity: 1, quantity: 1},
        {date: '2026-07-28', store_key: 'HL', gross_sales_sar: 200, sales_sar: 200, gross_orders: 2, orders: 2, gross_quantity: 2, quantity: 2},
      ],
      dailyProducts: [{date: '2026-07-28', standard_goods_sn: 'PA4-6L', gross_sales_sar: 300, sales_sar: 300, gross_orders: 3, orders: 3, gross_quantity: 3, quantity: 3}],
      dailyStoreProducts: [
        {date: '2026-07-28', store_key: 'DX', standard_goods_sn: 'PA4-6L', gross_sales_sar: 100, sales_sar: 100},
        {date: '2026-07-28', store_key: 'HL', standard_goods_sn: 'PA4-6L', gross_sales_sar: 200, sales_sar: 200},
      ],
    },
  },
  liveSalesToday: {
    liveSalesToday: {
      date: '2026-07-28',
      generatedAt: portalGeneration,
      accountingPending: false,
      items: [
        {store_key: 'DX', order_no: 'DX-1', standard_goods_sn: 'PA4-6L', gross_revenue_sar: 100},
        {store_key: 'HL', order_no: 'HL-1', standard_goods_sn: 'PA4-6L', gross_revenue_sar: 200},
      ],
      profitStoreRows: [],
    },
  },
})) {
  await fs.writeFile(path.join(portalSectionsDir, `${section}.json`), JSON.stringify({
    ok: true,
    section,
    generatedAt: portalGeneration,
    cachedAt: '2026-07-28T04:00:00.000Z',
    data,
    run: null,
  }), 'utf8');
}

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
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
}

function sendJson(res, value, status = 200, headers = {}) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', ...headers});
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

function runNode(args, {env = {}} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, ...env},
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.once('error', reject);
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

const authFile = await writeJson('auth.json', {
  users: [
    {
      username: 'owner_cli_smoke',
      password: 'owner-cli-pass',
      displayName: 'Owner CLI Smoke',
      role: 'owner',
      readStores: ['*'],
      writeStores: ['*'],
      ownerKey: 'OWNER',
    },
    {
      username: 'operator_cli_smoke',
      password: 'operator-cli-pass',
      displayName: 'Operator CLI Smoke',
      role: 'operator',
      readStores: ['*'],
      writeStores: ['DX', 'LQ', 'XC'],
      ownerKey: 'YANGHUAN',
    },
  ],
});
const accessRolesFile = await writeJson('access_roles.json', {
  defaults: {
    admin: {readStores: ['*'], writeStores: ['*']},
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
const runtimeFile = path.join(tmpRoot, 'runtime.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
await provisionBiSessionSecret(sessionSecretFile);
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const ownerSessionFile = path.join(tmpRoot, 'owner-session.json');
const operatorSessionFile = path.join(tmpRoot, 'operator-session.json');
const fakeCodexJs = path.join(tmpRoot, 'fake-codex.mjs');
const knowledgeCacheDir = path.join(tmpRoot, 'knowledge-cache');
await fs.writeFile(fakeCodexJs, `
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
for await (const _chunk of process.stdin) {}
const plan = ${JSON.stringify({
  version: 1,
  requestType: 'action',
  intents: ['update_inventory'],
  stores: ['DX'],
  sourceStores: [],
  productRefs: ['PA4-6L'],
  parameters: {
    timeRange: '', dateFrom: '', dateTo: '', metrics: [], groupBy: '', comparison: '', rankDirection: '',
    limit: null, title: '', inventory: 30, supplyPrice: null, productPrice: null, currency: '',
    discountRate: null, discountPrice: null, quantity: null, activityId: '', startAt: '', endAt: '',
    sourceScope: '', standardGoodsSn: 'PA4-6L', attributeOverrides: [], imageInstruction: '', actionNote: '',
  },
  ambiguity: {hasAmbiguity: false, reasons: [], clarifyingQuestions: []},
  risk: {level: 'medium', writeRequested: true, requiresHumanConfirmation: true, reasons: ['库存修改需人工确认。']},
  confidence: 0.96,
  summary: '把 DX 的 PA4-6L 库存改为 30；只完成结构化规划，不直接提交。',
})};
await fs.writeFile(output, JSON.stringify(plan), 'utf8');
`, 'utf8');

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
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
  '--link-ops-runtime-file', runtimeFile,
  '--manual-login-state-file', manualLoginStateFile,
  '--audit-file', auditFile,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    SHEIN_BI_CORE_WARMUP_DISABLED: '1',
    SHEIN_LINK_OPS_STORE: 'json',
    SHEIN_BI_INTENT_PLANNER_ENABLED: '1',
    SHEIN_BI_JOB_WORKER_ENABLED: '1',
    SHEIN_BI_JOB_POLL_MS: '100',
    SHEIN_BI_JOB_LEASE_MS: '60000',
    SHEIN_BI_CODEX_BIN: process.execPath,
    SHEIN_BI_CODEX_ARGS_PREFIX_JSON: JSON.stringify([fakeCodexJs]),
    SHEIN_OPENAPI_CONFIG_FILE: openapiConfigFile,
    SHEIN_BI_OPS_WRITE_WHITELIST_FILE: whitelistFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverStdout = '';
let serverStderr = '';
server.stdout.on('data', d => { serverStdout += d.toString(); });
server.stderr.on('data', d => { serverStderr += d.toString(); });

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited code=${server.exitCode}\nstdout=${serverStdout}\nstderr=${serverStderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`server not ready\nstdout=${serverStdout}\nstderr=${serverStderr}`);
}

function runCli(cliArgs, {input = '', baseUrl: cliBaseUrl = null, knowledgeCacheDir: cliKnowledgeCacheDir = null} = {}) {
  return new Promise((resolve) => {
    const targetBaseUrl = cliBaseUrl || baseUrl;
    const targetKnowledgeCacheDir = cliKnowledgeCacheDir || knowledgeCacheDir;
    const child = spawn(process.execPath, ['scripts/bi_ops_cli.mjs', '--base-url', targetBaseUrl, '--knowledge-cache-dir', targetKnowledgeCacheDir, ...cliArgs], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, SHEIN_BI_BASE_URL: targetBaseUrl},
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      let errorJson = null;
      try { errorJson = stderr.trim() ? JSON.parse(stderr) : null; } catch {}
      resolve({code, stdout, stderr, json, errorJson});
    });
  });
}

const result = {ok: false, tmpRoot, baseUrl, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}
function expectCliOk(label, run) {
  check(`${label} exit`, run.code, 0);
  check(`${label} ok`, run.json?.ok, true);
}
function expectCliBlocked(label, run) {
  check(`${label} exit`, run.code, 75);
  check(`${label} ok`, run.json?.ok, false);
  check(`${label} committed`, run.json?.committed, true);
  check(`${label} partial`, run.json?.partial, true);
  check(`${label} outcome`, run.json?.outcome, 'blocked');
}

async function runMaintenanceExecutorOutcomeFixture() {
  const fixtureRoot = path.join(tmpRoot, 'p1-maintenance-executor');
  const calls = [];
  let inventoryValue = 7;
  const fakeOpenApi = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const body = await readJsonBody(req);
    calls.push({method: req.method, path: pathname, body});
    if (pathname === '/open-api/openapi-business-backend/query-store-info') {
      return sendJson(res, {code: '0', msg: 'OK', info: {shopName: 'P1 Fixture Store'}});
    }
    if (pathname === '/open-api/goods/query-site-list') {
      return sendJson(res, {code: '0', msg: 'OK', info: [{sub_site_list: [{site_abbr: 'shein-sa', currency: 'SAR'}]}]});
    }
    if (pathname === '/open-api/msc/warehouse/list') {
      return sendJson(res, {code: '0', msg: 'OK', info: {list: [{warehouseCode: 'WH-1', warehouseName: 'Saudi fixture', saleCountryList: ['SA']}]}});
    }
    if (pathname === '/open-api/goods/product/partialEdit') {
      const title = body?.multi_language_name_list?.find(row => row?.language === 'en')?.name || '';
      const row = body?.skc_list?.[0] || {};
      if (body?.spu_name !== 'spu-p1-title' || row.skc_name !== 'sv-p1-title' || title !== 'P1 Confirmed Title') {
        return sendJson(res, {code: '400', msg: 'invalid title fixture payload'});
      }
      return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-p1-title', info: {success: true, version: 'P1-TITLE-V1'}});
    }
    if (pathname === '/open-api/stock/change-inventory/v2') {
      const row = body?.updateSkuInventoryQuantityRequests?.[0] || {};
      if (row.skuCode !== 'sku-p1-inventory' || row.changeQuantity !== 30 || row.changeType !== 'OVERWRITE' || row.warehouseCode !== 'WH-1') {
        return sendJson(res, {code: '400', msg: 'invalid inventory fixture payload'});
      }
      inventoryValue = 30;
      return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-p1-inventory'});
    }
    if (pathname === '/open-api/stock/stock-query') {
      return sendJson(res, {code: '0', msg: 'OK', info: [{goodsInventory: [{
        skcName: 'sv-p1-inventory',
        skuList: [{skuCode: 'sku-p1-inventory', totalUsableInventory: inventoryValue}],
      }]}]});
    }
    if (pathname === '/open-api/openapi-business-backend/product/query') {
      return sendJson(res, {code: '0', msg: 'OK', info: {data: [
        {skcName: 'sv-p1-title', spuName: 'spu-p1-title', supplierCode: 'P1-TITLE', skuCodeList: ['sku-p1-title']},
        {skcName: 'sv-p1-inventory', spuName: 'spu-p1-inventory', supplierCode: 'P1-INVENTORY', skuCodeList: ['sku-p1-inventory']},
      ]}});
    }
    return sendJson(res, {code: '404', msg: `Unhandled fixture endpoint ${pathname}`}, 404);
  });

  const fakeBaseUrl = await listenLoopback(fakeOpenApi);
  try {
    const configFile = await writeJson('p1-maintenance-executor/openapi.json', {
      apiBaseUrls: {prodSemiManaged: fakeBaseUrl},
      stores: [{storeKey: 'SMK', enabled: true, openKeyId: 'fixture-open-key', secretKey: 'fixture-secret-key'}],
    });
    const biDir = path.join(fixtureRoot, 'bi-portal');
    await writeJson('p1-maintenance-executor/bi-portal/sections/linksData.json', {
      data: {storeLinks: [
        {store_key: 'SMK', skc: 'sv-p1-title', spu: 'spu-p1-title', standard_goods_sn: 'P1-TITLE', is_on_shelf: true},
        {store_key: 'SMK', skc: 'sv-p1-inventory', spu: 'spu-p1-inventory', standard_goods_sn: 'P1-INVENTORY', is_on_shelf: true},
      ]},
    });
    const productCacheDir = path.join(fixtureRoot, 'products');
    await writeJson('p1-maintenance-executor/products/SMK/latest.json', {
      normalizedRows: [
        {storeKey: 'SMK', skc: 'sv-p1-title', spu: 'spu-p1-title', supplierCode: 'P1-TITLE', skuCodes: ['sku-p1-title']},
        {storeKey: 'SMK', skc: 'sv-p1-inventory', spu: 'spu-p1-inventory', supplierCode: 'P1-INVENTORY', skuCodes: ['sku-p1-inventory']},
      ],
    });
    const outDir = path.join(fixtureRoot, 'out');
    const commonArgs = [
      'scripts/link_ops_maintenance_openapi_executor.mjs',
      '--config', configFile,
      '--store', 'SMK',
      '--dir', biDir,
      '--product-cache-dir', productCacheDir,
      '--out-dir', outDir,
    ];
    const runExecutor = (extraArgs) => runNode([...commonArgs, ...extraArgs], {
      env: {NODE_ENV: 'test', SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1'},
    });
    const executeSnapshot = async (name, task, payloadHash, nonce) => writeJson(name, {
      version: 1,
      executionContext: {
        expectedPayloadHash: payloadHash,
        writeClaim: {
          schemaVersion: 1,
          claimId: `claim-${task.id}`,
          nonce,
          taskId: task.id,
          storeKey: 'SMK',
          operations: task.intents,
          expectedPayloadHash: payloadHash,
          claimedAt: '2026-08-18T00:00:00.000Z',
          claimedBy: 'p1-cli-flow-fixture',
          state: 'claimed',
        },
      },
      tasks: [task],
    });

    const titleTask = {
      id: 'p1-title-unconfirmed',
      status: 'waiting_review',
      command: '使用结构化参数更新标题',
      planning: {source: 'structured_cli', parameters: {title: 'P1 Confirmed Title'}},
      targets: {stores: ['SMK'], productRefs: ['P1-TITLE']},
      intents: ['update_title'],
    };
    const titleDryFile = await writeJson('p1-maintenance-executor/title-dry.json', {version: 1, tasks: [titleTask]});
    const titleDryCallStart = calls.length;
    const titleDry = await runExecutor(['--task-id', titleTask.id, '--task-json', titleDryFile, '--dry-run']);
    const titleDryCalls = calls.slice(titleDryCallStart);
    check('P1 title dry-run exits 0', titleDry.code, 0);
    check('P1 title dry-run ready', titleDry.json?.ok, true);
    check('P1 title dry-run outcome', titleDry.json?.outcome, 'ready');
    check('P1 title dry-run is not committed', titleDry.json?.committed, false);
    check('P1 title dry-run is not partial', titleDry.json?.partial, false);
    check('P1 title dry-run never writes', titleDryCalls.some(call => call.path === '/open-api/goods/product/partialEdit'), false);
    const titleHash = titleDry.json?.payload?.payloadHash || '';
    check('P1 title dry-run locks payload hash', titleHash, value => /^[a-f0-9]{64}$/.test(String(value || '')));

    const titleNoClaimFile = await writeJson('p1-maintenance-executor/title-no-claim.json', {
      version: 1,
      executionContext: {expectedPayloadHash: titleHash},
      tasks: [titleTask],
    });
    const titleNoClaimCallStart = calls.length;
    const titleNoClaim = await runExecutor(['--task-id', titleTask.id, '--task-json', titleNoClaimFile, '--execute', '--confirm', 'SHEIN_OPENAPI_SUBMIT']);
    const titleNoClaimCalls = calls.slice(titleNoClaimCallStart);
    check('P1 title execute without durable claim is blocked', titleNoClaim.json?.outcome, 'blocked');
    check('P1 title execute without durable claim is not committed', titleNoClaim.json?.committed, false);
    check('P1 title execute without durable claim never writes', titleNoClaimCalls.some(call => call.path === '/open-api/goods/product/partialEdit'), false);
    check('P1 title durable claim blocker is explicit', titleNoClaim.json?.blockers || [], rows => rows.some(row => /write-claim/.test(String(row))));

    const titleNonce = 'nonce-p1-title-unconfirmed';
    const titleExecuteFile = await executeSnapshot('p1-maintenance-executor/title-execute.json', titleTask, titleHash, titleNonce);
    const titleExecuteCallStart = calls.length;
    const titleExecute = await runExecutor(['--task-id', titleTask.id, '--task-json', titleExecuteFile, '--execute', '--confirm', 'SHEIN_OPENAPI_SUBMIT', '--claim-nonce', titleNonce]);
    const titleExecuteCalls = calls.slice(titleExecuteCallStart);
    check('P1 unconfirmed executor process exits deterministically', titleExecute.code, 0);
    check('P1 unconfirmed executor top-level ok false', titleExecute.json?.ok, false);
    check('P1 unconfirmed executor partial true', titleExecute.json?.partial, true);
    check('P1 unconfirmed executor outcome', titleExecute.json?.outcome, 'unconfirmed');
    check('P1 unconfirmed executor committed true', titleExecute.json?.committed, true);
    check('P1 unconfirmed executor state stays submitted', titleExecute.json?.state, 'submitted');
    check('P1 unconfirmed executor keeps locked payload hash', titleExecute.json?.payload?.payloadHash, titleHash);
    check('P1 unconfirmed executor keeps adapter real-submit evidence', titleExecute.json?.adapterEvidence?.realSubmit, true);
    check('P1 unconfirmed executor keeps adapter write-attempt evidence', titleExecute.json?.adapterEvidence?.writeAttempted, true);
    check('P1 unconfirmed executor keeps validated durable claim', titleExecute.json?.adapterEvidence?.writeClaim?.validated, true);
    check('P1 unconfirmed executor keeps durable claim id', titleExecute.json?.adapterEvidence?.writeClaim?.claimId, `claim-${titleTask.id}`);
    check('P1 unconfirmed executor binds durable claim payload hash', titleExecute.json?.adapterEvidence?.writeClaim?.expectedPayloadHash, titleHash);
    check('P1 unconfirmed executor binds durable claim operations', titleExecute.json?.adapterEvidence?.writeClaim?.operations || [], rows => rows.length === 1 && rows[0] === 'update_title');
    check('P1 unconfirmed executor never echoes claim nonce', titleExecute.json?.adapterEvidence?.writeClaim?.nonce, undefined);
    check('P1 unconfirmed executor keeps phase result', titleExecute.json?.adapterEvidence?.phaseResults?.[0]?.operation, 'update_title');
    check('P1 unconfirmed executor keeps successful adapter code', titleExecute.json?.adapterEvidence?.phaseResults?.[0]?.code, '0');
    check('P1 unconfirmed executor keeps publish result', titleExecute.json?.publishResult?.code, '0');
    check('P1 unconfirmed executor readback is not upgraded', titleExecute.json?.readback?.ok, false);
    check('P1 unconfirmed executor records title readback mismatch', titleExecute.json?.readback?.status, 'title_readback_mismatch');
    check('P1 unconfirmed executor readback fingerprint matches hash', titleExecute.json?.readbackFingerprint?.payloadHash, titleHash);
    check('P1 unconfirmed executor performs one real title write', titleExecuteCalls.filter(call => call.path === '/open-api/goods/product/partialEdit').length, 1);

    const inventoryTask = {
      id: 'p1-inventory-confirmed',
      status: 'waiting_review',
      command: '使用结构化参数更新库存',
      planning: {source: 'structured_cli', parameters: {inventory: 30}},
      targets: {stores: ['SMK'], productRefs: ['P1-INVENTORY']},
      intents: ['update_inventory'],
    };
    const inventoryDryFile = await writeJson('p1-maintenance-executor/inventory-dry.json', {version: 1, tasks: [inventoryTask]});
    const inventoryDryCallStart = calls.length;
    const inventoryDry = await runExecutor(['--task-id', inventoryTask.id, '--task-json', inventoryDryFile, '--dry-run']);
    const inventoryDryCalls = calls.slice(inventoryDryCallStart);
    check('P1 inventory dry-run exits 0', inventoryDry.code, 0);
    check('P1 inventory dry-run ready', inventoryDry.json?.ok, true);
    check('P1 inventory dry-run outcome', inventoryDry.json?.outcome, 'ready');
    check('P1 inventory dry-run is not committed', inventoryDry.json?.committed, false);
    check('P1 inventory dry-run never writes', inventoryDryCalls.some(call => call.path === '/open-api/stock/change-inventory/v2'), false);
    const inventoryHash = inventoryDry.json?.payload?.payloadHash || '';
    check('P1 inventory dry-run locks payload hash', inventoryHash, value => /^[a-f0-9]{64}$/.test(String(value || '')));
    const inventoryNonce = 'nonce-p1-inventory-confirmed';
    const inventoryExecuteFile = await executeSnapshot('p1-maintenance-executor/inventory-execute.json', inventoryTask, inventoryHash, inventoryNonce);
    const inventoryExecuteCallStart = calls.length;
    const inventoryExecute = await runExecutor(['--task-id', inventoryTask.id, '--task-json', inventoryExecuteFile, '--execute', '--confirm', 'SHEIN_OPENAPI_SUBMIT', '--claim-nonce', inventoryNonce]);
    const inventoryExecuteCalls = calls.slice(inventoryExecuteCallStart);
    check('P1 confirmed inventory executor exits 0', inventoryExecute.code, 0);
    check('P1 confirmed inventory executor ok true', inventoryExecute.json?.ok, true);
    check('P1 confirmed inventory executor partial false', inventoryExecute.json?.partial, false);
    check('P1 confirmed inventory executor outcome', inventoryExecute.json?.outcome, 'completed');
    check('P1 confirmed inventory executor committed true', inventoryExecute.json?.committed, true);
    check('P1 confirmed inventory executor exact readback', inventoryExecute.json?.readback?.status, 'matched_stock_query_exact');
    check('P1 confirmed inventory executor readback ok', inventoryExecute.json?.readback?.ok, true);
    check('P1 confirmed inventory executor keeps adapter evidence', inventoryExecute.json?.adapterEvidence?.realSubmit, true);
    check('P1 confirmed inventory executor keeps validated durable claim', inventoryExecute.json?.adapterEvidence?.writeClaim?.validated, true);
    check('P1 confirmed inventory uses unique SA warehouse', inventoryExecuteCalls.find(call => call.path === '/open-api/stock/change-inventory/v2')?.body?.updateSkuInventoryQuantityRequests?.[0]?.warehouseCode, 'WH-1');
    check('P1 confirmed inventory performs one real write', inventoryExecuteCalls.filter(call => call.path === '/open-api/stock/change-inventory/v2').length, 1);
    result.summary.p1Executor = {
      unconfirmed: {outcome: titleExecute.json?.outcome, committed: titleExecute.json?.committed, readback: titleExecute.json?.readback?.status},
      confirmed: {outcome: inventoryExecute.json?.outcome, committed: inventoryExecute.json?.committed, readback: inventoryExecute.json?.readback?.status},
    };
  } finally {
    await closeHttpServer(fakeOpenApi);
  }
}

async function runCliExecutionOutcomeFixture() {
  const published = buildOwnerKnowledgeDistribution({authorityId: 'p1-cli-fixture', rules: []});
  const sourceCommit = 'f'.repeat(40);
  const etag = `\"${published.manifest.fingerprint}-${sourceCommit}\"`;
  const calls = [];
  let lostResponseExecutePostCount = 0;
  const stub = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const body = await readJsonBody(req);
    calls.push({method: req.method, path: pathname, body});
    if (pathname === '/api/owner-knowledge/manifest') {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, {etag});
        res.end();
        return;
      }
      return sendJson(res, {ok: true, data: {
        ...published.manifest,
        enabled: true,
        ready: true,
        current: true,
        source: 'fixture',
        sourceCommit,
        distributionRevision: 1,
        activeFingerprint: published.manifest.fingerprint,
        cli: {minimumVersion: '2026.08.17.1', recommendedVersion: '2026.08.17.1'},
      }}, 200, {etag});
    }
    if (pathname === '/api/owner-knowledge/bundle') {
      return sendJson(res, {ok: true, data: {...published.bundle, manifest: {...published.manifest, sourceCommit}}});
    }
    if (pathname === '/api/link-ops-execute') {
      const id = String(body?.id || '');
      if (req.method === 'POST' && id === 'lost-response-task' && body?.mode === 'execute') {
        // The request body has been fully consumed above: simulate a server
        // that accepted the write but dropped the response before the client
        // could receive it.
        lostResponseExecutePostCount += 1;
        req.socket.destroy();
        return;
      }
      const task = {id, status: id === 'ready-task' ? 'waiting_review' : 'submitted'};
      if (id === 'unconfirmed-task' && body?.mode === 'execute') {
        // Deliberately contradictory upstream body: the CLI must fail closed
        // even when the service mistakenly leaves ok=true.
        return sendJson(res, {
          ok: true,
          committed: true,
          partial: true,
          outcome: 'unconfirmed',
          error: 'strong readback pending',
          stage: 'execution_committed_verified',
          task,
          execution: {state: 'submitted', writeAudit: {actualWriteSubmitted: true}, adapterEvidence: {realSubmit: true}},
        });
      }
      if (id === 'completed-task' && body?.mode === 'execute') {
        return sendJson(res, {
          ok: true,
          committed: true,
          partial: false,
          outcome: 'completed',
          stage: 'execution_committed_verified',
          task,
          execution: {state: 'submitted', writeAudit: {actualWriteSubmitted: true}, readback: {ok: true}},
        });
      }
      if (id === 'ready-task' && body?.mode === 'dry-run') {
        return sendJson(res, {
          ok: true,
          committed: true,
          partial: false,
          outcome: 'ready',
          stage: 'execution_check_persisted',
          task,
          execution: {state: 'ready_for_submit', writeAudit: {actualWriteSubmitted: false}},
        });
      }
      return sendJson(res, {ok: false, error: 'unknown fixture task'}, 404);
    }
    return sendJson(res, {ok: false, error: `Unhandled CLI fixture endpoint ${pathname}`}, 404);
  });

  const stubBaseUrl = await listenLoopback(stub);
  try {
    const sessionFile = await writeJson('p1-cli/stub-session.json', {cookie: 'stub-cookie'});
    const stubKnowledgeCache = path.join(tmpRoot, 'p1-cli', 'knowledge-cache');
    const options = {baseUrl: stubBaseUrl, knowledgeCacheDir: stubKnowledgeCache};

    const ready = await runCli(['--session-file', sessionFile, 'preflight', '--task-id', 'ready-task'], options);
    check('P1 CLI dry-run ready exits 0', ready.code, 0);
    check('P1 CLI dry-run ready stays ok', ready.json?.ok, true);
    check('P1 CLI dry-run preserves ready outcome', ready.json?.outcome, 'ready');
    check('P1 CLI dry-run stays non-partial', ready.json?.partial, undefined);

    const unconfirmed = await runCli([
      '--session-file', sessionFile,
      'execute',
      '--task-id', 'unconfirmed-task',
      '--confirm', 'SHEIN_OPENAPI_SUBMIT',
    ], options);
    check('P1 CLI unconfirmed maps to exit 75', unconfirmed.code, 75);
    check('P1 CLI unconfirmed cannot print top-level success', unconfirmed.json?.ok, false);
    check('P1 CLI unconfirmed preserves partial', unconfirmed.json?.partial, true);
    check('P1 CLI unconfirmed preserves outcome', unconfirmed.json?.outcome, 'unconfirmed');
    check('P1 CLI unconfirmed preserves committed evidence', unconfirmed.json?.committed, true);
    check('P1 CLI unconfirmed preserves task', unconfirmed.json?.task?.id, 'unconfirmed-task');
    check('P1 CLI unconfirmed preserves adapter evidence', unconfirmed.json?.execution?.adapterEvidence?.realSubmit, true);

    const completed = await runCli([
      '--session-file', sessionFile,
      'execute',
      '--task-id', 'completed-task',
      '--confirm', 'SHEIN_OPENAPI_SUBMIT',
    ], options);
    check('P1 CLI confirmed completed exits 0', completed.code, 0);
    check('P1 CLI confirmed completed stays ok', completed.json?.ok, true);
    check('P1 CLI confirmed completed preserves outcome', completed.json?.outcome, 'completed');
    check('P1 CLI confirmed completed stays non-partial', completed.json?.partial, undefined);
    check('P1 CLI confirmed completed preserves committed evidence', completed.json?.committed, true);

    const lostResponse = await runCli([
      '--session-file', sessionFile,
      'execute',
      '--task-id', 'lost-response-task',
      '--confirm', 'SHEIN_OPENAPI_SUBMIT',
    ], options);
    check('P1 CLI lost response execute posts exactly once', lostResponseExecutePostCount, 1);
    check('P1 CLI lost response execute exits nonzero', lostResponse.code, code => code !== 0);
    check('P1 CLI lost response execute cannot claim completed', lostResponse.json?.outcome, outcome => outcome !== 'completed');
    check('P1 CLI lost response execute cannot claim top-level success', lostResponse.json?.ok, value => value !== true);

    check('P1 CLI fixture uses only local deterministic endpoints', calls.some(call => !['/api/owner-knowledge/manifest', '/api/owner-knowledge/bundle', '/api/link-ops-execute'].includes(call.path)), false);
    result.summary.p1Cli = {
      ready: {exit: ready.code, outcome: ready.json?.outcome},
      unconfirmed: {exit: unconfirmed.code, outcome: unconfirmed.json?.outcome, partial: unconfirmed.json?.partial},
      completed: {exit: completed.code, outcome: completed.json?.outcome},
      lostResponse: {exit: lostResponse.code, outcome: lostResponse.json?.outcome, executePosts: lostResponseExecutePostCount},
    };
  } finally {
    await closeHttpServer(stub);
  }
}

try {
  await runMaintenanceExecutorOutcomeFixture();
  await runCliExecutionOutcomeFixture();
  await waitReady();

  const operatorLogin = await runCli(['--session-file', operatorSessionFile, 'login', '--username', 'operator_cli_smoke', '--password-stdin'], {input: 'operator-cli-pass\n'});
  expectCliOk('operator login', operatorLogin);
  check('operator login refreshes owner knowledge', operatorLogin.json?.knowledge?.current, true);
  result.summary.operatorSessionFileExists = fssync.existsSync(operatorSessionFile);
  const operatorSessionText = await fs.readFile(operatorSessionFile, 'utf8');
  check('operator session file exists', result.summary.operatorSessionFileExists, true);
  check('operator session stores no plaintext password', operatorSessionText.includes('operator-cli-pass'), false);
  const operatorSessionBackupFile = `${operatorSessionFile}.backup`;
  const operatorSessionBackupText = await fs.readFile(operatorSessionBackupFile, 'utf8');
  check('operator session backup exists', fssync.existsSync(operatorSessionBackupFile), true);
  check('operator session backup stores no plaintext password', operatorSessionBackupText.includes('operator-cli-pass'), false);
  check('operator receives long-lived CLI session', operatorLogin.json?.session?.ttlDays, 365);
  await fs.writeFile(operatorSessionFile, '{interrupted-write', 'utf8');

  const operatorMe = await runCli(['--session-file', operatorSessionFile, 'me']);
  expectCliOk('operator me', operatorMe);
  const recoveredOperatorSession = JSON.parse(await fs.readFile(operatorSessionFile, 'utf8'));
  check('operator session recovers from atomic backup', Boolean(recoveredOperatorSession.cookie), true);
  result.summary.operatorWriteStores = operatorMe.json?.user?.writeStores || [];
  check('operator writeStores from CLI me', result.summary.operatorWriteStores.join(','), 'DX,LQ,XC');

  const operatorCapabilities = await runCli(['--session-file', operatorSessionFile, 'capabilities']);
  expectCliOk('operator capabilities', operatorCapabilities);
  result.summary.capabilityCount = operatorCapabilities.json?.counts?.total || operatorCapabilities.json?.rows?.length || 0;
  result.summary.writeConfirmable = operatorCapabilities.json?.counts?.writeConfirmable ?? null;
  result.summary.safeWriteEnabled = operatorCapabilities.json?.safety?.safeWriteOperations?.enabled ?? null;
  result.summary.whitelistEnabled = operatorCapabilities.json?.safety?.realSubmitWhitelist?.enabled ?? null;
  check('operator capabilities include 19 stores', result.summary.capabilityCount, 19);
  check('safe write remains disabled in smoke', result.summary.safeWriteEnabled, false);
  check('account-scoped write authorization is enabled in smoke', result.summary.whitelistEnabled, true);

  const operatorDoctor = await runCli(['--session-file', operatorSessionFile, 'doctor']);
  expectCliOk('operator doctor', operatorDoctor);
  result.summary.operatorDoctorChecks = Array.isArray(operatorDoctor.json?.checks) ? operatorDoctor.json.checks.length : 0;
  result.summary.operatorDoctorUser = operatorDoctor.json?.user?.username || '';
  result.summary.operatorDoctorSafeWrite = operatorDoctor.json?.safety?.safeWriteOperations?.enabled ?? null;
  check('operator doctor has checks', result.summary.operatorDoctorChecks, n => n >= 5);
  check('operator doctor sees logged-in user', result.summary.operatorDoctorUser, 'operator_cli_smoke');
  check('operator doctor does not enable safe write', result.summary.operatorDoctorSafeWrite, false);

  const directQueryFile = path.join(tmpRoot, 'operator-direct-query.json');
  const operatorDirectQuery = await runCli([
    '--session-file', operatorSessionFile,
    'query',
    '--text', '今天全部店铺销售额和订单数是多少',
    '--out', directQueryFile,
  ]);
  expectCliOk('operator direct query', operatorDirectQuery);
  check('operator direct query invokes no AI', operatorDirectQuery.json?.aiInvoked, false);
  check('operator direct query writes result file', fssync.existsSync(directQueryFile), true);
  check('operator direct query writes evidence manifest', fssync.existsSync(`${directQueryFile}.manifest.json`), true);
  check('operator direct query compact outcome', operatorDirectQuery.json?.outcome, 'succeeded');
  check('operator direct query manifest hash', operatorDirectQuery.json?.manifestSha256, value => /^[a-f0-9]{64}$/.test(String(value || '')));
  const directQueryData = JSON.parse(await fs.readFile(directQueryFile, 'utf8'));
  const directQueryManifest = JSON.parse(await fs.readFile(`${directQueryFile}.manifest.json`, 'utf8'));
  check('operator direct query manifest schema', directQueryManifest.schemaVersion, 'shein-ops-run-manifest/v1');
  check('operator direct query manifest artifact count', directQueryManifest.artifacts?.length, 1);
  check('operator direct query mode', directQueryData.mode, 'direct-bi-data');
  check('operator direct query response marks no AI', directQueryData.aiInvoked, false);
  check('operator direct query loads warmed home rankings', directQueryData.sections?.loaded || [], rows => rows.includes('homeRankings'));
  check('operator direct query loads live sales', directQueryData.sections?.loaded || [], rows => rows.includes('liveSalesToday'));
  check('operator direct query preserves complete store rows', directQueryData.data?.rankings?.dailyStores?.length, 2);

  const incompleteQueryFile = path.join(tmpRoot, 'operator-incomplete-query.json');
  await fs.writeFile(incompleteQueryFile, '{"stale":true}\n', 'utf8');
  const operatorIncompleteQuery = await runCli([
    '--session-file', operatorSessionFile,
    'query',
    '--text', '查询当前售后数据',
    '--sections', 'afterSales',
    '--wait-seconds', '0',
    '--out', incompleteQueryFile,
  ]);
  check('incomplete query uses deferred exit', operatorIncompleteQuery.code, 75);
  check('incomplete query returns compact outcome', operatorIncompleteQuery.json?.outcome, 'incomplete');
  check('incomplete query writes evidence manifest', fssync.existsSync(`${incompleteQueryFile}.manifest.json`), true);
  const incompleteQueryData = JSON.parse(await fs.readFile(incompleteQueryFile, 'utf8'));
  check('incomplete query atomically replaces stale output', incompleteQueryData.stale, undefined);
  check('incomplete query evidence is not success', incompleteQueryData.ok, false);
  check('incomplete query keeps exact failure code', incompleteQueryData.error?.code, 'BI_QUERY_DATA_INCOMPLETE');

  const legacyAskFile = path.join(tmpRoot, 'operator-legacy-ask.json');
  const operatorLegacyAsk = await runCli([
    '--session-file', operatorSessionFile,
    'ask',
    '--text', '今天全部店铺销售额和订单数是多少',
    '--out', legacyAskFile,
  ]);
  expectCliOk('operator legacy ask alias', operatorLegacyAsk);
  check('legacy ask alias invokes no AI', operatorLegacyAsk.json?.aiInvoked, false);
  const legacyAskData = JSON.parse(await fs.readFile(legacyAskFile, 'utf8'));
  check('legacy ask is direct data', legacyAskData.mode, 'direct-bi-data');
  check('legacy ask is marked compatibility alias', legacyAskData.cli?.legacyAlias, true);

  const operatorDoctorRetireDx = await runCli(['--session-file', operatorSessionFile, 'doctor', '--operation', 'retire_link', '--stores', 'DX']);
  expectCliOk('operator doctor retire DX', operatorDoctorRetireDx);
  const retireDxReadiness = operatorDoctorRetireDx.json?.requestedActionReadiness || {};
  const retireDxItem = retireDxReadiness.items?.[0] || {};
  result.summary.operatorDoctorRetireDx = {
    allCanDryRun: retireDxReadiness.allCanDryRun,
    allCanRealSubmitAfterPreflight: retireDxReadiness.allCanRealSubmitAfterPreflight,
    item: {
      storeKey: retireDxItem.storeKey,
      canCreateTask: retireDxItem.canCreateTask,
      canDryRun: retireDxItem.canDryRun,
      canRealSubmitAfterPreflight: retireDxItem.canRealSubmitAfterPreflight,
      blockers: retireDxItem.blockers || [],
    },
  };
  check('operator doctor retire DX store', retireDxItem.storeKey, 'DX');
  check('operator doctor retire DX can create task', retireDxItem.canCreateTask, true);
  check('operator doctor retire DX can dry-run', retireDxItem.canDryRun, true);
  check('operator doctor retire DX cannot real-submit yet', retireDxItem.canRealSubmitAfterPreflight, false);
  check('operator doctor retire DX reports human-safe blockers', retireDxItem.blockers || [], xs => Array.isArray(xs) && xs.some(x => /授权|安全规则|执行能力/.test(String(x))));
  check('operator doctor retire DX does not expose browser capability internals', JSON.stringify(retireDxItem.blockers || []), x => !/SHEIN_OPENAPI_SUBMIT|dry[-_ ]?run|payload hash|payloadHash|确认文本|safeWriteOperations|\/open-api\/goods\/modify-skc-shelf/.test(x));

  const operatorDoctorRetireDxRequire = await runCli(['--session-file', operatorSessionFile, 'doctor', '--operation', 'retire_link', '--stores', 'DX', '--require-real-submit']);
  result.summary.operatorDoctorRetireDxRequireCode = operatorDoctorRetireDxRequire.code;
  result.summary.operatorDoctorRetireDxRequireOk = operatorDoctorRetireDxRequire.json?.ok ?? null;
  result.summary.operatorDoctorRetireDxRequireReadiness = operatorDoctorRetireDxRequire.json?.requestedActionReadiness?.okForRequestedLevel ?? null;
  check('operator doctor retire DX require real exits nonzero', operatorDoctorRetireDxRequire.code, c => c !== 0);
  check('operator doctor retire DX require real report not ok', result.summary.operatorDoctorRetireDxRequireOk, false);
  check('operator doctor retire DX require real readiness false', result.summary.operatorDoctorRetireDxRequireReadiness, false);

  const missingTaskPreflight = await runCli([
    '--session-file', operatorSessionFile,
    'preflight',
    '--task-id', 'missing-task-protocol-check',
  ]);
  check('missing task preflight exits failed', missingTaskPreflight.code, 1);
  check('missing task preflight stays on stderr', missingTaskPreflight.json, null);
  check('missing task preflight does not claim committed evidence', missingTaskPreflight.errorJson?.committed, undefined);

  const operatorCreateDx = await runCli([
    '--session-file', operatorSessionFile,
    'operate',
    '--operation', 'retire_link',
    '--text', '处理这个目标，不要依赖关键词判断动作',
    '--stores', 'DX',
    '--products', 'PA4-6L',
  ]);
  expectCliBlocked('operator structured operate DX', operatorCreateDx);
  const operatorTaskId = operatorCreateDx.json?.task?.id || '';
  result.summary.operatorTaskId = operatorTaskId;
  check('operator task id present', Boolean(operatorTaskId), true);
  check('operator blocked task remains waiting review', operatorCreateDx.json?.task?.status, 'waiting_review');
  check('operator structured operate invokes no cloud AI', operatorCreateDx.json?.aiInvoked, false);
  check('operator structured operation bypasses keyword inference', operatorCreateDx.json?.task?.intents || [], intents => intents.length === 1 && intents[0] === 'retire_link');
  check('operator structured operate runs preflight', Boolean(operatorCreateDx.json?.execution), true);
  check('operator structured operate preserves blocked execution', operatorCreateDx.json?.execution?.state, 'blocked');
  check('operator blocked operate instructs task reuse', operatorCreateDx.json?.nextStep, text => /task ID/.test(String(text)) && /勿重复 operate/.test(String(text)));
  check('operator task projection hides owner knowledge internals', Boolean(operatorCreateDx.json?.task?.ownerKnowledgePolicy), false);

  const operatorPreflight = await runCli(['--session-file', operatorSessionFile, 'preflight', '--task-id', operatorTaskId]);
  expectCliBlocked('operator preflight DX', operatorPreflight);
  check('operator blocked preflight preserves same task id', operatorPreflight.json?.task?.id, operatorTaskId);
  result.summary.operatorPreflightState = operatorPreflight.json?.execution?.state || '';
  result.summary.operatorPreflightSubmitted = Boolean(operatorPreflight.json?.execution?.writeAudit?.submitted);
  check('operator preflight does not submit real write', result.summary.operatorPreflightSubmitted, false);

  const operatorAudit = await runCli(['--session-file', operatorSessionFile, 'audit', '--task-id', operatorTaskId]);
  expectCliOk('operator audit DX', operatorAudit);
  result.summary.operatorAuditEntries = Array.isArray(operatorAudit.json?.entries) ? operatorAudit.json.entries.length : 0;
  check('operator audit has entries', result.summary.operatorAuditEntries, n => n >= 2);

  const operatorCreateHlDenied = await runCli([
    '--session-file', operatorSessionFile,
    'operate',
    '--operation', 'retire_link',
    '--text', '处理这个目标',
    '--stores', 'HL',
    '--products', 'PA4-6L',
  ]);
  result.summary.operatorCreateHlDeniedCode = operatorCreateHlDenied.code;
  result.summary.operatorCreateHlDeniedStatus = operatorCreateHlDenied.errorJson?.status || null;
  check('operator create HL denied exit', operatorCreateHlDenied.code, c => c !== 0);
  check('operator create HL denied status', result.summary.operatorCreateHlDeniedStatus, 403);

  const operatorCopyAllowed = await runCli([
    '--session-file', operatorSessionFile,
    'create',
    '--operation', 'copy_product_draft',
    '--text', '复制 CX 的 SM-961 到 DX',
    '--source-stores', 'CX',
    '--source-skc', 'sb260619161490554120094',
    '--target-stores', 'DX',
    '--products', 'SM-961',
  ]);
  expectCliOk('operator copy CX to DX', operatorCopyAllowed);
  result.summary.operatorCopyTaskId = operatorCopyAllowed.json?.task?.id || '';
  check('operator copy task id present', Boolean(result.summary.operatorCopyTaskId), true);
  check('operator copy preserves exact source SKC', operatorCopyAllowed.json?.task?.targets?.sourceSkc, 'sb260619161490554120094');


  const operatorLockSource = await runCli([
    '--session-file', operatorSessionFile,
    'lock-source',
    '--task-id', result.summary.operatorCopyTaskId,
    '--source-store', 'CX',
    '--source-skc', 'sb260619161490554120094',
  ]);
  expectCliOk('operator exact source lock', operatorLockSource);
  check('operator exact source lock readback store', operatorLockSource.json?.lockedSource?.sourceStore, 'CX');
  check('operator exact source lock readback SKC', operatorLockSource.json?.lockedSource?.sourceSkc, 'sb260619161490554120094');
  check('operator exact source lock performs no real publish', operatorLockSource.json?.safety?.realPublishOccurred, false);

  const operatorAmbiguousSource = await runCli([
    '--session-file', operatorSessionFile,
    'create',
    '--operation', 'copy_product_draft',
    '--text', 'ambiguous source must stop locally',
    '--source-stores', 'CX,LQ',
    '--source-skc', 'sb260619161490554120094',
    '--target-stores', 'DX',
    '--products', 'SM-961',
  ]);
  check('ambiguous source store/SKC pair exits nonzero', operatorAmbiguousSource.code, code => code !== 0);
  check('ambiguous source store/SKC pair is rejected before create', operatorAmbiguousSource.stderr, text => /exactly one --source-store/.test(text));

  const operatorChat = await runCli([
    '--session-file', operatorSessionFile,
    'chat',
    '--text', '把 DX 的 PA4-6L 库存改成 30',
    '--no-agent',
    '--wait-seconds', '10',
  ]);
  expectCliOk('operator chat with durable plan', operatorChat);
  const operatorJobId = operatorChat.json?.job?.id || '';
  result.summary.operatorJobId = operatorJobId;
  result.summary.operatorCompletedJobStatus = operatorChat.json?.completedJob?.status || '';
  check('operator chat job id present', Boolean(operatorJobId), true);
  check('operator chat waits for durable plan', result.summary.operatorCompletedJobStatus, 'succeeded');

  const operatorJobs = await runCli(['--session-file', operatorSessionFile, 'jobs', '--status', 'succeeded']);
  expectCliOk('operator jobs', operatorJobs);
  check('operator jobs includes own durable plan', operatorJobs.json?.data || [], rows => Array.isArray(rows) && rows.some(row => row.id === operatorJobId));

  const operatorJob = await runCli(['--session-file', operatorSessionFile, 'job', '--job-id', operatorJobId]);
  check('operator job exit', operatorJob.code, 0);
  check('operator job detail status', operatorJob.json?.status, 'succeeded');
  check('operator job detail remains read-only', operatorJob.json?.writeBoundary, 'read_only');

  const operatorWaitJob = await runCli(['--session-file', operatorSessionFile, 'wait-job', '--job-id', operatorJobId, '--wait-seconds', '5']);
  expectCliOk('operator wait-job', operatorWaitJob);
  check('operator wait-job status', operatorWaitJob.json?.job?.status, 'succeeded');

  const ownerLogin = await runCli(['--session-file', ownerSessionFile, 'login', '--username', 'owner_cli_smoke', '--password-stdin'], {input: 'owner-cli-pass\n'});
  expectCliOk('owner login', ownerLogin);
  const ownerCreateHl = await runCli([
    '--session-file', ownerSessionFile,
    'create',
    '--operation', 'retire_link',
    '--text', '处理这个目标',
    '--stores', 'HL',
    '--products', 'PA4-6L',
  ]);
  expectCliOk('owner create HL', ownerCreateHl);
  result.summary.ownerTaskId = ownerCreateHl.json?.task?.id || '';
  check('owner task id present', Boolean(result.summary.ownerTaskId), true);

  const operatorLogout = await runCli(['--session-file', operatorSessionFile, 'logout']);
  expectCliOk('operator logout', operatorLogout);
  result.summary.operatorSessionRemoved = !fssync.existsSync(operatorSessionFile);
  check('operator session removed after logout', result.summary.operatorSessionRemoved, true);
  check('operator session backup removed after logout', fssync.existsSync(operatorSessionBackupFile), false);

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = Array.isArray(tasks.tasks) ? tasks.tasks.length : 0;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('task count from CLI flow', result.summary.taskCount, 4);
  check('all explicit and chat tasks carry owner knowledge snapshot', tasks.tasks || [], rows => Array.isArray(rows) && rows.every(row => Boolean(row?.ownerKnowledgePolicy?.fingerprint)));
  check('partner knowledge manifest cached atomically', fssync.existsSync(path.join(knowledgeCacheDir, 'manifest.json')), true);
  check('audit lines from CLI flow >= 12', result.summary.auditLines, n => n >= 12);
  // Deterministic gateway CAS contract (isolated files, independent of the
  // running portal): the portal request writer relies on these guarantees.
  const casRoot = await fs.mkdtemp(path.join(tmpBase, 'biops-cas-chain-'));
  const casRepo = createLinkOpsJsonRepository({
    taskFile: path.join(casRoot, 'tasks.json'),
    sessionFile: path.join(casRoot, 'sessions.json'),
    actionFile: path.join(casRoot, 'actions.json'),
    runtimeFile: path.join(casRoot, 'runtime.json'),
  });
  const casGateway = createLinkOpsStoreGateway({repository: casRepo});
  const casNow = new Date().toISOString();
  const casTaskId = 'cas-task-1';
  const casBaseTask = {
    id: casTaskId,
    title: 'CAS chain',
    status: 'draft',
    command: '把 DX 的 PA4-6L 库存改成 30',
    intents: ['update_inventory'],
    targets: {stores: ['DX'], productRefs: ['PA4-6L']},
    ownership: {version: 1, state: 'owned', actorKey: 'cas-actor', username: 'cas-actor', ownerKey: 'CAS'},
    requestedByUser: 'cas-actor',
    history: [],
    createdAt: casNow,
    updatedAt: casNow,
  };
  // (1) same-request create -> update threads the authoritative revision.
  const casCreated = await casGateway.createTaskRecord(casBaseTask, {actorUser: 'cas-actor'});
  const casCreatedRev = Number(casCreated.repositoryRevision || 0);
  check('deterministic cas create returns positive revision', casCreatedRev > 0, true);
  const casUpdatedTask = {...casCreated, status: 'confirmed', progress: 30, updatedAt: new Date().toISOString()};
  const casUpdated = await casGateway.updateTaskRecord(casTaskId, casUpdatedTask, {expectedRevision: casCreatedRev, actorUser: 'cas-actor'});
  check('deterministic cas create->update advances revision', Number(casUpdated.repositoryRevision || 0), casCreatedRev + 1);
  check('deterministic cas create->update returns authoritative record', String(casUpdated.id || ''), casTaskId);
  // (2) stale expectedRevision must fail closed and never overwrite.
  let casStaleError = null;
  try {
    await casGateway.updateTaskRecord(casTaskId, {...casUpdatedTask, title: 'stale-stick-token', status: 'done'}, {expectedRevision: casCreatedRev, actorUser: 'cas-actor'});
  } catch (err) {
    casStaleError = err;
  }
  check('deterministic cas stale revision is rejected', Boolean(casStaleError), true);
  check('deterministic cas stale revision is a conflict', casStaleError?.code, 'LINK_OPS_REVISION_CONFLICT');
  const casAfterStale = await casGateway.readTaskStore();
  const casAfterStaleRow = (casAfterStale.tasks || []).find(row => String(row?.id || '') === casTaskId) || null;
  check('deterministic cas stale write never overwrites content', casAfterStaleRow?.title, casUpdated.title);
  check('deterministic cas stale write never regresses revision', Number(casAfterStaleRow?.repositoryRevision || 0), Number(casUpdated.repositoryRevision || 0));
  // (3) post-commit ambiguity: a retried create must never double-create. The
  // gateway replays the same create idempotently (returning the original
  // authoritative row) or fails with the already-exists code; either way only
  // one row may ever exist for the id.
  let casReplay = null;
  let casDuplicateError = null;
  try {
    casReplay = await casGateway.createTaskRecord(casBaseTask, {actorUser: 'cas-actor'});
  } catch (err) {
    casDuplicateError = err;
  }
  const casRetryUnexpected = Boolean(casDuplicateError) && casDuplicateError?.code !== 'LINK_OPS_ALREADY_EXISTS';
  check('deterministic cas retry create has no unexpected error', casRetryUnexpected, false);
  const casReadback = await casGateway.readTaskStore();
  const casDuplicateCount = (casReadback.tasks || []).filter(row => String(row?.id || '') === casTaskId).length;
  check('deterministic cas duplicate create never duplicates rows', casDuplicateCount, 1);
  check('deterministic cas retry reuses the same authoritative id', String((casReplay && casReplay.id) || (casReadback.tasks.find(row => String(row?.id || '') === casTaskId) || {}).id || ''), casTaskId);
  // (4) chat session create -> append messages threads the authoritative revision.
  const casSessionId = 'cas-session-1';
  const casSession = {
    id: casSessionId,
    title: 'CAS session',
    status: 'chatting',
    memoryPolicy: 'shared',
    ownership: {version: 1, state: 'owned', actorKey: 'cas-actor', username: 'cas-actor', ownerKey: 'CAS'},
    messages: [{id: 'cas-msg-1', role: 'user', content: '改库存 30', at: casNow}],
    requestedByUser: 'cas-actor',
    createdAt: casNow,
    updatedAt: casNow,
  };
  const casSessionCreated = await casGateway.createChatSessionRecord(casSession, {actorUser: 'cas-actor'});
  check('deterministic cas session create returns positive revision', Number(casSessionCreated.repositoryRevision || 0) > 0, true);
  const casSessionMessages = Array.isArray(casSessionCreated.messages) ? casSessionCreated.messages : [];
  const casNextSession = {
    ...casSessionCreated,
    messages: [...casSessionMessages, {id: 'cas-msg-2', role: 'assistant', content: '已收到', at: new Date().toISOString()}],
    updatedAt: new Date().toISOString(),
  };
  const casSessionUpdated = await casGateway.updateChatSessionRecord(casSessionId, casNextSession, {
    expectedRevision: Number(casSessionCreated.repositoryRevision || 0),
    actorUser: 'cas-actor',
  });
  check('deterministic cas session append advances revision', Number(casSessionUpdated.repositoryRevision || 0), Number(casSessionCreated.repositoryRevision || 0) + 1);
  const casSessionMessageIds = Array.isArray(casSessionUpdated.messages) ? casSessionUpdated.messages.map(row => String(row?.id || '')) : [];
  check('deterministic cas session keeps appended message', casSessionMessageIds.includes('cas-msg-2'), true);
  // (5) explicit session delete actually removes the row (a whole-store replace cannot).
  await casGateway.deleteChatSessionRecord(casSessionId, {
    expectedRevision: Number(casSessionUpdated.repositoryRevision || 0),
    actorUser: 'cas-actor',
  });
  const casChatAfterDelete = await casGateway.readChatStore();
  check('deterministic cas session delete removes the row', (casChatAfterDelete.sessions || []).some(row => String(row?.id || '') === casSessionId), false);
  await casRepo.close();
  check('direct queries are audited without agent route', auditText, text => {
    const directCount = (String(text).match(/"type":"bi-direct-query"/g) || []).length;
    return directCount >= 2 && !String(text).includes('"type":"ops-agent-ask"');
  });

  result.ok = result.checks.every(x => x.pass);
} finally {
  server.kill();
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`CLI flow smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
