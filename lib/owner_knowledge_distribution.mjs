import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {
  ownerKnowledgeBundleFingerprint,
  ownerKnowledgeMachinePolicyForRuleKey,
  ownerKnowledgeTextContainsSensitiveData,
  redactOwnerKnowledgeSensitiveText,
} from './owner_knowledge_policy.mjs';

export const OWNER_KNOWLEDGE_DISTRIBUTION_SCHEMA_VERSION = 1;
export const OWNER_KNOWLEDGE_DISTRIBUTION_ROOT = 'owner-knowledge';
const OWNER_KNOWLEDGE_MACHINE_POLICY_ENUMS = new Set([
  'owner_only',
  'task_or_session_only',
  'pure_model_only',
  'model_plus_product_name',
  'upload_suggest_adjust_controlled_submit',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedObject(value) {
  if (Array.isArray(value)) return value.map(normalizedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizedObject(value[key])]));
}

function jsonText(value) {
  return `${JSON.stringify(normalizedObject(value), null, 2)}\n`;
}

function cleanList(value, limit = 32) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function publicDistributionRule(rule) {
  if (!rule || rule.activation !== 'active') return null;
  const text = redactOwnerKnowledgeSensitiveText(rule.text);
  if (!text || !rule.ruleKey || !rule.versionId || !rule.contentHash) return null;
  return {
    version: 1,
    ruleKey: String(rule.ruleKey),
    versionId: String(rule.versionId),
    text,
    activation: 'active',
    explicitDurable: Boolean(rule.explicitDurable),
    risk: String(rule.risk || 'low'),
    scope: cleanList(rule.scope, 16),
    tags: cleanList(rule.tags, 24),
    machinePolicy: normalizedObject(ownerKnowledgeMachinePolicyForRuleKey(String(rule.ruleKey || ''))),
    contentHash: String(rule.contentHash),
    publishedAt: rule.publishedAt ? String(rule.publishedAt) : null,
  };
}

function assertNoForbiddenDistributionData(value, pointer = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenDistributionData(item, `${pointer}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    const structuralHash = /\.(?:fingerprint|contentHash|versionId|bundlePath|bundleSha256)$/.test(pointer);
    const safeMachinePolicyEnum = pointer.includes('.machinePolicy.') && OWNER_KNOWLEDGE_MACHINE_POLICY_ENUMS.has(String(value));
    if (typeof value === 'string' && !structuralHash && !safeMachinePolicyEnum && ownerKnowledgeTextContainsSensitiveData(value)) {
      throw new Error(`owner knowledge distribution contains sensitive text at ${pointer}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:source|sourceId|sourceKind|actor|actorUser|device|deviceId|token|cookie|password|secret|authorization|session|sessionId|file|filePath|path)$/i.test(key)) {
      throw new Error(`owner knowledge distribution contains forbidden field ${pointer}.${key}`);
    }
    assertNoForbiddenDistributionData(item, `${pointer}.${key}`);
  }
}

export function buildOwnerKnowledgeDistribution(activeBundle, {publishedAt = ''} = {}) {
  const rules = (Array.isArray(activeBundle?.rules) ? activeBundle.rules : [])
    .map(publicDistributionRule)
    .filter(Boolean)
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
  const fingerprint = ownerKnowledgeBundleFingerprint(rules);
  const expected = String(activeBundle?.globalFingerprint || activeBundle?.fingerprint || '');
  if (expected && expected !== fingerprint) {
    throw new Error(`owner knowledge fingerprint mismatch before distribution: expected=${expected} actual=${fingerprint}`);
  }
  const stablePublishedAt = String(publishedAt || rules.map(rule => rule.publishedAt || '').filter(Boolean).sort().at(-1) || '1970-01-01T00:00:00.000Z');
  const bundle = {
    schemaVersion: OWNER_KNOWLEDGE_DISTRIBUTION_SCHEMA_VERSION,
    authorityId: String(activeBundle?.authorityId || 'dushengyi'),
    fingerprint,
    publishedAt: stablePublishedAt,
    ruleCount: rules.length,
    rules,
  };
  assertNoForbiddenDistributionData(bundle);
  const bundlePath = `${OWNER_KNOWLEDGE_DISTRIBUTION_ROOT}/bundles/${fingerprint}.json`;
  const bundleBytes = jsonText(bundle);
  const manifest = {
    schemaVersion: OWNER_KNOWLEDGE_DISTRIBUTION_SCHEMA_VERSION,
    authorityId: bundle.authorityId,
    fingerprint,
    publishedAt: stablePublishedAt,
    ruleCount: rules.length,
    bundlePath,
    bundleSha256: sha256(bundleBytes),
  };
  return {manifest, bundle, bundleBytes, manifestBytes: jsonText(manifest)};
}

