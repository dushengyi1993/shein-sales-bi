import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
    keys: ['rankings', 'liveSalesToday'],
    loaded: ['core'],
  },
}), 'utf8');
for (const [section, data] of Object.entries({
  rankings: {
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
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  return file;
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

function runCli(cliArgs, {input = ''} = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/bi_ops_cli.mjs', '--base-url', baseUrl, '--knowledge-cache-dir', knowledgeCacheDir, ...cliArgs], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, SHEIN_BI_BASE_URL: baseUrl},
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

try {
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
  check('operator direct query loads rankings', directQueryData.sections?.loaded || [], rows => rows.includes('rankings'));
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

  const operatorCreateDx = await runCli([
    '--session-file', operatorSessionFile,
    'operate',
    '--operation', 'retire_link',
    '--text', '处理这个目标，不要依赖关键词判断动作',
    '--stores', 'DX',
    '--products', 'PA4-6L',
  ]);
  expectCliOk('operator structured operate DX', operatorCreateDx);
  const operatorTaskId = operatorCreateDx.json?.task?.id || '';
  result.summary.operatorTaskId = operatorTaskId;
  check('operator task id present', Boolean(operatorTaskId), true);
  check('operator structured operate invokes no cloud AI', operatorCreateDx.json?.aiInvoked, false);
  check('operator structured operation bypasses keyword inference', operatorCreateDx.json?.task?.intents || [], intents => intents.length === 1 && intents[0] === 'retire_link');
  check('operator structured operate runs preflight', Boolean(operatorCreateDx.json?.execution), true);
  check('operator task projection hides owner knowledge internals', Boolean(operatorCreateDx.json?.task?.ownerKnowledgePolicy), false);

  const operatorPreflight = await runCli(['--session-file', operatorSessionFile, 'preflight', '--task-id', operatorTaskId]);
  expectCliOk('operator preflight DX', operatorPreflight);
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
    '--target-stores', 'DX',
    '--products', 'SM-961',
  ]);
  expectCliOk('operator copy CX to DX', operatorCopyAllowed);
  result.summary.operatorCopyTaskId = operatorCopyAllowed.json?.task?.id || '';
  check('operator copy task id present', Boolean(result.summary.operatorCopyTaskId), true);

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
