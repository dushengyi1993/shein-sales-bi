#!/usr/bin/env node
/**
 * Test real pending_discuss_daily.mjs entry point with --send using a mock SSH command
 * in the shared cloud channel (without PENDING_DISCUSS_DAILY_LARK_BIN env var).
 *
 * Verifies:
 * 1. The real pending_discuss_daily child process executes;
 * 2. It parses scan.json and report.txt;
 * 3. The raw file bytes SHA-256 of scan.json is computed and passed to the shared cloud channel;
 * 4. Stdin bundle contains the exact expected attachment SHA and report text;
 * 5. Mock SSH returns strict success with messageIdVerified=true;
 * 6. Zero real network/production write.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {sha256Bytes, computeDeliveryFingerprint} from '../lib/cloud_team_report_common.mjs';
import {runCli, isCloudEnvironment} from './pending_discuss_daily.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'test-pd-shared-entry-'));

function sendJson(response, value, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(value));
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

// 1. Setup mock OpenAPI server
const port = await freePort();
const identityByStore = {
  A: {merchantId: 'merchant-a', accountNo: 'GS-A'},
};

let queryDiscussListCalls = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(response, {code: '0', msg: 'OK', info: identityByStore.A});
  }
  if (url.pathname === '/open-api/goods/discuss/query-discuss-list') {
    queryDiscussListCalls += 1;
    return sendJson(response, {code: '0', msg: 'OK', info: {count: 0, records: []}});
  }
  return sendJson(response, {code: '404', msg: 'unhandled'}, 404);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

// 2. Setup mock SSH executable that inspects bundle stdin
const mockSshScript = path.join(temp, 'mock-ssh.mjs');
const capturedBundleFile = path.join(temp, 'captured-bundle.json');

await fs.writeFile(mockSshScript, `import fs from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8').trim();
const target = process.env.CAPTURED_BUNDLE_FILE;
if (target) fs.writeFileSync(target, raw, 'utf8');

const bundle = JSON.parse(raw);
const outcome = {
  ok: true,
  status: 'ok',
  automationId: bundle.automationId,
  businessDate: bundle.businessDate,
  fingerprint: bundle.fingerprint,
  attachmentName: bundle.attachmentName,
  attachmentSha256: bundle.expectedAttachmentSha256,
  summarySha256: 'summary_sha_test',
  items: {
    summary: { accepted: true, messageId: 'om_mock_summary_123' },
    attachment: { accepted: true, messageId: 'om_mock_attachment_456' },
  },
};
console.log(JSON.stringify(outcome));
process.exit(0);
`, 'utf8');

const mockSshBin = path.join(temp, process.platform === 'win32' ? 'ssh.cmd' : 'ssh');
if (process.platform === 'win32') {
  await fs.writeFile(mockSshBin, `@echo off\n"${process.execPath}" "${mockSshScript}" %*\n`, 'utf8');
} else {
  await fs.writeFile(mockSshBin, `#!/bin/sh\nexec "${process.execPath}" "${mockSshScript}" "$@"\n`, 'utf8');
  await fs.chmod(mockSshBin, 0o755);
}

try {
  const openapiConfig = path.join(temp, 'openapi.json');
  await fs.writeFile(openapiConfig, JSON.stringify({
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [
      {storeKey: 'A', enabled: true, merchantId: 'merchant-a', accountNo: 'GS-A', openKeyId: 'K-A', secretKey: 'S-A'},
    ],
  }, null, 2), 'utf8');

  const storesConfig = path.join(temp, 'stores.json');
  await fs.writeFile(storesConfig, JSON.stringify({stores: [{storeKey: 'A', enabled: true}]}, null, 2), 'utf8');

  const truthConfig = path.join(temp, 'truth.json');
  await fs.writeFile(truthConfig, JSON.stringify({stores: identityByStore}, null, 2), 'utf8');

  // Notice: We create outDir under ROOT/outputs so validateLocalOutputFile succeeds!
  const outDir = path.join(ROOT, 'outputs', 'test-pd-shared-' + Date.now());
  await fs.mkdir(outDir, {recursive: true});

  // Execute real pending_discuss_daily.mjs entry point with --send!
  // PATH is prepended with temp dir so 'ssh' resolves to mockSshBin!
  // Ensure PENDING_DISCUSS_DAILY_LARK_BIN is NOT set!
  const env = {
    ...process.env,
    PATH: `${temp}${path.delimiter}${process.env.PATH}`,
    CAPTURED_BUNDLE_FILE: capturedBundleFile,
    CLOUD_TEAM_REPORT_SSH_BIN: mockSshBin,
    PENDING_DISCUSS_DAILY_LARK_BIN: '',
  };
  delete env.PENDING_DISCUSS_DAILY_LARK_BIN;

  const child = spawn(process.execPath, [
    'scripts/pending_discuss_daily.mjs',
    'daily',
    '--out-dir', outDir,
    '--send',
    '--config', openapiConfig,
    '--stores-config', storesConfig,
    '--store-truth', truthConfig,
    '--expected-store-count', '1',
    '--read-attempts', '1',
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const exitCode = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exitCode, 0, `pending_discuss_daily failed with stderr: ${stderr}, stdout: ${stdout}`);

  // Verify delivery.json was written and ok
  const deliveryDoc = JSON.parse(await fs.readFile(path.join(outDir, 'delivery.json'), 'utf8'));
  assert.equal(deliveryDoc.status, 'ok');
  assert.equal(deliveryDoc.messageIdVerified, true);

  // Verify scan.json was written and compute its real file bytes SHA-256
  const scanBytes = await fs.readFile(path.join(outDir, 'scan.json'));
  const actualScanFileSha = sha256Bytes(scanBytes);

  // Verify captured bundle sent across SSH
  assert.equal(await fs.access(capturedBundleFile).then(() => true).catch(() => false), true);
  const bundleSent = JSON.parse(await fs.readFile(capturedBundleFile, 'utf8'));

  assert.equal(bundleSent.automationId, 'pending-discuss-daily');
  assert.equal(bundleSent.attachmentName, 'scan.json');
  assert.equal(bundleSent.expectedAttachmentSha256, actualScanFileSha, 'Expected attachment SHA must match raw scan.json file bytes SHA-256');

  // Verify decoded attachment base64 matches raw bytes exactly
  const decodedAttachmentBytes = Buffer.from(bundleSent.attachmentBase64, 'base64');
  assert.equal(sha256Bytes(decodedAttachmentBytes), actualScanFileSha);

  // Verify report.txt was written and compute its real file bytes SHA-256
  const reportBytes = await fs.readFile(path.join(outDir, 'report.txt'));
  const actualReportFileSha = sha256Bytes(reportBytes);

  // Verify decoded summary base64 matches raw report.txt file bytes SHA-256
  const decodedSummaryBytes = Buffer.from(bundleSent.summaryBase64, 'base64');
  assert.equal(sha256Bytes(decodedSummaryBytes), actualReportFileSha, 'Decoded summary base64 must match raw report.txt file bytes SHA-256');
  assert.equal(decodedSummaryBytes.toString('utf8'), reportBytes.toString('utf8'));

  // Verify queryDiscussListCalls is 1
  assert.equal(queryDiscussListCalls, 1, `Expected 1 scan query call, got ${queryDiscussListCalls}`);
  // Cleanup outputs
  await fs.rm(outDir, {recursive: true, force: true}).catch(() => {});
  console.log('✓ Real pending_discuss_daily --send shared cloud delivery local SSH entry point passed');

  // =========================================================================
  // 7. Test cloud production branch with isolated runtime directory outside outputs
  // =========================================================================
  const cloudRuntimeDir = path.join(temp, 'srv-runtime', 'pending-discuss', '2026-09-06', 'cloud-run-01');
  const cloudLandingRoot = path.join(temp, 'srv-runtime', 'automation-delivery');
  const cloudConfig = {
    recipientChatId: 'oc_testcloudgroup123',
    defaultIdentity: 'bot',
  };

  const fakeLarkCalls = [];
  let fakeSshCalled = false;
  const fakeLarkSpawn = (bin, args, options) => {
    fakeLarkCalls.push({bin, args, options});
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({ok: true, message_id: 'om_cloud_msg_' + fakeLarkCalls.length}));
      child.emit('close', 0);
    });
    return child;
  };

  const cloudCliResult = await runCli({
    command: 'daily',
    outDir: cloudRuntimeDir,
    send: true,
    config: openapiConfig,
    storesConfig,
    storeTruth: truthConfig,
    expectedStoreCount: 1,
    readAttempts: 1,
    readDelayMs: 0,
    requestTimeoutMs: 3000,
  }, {
    isCloud: true,
    landingRoot: cloudLandingRoot,
    cloudConfig,
    spawnImpl: fakeLarkSpawn,
    runLocalFn: () => {
      fakeSshCalled = true;
      throw new Error('runLocalCloudTeamReport must not be called in cloud environment');
    },
  });

  assert.equal(cloudCliResult.exitCode, 0, `cloud runCli failed: ${JSON.stringify(cloudCliResult.result)}`);
  assert.equal(cloudCliResult.result.ok, true);
  assert.equal(cloudCliResult.result.delivery.status, 'ok');
  assert.equal(cloudCliResult.result.delivery.messageIdVerified, true);
  assert.equal(fakeSshCalled, false, '0 SSH calls must be made in cloud environment');

  // Verify scan.json was written in isolated cloud directory outside outputs
  const cloudScanFile = path.join(cloudRuntimeDir, 'scan.json');
  assert.equal(await fs.access(cloudScanFile).then(() => true).catch(() => false), true);
  const cloudScanBytes = await fs.readFile(cloudScanFile);
  const cloudScanSha = sha256Bytes(cloudScanBytes);

  // Verify report.txt was written
  const cloudReportFile = path.join(cloudRuntimeDir, 'report.txt');
  assert.equal(await fs.access(cloudReportFile).then(() => true).catch(() => false), true);
  const cloudReportBytes = await fs.readFile(cloudReportFile);
  const cloudReportSha = sha256Bytes(cloudReportBytes);

  // Verify landing directory received summary.md and scan.json with identical raw bytes and hash
  const cloudFp = computeDeliveryFingerprint({
    automationId: 'pending-discuss-daily',
    businessDate: cloudCliResult.result.businessDate,
    attachmentSha256: cloudScanSha,
  });
  const stagedDir = path.join(cloudLandingRoot, 'pending-discuss-daily', cloudCliResult.result.businessDate, cloudFp);
  const stagedSummaryBytes = await fs.readFile(path.join(stagedDir, 'summary.md'));
  const stagedAttachmentBytes = await fs.readFile(path.join(stagedDir, 'scan.json'));

  assert.equal(sha256Bytes(stagedSummaryBytes), cloudReportSha, 'Landing summary.md bytes must match raw report.txt');
  assert.equal(sha256Bytes(stagedAttachmentBytes), cloudScanSha, 'Landing scan.json bytes must match raw scan.json');
  assert.equal(fakeLarkCalls.length, 2, 'fake Lark must receive exactly summary and attachment');
  assert.equal(fakeLarkCalls[0].args.includes('--markdown'), true);
  assert.equal(fakeLarkCalls[1].args.includes('--file'), true);

  // Verify manifest.json and delivery.json
  const cloudManifestDoc = JSON.parse(await fs.readFile(path.join(cloudRuntimeDir, 'manifest.json'), 'utf8'));
  assert.equal(cloudManifestDoc.ok, true);
  assert.equal(cloudManifestDoc.delivery, 'ok');

  const cloudDeliveryDoc = JSON.parse(await fs.readFile(path.join(cloudRuntimeDir, 'delivery.json'), 'utf8'));
  assert.equal(cloudDeliveryDoc.status, 'ok');
  assert.equal(cloudDeliveryDoc.messageIdVerified, true);
  assert.equal(cloudDeliveryDoc.scanHash, cloudManifestDoc.scanHash);
  assert.equal(queryDiscussListCalls, 2, `Expected 2 cumulative scan query calls, got ${queryDiscussListCalls}`);

  console.log('✓ Cloud production branch with isolated runtime path and 0 SSH passed');

  // =========================================================================
  // 8. Test cloud delivery failure: fake Lark rejection fails closed
  // =========================================================================
  const failRuntimeDir = path.join(temp, 'srv-runtime', 'pending-discuss', '2026-09-06', 'cloud-run-fail');
  const failingLarkSpawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({ok: false, error: 'simulated_lark_error'}));
      child.emit('close', 1);
    });
    return child;
  };

  const failResult = await runCli({
    command: 'daily',
    outDir: failRuntimeDir,
    send: true,
    config: openapiConfig,
    storesConfig,
    storeTruth: truthConfig,
    expectedStoreCount: 1,
    readAttempts: 1,
    readDelayMs: 0,
    requestTimeoutMs: 3000,
  }, {
    isCloud: true,
    landingRoot: cloudLandingRoot,
    cloudConfig,
    spawnImpl: failingLarkSpawn,
  });

  assert.equal(failResult.exitCode, 3, 'Delivery failure must exit with code 3');
  assert.equal(failResult.result.ok, false);
  assert.equal(failResult.result.delivery.status, 'failed');
  assert.equal(failResult.result.delivery.messageIdVerified, false);

  const failDeliveryDoc = JSON.parse(await fs.readFile(path.join(failRuntimeDir, 'delivery.json'), 'utf8'));
  assert.equal(failDeliveryDoc.status, 'failed');
  assert.equal(failDeliveryDoc.messageIdVerified, false);
  assert.equal(queryDiscussListCalls, 3, `Expected 3 cumulative scan query calls, got ${queryDiscussListCalls}`);

  console.log('✓ Cloud production branch failure fails closed (status=failed, exitCode=3)');

  // =========================================================================
  // 9. Test stage-delivery + send co-existence does not double deliver
  // =========================================================================
  const stageRuntimeDir = path.join(temp, 'srv-runtime', 'pending-discuss', '2026-09-06', 'cloud-run-stage');
  const stageLarkCalls = [];
  const stageLarkSpawn = (bin, args, options) => {
    stageLarkCalls.push({bin, args, options});
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.end(JSON.stringify({ok: true, message_id: 'om_stage_msg_' + stageLarkCalls.length}));
      child.emit('close', 0);
    });
    return child;
  };

  let stageSpyCalls = 0;
  const stageSpy = async () => {
    stageSpyCalls += 1;
    throw new Error('stageAndDeliverBusinessResult must not be called when --send is active');
  };

  const stageResult = await runCli({
    command: 'daily',
    outDir: stageRuntimeDir,
    send: true,
    stageDelivery: true,
    config: openapiConfig,
    storesConfig,
    storeTruth: truthConfig,
    expectedStoreCount: 1,
    readAttempts: 1,
    readDelayMs: 0,
    requestTimeoutMs: 3000,
  }, {
    isCloud: true,
    landingRoot: cloudLandingRoot,
    cloudConfig,
    spawnImpl: stageLarkSpawn,
    stageFn: stageSpy,
  });

  assert.equal(stageSpyCalls, 0, `stageFn must be called 0 times when --send is active, got ${stageSpyCalls}`);
  assert.equal(queryDiscussListCalls, 4, `Expected 4 cumulative scan query calls, got ${queryDiscussListCalls}`);

  assert.equal(stageResult.exitCode, 0);
  assert.equal(stageLarkCalls.length, 2, 'Only 2 Lark calls (1 summary + 1 attachment), no second delivery');
  const stageManifest = JSON.parse(await fs.readFile(path.join(stageRuntimeDir, 'manifest.json'), 'utf8'));
  assert.equal(stageManifest.stagedDelivery, 'shared-delivered');

  console.log('✓ Stage-delivery + send co-existence avoids duplicate delivery');

  // =========================================================================
  // 10. Test local preflight rejection: outside outputs and symlinks rejected before scan
  // =========================================================================
  const outsideDir = path.join(temp, 'local-outside-out');
  const outsideResult = await runCli({
    command: 'daily',
    outDir: outsideDir,
    send: true,
    config: openapiConfig,
    storesConfig,
    storeTruth: truthConfig,
    expectedStoreCount: 1,
  }, {
    isCloud: false,
    root: ROOT,
  });

  assert.equal(outsideResult.exitCode, 3);
  assert.equal(outsideResult.result.error?.code, 'LOCAL_ARTIFACT_OUTSIDE_OUTPUTS');
  assert.equal(await fs.access(path.join(outsideDir, 'scan.json')).then(() => true).catch(() => false), false, 'scan.json must not be created on preflight failure');
  assert.equal(queryDiscussListCalls, 4, `Preflight outside outputs must reject before scan, expected 4 calls, got ${queryDiscussListCalls}`);

  // Test symlink parent rejection under fake outputs
  const fakeRepo = path.join(temp, 'fake-local-repo');
  const fakeOutputs = path.join(fakeRepo, 'outputs');
  const fakeReal = path.join(temp, 'fake-real-dir');
  await fs.mkdir(fakeOutputs, {recursive: true});
  await fs.mkdir(fakeReal, {recursive: true});
  const symlinkDir = path.join(fakeOutputs, 'symlink-folder');
  await fs.symlink(fakeReal, symlinkDir, 'junction');

  const symlinkOutDir = path.join(symlinkDir, 'daily-run');
  const symlinkResult = await runCli({
    command: 'daily',
    outDir: symlinkOutDir,
    send: true,
    config: openapiConfig,
    storesConfig,
    storeTruth: truthConfig,
    expectedStoreCount: 1,
  }, {
    isCloud: false,
    root: fakeRepo,
  });

  assert.equal(symlinkResult.exitCode, 3);
  assert.equal(symlinkResult.result.error?.code, 'LOCAL_ARTIFACT_SYMLINK');
  assert.equal(await fs.access(path.join(symlinkOutDir, 'scan.json')).then(() => true).catch(() => false), false, 'scan.json must not be created on symlink failure');
  assert.equal(queryDiscussListCalls, 4, `Preflight symlink must reject before scan, expected 4 calls, got ${queryDiscussListCalls}`);
  assert.deepEqual(await fs.readdir(fakeReal), [], 'Rejected symlink must not create error artifacts through its target');
  assert.equal(await fs.access(outsideDir).then(() => true).catch(() => false), false);

  // Reject a completed run before any new scan, delivery, error file or manifest write.
  const directoryBytes = async directory => Object.fromEntries(await Promise.all(
    (await fs.readdir(directory)).sort().map(async name => [name, sha256Bytes(await fs.readFile(path.join(directory, name)))]),
  ));
  const preservedRun = await directoryBytes(cloudRuntimeDir);
  const reused = await runCli({command: 'daily', outDir: cloudRuntimeDir, send: true}, {isCloud: true});
  assert.equal(reused.exitCode, 3);
  assert.equal(reused.result.failureFile, '');
  assert.deepEqual(await directoryBytes(cloudRuntimeDir), preservedRun);
  assert.equal(queryDiscussListCalls, 4);
  assert.equal(fakeLarkCalls.length, 2);
  console.log('✓ Completed run reuse rejected with zero scans, sends or artifact changes');

  for (const scenario of [
    {name: 'environment-stage', expected: 'ok', responses: [{ok: true, message_id: 'om_env_s'}, {ok: true, message_id: 'om_env_a'}], stageEnv: true},
    {name: 'partial-attachment', expected: 'partial', responses: [{ok: true, message_id: 'om_partial_s'}, {ok: false}]},
    {name: 'unknown-summary', expected: 'unknown', responses: [{ok: true}]},
    {name: 'unknown-attachment', expected: 'unknown', responses: [{ok: true, message_id: 'om_unknown_s'}, {ok: true}]},
  ]) {
    const directory = path.join(temp, 'srv-runtime', scenario.name);
    const landingRoot = path.join(temp, 'delivery-' + scenario.name);
    const scanCount = queryDiscussListCalls;
    let sends = 0, secondaryCalls = 0;
    const priorStage = process.env.STAGE_OPS_DELIVERY;
    const spawnImpl = () => {
      const response = scenario.responses[sends++];
      assert(response, 'Unexpected extra delivery process');
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {child.stdout.end(JSON.stringify(response)); child.emit('close', 0);});
      return child;
    };
    let result;
    try {
      if (scenario.stageEnv) process.env.STAGE_OPS_DELIVERY = '1';
      result = await runCli(['daily', '--out-dir', directory, '--send', '--config', openapiConfig,
        '--stores-config', storesConfig, '--store-truth', truthConfig, '--expected-store-count', '1', '--read-attempts', '1'], {
        isCloud: true, landingRoot, cloudConfig, spawnImpl,
        runLocalFn: () => {throw new Error('Cloud entry must not invoke SSH');},
        stageFn: () => {secondaryCalls += 1; throw new Error('Secondary delivery must not run');},
      });
    } finally {
      if (priorStage === undefined) delete process.env.STAGE_OPS_DELIVERY;
      else process.env.STAGE_OPS_DELIVERY = priorStage;
    }
    assert.equal(queryDiscussListCalls, scanCount + 1, scenario.name + ' scans exactly once');
    assert.equal(sends, scenario.responses.length, scenario.name + ' does not retry');
    assert.equal(secondaryCalls, 0);
    const scanBytes = await fs.readFile(path.join(directory, 'scan.json'));
    assert.equal(JSON.parse(scanBytes).ok, true, 'Delivery failure cannot erase successful scan evidence');
    const fingerprint = computeDeliveryFingerprint({automationId: 'pending-discuss-daily', businessDate: result.result.businessDate, attachmentSha256: sha256Bytes(scanBytes)});
    const state = JSON.parse(await fs.readFile(path.join(landingRoot, 'pending-discuss-daily', result.result.businessDate, fingerprint, 'state.json'), 'utf8'));
    assert.equal(state.status, scenario.expected);
    assert.equal(result.exitCode, scenario.expected === 'ok' ? 0 : 3);
    assert.equal(result.result.delivery.messageIdVerified, scenario.expected === 'ok');
    if (scenario.expected === 'unknown') {
      const delivery = JSON.parse(await fs.readFile(path.join(directory, 'delivery.json'), 'utf8'));
      assert.equal(delivery.error.code, 'lark_receipt_unknown');
    }
    console.log('✓ ' + scenario.name + ': exact scan count, durable receipt state and no duplicate delivery');
  }

  // Verify isCloudEnvironment edge cases
  assert.equal(isCloudEnvironment('C:\\\\non\\\\existent\\\\path\\\\12345'), false);

  console.log('✓ Local preflight rejection (outside outputs & symlink) passed without running scan');
  console.log('✓ All pending_discuss_daily shared delivery tests passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