export function validateOwnerKnowledgeDistribution({manifest, bundle}) {
  if (!manifest || !bundle) throw new Error('owner knowledge manifest and bundle are required');
  if (Number(manifest.schemaVersion) !== OWNER_KNOWLEDGE_DISTRIBUTION_SCHEMA_VERSION) throw new Error('owner knowledge manifest schemaVersion is unsupported');
  if (Number(bundle.schemaVersion) !== OWNER_KNOWLEDGE_DISTRIBUTION_SCHEMA_VERSION) throw new Error('owner knowledge bundle schemaVersion is unsupported');
  if (String(manifest.authorityId || '') !== String(bundle.authorityId || '')) throw new Error('owner knowledge authorityId mismatch');
  if (String(manifest.fingerprint || '') !== String(bundle.fingerprint || '')) throw new Error('owner knowledge fingerprint mismatch');
  if (Number(manifest.ruleCount) !== Number(bundle.ruleCount) || Number(bundle.ruleCount) !== (bundle.rules || []).length) throw new Error('owner knowledge ruleCount mismatch');
  const fingerprint = ownerKnowledgeBundleFingerprint(bundle.rules || []);
  if (fingerprint !== bundle.fingerprint) throw new Error('owner knowledge bundle content fingerprint mismatch');
  const expectedPath = `${OWNER_KNOWLEDGE_DISTRIBUTION_ROOT}/bundles/${fingerprint}.json`;
  if (manifest.bundlePath !== expectedPath) throw new Error('owner knowledge bundlePath mismatch');
  if (sha256(jsonText(bundle)) !== manifest.bundleSha256) throw new Error('owner knowledge bundleSha256 mismatch');
  const keys = new Set();
  for (const rule of bundle.rules || []) {
    if (rule.activation !== 'active' || !rule.explicitDurable) throw new Error(`owner knowledge distributed rule is not durable active: ${rule.ruleKey || '-'}`);
    if (keys.has(rule.ruleKey)) throw new Error(`owner knowledge duplicate ruleKey: ${rule.ruleKey}`);
    const expectedMachinePolicy = normalizedObject(ownerKnowledgeMachinePolicyForRuleKey(String(rule.ruleKey || '')));
    if (JSON.stringify(normalizedObject(rule.machinePolicy)) !== JSON.stringify(expectedMachinePolicy)) {
      throw new Error(`owner knowledge machinePolicy is not server-derived: ${rule.ruleKey || '-'}`);
    }
    keys.add(rule.ruleKey);
  }
  assertNoForbiddenDistributionData(bundle);
  return {ok: true, fingerprint, ruleCount: bundle.rules.length, bundleSha256: manifest.bundleSha256};
}

async function run(command, args, {cwd, env, allowedCodes = [0], timeoutMs = 120_000} = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, env: {...process.env, ...(env || {})}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(1, Number(timeoutMs) || 120_000));
    timer.unref?.();
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      if (timedOut) {
        return finish(reject, Object.assign(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`), {
          code: 'OWNER_KNOWLEDGE_GIT_TIMEOUT',
          stdout,
          stderr,
        }));
      }
      if (allowedCodes.includes(Number(code))) return finish(resolve, {code: Number(code), stdout: stdout.trim(), stderr: stderr.trim()});
      return finish(reject, Object.assign(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`), {code, stdout, stderr}));
    });
  });
}

async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, text, {encoding: 'utf8', mode: 0o644});
  await fs.rename(temp, file);
}

async function acquireFileLock(file, {
  timeoutMs = 30_000,
  staleMs = 10 * 60_000,
  heartbeatMs = Math.max(25, Math.min(30_000, Math.floor(staleMs / 3))),
} = {}) {
  return await acquireCrossProcessTicketLock(file, {
    timeoutMs,
    staleMs,
    heartbeatMs,
    timeoutMessage: `owner knowledge git publish lock timeout: ${file}`,
    timeoutCode: 'OWNER_KNOWLEDGE_GIT_LOCK_TIMEOUT',
  });
}

