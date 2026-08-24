import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {writeFileAtomic, writeJsonFileAtomic} from './atomic_file_publish.mjs';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {
  CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  CLOUD_TEAM_REPORT_LANDING_ROOT,
  CLOUD_TEAM_REPORT_CLOUD_HOST,
  CLOUD_TEAM_REPORT_SCHEMA_VERSION,
  CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION,
  CloudTeamReportError,
  assertNoForbiddenBundleFields,
  buildDeliveryIdempotencyKey,
  computeDeliveryFingerprint,
  contractError,
  decodeBase64,
  hashOpaque,
  interpretLarkResult,
  normalizeAutomationId,
  normalizeBusinessDate,
  normalizeAttachmentName,
  normalizeFingerprint,
  normalizeSha256,
  safeErrorCode,
  safePublicReason,
  safeResult,
  sha256Bytes,
} from './cloud_team_report_common.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;

async function readJson(file) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error instanceof SyntaxError) throw contractError('LARK_CONFIG_INVALID', 'cloud lark config is not valid JSON');
    if (error?.code === 'ENOENT') throw contractError('LARK_CONFIG_MISSING', 'cloud lark config is missing');
    throw contractError('LARK_CONFIG_UNREADABLE', 'cloud lark config is unreadable');
  }
}

export function validateCloudLarkConfig(config) {
  const recipientChatId = String(config?.recipientChatId || '').trim();
  if (!/^oc_[A-Za-z0-9]+$/u.test(recipientChatId)) {
    throw contractError('LARK_RECIPIENT_CHAT_INVALID', 'cloud lark config must contain a group recipientChatId');
  }
  if (config?.defaultIdentity !== 'bot') {
    throw contractError('LARK_IDENTITY_LOCKED', 'cloud team report delivery requires defaultIdentity=bot');
  }
  return {recipientChatId};
}

export function buildCloudLandingPaths({
  landingRoot = CLOUD_TEAM_REPORT_LANDING_ROOT,
  automationId,
  businessDate,
  fingerprint,
  attachmentName = 'attachment.bin',
} = {}) {
  const root = path.resolve(String(landingRoot));
  const automation = normalizeAutomationId(automationId);
  const date = normalizeBusinessDate(businessDate);
  const digest = normalizeFingerprint(fingerprint);
  const safeAttachmentName = normalizeAttachmentName(attachmentName);
  const deliveryDir = path.resolve(root, automation, date, digest);
  const relative = path.relative(root, deliveryDir);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud delivery path escaped the allowlisted landing root');
  }
  return Object.freeze({
    root,
    deliveryDir,
    stateFile: path.join(deliveryDir, 'state.json'),
    summaryFile: path.join(deliveryDir, 'summary.md'),
    attachmentFile: path.join(deliveryDir, safeAttachmentName),
    lockFile: path.join(deliveryDir, 'delivery.lock'),
  });
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureLandingDirectory(paths) {
  await fs.mkdir(paths.root, {recursive: true, mode: 0o750});
  const rootStat = await lstatOrNull(paths.root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud landing root must be a real directory');
  }
  let current = paths.root;
  const relative = path.relative(paths.root, paths.deliveryDir);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) throw contractError('CLOUD_LANDING_SYMLINK', 'cloud delivery path must not contain symlinks');
    if (stat && !stat.isDirectory()) throw contractError('CLOUD_LANDING_PATH_INVALID', 'cloud delivery path contains a non-directory');
    if (!stat) await fs.mkdir(current, {mode: 0o750});
  }
}

async function assertArtifactPathSafe(file, label) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw contractError('CLOUD_ARTIFACT_SYMLINK', `${label} must not be a symlink`);
  if (!stat.isFile()) throw contractError('CLOUD_ARTIFACT_PATH_INVALID', `${label} must be a regular file`);
  return stat;
}

async function stageArtifact(file, bytes, label) {
  const existing = await assertArtifactPathSafe(file, label);
  if (existing) {
    const current = await fs.readFile(file);
    if (!current.equals(bytes)) throw contractError('CLOUD_ARTIFACT_DRIFT', `${label} already exists with different bytes`);
    return;
  }
  await writeFileAtomic(file, bytes, {mode: 0o600});
  const published = await assertArtifactPathSafe(file, label);
  if (!published) throw contractError('CLOUD_ARTIFACT_PUBLISH_FAILED', `${label} was not published`);
}

async function readState(file) {
  const stat = await lstatOrNull(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw contractError('CLOUD_STATE_PATH_INVALID', 'delivery state must be a regular file');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw contractError('CLOUD_STATE_INVALID', 'delivery state is not valid JSON');
  }
}

function stateBindingMatches(state, context) {
  return state?.schemaVersion === CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION
    && state?.automationId === context.automationId
    && state?.businessDate === context.businessDate
    && state?.fingerprint === context.fingerprint
    && state?.attachmentSha256 === context.attachmentSha256
    && state?.summarySha256 === context.summarySha256;
}

