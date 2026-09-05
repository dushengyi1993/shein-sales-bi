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
import {sha256Bytes} from '../lib/cloud_team_report_common.mjs';

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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(response, {code: '0', msg: 'OK', info: identityByStore.A});
  }
  if (url.pathname === '/open-api/goods/discuss/query-discuss-list') {
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

  // Cleanup outputs
  await fs.rm(outDir, {recursive: true, force: true}).catch(() => {});
  console.log('✓ Real pending_discuss_daily --send shared cloud delivery entry point test passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
