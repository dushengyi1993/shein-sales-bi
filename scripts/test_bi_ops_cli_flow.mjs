import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-cli-flow-smoke-'));
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
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const ownerSessionFile = path.join(tmpRoot, 'owner-session.json');
const operatorSessionFile = path.join(tmpRoot, 'operator-session.json');

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [
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
    const child = spawn(process.execPath, ['scripts/bi_ops_cli.mjs', '--base-url', baseUrl, ...cliArgs], {
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
  result.summary.operatorSessionFileExists = fssync.existsSync(operatorSessionFile);
  const operatorSessionText = await fs.readFile(operatorSessionFile, 'utf8');
  check('operator session file exists', result.summary.operatorSessionFileExists, true);
  check('operator session stores no plaintext password', operatorSessionText.includes('operator-cli-pass'), false);

  const operatorMe = await runCli(['--session-file', operatorSessionFile, 'me']);
  expectCliOk('operator me', operatorMe);
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
  check('real submit whitelist remains disabled in smoke', result.summary.whitelistEnabled, false);

  const operatorDoctor = await runCli(['--session-file', operatorSessionFile, 'doctor']);
  expectCliOk('operator doctor', operatorDoctor);
  result.summary.operatorDoctorChecks = Array.isArray(operatorDoctor.json?.checks) ? operatorDoctor.json.checks.length : 0;
  result.summary.operatorDoctorUser = operatorDoctor.json?.user?.username || '';
  result.summary.operatorDoctorSafeWrite = operatorDoctor.json?.safety?.safeWriteOperations?.enabled ?? null;
  check('operator doctor has checks', result.summary.operatorDoctorChecks, n => n >= 5);
  check('operator doctor sees logged-in user', result.summary.operatorDoctorUser, 'operator_cli_smoke');
  check('operator doctor does not enable safe write', result.summary.operatorDoctorSafeWrite, false);

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
    'create',
    '--text', '把 DX 的 PA4-6L 做下架预检',
    '--stores', 'DX',
    '--products', 'PA4-6L',
  ]);
  expectCliOk('operator create DX', operatorCreateDx);
  const operatorTaskId = operatorCreateDx.json?.task?.id || '';
  result.summary.operatorTaskId = operatorTaskId;
  check('operator task id present', Boolean(operatorTaskId), true);

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
    'create',
    '--text', '把 HL 的 PA4-6L 做下架预检',
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
    '--text', '复制 CX 的 SM-961 到 DX',
    '--source-stores', 'CX',
    '--target-stores', 'DX',
    '--products', 'SM-961',
  ]);
  expectCliOk('operator copy CX to DX', operatorCopyAllowed);
  result.summary.operatorCopyTaskId = operatorCopyAllowed.json?.task?.id || '';
  check('operator copy task id present', Boolean(result.summary.operatorCopyTaskId), true);

  const ownerLogin = await runCli(['--session-file', ownerSessionFile, 'login', '--username', 'owner_cli_smoke', '--password-stdin'], {input: 'owner-cli-pass\n'});
  expectCliOk('owner login', ownerLogin);
  const ownerCreateHl = await runCli([
    '--session-file', ownerSessionFile,
    'create',
    '--text', '把 HL 的 PA4-6L 做下架预检',
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

  const tasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.taskCount = Array.isArray(tasks.tasks) ? tasks.tasks.length : 0;
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('task count from CLI flow', result.summary.taskCount, 3);
  check('audit lines from CLI flow >= 8', result.summary.auditLines, n => n >= 8);

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