function assertStateContract(state, context) {
  if (!stateBindingMatches(state, context)) {
    throw contractError('CLOUD_STATE_BINDING_MISMATCH', 'existing delivery state belongs to a different report binding');
  }
  if (!['pending', 'partial', 'failed', 'ok'].includes(state.status)) {
    throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid status');
  }
  for (const kind of ['summary', 'attachment']) {
    const item = state?.items?.[kind];
    if (!item || typeof item !== 'object' || typeof item.accepted !== 'boolean'
      || !Number.isSafeInteger(item.attempts) || item.attempts < 0
      || item.idempotencyKeySha256 !== hashOpaque(context.idempotencyKeys[kind])) {
      throw contractError('CLOUD_STATE_INVALID', 'delivery state has an invalid item receipt');
    }
  }
}

function newState(context, now) {
  return {
    schemaVersion: CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION,
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
    attachmentSha256: context.attachmentSha256,
    summarySha256: context.summarySha256,
    status: 'pending',
    items: {
      summary: {
        accepted: false,
        attempts: 0,
        idempotencyKeySha256: hashOpaque(context.idempotencyKeys.summary),
      },
      attachment: {
        accepted: false,
        attempts: 0,
        idempotencyKeySha256: hashOpaque(context.idempotencyKeys.attachment),
      },
    },
    sensitiveFieldsOmitted: true,
    updatedAt: now(),
  };
}

async function persistState(file, state, now) {
  state.updatedAt = now();
  await writeJsonFileAtomic(file, state, {mode: 0o600});
}

async function acquireDeliveryLock(file) {
  const queueDir = `${path.resolve(file)}.tickets`;
  await fs.mkdir(queueDir, {recursive: true, mode: 0o700});
  const queueStat = await lstatOrNull(queueDir);
  if (!queueStat?.isDirectory() || queueStat.isSymbolicLink()) {
    throw contractError('CLOUD_LOCK_SYMLINK', 'delivery lock queue must be a real directory');
  }
  try {
    return await acquireCrossProcessTicketLock(file, {
      timeoutMs: 5_000,
      staleMs: 10 * 60_000,
      timeoutMessage: 'another delivery is using this fingerprint',
      timeoutCode: 'DELIVERY_IN_PROGRESS',
    });
  } catch (error) {
    if (error?.code === 'DELIVERY_IN_PROGRESS') {
      throw contractError('DELIVERY_IN_PROGRESS', 'another delivery is using this fingerprint');
    }
    throw contractError('CLOUD_LOCK_FAILED', 'could not acquire the delivery lock');
  }
}

