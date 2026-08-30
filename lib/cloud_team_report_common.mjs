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
const SAFE_ATTACHMENT_NAME = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._-]{0,127}$/u;

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

export function normalizeAttachmentName(value) {
  const normalized = String(value || '').trim();
  if (!SAFE_ATTACHMENT_NAME.test(normalized) || normalized === '.' || normalized === '..' || pathLike(normalized)) {
    throw contractError('INVALID_ATTACHMENT_NAME', 'attachment name must be one safe filename');
  }
  return normalized;
}

function pathLike(value) {
  return value.includes('/') || value.includes('\\');
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
  // lark-cli may print progress objects and a final receipt in one stream.
  // Collect parseable JSON blocks and prefer the last object that carries the
  // command's `ok` field; do not combine fields from different blocks.
  const candidates = [];
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{' && raw[start] !== '[') continue;
    let depth = 0;
    let end = -1;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const character = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === '{' || character === '[') {
        depth += 1;
      } else if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      candidates.push(JSON.parse(raw.slice(start, end + 1)));
    } catch {}
    start = end;
  }
  const responses = candidates.filter(candidate => candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && Object.prototype.hasOwnProperty.call(candidate, 'ok'));
  return responses.length ? responses[responses.length - 1]
    : (candidates.length ? candidates[candidates.length - 1] : null);
}

function responseString(parsed, paths) {
  for (const path of paths) {
    let value = parsed;
    for (const key of path) value = value?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function responseMessageId(parsed) {
  return responseString(parsed, [
    ['message_id'],
    ['message', 'message_id'],
    ['data', 'message_id'],
    ['data', 'message', 'message_id'],
    ['data', 'data', 'message_id'],
  ]);
}

function responseFileKey(parsed) {
  return responseString(parsed, [
    ['file_key'],
    ['data', 'file_key'],
    ['data', 'data', 'file_key'],
  ]);
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
export function interpretLarkResult({exitCode = 0, stdout = '', stderr = '', executionIdentityVerified = false, spawnError = false, timedOut = false, retryable = false} = {}) {
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
  if (timedOut) {
    return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true};
  }
  if (spawnError) {
    return {accepted: false, errorCode: 'lark_process_failed', retryable: true};
  }
  if (Number(exitCode) !== 0) {
    return {accepted: false, errorCode: 'lark_process_failed', retryable: retryable === true};
  }
  if (!parsed) {
    return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true};
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'ok')) {
    return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true};
  }
  if (parsed.ok !== true) {
    return {accepted: false, errorCode: 'lark_response_not_ok'};
  }
  const messageId = responseMessageId(parsed);
  if (!messageId) {
    return {accepted: false, errorCode: 'lark_receipt_unknown', unknown: true};
  }
  const result = {accepted: true, messageId};
  const fileKey = responseFileKey(parsed);
  if (fileKey) result.fileKey = fileKey;
  return result;
}

export function safePublicReason(code) {
  return {
    caller_identity_not_in_chat: 'lark caller identity was rejected; group membership was not inferred',
    lark_process_failed: 'lark command failed',
    lark_response_not_ok: 'lark response was not accepted',
    lark_receipt_missing: 'lark response did not contain an acceptable message receipt',
    lark_receipt_unknown: 'lark command finished without a verifiable delivery receipt',
    cloud_result_incomplete: 'cloud delivery returned an incomplete receipt',
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

export function safeResult({ok, status, automationId, businessDate, fingerprint, attachmentName, attachmentSha256, summarySha256, items, errorCode = null, sourceCode = null, executionIdentityVerified = null, retryable = null} = {}) {
  const result = {
    ok: ok === true,
    status: String(status || (ok ? 'ok' : 'failed')),
    automationId: String(automationId || ''),
    businessDate: String(businessDate || ''),
    fingerprint: String(fingerprint || ''),
    attachmentSha256: String(attachmentSha256 || ''),
    summarySha256: String(summarySha256 || ''),
    items: {
      summary: {accepted: items?.summary?.accepted === true},
      attachment: {accepted: items?.attachment?.accepted === true},
    },
  };
  if (typeof attachmentName === 'string' && attachmentName) result.attachmentName = attachmentName;
  for (const kind of ['summary', 'attachment']) {
    const item = items?.[kind];
    if (item?.unknown === true) result.items[kind].unknown = true;
    if (typeof item?.messageId === 'string' && item.messageId.trim()) {
      result.items[kind].messageId = item.messageId.trim();
    }
    if (Number.isSafeInteger(item?.attempts) && item.attempts >= 0) {
      result.items[kind].attempts = item.attempts;
    }
    if (typeof item?.fileKey === 'string' && item.fileKey.trim()) {
      result.items[kind].fileKey = item.fileKey.trim();
    }
  }
  if (errorCode) result.errorCode = String(errorCode);
  if (sourceCode) result.sourceCode = String(sourceCode);
  if (executionIdentityVerified !== null) result.executionIdentityVerified = Boolean(executionIdentityVerified);
  if (retryable !== null) result.retryable = retryable === true;
  if (errorCode) result.reason = safePublicReason(String(errorCode));
  return result;
}
