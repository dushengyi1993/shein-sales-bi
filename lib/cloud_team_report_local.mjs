import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  CLOUD_TEAM_REPORT_CLOUD_ENTRY,
  CLOUD_TEAM_REPORT_CLOUD_HOST,
  CLOUD_TEAM_REPORT_SCHEMA_VERSION,
  CloudTeamReportError,
  computeDeliveryFingerprint,
  contractError,
  normalizeAutomationId,
  normalizeBusinessDate,
  normalizeAttachmentName,
  normalizeSha256,
  parseJsonFromText,
  safeErrorCode,
  safePublicReason,
  safeResult,
  sha256Bytes,
} from './cloud_team_report_common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 120_000;

function relativeSegments(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw contractError('LOCAL_ARTIFACT_OUTSIDE_OUTPUTS', 'local report files must stay under repository outputs');
  }
  return relative.split(/[\\/]+/u).filter(Boolean);
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Validate every path component, not only the final file. A symlinked parent
 * could otherwise make an apparently in-tree path escape outputs.
 */
export async function validateLocalOutputFile(file, {root = ROOT, label = 'artifact'} = {}) {
  const repositoryRoot = path.resolve(root);
  const outputsRoot = path.join(repositoryRoot, 'outputs');
  const target = path.resolve(repositoryRoot, String(file || ''));
  const outputStat = await lstatOrNull(outputsRoot);
  if (!outputStat || !outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw contractError('LOCAL_OUTPUT_ROOT_INVALID', 'repository outputs must be a real directory');
  }
  const segments = relativeSegments(outputsRoot, target);
  let current = outputsRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstatOrNull(current);
    if (!stat) throw contractError('LOCAL_ARTIFACT_MISSING', `${label} does not exist under outputs`);
    if (stat.isSymbolicLink()) throw contractError('LOCAL_ARTIFACT_SYMLINK', `${label} must not be a symlink`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw contractError('LOCAL_ARTIFACT_PARENT_INVALID', `${label} has a non-directory parent`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw contractError('LOCAL_ARTIFACT_NOT_FILE', `${label} must be a regular file`);
    }
  }
  return target;
}

async function readVerifiedLocalFile(file, options) {
  const target = await validateLocalOutputFile(file, options);
  const bytes = await fs.readFile(target);
  // Re-check after reading so a simple replace/symlink swap cannot silently
  // turn the outbound bundle into a different object.
  await validateLocalOutputFile(target, options);
  return {target, bytes};
}

export async function buildCloudTeamReportBundle({
  automationId,
  businessDate,
  summaryFile,
  attachment,
  expectedAttachmentSha256,
  root = ROOT,
} = {}) {
  const normalizedAutomationId = normalizeAutomationId(automationId);
  const normalizedBusinessDate = normalizeBusinessDate(businessDate);
  const expectedSha = normalizeSha256(expectedAttachmentSha256, 'expected attachment SHA-256');
  const summary = await readVerifiedLocalFile(summaryFile, {root, label: 'summary-file'});
  const artifact = await readVerifiedLocalFile(attachment, {root, label: 'attachment'});
  const actualSha = sha256Bytes(artifact.bytes);
  if (actualSha !== expectedSha) {
    throw contractError('ATTACHMENT_SHA256_MISMATCH', 'attachment SHA-256 does not match expected-attachment-sha256');
  }
  const fingerprint = computeDeliveryFingerprint({
    automationId: normalizedAutomationId,
    businessDate: normalizedBusinessDate,
    attachmentSha256: actualSha,
  });
  return {
    schemaVersion: CLOUD_TEAM_REPORT_SCHEMA_VERSION,
    automationId: normalizedAutomationId,
    businessDate: normalizedBusinessDate,
    expectedAttachmentSha256: actualSha,
    fingerprint,
    attachmentName: normalizeAttachmentName(path.basename(artifact.target)),
    summaryBase64: summary.bytes.toString('base64'),
    attachmentBase64: artifact.bytes.toString('base64'),
  };
}

function runExternal({spawnImpl = spawn, bin, args, input = '', cwd = ROOT, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(bin, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
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
    timer = setTimeout(() => {
      try { child.kill?.(); } catch {}
      finish({exitCode: -1, timedOut: true});
    }, timeoutMs);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', chunk => { stdout += String(chunk); });
    child.stderr?.on?.('data', chunk => { stderr += String(chunk); });
    child.on?.('error', () => finish({exitCode: -1, spawnError: true}));
    child.on?.('close', code => finish({exitCode: Number.isInteger(code) ? code : -1}));
    try {
      if (child.stdin?.end) child.stdin.end(input);
      else finish({exitCode: -1, spawnError: true});
    } catch {
      finish({exitCode: -1, spawnError: true});
    }
  });
}