function runLarkCommand({spawnImpl = spawn, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl('lark-cli', args, {
        ...(cwd ? {cwd} : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve({exitCode: -1, stdout: '', stderr: '', spawnError: true});
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({stdout, stderr, ...result});
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => { stdout += String(chunk); });
    child.stderr?.on?.('data', chunk => { stderr += String(chunk); });
    child.on?.('error', () => finish({exitCode: -1, spawnError: true}));
    child.on?.('close', code => finish({exitCode: Number.isInteger(code) ? code : -1}));
    timer = setTimeout(() => {
      try { child.kill?.(); } catch {}
      finish({exitCode: -1, timedOut: true});
    }, timeoutMs);
  });
}

async function sendItem({kind, context, config, deliveryDir, file, summary, spawnImpl, timeoutMs, executionIdentityVerified}) {
  const common = [
    'im', '+messages-send',
    '--as', 'bot',
    '--chat-id', config.recipientChatId,
  ];
  let args;
  let cwd;
  if (kind === 'summary') {
    args = [...common, '--markdown', summary, '--idempotency-key', context.idempotencyKeys.summary];
  } else {
    if (path.dirname(file) !== deliveryDir) {
      throw contractError('CLOUD_ARTIFACT_PATH_INVALID', 'attachment must stay in the verified delivery directory');
    }
    args = [...common, '--file', path.basename(file), '--idempotency-key', context.idempotencyKeys.attachment];
    cwd = deliveryDir;
  }
  const raw = await runLarkCommand({spawnImpl, args, cwd, timeoutMs});
  return interpretLarkResult({
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    executionIdentityVerified,
  });
}

function validateBundle(bundle) {
  assertNoForbiddenBundleFields(bundle);
  if (bundle?.schemaVersion !== CLOUD_TEAM_REPORT_SCHEMA_VERSION) throw contractError('INVALID_BUNDLE', 'unsupported cloud team report bundle');
  const automationId = normalizeAutomationId(bundle.automationId);
  const businessDate = normalizeBusinessDate(bundle.businessDate);
  const attachmentSha256 = normalizeSha256(bundle.expectedAttachmentSha256, 'expected attachment SHA-256');
  const attachmentName = normalizeAttachmentName(bundle.attachmentName);
  const attachmentBytes = decodeBase64(bundle.attachmentBase64, 'attachment');
  const summaryBytes = decodeBase64(bundle.summaryBase64, 'summary');
  const actualAttachmentSha256 = sha256Bytes(attachmentBytes);
  if (actualAttachmentSha256 !== attachmentSha256) throw contractError('ATTACHMENT_SHA256_MISMATCH', 'cloud attachment SHA-256 does not match expected value');
  const fingerprint = computeDeliveryFingerprint({automationId, businessDate, attachmentSha256});
  if (bundle.fingerprint !== undefined && normalizeFingerprint(bundle.fingerprint) !== fingerprint) {
    throw contractError('BUNDLE_FINGERPRINT_MISMATCH', 'cloud bundle fingerprint does not match its binding');
  }
  return {
    automationId,
    businessDate,
    attachmentSha256,
    attachmentName,
    summarySha256: sha256Bytes(summaryBytes),
    fingerprint,
    summaryBytes,
    attachmentBytes,
    idempotencyKeys: {
      summary: buildDeliveryIdempotencyKey({fingerprint, kind: 'summary'}),
      attachment: buildDeliveryIdempotencyKey({fingerprint, kind: 'attachment'}),
    },
  };
}

function resultFromState(context, state, extra = {}) {
  return safeResult({
    ok: state?.status === 'ok',
    status: state?.status || 'failed',
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
    attachmentName: context.attachmentName,
    attachmentSha256: context.attachmentSha256,
    summarySha256: context.summarySha256,
    items: state?.items,
    ...extra,
  });
}

export async function deliverCloudTeamReport({
  bundle,
  configPath = CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  config: configOverride,
  landingRoot = CLOUD_TEAM_REPORT_LANDING_ROOT,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
  executionIdentityVerified = false,
} = {}) {
  const context = validateBundle(bundle);
  const config = validateCloudLarkConfig(configOverride || await readJson(configPath));
  const paths = buildCloudLandingPaths({
    landingRoot,
    automationId: context.automationId,
    businessDate: context.businessDate,
    fingerprint: context.fingerprint,
  });
  await ensureLandingDirectory(paths);
  const releaseLock = await acquireDeliveryLock(paths.lockFile);
  try {
    await stageArtifact(paths.summaryFile, context.summaryBytes, 'summary.md');
    await stageArtifact(paths.attachmentFile, context.attachmentBytes, 'attachment.bin');
    let state = await readState(paths.stateFile);
    if (state) assertStateContract(state, context);
    if (!state) {
      state = newState(context, now);
      await persistState(paths.stateFile, state, now);
    }
    let firstFailure = null;
    for (const kind of ['summary', 'attachment']) {
      if (state.items?.[kind]?.accepted === true) continue;
      const item = state.items[kind] || {accepted: false, attempts: 0};
      item.attempts = Number(item.attempts || 0) + 1;
      const response = await sendItem({
        kind,
        context,
        config,
        deliveryDir: paths.deliveryDir,
        file: paths.attachmentFile,
        summary: context.summaryBytes.toString('utf8'),
        spawnImpl,
        timeoutMs,
        executionIdentityVerified,
      });
      if (response.accepted) {
        item.accepted = true;
        delete item.errorCode;
        delete item.sourceCode;
        delete item.executionIdentityVerified;
        delete item.botMembershipInferred;
      } else {
        item.accepted = false;
        item.errorCode = response.errorCode;
        if (response.sourceCode) item.sourceCode = response.sourceCode;
        if (response.executionIdentityVerified !== undefined) item.executionIdentityVerified = response.executionIdentityVerified;
        if (response.botMembershipInferred !== undefined) item.botMembershipInferred = response.botMembershipInferred;
        if (!firstFailure) firstFailure = response;
      }
      state.items[kind] = item;
      state.status = state.items.summary.accepted && state.items.attachment.accepted
        ? 'ok'
        : (state.items.summary.accepted || state.items.attachment.accepted ? 'partial' : 'failed');
      await persistState(paths.stateFile, state, now);
    }
    const result = resultFromState(context, state, firstFailure ? {
      errorCode: firstFailure.errorCode,
      sourceCode: firstFailure.sourceCode || null,
      executionIdentityVerified: firstFailure.executionIdentityVerified ?? null,
    } : {});
    return result;
  } finally {
    await releaseLock().catch(() => {});
  }
}

export function cloudFailureResult(error) {
  const code = safeErrorCode(error);
  return {
    ok: false,
    errorCode: code,
    reason: error instanceof CloudTeamReportError ? safePublicReason(code) : 'cloud team report delivery failed',
  };
}

export {CLOUD_TEAM_REPORT_CLOUD_HOST};
