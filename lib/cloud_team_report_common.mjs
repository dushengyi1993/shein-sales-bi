import crypto from 'node:crypto';

export const CLOUD_TEAM_REPORT_SCHEMA_VERSION = 'cloud-team-report/v1';
export const CLOUD_TEAM_REPORT_STATE_SCHEMA_VERSION = 'cloud-team-report-state/v1';
export const CLOUD_TEAM_REPORT_CLOUD_HOST = 'shein-bi-tencent';
export const CLOUD_TEAM_REPORT_CLOUD_CONFIG = '/opt/shein-bi/app/config/lark_report.json';
export const CLOUD_TEAM_REPORT_CLOUD_ENTRY = '/opt/shein-bi/app/scripts/cloud_team_report_delivery.mjs';
export const CLOUD_TEAM_REPORT_LANDING_ROOT = '/srv/shein-bi/runtime/automation-delivery';

const SAFE_AUTOMATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_FINGERPRINT = /^[a-f0-9]{64}$/u;

export class CloudTeamReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CloudTeamReportError';
    this.code = code;
  }
}

export function contractError(code, message) {
  return new CloudTeamReportError(code, message);
}

export function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), 'utf8'));
}

export function normalizeSha256(value, label = 'sha256') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SAFE_SHA256.test(normalized)) {
    throw contractError('INVALID_SHA256', `${label} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

export function normalizeAutomationId(value) {
  const normalized = String(value || '').trim();
  if (!SAFE_AUTOMATION_ID.test(normalized) || normalized === '.' || normalized === '..') {
    throw contractError('INVALID_AUTOMATION_ID', 'automation-id must be one safe path segment');
  }
  return normalized;
}

export function normalizeBusinessDate(value) {
  const normalized = String(value || '').trim();
  if (!SAFE_DATE.test(normalized)) {
    throw contractError('INVALID_BUSINESS_DATE', 'business-date must use YYYY-MM-DD');
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw contractError('INVALID_BUSINESS_DATE', 'business-date is not a calendar date');
  }
  return normalized;
}

export function normalizeFingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!SAFE_FINGERPRINT.test(normalized)) {
    throw contractError('INVALID_FINGERPRINT', 'fingerprint must be a 64-character SHA-256 hex digest');
  }
  return normalized;
}

export function computeDeliveryFingerprint({automationId, businessDate, attachmentSha256}) {
  const automation = normalizeAutomationId(automationId);
  const date = normalizeBusinessDate(businessDate);
  const artifactSha = normalizeSha256(attachmentSha256, 'attachment SHA-256');
  return sha256Text(`${automation}\n${date}\n${artifactSha}`);
}

/**
 * Lark's idempotency key is deliberately a short digest-derived key. The
 * complete binding remains in the state file and the full fingerprint is used
 * for the cloud landing directory; the key therefore cannot be detached from
 * automation id, business date, or artifact SHA without changing the digest.
 */
export function buildDeliveryIdempotencyKey({fingerprint, kind}) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!['summary', 'attachment'].includes(kind)) {
    throw contractError('INVALID_DELIVERY_ITEM', 'delivery item must be summary or attachment');
  }
  const suffix = kind === 'summary' ? 's' : 'a';
  return `atr-${normalized.slice(0, 44)}-${suffix}`;
}

export function hashOpaque(value) {
  return sha256Text(String(value));
}

export function decodeBase64(value, label) {
  const encoded = String(value ?? '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw contractError('INVALID_BUNDLE', `${label} is not canonical base64`);
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw contractError('INVALID_BUNDLE', `${label} is not canonical base64`);
  }
  return decoded;
}

export function assertNoForbiddenBundleFields(bundle) {
  for (const key of [
    'recipientChatId', 'recipientUserId', 'recipient_chat_id', 'recipient_user_id',
    'chatId', 'chat_id', 'userId', 'user_id', 'messageId', 'message_id',
    'token', 'accessToken', 'access_token', 'appSecret', 'app_secret',
  ]) {
    if (Object.prototype.hasOwnProperty.call(bundle || {}, key)) {
      throw contractError('LOCAL_TARGET_FORBIDDEN', 'the local bundle cannot carry a delivery target or credential');
    }
  }
}

export function parseJsonFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const start = [...line].findIndex(character => character === '{' || character === '[');
    if (start < 0) continue;
    try {
      return JSON.parse(line.slice(start));
    } catch {
      // Continue with the next candidate. lark-cli may prefix a JSON line with
      // a short progress message, but raw output is never returned to callers.
    }
  }
  const starts = [raw.indexOf('{'), raw.indexOf('[')].filter(index => index >= 0);
  if (!starts.length) return null;
  try {
    return JSON.parse(raw.slice(Math.min(...starts)));
  } catch {
    return null;
  }
}

function responseMessageId(parsed) {
  return String(
    parsed?.message_id
      || parsed?.message?.message_id
      || parsed?.data?.message_id
      || parsed?.data?.message?.message_id
      || parsed?.data?.data?.message_id
      || '',
  ).trim();
}

function responseErrorCode(parsed) {
  return [
    parsed?.error?.code,
    parsed?.error?.Code,
    parsed?.code,
    parsed?.data?.error?.code,
    parsed?.data?.code,
  ].map(value => String(value || '').trim()).find(Boolean) || '';
}

function has230002(raw, parsed) {
  return responseErrorCode(parsed) === '230002' || /(?:^|\D)230002(?:\D|$)/u.test(String(raw || ''));
}

/**
 * Interpret one lark-cli invocation without exposing its raw response. A
 * 230002 response is about the caller identity. Unless that identity was
 * independently verified, this helper deliberately does not infer anything
 * about whether the cloud bot is or is not in the group.
 */
export function interpretLarkResult({exitCode = 0, stdout = '', stderr = '', executionIdentityVerified = false} = {}) {
  const combined = `${String(stdout || '')}\n${String(stderr || '')}`;
  const parsed = parseJsonFromText(combined);
  if (has230002(combined, parsed)) {
    return {
      accepted: false,
      errorCode: 'caller_identity_not_in_chat',
      sourceCode: '230002',
      executionIdentityVerified: Boolean(executionIdentityVerified),
      botMembershipInferred: false,
    };
  }
  if (Number(exitCode) !== 0) {
    return {accepted: false, errorCode: 'lark_process_failed'};
  }
  if (!parsed || parsed?.ok !== true) {
    return {accepted: false, errorCode: 'lark_response_not_ok'};
  }
  if (!responseMessageId(parsed)) {
    return {accepted: false, errorCode: 'lark_receipt_missing'};
  }
  return {accepted: true};
}

export function safePublicReason(code) {
  return {
    caller_identity_not_in_chat: 'lark caller identity was rejected; group membership was not inferred',
    lark_process_failed: 'lark command failed',
    lark_response_not_ok: 'lark response was not accepted',
    lark_receipt_missing: 'lark response did not contain an acceptable message receipt',
    LARK_RESPONSE_UNPARSEABLE: 'lark response was not parseable',
  }[code] || 'cloud team report delivery failed';
}

/**
 * Redact untrusted command output before it can reach a test log or caller.
 * Production result objects use fixed reason codes and do not need this
 * fallback, but keeping the helper here makes future error plumbing fail
 * closed if a raw diagnostic is accidentally passed through.
 */
export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\b(?:chat[_-]?id|message[_-]?id|recipientchatid|recipientuserid|token|app[_-]?secret|appsecret|authorization|bearer|secret)\b\s*[:=]?\s*[^\s,;}\]]*/giu, '[redacted]')
    .replace(/\b(?:oc|om|ou)_[A-Za-z0-9_-]+\b/gu, '[redacted]')
    .replace(/\b(?:sk|rk)_[A-Za-z0-9_-]{8,}\b/gu, '[redacted]');
}

export function safeErrorCode(error, fallback = 'cloud_team_report_failed') {
  const code = String(error?.code || '').trim();
  return /^[A-Za-z0-9._-]+$/u.test(code) ? code : fallback;
}

export function safeResult({ok, status, automationId, businessDate, fingerprint, attachmentSha256, summarySha256, items, errorCode = null, sourceCode = null, executionIdentityVerified = null} = {}) {
  const result = {
    ok: Boolean(ok),
    status: String(status || (ok ? 'ok' : 'failed')),
    automationId: String(automationId || ''),
    businessDate: String(businessDate || ''),
    fingerprint: String(fingerprint || ''),
    attachmentSha256: String(attachmentSha256 || ''),
    summarySha256: String(summarySha256 || ''),
    items: {
      summary: {accepted: Boolean(items?.summary?.accepted)},
      attachment: {accepted: Boolean(items?.attachment?.accepted)},
    },
  };
  if (errorCode) result.errorCode = String(errorCode);
  if (sourceCode) result.sourceCode = String(sourceCode);
  if (executionIdentityVerified !== null) result.executionIdentityVerified = Boolean(executionIdentityVerified);
  return result;
}