export function createOwnerKnowledgeGitPublisher({
  repoDir,
  branch = 'owner-knowledge',
  remote = 'origin',
  lockFile = '',
  gitBin = 'git',
  gitTimeoutMs = 120_000,
  lockTimeoutMs = 30_000,
  lockStaleMs = 10 * 60_000,
  lockHeartbeatMs = Math.max(25, Math.min(30_000, Math.floor(lockStaleMs / 3))),
} = {}) {
  const repository = path.resolve(String(repoDir || ''));
  if (!repoDir || repository === path.parse(repository).root) throw new TypeError('owner knowledge git repoDir is required');
  const publishLock = path.resolve(lockFile || path.join(repository, '..', 'runtime', 'owner-knowledge-git-publish.lock'));

  async function git(args, options = {}) {
    return await run(gitBin, ['-C', repository, ...args], {timeoutMs: gitTimeoutMs, ...options});
  }

  async function readRemoteHead() {
    const result = await git(['ls-remote', remote, `refs/heads/${branch}`]);
    const sha = String(result.stdout || '').split(/\s+/)[0] || '';
    if (sha && !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error(`owner knowledge remote returned an invalid ref: ${sha}`);
    return sha.toLowerCase();
  }

  async function pushAndVerifyRemote(localHead) {
    const local = String(localHead || '').trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(local)) throw new Error(`owner knowledge local HEAD is invalid: ${local}`);
    let remoteHead = await readRemoteHead();
    if (remoteHead !== local) {
      if (remoteHead) {
        const ancestor = await git(['merge-base', '--is-ancestor', remoteHead, local], {allowedCodes: [0, 1]});
        if (ancestor.code !== 0) throw new Error(`owner knowledge local branch diverged from ${remote}/${branch}; refusing to overwrite remote history`);
      }
      await git(['push', remote, `HEAD:${branch}`]);
      remoteHead = await readRemoteHead();
    }
    if (remoteHead !== local) throw new Error(`owner knowledge remote readback mismatch: local=${local} remote=${remoteHead || 'missing'}`);
    return remoteHead;
  }

  async function publish(activeBundle) {
    const release = await acquireFileLock(publishLock, {
      timeoutMs: lockTimeoutMs,
      staleMs: lockStaleMs,
      heartbeatMs: lockHeartbeatMs,
    });
    try {
      const inside = await git(['rev-parse', '--is-inside-work-tree']);
      if (inside.stdout !== 'true') throw new Error(`owner knowledge git repo is invalid: ${repository}`);
      const dirtyBefore = await git(['status', '--porcelain']);
      if (dirtyBefore.stdout) throw new Error(`owner knowledge git repo is dirty before publish: ${dirtyBefore.stdout.slice(0, 500)}`);
      await git(['fetch', remote, branch]);
      await git(['checkout', branch]);
      await git(['merge', '--ff-only', `${remote}/${branch}`]);

      const built = buildOwnerKnowledgeDistribution(activeBundle);
      validateOwnerKnowledgeDistribution(built);
      const priorManifestFile = path.join(repository, OWNER_KNOWLEDGE_DISTRIBUTION_ROOT, 'manifest.json');
      const priorManifest = await readJson(priorManifestFile);
      if (priorManifest?.fingerprint === built.bundle.fingerprint) {
        if (!String(priorManifest.bundlePath || '').startsWith(`${OWNER_KNOWLEDGE_DISTRIBUTION_ROOT}/bundles/`) || String(priorManifest.bundlePath).includes('..')) {
          throw new Error('owner knowledge prior manifest bundlePath is unsafe');
        }
        const priorBundle = await readJson(path.join(repository, priorManifest.bundlePath));
        validateOwnerKnowledgeDistribution({manifest: priorManifest, bundle: priorBundle});
        const head = await git(['rev-parse', 'HEAD']);
        const remoteHead = await pushAndVerifyRemote(head.stdout);
        return {source: 'github', branch, sourceCommit: remoteHead, manifest: priorManifest, bundle: priorBundle, changed: false};
      }

      const bundleFile = path.join(repository, built.manifest.bundlePath);
      const existingBundle = await fs.readFile(bundleFile, 'utf8').catch(() => '');
      if (existingBundle && existingBundle !== built.bundleBytes) throw new Error(`immutable owner knowledge bundle collision: ${built.manifest.bundlePath}`);
      if (!existingBundle) await writeAtomic(bundleFile, built.bundleBytes);
      await writeAtomic(priorManifestFile, built.manifestBytes);

      await git(['add', '--', built.manifest.bundlePath, `${OWNER_KNOWLEDGE_DISTRIBUTION_ROOT}/manifest.json`]);
      const staged = await git(['diff', '--cached', '--quiet'], {allowedCodes: [0, 1]});
      if (staged.code === 1) {
        await git([
          '-c', 'user.name=SHEIN Owner Knowledge Publisher',
          '-c', 'user.email=owner-knowledge@shein-bi.invalid',
          'commit', '-m', `knowledge: publish ${built.bundle.fingerprint.slice(0, 12)} (${built.bundle.ruleCount} rules)`,
        ]);
      }
      const head = await git(['rev-parse', 'HEAD']);
      const remoteHead = await pushAndVerifyRemote(head.stdout);
      return {source: 'github', branch, sourceCommit: remoteHead, manifest: built.manifest, bundle: built.bundle, changed: staged.code === 1};
    } finally {
      await release();
    }
  }

  return Object.freeze({repoDir: repository, branch, remote, publish});
}
