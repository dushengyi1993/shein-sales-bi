#!/usr/bin/env node
/**
 * Deterministic tests for the pending-discuss daily one-shot entry.
 *
 * The daily command is exercised end-to-end against a local fake OpenAPI
 * server and a fake lark binary injected through env vars. Nothing touches
 * the network and no real message is sent.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  buildDailyReportText,
  buildIdempotencyKey,
  parseLarkSendResponse,
  resolveDailyIdentity,
  resolveDailyRecipientChatId,
  verifyScanHash,
} from '../lib/pending_discuss_daily.mjs';
import {buildScanDocument, normalizePendingDiscussRow} from '../lib/pending_discuss_batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(ROOT, 'tmp'), {recursive: true});
const temp = await fs.mkdtemp(path.join(ROOT, 'tmp', 'pending-discuss-daily-'));

function sendJson(response, value, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(name, value) {
  const file = path.join(temp, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

async function hashFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function assertManifest(outDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.artifacts.length >= 1);
  for (const artifact of manifest.artifacts) {
    const file = path.join(outDir, artifact.name);
    assert.equal(await hashFile(file), artifact.sha256, `${artifact.name} sha256`);
    assert.equal((await fs.stat(file)).size, artifact.bytes, `${artifact.name} bytes`);
  }
  return manifest;
}

async function readState(stateFile) {
  const text = await fs.readFile(stateFile, 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function runCli(args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/pending_discuss_daily.mjs', ...args], {
      cwd: ROOT, env: {...process.env, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

function row({discussSn, supplierCode, price = 10, currency = 'SAR'}) {
  return {
    discussSn, discussStatus: 1, discussType: 0, supplierCode,
    skcName: `SKC-${discussSn}`, spuName: `SPU-${discussSn}`,
    productTitle: `Product ${discussSn}`, appealReason: `reason-${discussSn}`,
    appealCount: 3, serialNumber: 1,
    skuCostPrices: [{
      skuCode: `SKU-${discussSn}`, suggestCostPrice: price, suggestCostCurrency: currency,
      latestCostPrice: price + 2,
      costPriceHistories: [{serialNumber: 1, costPrice: price + 2, currency}],
    }],
  };
}

function businessDateShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ---------- pure helper invariants ----------
assert.equal(buildIdempotencyKey('2026-08-12'), 'pd-discuss-daily-20260812');
assert.ok(buildIdempotencyKey(businessDateShanghai()).length <= 50);
assert.throws(() => buildIdempotencyKey('not-a-date'), /business date/);
assert.equal(parseLarkSendResponse('{"ok":true,"message_id":"om_x","chat_id":"oc_c"}').messageId, 'om_x');
assert.equal(parseLarkSendResponse('prefix {"ok":true,"data":{"message_id":"om_nested"}}').messageId, 'om_nested');
assert.equal(parseLarkSendResponse('{"ok":true,"data":{"message":{"message_id":"om_message"}}}').messageId, 'om_message');
assert.throws(() => parseLarkSendResponse('{"ok":true}'), error => error.code === 'LARK_SEND_MESSAGE_ID_MISSING');
assert.throws(() => parseLarkSendResponse('{"ok":false,"error":{"message":"denied"}}'), error => error.code === 'LARK_SEND_NOT_OK');
assert.throws(() => parseLarkSendResponse('not json at all'), error => error.code === 'LARK_SEND_UNPARSEABLE');
assert.throws(() => parseLarkSendResponse(''), error => error.code === 'LARK_SEND_UNPARSEABLE');
assert.throws(() => resolveDailyRecipientChatId({}), error => error.code === 'LARK_RECIPIENT_CHAT_MISSING');
assert.throws(() => resolveDailyRecipientChatId({recipientUserId: 'ou_x'}), error => error.code === 'LARK_RECIPIENT_CHAT_MISSING');
assert.throws(() => resolveDailyRecipientChatId({recipientChatId: 'not-a-chat'}), error => error.code === 'LARK_RECIPIENT_CHAT_INVALID');
assert.equal(resolveDailyRecipientChatId({recipientChatId: 'oc_abc123'}), 'oc_abc123');
assert.equal(resolveDailyIdentity({}), 'bot');
assert.throws(() => resolveDailyIdentity({defaultIdentity: 'user'}), error => error.code === 'LARK_IDENTITY_INVALID');
assert.throws(() => resolveDailyIdentity({defaultIdentity: 'other'}), error => error.code === 'LARK_IDENTITY_INVALID');
assert.match(buildDailyReportText({ok: false, businessDate: '2026-08-12'}), /不按 0 条/);
const unitRow = normalizePendingDiscussRow('A', row({discussSn: 'U1', supplierCode: '(全)SK-UNIT测试'}));
const unitScan = buildScanDocument({
  businessDate: '2026-08-12', expectedStores: ['A'],
  storeResults: [{storeKey: 'A', ok: true, identity: {ok: true}, rows: [unitRow]}],
});
assert.equal(verifyScanHash(unitScan).ok, true);
assert.equal(verifyScanHash({...unitScan, rows: [{...unitScan.rows[0], discussSn: 'TAMPERED'}]}).ok, false);

// ---------- fake OpenAPI server ----------
const port = await freePort();
const state = {
  rows: {A: [], B: []},
  identityOverride: {},
  queryCount: {A: 0, B: 0},
  identityCount: {A: 0, B: 0},
};
const keyByOpenId = {'DUMMY-OPEN-A': 'A', 'DUMMY-OPEN-B': 'B'};
const identityByStore = {
  A: {merchantId: 'merchant-a', accountNo: 'GS-A'},
  B: {merchantId: 'merchant-b', accountNo: 'GS-B'},
};

const server = http.createServer(async (request, response) => {
  const key = keyByOpenId[String(request.headers['x-lt-openkeyid'] || '')] || '';
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const body = await readBody(request);
  if (url.pathname === '/open-api/openapi-business-backend/query-store-info') {
    state.identityCount[key] += 1;
    return sendJson(response, {code: '0', msg: 'OK', info: state.identityOverride[key] || identityByStore[key]});
  }
  if (url.pathname === '/open-api/goods/discuss/query-discuss-list') {
    state.queryCount[key] += 1;
    const all = (state.rows[key] || []).filter(item => Number(item.discussStatus) === Number(body.discussStatus));
    const start = (Number(body.pageNum) - 1) * Number(body.pageSize);
    const page = all.slice(start, start + Number(body.pageSize));
    const info = key === 'A' ? {count: all.length, records: page} : {totalCount: all.length, data: page};
    return sendJson(response, {code: '0', msg: 'OK', info});
  }
  return sendJson(response, {code: '404', msg: 'unhandled'}, 404);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

// ---------- fake lark binary ----------
const fakeLark = path.join(temp, 'fake-lark.mjs');
await fs.writeFile(fakeLark, `
import fs from 'node:fs/promises';
const mode = process.env.FAKE_LARK_MODE || 'ok';
const stateFile = process.env.FAKE_LARK_STATE_FILE;
if (stateFile) await fs.appendFile(stateFile, JSON.stringify({args: process.argv.slice(2)}) + '\\n', 'utf8');
if (mode === 'nonzero') { process.stderr.write('fake boom'); process.exit(1); }
if (mode === 'unparseable') { process.stdout.write('this is not json'); process.exit(0); }
if (mode === 'non-ok') { process.stdout.write(JSON.stringify({ok: false, error: {code: 99999, message: 'denied'}})); process.exit(0); }
if (mode === 'no-message-id') { process.stdout.write(JSON.stringify({ok: true, chat_id: 'oc_fakechat123', create_time: '1'})); process.exit(0); }
process.stdout.write(JSON.stringify({ok: true, message_id: 'om_fakemsg456', chat_id: 'oc_fakechat123', create_time: '1700000000'}));
process.exit(0);
`, 'utf8');
const larkBinEnv = JSON.stringify([process.execPath, fakeLark]);

async function commonEnv({mode = 'ok', stateFile = path.join(temp, 'lark-state.json')} = {}) {
  return {
    PENDING_DISCUSS_DAILY_LARK_BIN: larkBinEnv,
    FAKE_LARK_MODE: mode,
    FAKE_LARK_STATE_FILE: stateFile,
  };
}

try {
  const config = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [
      {storeKey: 'A', enabled: true, merchantId: 'merchant-a', accountNo: 'GS-A', openKeyId: 'DUMMY-OPEN-A', secretKey: 'DUMMY-SECRET-A-NEVER-LEAK'},
      {storeKey: 'B', enabled: true, merchantId: 'merchant-b', accountNo: 'GS-B', openKeyId: 'DUMMY-OPEN-B', secretKey: 'DUMMY-SECRET-B-NEVER-LEAK'},
    ],
  });
  const storesConfig = await writeJson('stores.json', {stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}]});
  const truth = await writeJson('truth.json', {stores: identityByStore});
  const larkConfig = await writeJson('lark.json', {recipientChatId: 'oc_fakechat123', defaultIdentity: 'bot'});
  const common = [
    '--config', config, '--stores-config', storesConfig, '--store-truth', truth,
    '--expected-store-count', '2', '--lark-config', larkConfig,
    '--read-attempts', '2', '--read-delay-ms', '1', '--request-timeout-ms', '3000',
  ];
  const businessDate = businessDateShanghai();
  const compactDate = businessDate.replaceAll('-', '');

  // 1. Zero rows with --send: explicit zero + strict send receipt.
  state.rows.A = [];
  state.rows.B = [];
  state.identityOverride = {};
  const zeroState = path.join(temp, 'lark-zero.json');
  const zeroDir = path.join(temp, 'zero-send');
  const zero = await runCli(['daily', '--out-dir', zeroDir, '--send', ...common], await commonEnv({stateFile: zeroState}));
  assert.equal(zero.code, 0, zero.stderr || zero.stdout);
  const zeroScan = JSON.parse(await fs.readFile(path.join(zeroDir, 'scan.json'), 'utf8'));
  assert.equal(zeroScan.ok, true);
  assert.equal(zeroScan.rowCount, 0);
  assert.equal(zeroScan.coverage.succeededCount, 2);
  assert.equal(verifyScanHash(zeroScan).ok, true);
  const zeroReport = await fs.readFile(path.join(zeroDir, 'report.txt'), 'utf8');
  assert.match(zeroReport, /0 条/);
  const zeroDelivery = JSON.parse(await fs.readFile(path.join(zeroDir, 'delivery.json'), 'utf8'));
  assert.equal(zeroDelivery.status, 'ok');
  assert.equal(zeroDelivery.messageIdVerified, true);
  assert.equal(zeroDelivery.idempotencyKey, `pd-discuss-daily-${compactDate}`);
  assert.ok(zeroDelivery.idempotencyKey.length <= 50);
  const zeroCalls = await readState(zeroState);
  assert.equal(zeroCalls.length, 1);
  assert.deepEqual(zeroCalls[0].args.slice(0, 4), ['im', '+messages-send', '--as', 'bot']);
  assert.ok(zeroCalls[0].args.includes('--chat-id'));
  assert.equal(zeroCalls[0].args[zeroCalls[0].args.indexOf('--chat-id') + 1], 'oc_fakechat123');
  assert.equal(zeroCalls[0].args[zeroCalls[0].args.indexOf('--idempotency-key') + 1], `pd-discuss-daily-${compactDate}`);
  assert.equal(zero.json.ok, true);
  assert.equal(zero.json.rowCount, 0);
  assert.equal(zero.json.delivery.status, 'ok');
  assert.equal(zero.json.delivery.messageIdVerified, true);
  assert.ok(!zero.stdout.includes('oc_fakechat123'), 'compact output must not contain the target');
  assert.ok(!zero.stdout.includes('om_fakemsg456'), 'compact output must not contain the message id');
  const zeroManifest = await assertManifest(zeroDir);
  assert.equal(zeroManifest.delivery, 'ok');
  assert.deepEqual(zeroManifest.artifacts.map(item => item.name).sort(), ['delivery.json', 'report.txt', 'scan.json'].sort());

  // 2. Data rows without --send: aggregated human report + skipped delivery.
  state.rows.A = [
    row({discussSn: 'D-7027', supplierCode: '(全)SK-7027绞肉机', price: 9}),
    row({discussSn: 'D-7028', supplierCode: '(全)SK-7027绞肉机', price: 11}),
  ];
  state.rows.B = [row({discussSn: 'D-03012', supplierCode: '(全)SK-03012台式榨汁机', price: 13})];
  state.identityOverride = {};
  state.queryCount = {A: 0, B: 0};
  state.identityCount = {A: 0, B: 0};
  const dataDir = path.join(temp, 'data-nosend');
  const data = await runCli(['daily', '--out-dir', dataDir, ...common]);
  assert.equal(data.code, 0, data.stderr || data.stdout);
  const dataScan = JSON.parse(await fs.readFile(path.join(dataDir, 'scan.json'), 'utf8'));
  assert.equal(dataScan.rowCount, 3);
  const dataReport = await fs.readFile(path.join(dataDir, 'report.txt'), 'utf8');
  assert.match(dataReport, /共 3 条待议价/);
  assert.match(dataReport, /SK-7027绞肉机/);
  assert.match(dataReport, /条数：2/);
  assert.match(dataReport, /店铺：A/);
  assert.match(dataReport, /SAR建议价：9–11/);
  assert.match(dataReport, /原因：reason-D-7027；reason-D-7028/);
  assert.match(dataReport, /剩余申诉次数：3/);
  assert.match(dataReport, /SK-03012台式榨汁机/);
  assert.match(dataReport, /条数：1/);
  assert.match(dataReport, /店铺：B/);
  assert.match(dataReport, /SAR建议价：13/);
  const dataDelivery = JSON.parse(await fs.readFile(path.join(dataDir, 'delivery.json'), 'utf8'));
  assert.equal(dataDelivery.status, 'skipped');
  assert.equal(dataDelivery.reason, 'send not requested');
  assert.equal(dataDelivery.messageIdVerified, false);
  assert.ok(!Object.hasOwn(dataDelivery, 'idempotencyKey'));
  assert.equal(data.json.delivery.status, 'skipped');
  assert.ok(!data.stdout.includes('oc_'), 'no target in compact output');
  await assertManifest(dataDir);
  // Exactly one scan: one identity probe and one status query per store.
  assert.deepEqual(state.identityCount, {A: 1, B: 1});
  assert.deepEqual(state.queryCount, {A: 1, B: 1});

  // 3. Failed scan: no send, never reported as zero.
  state.identityOverride.B = {merchantId: 'wrong-merchant', accountNo: 'WRONG'};
  const failState = path.join(temp, 'lark-fail.json');
  const failDir = path.join(temp, 'scan-fail');
  const failed = await runCli(['daily', '--out-dir', failDir, ...common], await commonEnv({stateFile: failState}));
  assert.equal(failed.code, 3);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.rowCount, null);
  assert.deepEqual(failed.json.blockers, ['STORE_QUERY_FAILED']);
  const failScan = JSON.parse(await fs.readFile(path.join(failDir, 'scan.json'), 'utf8'));
  assert.equal(failScan.ok, false);
  assert.deepEqual(failScan.coverage.failedStores, ['B']);
  await assert.ok(!(await fs.access(path.join(failDir, 'report.txt')).then(() => true).catch(() => false)), 'no report on failed scan');
  await assert.ok(!(await fs.access(path.join(failDir, 'delivery.json')).then(() => true).catch(() => false)), 'no delivery on failed scan');
  assert.equal((await readState(failState)).length, 0, 'failed scan must never send');
  const failManifest = await assertManifest(failDir);
  assert.deepEqual(failManifest.artifacts.map(item => item.name).sort(), ['error.json', 'scan.json'].sort());
  delete state.identityOverride.B;

  // 4. Missing group config: --send fails before any lark call.
  const noChatConfig = await writeJson('lark-no-chat.json', {recipientUserId: 'ou_someuser', defaultIdentity: 'bot'});
  const noChatState = path.join(temp, 'lark-no-chat.json.state');
  const noChatDir = path.join(temp, 'no-chat');
  const noChat = await runCli([
    'daily', '--out-dir', noChatDir, '--send',
    '--config', config, '--stores-config', storesConfig, '--store-truth', truth,
    '--expected-store-count', '2', '--lark-config', noChatConfig,
    '--read-attempts', '2', '--read-delay-ms', '1', '--request-timeout-ms', '3000',
  ], await commonEnv({stateFile: noChatState}));
  assert.equal(noChat.code, 3);
  assert.equal(noChat.json.delivery.status, 'failed');
  const noChatDelivery = JSON.parse(await fs.readFile(path.join(noChatDir, 'delivery.json'), 'utf8'));
  assert.equal(noChatDelivery.status, 'failed');
  assert.equal(noChatDelivery.error.code, 'LARK_RECIPIENT_CHAT_MISSING');
  assert.equal(noChatDelivery.messageIdVerified, false);
  assert.equal((await readState(noChatState)).length, 0, 'no send without a configured chat');
  await assertManifest(noChatDir);

  // 5. Missing message_id: delivery is not ok.
  const noIdState = path.join(temp, 'lark-no-id.json');
  const noIdDir = path.join(temp, 'no-message-id');
  const noId = await runCli(['daily', '--out-dir', noIdDir, '--send', ...common], await commonEnv({mode: 'no-message-id', stateFile: noIdState}));
  assert.equal(noId.code, 3);
  assert.equal(noId.json.delivery.status, 'failed');
  assert.equal(noId.json.delivery.messageIdVerified, false);
  const noIdDelivery = JSON.parse(await fs.readFile(path.join(noIdDir, 'delivery.json'), 'utf8'));
  assert.equal(noIdDelivery.status, 'failed');
  assert.equal(noIdDelivery.error.code, 'LARK_SEND_MESSAGE_ID_MISSING');
  assert.ok(!noId.stdout.includes('om_fakemsg456'));
  assert.equal((await assertManifest(noIdDir)).ok, false);

  // 6. Process failure / non-ok / unparseable responses all fail delivery.
  for (const [mode, expectedCode] of [
    ['nonzero', 'LARK_SEND_PROCESS_FAILED'],
    ['non-ok', 'LARK_SEND_NOT_OK'],
    ['unparseable', 'LARK_SEND_UNPARSEABLE'],
  ]) {
    const dir = path.join(temp, `send-${mode}`);
    const run = await runCli(['daily', '--out-dir', dir, '--send', ...common], await commonEnv({mode}));
    assert.equal(run.code, 3, `${mode} must exit 3`);
    assert.equal(run.json.delivery.status, 'failed');
    const delivery = JSON.parse(await fs.readFile(path.join(dir, 'delivery.json'), 'utf8'));
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.error.code, expectedCode);
    assert.equal(delivery.messageIdVerified, false);
    await assertManifest(dir);
  }

  // 7. Manifest/hash self-check detects tampering.
  const tamperedScan = JSON.parse(await fs.readFile(path.join(zeroDir, 'scan.json'), 'utf8'));
  tamperedScan.rows = [{discussSn: 'TAMPERED'}];
  assert.equal(verifyScanHash(tamperedScan).ok, false);
  const tamperedReport = path.join(zeroDir, 'report.txt');
  await fs.appendFile(tamperedReport, 'tampered', 'utf8');
  await assert.rejects(assertManifest(zeroDir), /sha256/);

  // Artifacts never leak fake credentials or chat/message ids.
  const evidenceFiles = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (path.dirname(file) !== temp && file !== tamperedReport && !/^lark-/.test(entry.name)) evidenceFiles.push(file);
    }
  }
  await walk(temp);
  const evidenceText = (await Promise.all(evidenceFiles.map(file => fs.readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(evidenceText, /DUMMY-SECRET-A-NEVER-LEAK|DUMMY-SECRET-B-NEVER-LEAK|DUMMY-OPEN-A|DUMMY-OPEN-B|oc_fakechat123|om_fakemsg456/);

  console.log(JSON.stringify({
    ok: true,
    checks: {
      zeroSendReceipt: true, aggregatedReport: true, singleScanReuse: true,
      scanFailureNoSendNoZero: true, missingGroupConfigFails: true,
      missingMessageIdFails: true, processAndResponseFailures: true,
      manifestHashSelfCheck: true, redaction: true,
    },
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
