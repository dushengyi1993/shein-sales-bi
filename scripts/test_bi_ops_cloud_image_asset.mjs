#!/usr/bin/env node
/**
 * Smoke test for cloud-mediated SHEIN OpenAPI image utilities.
 *
 * Verifies that BI Ops CLI image upload can use the portal session boundary
 * instead of local OpenAPI credentials, and that the portal endpoint enforces
 * store write permissions before calling SHEIN upload-pic.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-cloud-image-asset-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
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
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json = null;
      try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch {}
      resolve({raw, json});
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}

function runNode(args, {input = '', env = {}} = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {...process.env, ...env},
      stdio: ['pipe', 'pipe', 'pipe'],
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

const fakeCalls = [];
const fakePort = await freePort();
const fakeOpenApi = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  fakeCalls.push({
    method: req.method,
    path: pathname,
    contentType: req.headers['content-type'] || '',
    bodyText: body.raw.toString('utf8').slice(0, 500),
    json: body.json,
  });
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, 200, {code: '0', msg: 'OK', info: {accountNo: 'GS7676443', merchantId: '6746928'}});
  }
  if (pathname === '/open-api/goods/upload-pic') {
    if (!String(req.headers['content-type'] || '').includes('multipart/form-data')) {
      return sendJson(res, 200, {code: '400', msg: 'missing multipart form'});
    }
    return sendJson(res, 200, {
      code: '0',
      msg: 'OK',
      traceId: 'trace-cloud-upload',
      info: {
        image_url: 'https://img.shein.test/cloud-uploaded.png',
        width: 1200,
        height: 1600,
        size: 12345,
        image_hex_type: 'png',
      },
    });
  }
  if (pathname === '/open-api/goods/transform-pic') {
    return sendJson(res, 200, {
      code: '0',
      msg: 'OK',
      traceId: 'trace-cloud-transform',
      info: {
        original: body.json?.original_url || '',
        transformed: 'https://img.shein.test/cloud-transformed.jpg',
      },
    });
  }
  return sendJson(res, 404, {code: '404', msg: `Unhandled ${pathname}`});
});
await new Promise(resolve => fakeOpenApi.listen(fakePort, '127.0.0.1', resolve));

const authFile = await writeJson('auth.json', {
  users: [
    {
      username: 'owner_cloud_image',
      password: 'owner-pass',
      displayName: 'Owner Cloud Image',
      role: 'owner',
      readStores: ['*'],
      writeStores: ['*'],
      ownerKey: 'OWNER',
    },
    {
      username: 'operator_cloud_image',
      password: 'operator-pass',
      displayName: 'Operator Cloud Image',
      role: 'operator',
      readStores: ['*'],
      writeStores: ['DX'],
      ownerKey: 'OP',
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
const openapiConfigFile = await writeJson('openapi.json', {
  apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${fakePort}`},
  stores: [{storeKey: 'DX', enabled: true, openKeyId: 'fake-open-key', secretKey: 'fake-secret'}],
});
const whitelistFile = await writeJson('whitelist.json', {enabled: false, rules: []});
const htpasswdFile = path.join(tmpRoot, 'empty.htpasswd');
await fs.writeFile(htpasswdFile, '', 'utf8');
const stateFile = path.join(tmpRoot, 'action_state.json');
const taskFile = path.join(tmpRoot, 'tasks.json');
const chatFile = path.join(tmpRoot, 'chats.json');
const auditFile = path.join(tmpRoot, 'audit.jsonl');
const sessionSecretFile = path.join(tmpRoot, 'session_secret');
const manualLoginStateFile = path.join(tmpRoot, 'manual_login.json');
const assetDir = path.join(tmpRoot, 'assets');
const ownerSessionFile = path.join(tmpRoot, 'owner-session.json');
const operatorSessionFile = path.join(tmpRoot, 'operator-session.json');
const tinyPng = path.join(tmpRoot, 'tiny.png');
await fs.writeFile(tinyPng, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax2Z7kAAAAASUVORK5CYII=',
  'base64',
));

const portalPort = await freePort();
const baseUrl = `http://127.0.0.1:${portalPort}`;
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
  '--link-ops-asset-dir', assetDir,
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
let portalStdout = '';
let portalStderr = '';
portal.stdout.on('data', d => { portalStdout += d.toString(); });
portal.stderr.on('data', d => { portalStderr += d.toString(); });

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (portal.exitCode !== null) throw new Error(`portal exited code=${portal.exitCode}\nstdout=${portalStdout}\nstderr=${portalStderr}`);
    try {
      const res = await fetch(`${baseUrl}/login`, {redirect: 'manual'});
      if (res.status >= 200 && res.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`portal not ready\nstdout=${portalStdout}\nstderr=${portalStderr}`);
}

function runCli(cliArgs, opts = {}) {
  return runNode(['scripts/bi_ops_cli.mjs', '--base-url', baseUrl, ...cliArgs], {
    ...opts,
    env: {...(opts.env || {}), SHEIN_BI_BASE_URL: baseUrl},
  });
}

const result = {ok: false, tmpRoot, baseUrl, summary: {}, checks: []};
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  result.checks.push({label, actual, expected: typeof expected === 'function' ? expected.name || 'predicate' : expected, pass});
  return pass;
}

try {
  await waitReady();

  const ownerLogin = await runCli(['--session-file', ownerSessionFile, 'login', '--username', 'owner_cloud_image', '--password-stdin'], {input: 'owner-pass\n'});
  check('owner login exits', ownerLogin.code, 0);
  check('owner login ok', ownerLogin.json?.ok, true);

  const operatorLogin = await runCli(['--session-file', operatorSessionFile, 'login', '--username', 'operator_cloud_image', '--password-stdin'], {input: 'operator-pass\n'});
  check('operator login exits', operatorLogin.code, 0);
  check('operator login ok', operatorLogin.json?.ok, true);

  fakeCalls.length = 0;
  const upload = await runCli([
    '--session-file', ownerSessionFile,
    'upload-pic',
    '--store', 'DX',
    '--image-type', '2',
    '--file', tinyPng,
    '--mode', 'execute',
  ]);
  result.summary.uploadCode = upload.code;
  result.summary.uploadImageUrl = upload.json?.adapterResult?.result?.imageUrl || upload.json?.result?.imageUrl || '';
  result.summary.uploadCallPaths = fakeCalls.map(c => c.path);
  check('cloud upload CLI exits', upload.code, 0);
  check('cloud upload ok', upload.json?.ok, true);
  check('cloud upload image url returned', result.summary.uploadImageUrl, 'https://img.shein.test/cloud-uploaded.png');
  check('cloud upload uses identity then upload', result.summary.uploadCallPaths.join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/upload-pic');
  check('cloud upload uses multipart', fakeCalls.find(c => c.path === '/open-api/goods/upload-pic')?.contentType || '', v => /multipart\/form-data/.test(v));
  check('cloud upload output omits secret', `${upload.stdout}${upload.stderr}`, text => !/fake-secret|fake-open-key/.test(String(text)));

  fakeCalls.length = 0;
  const denied = await runCli([
    '--session-file', operatorSessionFile,
    'upload-pic',
    '--store', 'HL',
    '--image-type', '2',
    '--file', tinyPng,
    '--mode', 'execute',
  ]);
  result.summary.deniedCode = denied.code;
  result.summary.deniedStatus = denied.errorJson?.status || null;
  result.summary.deniedCallCount = fakeCalls.length;
  check('operator upload outside writeStores denied exit', denied.code, code => code !== 0);
  check('operator upload outside writeStores status', result.summary.deniedStatus, 403);
  check('denied upload does not call SHEIN', result.summary.deniedCallCount, 0);

  fakeCalls.length = 0;
  const transform = await runCli([
    '--session-file', ownerSessionFile,
    'transform-pic',
    '--store', 'DX',
    '--image-type', '2',
    '--url', 'https://example.com/a.jpg',
    '--mode', 'execute',
  ]);
  result.summary.transformUrl = transform.json?.adapterResult?.result?.transformedUrl || transform.json?.result?.transformedUrl || '';
  result.summary.transformCallPaths = fakeCalls.map(c => c.path);
  check('cloud transform CLI exits', transform.code, 0);
  check('cloud transform ok', transform.json?.ok, true);
  check('cloud transform url returned', result.summary.transformUrl, 'https://img.shein.test/cloud-transformed.jpg');
  check('cloud transform uses identity then transform', result.summary.transformCallPaths.join(','), '/open-api/openapi-business-backend/query-store-info,/open-api/goods/transform-pic');

  const auditText = fssync.existsSync(auditFile) ? await fs.readFile(auditFile, 'utf8') : '';
  result.summary.auditLines = auditText.trim() ? auditText.trim().split(/\r?\n/).length : 0;
  check('audit records image utility actions', auditText, text => /openapi-image-asset-upload-pic/.test(text) && /openapi-image-asset-transform-pic/.test(text));
  check('audit omits OpenAPI secrets', auditText, text => !/fake-secret|fake-open-key/.test(String(text)));

  result.ok = result.checks.every(x => x.pass);
} finally {
  portal.kill();
  fakeOpenApi.close();
  await sleep(300);
}

console.log(JSON.stringify(result, null, 2));
if (result.ok && !KEEP_TEMP) {
  await fs.rm(tmpRoot, {recursive: true, force: true});
} else if (!result.ok) {
  console.error(`cloud image asset smoke failed; temp files kept at ${tmpRoot}`);
}
if (!result.ok) process.exit(1);