function parseRemoteResult(stdout, bundle) {
  const parsed = parseJsonFromText(stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const bindingMatches = parsed.automationId === bundle.automationId
    && parsed.businessDate === bundle.businessDate
    && parsed.fingerprint === bundle.fingerprint
    && parsed.attachmentSha256 === bundle.expectedAttachmentSha256
    && parsed.attachmentName === bundle.attachmentName;
  if (!bindingMatches) {
    return safeResult({
      ok: false,
      status: 'failed',
      automationId: bundle.automationId,
      businessDate: bundle.businessDate,
      fingerprint: bundle.fingerprint,
      attachmentName: bundle.attachmentName,
      attachmentSha256: bundle.expectedAttachmentSha256,
      summarySha256: sha256Bytes(Buffer.from(bundle.summaryBase64, 'base64')),
      items: {},
      errorCode: 'cloud_result_binding_mismatch',
    });
  }
  const sanitized = safeResult(parsed);
  const hasReceipt = item => item?.accepted === true
    && typeof item.messageId === 'string' && item.messageId.trim().length > 0;
  if (sanitized.ok && !(sanitized.status === 'ok'
    && hasReceipt(sanitized.items.summary)
    && hasReceipt(sanitized.items.attachment))) {
    sanitized.ok = false;
    sanitized.status = 'failed';
    sanitized.errorCode = 'cloud_result_incomplete';
    sanitized.reason = safePublicReason(sanitized.errorCode);
  }
  return sanitized;
}

export async function runLocalCloudTeamReport({
  automationId,
  businessDate,
  summaryFile,
  attachment,
  expectedAttachmentSha256,
  cloudSsh,
  root = ROOT,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (String(cloudSsh || '').trim() !== CLOUD_TEAM_REPORT_CLOUD_HOST) {
    throw contractError('CLOUD_SSH_NOT_ALLOWED', `cloud-ssh must be ${CLOUD_TEAM_REPORT_CLOUD_HOST}`);
  }
  const bundle = await buildCloudTeamReportBundle({
    automationId,
    businessDate,
    summaryFile,
    attachment,
    expectedAttachmentSha256,
    root,
  });
  const args = [
    CLOUD_TEAM_REPORT_CLOUD_HOST,
    'node',
    CLOUD_TEAM_REPORT_CLOUD_ENTRY,
    'deliver-stdin',
  ];
  let child;
  let preflightFailure = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    child = await runExternal({
      spawnImpl,
      bin: 'ssh',
      args,
      input: `${JSON.stringify(bundle)}\n`,
      cwd: root,
      timeoutMs,
    });
    preflightFailure = child.spawnError === true
      || (child.exitCode !== 0 && !child.stdout
        && /(?:connection|connect|resolve|no route|refused|unreachable|timed out|timeout)/iu.test(child.stderr));
    if (!preflightFailure || attempt === 1) break;
  }
  const remote = parseRemoteResult(child.stdout, bundle);
  if (remote) return remote;
  const unknown = child.timedOut || child.exitCode === 0;
  const status = unknown ? 'unknown' : 'failed';
  return safeResult({
    ok: false,
    status,
    automationId: bundle.automationId,
    businessDate: bundle.businessDate,
    fingerprint: bundle.fingerprint,
    attachmentName: bundle.attachmentName,
    attachmentSha256: bundle.expectedAttachmentSha256,
    summarySha256: sha256Bytes(Buffer.from(bundle.summaryBase64, 'base64')),
    items: {},
    errorCode: unknown ? 'lark_receipt_unknown' : (child.spawnError ? 'cloud_command_spawn_failed' : 'cloud_command_failed'),
    retryable: preflightFailure,
  });
}

export function localFailureResult(error) {
  if (error instanceof CloudTeamReportError) {
    const errorCode = safeErrorCode(error);
    return {ok: false, errorCode, reason: safePublicReason(errorCode)};
  }
  return {ok: false, errorCode: 'cloud_team_report_failed', reason: safePublicReason('cloud_team_report_failed')};
}
