#!/usr/bin/env node
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {
  CLOUD_TEAM_REPORT_CLOUD_HOST,
  interpretLarkResult,
  sha256Bytes,
} from '../lib/cloud_team_report_common.mjs';
import {
  buildCloudLandingPaths,
  deliverCloudTeamReport,
  validateCloudLarkConfig,
} from '../lib/cloud_team_report_cloud.mjs';
import {
  buildCloudTeamReportBundle,
  runLocalCloudTeamReport,
  validateLocalOutputFile,
} from '../lib/cloud_team_report_local.mjs';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-cloud-team-report-'));
const repositoryRoot = path.join(tempRoot, 'repo');
const outputsRoot = path.join(repositoryRoot, 'outputs');
await fs.mkdir(outputsRoot, {recursive: true});
const summaryFile = path.join(outputsRoot, 'summary.md');
const attachmentFile = path.join(outputsRoot, 'report.bin');
await fs.writeFile(summaryFile, '# team report\nnot a target\n', 'utf8');
await fs.writeFile(attachmentFile, Buffer.from('attachment-v1\n', 'utf8'));
const attachmentSha256 = sha256Bytes(await fs.readFile(attachmentFile));
const config = {recipientChatId: 'oc_group123', defaultIdentity: 'bot'};

function fakeSpawnFactory(responses, calls = []) {
  return (bin, args, options) => {
    const response = responses.length ? responses.shift() : {ok: false, error: {code: 'NO_FAKE_RESPONSE'}};
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = '';
    child.stdin.on('data', chunk => { stdin += chunk.toString('utf8'); });
    calls.push({bin, args: [...args], options, stdin, child});
    queueMicrotask(() => {
      const output = typeof response === 'string' ? response : JSON.stringify(response.output || response);
      const stderr = typeof response === 'object' ? String(response.stderr || '') : '';
      const exitCode = typeof response === 'object' && response.exitCode !== undefined ? response.exitCode : 0;
      child.stdout.end(output);
      child.stderr.end(stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}

async function makeBundle() {
  return buildCloudTeamReportBundle({
    automationId: 'daily-report',
    businessDate: '2026-08-24',
    summaryFile,
    attachment: attachmentFile,
    expectedAttachmentSha256: attachmentSha256,
    root: repositoryRoot,
  });
}

async function assertCode(action, code) {
  try {
    await action();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code || error}`);
  }
}

// Local path: the only child process is the fixed SSH hop. There is no local
// lark-cli command or local chat target in the argv/stdout contract.
const localCalls = [];
const localFixtureBundle = await makeBundle();
const localResult = await runLocalCloudTeamReport({
  automationId: 'daily-report',
  businessDate: '2026-08-24',
  summaryFile,
  attachment: attachmentFile,
  expectedAttachmentSha256: attachmentSha256,
  cloudSsh: CLOUD_TEAM_REPORT_CLOUD_HOST,
  root: repositoryRoot,
  spawnImpl: fakeSpawnFactory([{
    ok: true,
    status: 'ok',
    automationId: 'daily-report',
    businessDate: '2026-08-24',
    fingerprint: localFixtureBundle.fingerprint,
    attachmentSha256,
    summarySha256: sha256Bytes(Buffer.from(localFixtureBundle.summaryBase64, 'base64')),
    items: {summary: {accepted: true}, attachment: {accepted: true}},
    message_id: 'om_local_output_must_strip',
    chat_id: 'oc_local_output_must_strip',
  }], localCalls),
});
assert.equal(localCalls.length, 1);
assert.equal(localCalls[0].bin, 'ssh');
assert.deepEqual(localCalls[0].args.slice(0, 4), [CLOUD_TEAM_REPORT_CLOUD_HOST, 'node', '/opt/shein-bi/app/scripts/cloud_team_report_delivery.mjs', 'deliver-stdin']);
assert.doesNotMatch(JSON.stringify(localCalls[0].args), /oc_|chat[_-]?id|recipientchatid/iu);
assert.doesNotMatch(JSON.stringify(localResult), /oc_|om_|message[_-]?id|token|app[_-]?secret/iu);
const localSource = await fs.readFile(new URL('../lib/cloud_team_report_local.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(localSource, /lark-cli/iu, 'local implementation must not invoke or name a local lark-cli');

// Cloud bot identity lock: a user identity is rejected before any child
// process, while a valid config always sends with --as bot.
assert.throws(() => validateCloudLarkConfig({recipientChatId: 'oc_group123', defaultIdentity: 'user'}), error => error?.code === 'LARK_IDENTITY_LOCKED');
assert.throws(() => validateCloudLarkConfig({recipientChatId: 'ou_user123', defaultIdentity: 'bot'}), error => error?.code === 'LARK_RECIPIENT_CHAT_INVALID');
const botCalls = [];
const botBundle = await makeBundle();
const botLandingRoot = path.join(tempRoot, 'bot-cloud');
const botResult = await deliverCloudTeamReport({
  bundle: botBundle,
  config,
  landingRoot: botLandingRoot,
  spawnImpl: fakeSpawnFactory([
    {ok: true, message_id: 'om_hidden_summary', chat_id: 'oc_hidden_chat'},
    {ok: true, data: {message_id: 'om_hidden_attachment', chat_id: 'oc_hidden_chat'}},
  ], botCalls),
  now: () => '2026-08-24T00:00:00.000Z',
});
assert.equal(botResult.ok, true);
assert.equal(botCalls.length, 2);
for (const call of botCalls) {
  assert.equal(call.bin, 'lark-cli');
  assert.equal(call.args[call.args.indexOf('--as') + 1], 'bot');
  assert.equal(call.args[call.args.indexOf('--chat-id') + 1], 'oc_group123');
}
const botPaths = buildCloudLandingPaths({
  landingRoot: botLandingRoot,
  automationId: botBundle.automationId,
  businessDate: botBundle.businessDate,
  fingerprint: botBundle.fingerprint,
});
const summaryCall = botCalls.find(call => call.args.includes('--markdown'));
const attachmentCall = botCalls.find(call => call.args.includes('--file'));
assert.ok(summaryCall, 'summary must keep the markdown send path');
assert.equal(summaryCall.options.cwd, undefined, 'summary spawn cwd must remain unchanged');
assert.ok(attachmentCall, 'attachment must use the file send path');
const attachmentArg = attachmentCall.args[attachmentCall.args.indexOf('--file') + 1];
assert.equal(attachmentArg, path.basename(botPaths.attachmentFile));
assert.equal(path.isAbsolute(attachmentArg), false, 'attachment argv must not contain an absolute path');
assert.equal(attachmentArg.split(/[\\/]/u).includes('..'), false, 'attachment argv must not traverse parent directories');
assert.equal(attachmentArg.includes('..'), false, 'attachment argv must not contain a parent traversal token');
assert.equal(attachmentCall.args.includes(botPaths.attachmentFile), false, 'attachment argv must omit the absolute staged path');
assert.equal(attachmentCall.options.cwd, botPaths.deliveryDir, 'attachment spawn cwd must be the verified delivery directory');

// SHA drift is rejected on both sides of the handoff, before a send.
await fs.writeFile(attachmentFile, Buffer.from('attachment-v2\n', 'utf8'));
await assertCode(() => runLocalCloudTeamReport({
  automationId: 'daily-report', businessDate: '2026-08-24', summaryFile, attachment: attachmentFile,
  expectedAttachmentSha256: attachmentSha256, cloudSsh: CLOUD_TEAM_REPORT_CLOUD_HOST, root: repositoryRoot,
  spawnImpl: fakeSpawnFactory([], []),
}), 'ATTACHMENT_SHA256_MISMATCH');
await fs.writeFile(attachmentFile, Buffer.from('attachment-v1\n', 'utf8'));
const stableBundle = await makeBundle();
await assertCode(() => deliverCloudTeamReport({
  bundle: {...stableBundle, recipientChatId: 'oc_forbidden_local_target'},
  config,
  landingRoot: path.join(tempRoot, 'forbidden-target-cloud'),
  spawnImpl: fakeSpawnFactory([], []),
}), 'LOCAL_TARGET_FORBIDDEN');
const driftedBundle = {...stableBundle, attachmentBase64: Buffer.from('drifted', 'utf8').toString('base64')};
await assertCode(() => deliverCloudTeamReport({bundle: driftedBundle, config, landingRoot: path.join(tempRoot, 'sha-cloud'), spawnImpl: fakeSpawnFactory([], [])}), 'ATTACHMENT_SHA256_MISMATCH');

// Path escape and symlink rejection cover both the local input boundary and
// the cloud landing boundary.
await assertCode(() => validateLocalOutputFile(path.join('..', 'outside.txt'), {root: repositoryRoot, label: 'summary-file'}), 'LOCAL_ARTIFACT_OUTSIDE_OUTPUTS');
const outsideDir = path.join(tempRoot, 'outside-dir');
await fs.mkdir(outsideDir, {recursive: true});
await fs.writeFile(path.join(outsideDir, 'summary.md'), 'outside', 'utf8');
const symlinkDir = path.join(outputsRoot, 'linked-output');
try {
  // A junction is the Windows-compatible form of a directory symlink and
  // still proves that a parent component cannot escape outputs.
  await fs.symlink(outsideDir, symlinkDir, 'junction');
  await assertCode(() => validateLocalOutputFile(path.join(symlinkDir, 'summary.md'), {root: repositoryRoot, label: 'summary-file'}), 'LOCAL_ARTIFACT_SYMLINK');
} finally {
  await fs.rm(symlinkDir, {recursive: true, force: true});
}
await assertCode(() => buildCloudLandingPaths({landingRoot: path.join(tempRoot, 'landing'), automationId: '../escape', businessDate: '2026-08-24', fingerprint: 'a'.repeat(64)}), 'INVALID_AUTOMATION_ID');
const cloudSymlinkRoot = path.join(tempRoot, 'cloud-symlink');
const cloudSymlinkOutside = path.join(tempRoot, 'cloud-symlink-outside');
await fs.mkdir(cloudSymlinkRoot, {recursive: true});
await fs.mkdir(cloudSymlinkOutside, {recursive: true});
const cloudSymlinkAutomation = path.join(cloudSymlinkRoot, stableBundle.automationId);
try {
  await fs.symlink(cloudSymlinkOutside, cloudSymlinkAutomation, 'junction');
  await assertCode(() => deliverCloudTeamReport({
    bundle: stableBundle,
    config,
    landingRoot: cloudSymlinkRoot,
    spawnImpl: fakeSpawnFactory([], []),
  }), 'CLOUD_LANDING_SYMLINK');
} finally {
  await fs.rm(cloudSymlinkAutomation, {recursive: true, force: true});
}

// Only ok=true plus a non-empty message_id is accepted.
const missingIdResult = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: path.join(tempRoot, 'missing-id-cloud'),
  spawnImpl: fakeSpawnFactory([
    {ok: true},
    {ok: true},
  ]),
});
assert.equal(missingIdResult.ok, false);
assert.equal(missingIdResult.status, 'failed');
assert.equal(missingIdResult.items.summary.accepted, false);
assert.doesNotMatch(JSON.stringify(missingIdResult), /chat[_-]?id|message[_-]?id|token|app[_-]?secret/iu);
const notOkResult = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: path.join(tempRoot, 'not-ok-cloud'),
  spawnImpl: fakeSpawnFactory([
    {ok: false, message_id: 'om_should_not_count'},
    {ok: false, message_id: 'om_should_not_count'},
  ]),
});
assert.equal(notOkResult.ok, false);
assert.equal(notOkResult.items.attachment.accepted, false);

// 230002 is classified as caller_identity_not_in_chat, with no inference that
// the cloud bot itself is absent from the group.
const identityFailure = interpretLarkResult({
  exitCode: 1,
  stdout: '{"ok":false,"error":{"code":"230002","message":"private detail"}}',
  executionIdentityVerified: false,
});
assert.deepEqual(identityFailure, {
  accepted: false,
  errorCode: 'caller_identity_not_in_chat',
  sourceCode: '230002',
  executionIdentityVerified: false,
  botMembershipInferred: false,
});
assert.doesNotMatch(JSON.stringify(identityFailure), /bot.*not.*in.*chat/iu);

// A partial receipt is resumable: the accepted summary is not sent again, the
// missing attachment is retried with the same binding, and a third duplicate
// call sends nothing.
const partialRoot = path.join(tempRoot, 'partial-cloud');
const partialCalls = [];
const partialFirst = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: partialRoot,
  spawnImpl: fakeSpawnFactory([
    {ok: true, message_id: 'om_hidden_one'},
    {ok: false, error: {code: 'TEMPORARY_FAILURE'}},
  ], partialCalls),
});
assert.equal(partialFirst.ok, false);
assert.equal(partialFirst.status, 'partial');
assert.equal(partialFirst.items.summary.accepted, true);
assert.equal(partialFirst.items.attachment.accepted, false);
const partialPaths = buildCloudLandingPaths({landingRoot: partialRoot, automationId: stableBundle.automationId, businessDate: stableBundle.businessDate, fingerprint: stableBundle.fingerprint});
const partialState = JSON.parse(await fs.readFile(partialPaths.stateFile, 'utf8'));
assert.equal(partialState.items.summary.accepted, true);
assert.equal(partialState.items.attachment.accepted, false);
assert.doesNotMatch(await fs.readFile(partialPaths.stateFile, 'utf8'), /chat[_-]?id|message[_-]?id|token|app[_-]?secret|om_hidden_one/iu);
const partialSecond = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: partialRoot,
  spawnImpl: fakeSpawnFactory([{ok: true, data: {message_id: 'om_hidden_two'}}], partialCalls),
});
assert.equal(partialSecond.ok, true);
assert.equal(partialCalls.length, 3, 'resume must send only the missing item');
const partialThird = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: partialRoot,
  spawnImpl: fakeSpawnFactory([{
    ok: false,
    error: {code: 'MUST_NOT_SEND'},
  }], partialCalls),
});
assert.equal(partialThird.ok, true);
assert.equal(partialCalls.length, 3, 'duplicate complete delivery must not send again');
assert.doesNotMatch(JSON.stringify(partialThird), /chat[_-]?id|message[_-]?id|token|app[_-]?secret|om_hidden/iu);

// A power loss must not leave this exact report permanently blocked. The
// shared ticket lock reclaims a ticket whose recorded owner is verifiably
// dead, while still refusing to steal a live process's ticket.
const staleRoot = path.join(tempRoot, 'stale-lock-cloud');
const stalePaths = buildCloudLandingPaths({
  landingRoot: staleRoot,
  automationId: stableBundle.automationId,
  businessDate: stableBundle.businessDate,
  fingerprint: stableBundle.fingerprint,
});
const staleQueueDir = `${stalePaths.lockFile}.tickets`;
await fs.mkdir(staleQueueDir, {recursive: true});
const staleTicket = path.join(staleQueueDir, 'dead-owner.json');
await fs.writeFile(staleTicket, JSON.stringify({
  pid: 2147483647,
  nonce: 'dead-owner-after-power-loss',
  processStart: '1',
  orderNs: '1',
}), 'utf8');
const staleRecovered = await deliverCloudTeamReport({
  bundle: stableBundle,
  config,
  landingRoot: staleRoot,
  spawnImpl: fakeSpawnFactory([
    {ok: true, message_id: 'om_hidden_stale_summary'},
    {ok: true, message_id: 'om_hidden_stale_attachment'},
  ]),
});
assert.equal(staleRecovered.ok, true);
await assert.rejects(fs.access(staleTicket), error => error?.code === 'ENOENT');

await fs.rm(tempRoot, {recursive: true, force: true});
console.log('cloud_team_report_delivery: local/cloud boundary, bot lock, SHA/path guards, strict receipts, 230002 classification, resumable idempotency, stale-lock recovery, and redaction passed');
