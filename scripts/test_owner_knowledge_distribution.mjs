import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  createOwnerKnowledgeGitPublisher,
  validateOwnerKnowledgeDistribution,
} from '../lib/owner_knowledge_distribution.mjs';
import {
  normalizeOwnerKnowledgeExperience,
  ownerKnowledgeBundleFingerprint,
} from '../lib/owner_knowledge_policy.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-distribution-'));
const remote = path.join(temp, 'remote.git');
const repo = path.join(temp, 'repo');
const lockFile = path.join(temp, 'publish.lock');

function run(command, args, cwd = temp) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} failed (${code}): ${stderr || stdout}`)));
  });
}

function activeBundle(experiences) {
  const rules = experiences.map(input => normalizeOwnerKnowledgeExperience(input, {actorUser: 'owner'}));
  const fingerprint = ownerKnowledgeBundleFingerprint(rules);
  return {authorityId: 'dushengyi', fingerprint, globalFingerprint: fingerprint, rules, allRuleCount: rules.length};
}

try {
  await run('git', ['init', '--bare', remote]);
  await fs.mkdir(repo, {recursive: true});
  await run('git', ['init'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), 'owner knowledge distribution test\n', 'utf8');
  await run('git', ['add', 'README.md'], repo);
  await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init'], repo);
  await run('git', ['branch', '-M', 'owner-knowledge'], repo);
  await run('git', ['remote', 'add', 'origin', remote], repo);
  await run('git', ['push', '-u', 'origin', 'owner-knowledge'], repo);

  const staleTicketDir = `${lockFile}.tickets`;
  await fs.mkdir(staleTicketDir, {recursive: true});
  const staleTicketFile = path.join(staleTicketDir, '0000000000000-2147483647-dead-publisher-lock.json');
  await fs.writeFile(staleTicketFile, JSON.stringify({pid: 2147483647, nonce: 'dead-publisher-lock', at: '2020-01-01T00:00:00.000Z'}), 'utf8');
  await fs.writeFile(`${lockFile}.recovery`, JSON.stringify({pid: 2147483647, nonce: 'orphaned-legacy-recovery'}), 'utf8');
  const staleLockAt = new Date(Date.now() - 5_000);
  await fs.utimes(staleTicketFile, staleLockAt, staleLockAt);
  const publisher = createOwnerKnowledgeGitPublisher({
    repoDir: repo,
    branch: 'owner-knowledge',
    lockFile,
    lockTimeoutMs: 5_000,
    lockStaleMs: 100,
    lockHeartbeatMs: 25,
  });
  const fakeGithubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_');
  const fakeSlackToken = ['xoxb', '123456789012', 'abcdefghijklmnopqrstuvwxyz'].join('-');
  const fakeOpaqueHexSecret = ['0123456789abcdef', 'fedcba9876543210'].join('');
  const firstBundle = activeBundle([{
    text: `以后所有真实提交必须先预检、明确确认并强回读，token=should-not-leak，${fakeGithubToken}、${fakeSlackToken}、${fakeOpaqueHexSecret} 也不能泄露`,
    sourceKind: 'owner_manual',
    sourceId: 'private-session-path',
    explicitDurable: true,
    activation: 'active',
    machinePolicy: {apiKey: 'shortsecret123', credentials: {pin: 837261}},
  }]);
  const firstAttempts = await Promise.all([publisher.publish(firstBundle), publisher.publish(firstBundle)]);
  if (firstAttempts.filter(result => result.changed).length !== 1) throw new Error('stale publisher lock recovery did not serialize two contenders');
  const first = firstAttempts.find(result => result.changed);
  if (!first || !/^[a-f0-9]{40}$/i.test(first.sourceCommit) || firstAttempts.some(result => result.sourceCommit !== first.sourceCommit)) {
    throw new Error('first distribution publish did not create and share one verified git commit');
  }
  await fs.access(staleTicketFile).then(
    () => { throw new Error('dead publisher ticket was not reclaimed'); },
    error => { if (error?.code !== 'ENOENT') throw error; }
  );
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'owner-knowledge', 'manifest.json'), 'utf8'));
  const bundle = JSON.parse(await fs.readFile(path.join(repo, manifest.bundlePath), 'utf8'));
  validateOwnerKnowledgeDistribution({manifest, bundle});
  const serialized = JSON.stringify(bundle);
  if (serialized.includes('should-not-leak') || serialized.includes('shortsecret123') || serialized.includes('837261') || serialized.includes(fakeGithubToken) || serialized.includes(fakeSlackToken) || serialized.includes(fakeOpaqueHexSecret) || serialized.includes('private-session-path') || /"source"|"deviceId"|"actorUser"/.test(serialized)) {
    throw new Error('distribution leaked source or sensitive data');
  }

  const second = await publisher.publish(firstBundle);
  if (second.changed || second.sourceCommit !== first.sourceCommit) throw new Error('identical distribution created a noisy commit');

  const updatedBundle = activeBundle([
    {text: '以后所有真实提交必须先预检、明确确认并强回读', explicitDurable: true, activation: 'active'},
    {text: '同事账号不能发布或覆盖负责人长期规则', explicitDurable: true, activation: 'active'},
  ]);
  const third = await publisher.publish(updatedBundle);
  if (!third.changed || third.sourceCommit === first.sourceCommit) throw new Error('changed distribution did not create a new commit');

  const retryBundle = activeBundle([
    ...updatedBundle.rules.map(rule => ({...rule})),
    {text: '以后合伙人 CLI 必须在任务前校验负责人规则版本', explicitDurable: true, activation: 'active'},
  ]);
  await run('git', ['remote', 'set-url', '--push', 'origin', path.join(temp, 'missing-remote.git')], repo);
  let pushFailed = false;
  try { await publisher.publish(retryBundle); } catch { pushFailed = true; }
  if (!pushFailed) throw new Error('publisher failure injection did not fail the push');
  const remoteAfterFailure = await run('git', ['ls-remote', 'origin', 'refs/heads/owner-knowledge'], repo);
  if (!remoteAfterFailure.startsWith(third.sourceCommit)) throw new Error('failed push unexpectedly advanced remote');
  await run('git', ['remote', 'set-url', '--push', 'origin', remote], repo);
  const retried = await publisher.publish(retryBundle);
  const remoteAfterRetry = await run('git', ['ls-remote', 'origin', 'refs/heads/owner-knowledge'], repo);
  if (!remoteAfterRetry.startsWith(retried.sourceCommit) || retried.sourceCommit === third.sourceCommit) {
    throw new Error('publisher did not retry and verify the previously unpushed local commit');
  }

  const malicious = structuredClone(retryBundle);
  malicious.rules[0].machinePolicy = {token: 'forbidden-value'};
  const sanitized = await publisher.publish(malicious);
  const sanitizedText = JSON.stringify(sanitized.bundle);
  if (sanitizedText.includes('forbidden-value') || sanitizedText.includes('"token"')) {
    throw new Error('client-supplied machinePolicy was not replaced by the server-derived policy');
  }

  console.log(JSON.stringify({ok: true, firstCommit: first.sourceCommit, latestCommit: retried.sourceCommit, ruleCount: retried.bundle.ruleCount, pushRetryVerified: true}));
} finally {
  await fs.rm(temp, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
}
