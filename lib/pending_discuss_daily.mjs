/**
 * Pure helpers for the deterministic pending-discuss daily entry point.
 *
 * The daily command reuses runPendingDiscussScan exactly once, then builds
 * the human-readable report, delivery receipt and manifest. This module only
 * contains deterministic pure helpers so the CLI and its tests share the
 * exact same report / idempotency / receipt semantics.
 */
import {redactError, sha256Json} from './pending_discuss_batch.mjs';

export const PENDING_DISCUSS_DAILY_SCHEMA_VERSION = 'pending-discuss-daily/v1';
export const PENDING_DISCUSS_DAILY_MANIFEST_SCHEMA_VERSION = 'pending-discuss-daily-manifest/v1';
export const PENDING_DISCUSS_DAILY_IDEMPOTENCY_PREFIX = 'pd-discuss-daily';

// These are exactly the fields buildScanDocument hashes in
// lib/pending_discuss_batch.mjs (the binding before ok/rowCount/summary/
// blockers/scanHash are attached).
const SCAN_BINDING_KEYS = [
  'schemaVersion',
  'businessDate',
  'generatedAt',
  'coverage',
  'stores',
  'rows',
  'duplicateKeys',
];

function pick(object, keys) {
  const output = {};
  for (const key of keys) {
    if (object?.[key] !== undefined) output[key] = object[key];
  }
  return output;
}

export function compactBusinessDate(businessDate) {
  return String(businessDate || '').replaceAll('-', '');
}

/**
 * Idempotency key for the group message. Contains the business date and is
 * guaranteed to stay within lark-cli's 50-character limit.
 */
export function buildIdempotencyKey(businessDate) {
  const compact = compactBusinessDate(businessDate);
  if (!/^\d{8}$/.test(compact)) {
    throw new Error('idempotency key requires a YYYY-MM-DD business date');
  }
  const key = `${PENDING_DISCUSS_DAILY_IDEMPOTENCY_PREFIX}-${compact}`;
  if (key.length > 50) {
    throw new Error(`idempotency key exceeds 50 characters: ${key.length}`);
  }
  return key;
}

/**
 * Recomputes the scan hash over the persisted document. This is the
 * manifest/hash self-check: a persisted scan.json must reproduce its own
 * scanHash before the report or any delivery is produced.
 */
export function verifyScanHash(scan) {
  const scanHash = sha256Json(pick(scan, SCAN_BINDING_KEYS));
  return {ok: scan?.scanHash === scanHash, scanHash};
}

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(value ?? '');
}

function rangeText(range) {
  const values = (range?.values || []).filter(value => Number.isFinite(Number(value)));
  if (!values.length) return '';
  const min = formatPrice(values[0]);
  const max = formatPrice(values.at(-1));
  return min === max ? min : `${min}–${max}`;
}

function priceLines(group) {
  const ranges = group?.suggestedPrices || [];
  const sar = ranges.filter(row => String(row?.currency || '').toUpperCase() === 'SAR');
  const others = ranges.filter(row => String(row?.currency || '').toUpperCase() !== 'SAR');
  const lines = [];
  if (sar.length) lines.push(`SAR建议价：${sar.map(rangeText).filter(Boolean).join('；')}`);
  for (const row of others) {
    const text = rangeText(row);
    if (text) lines.push(`${String(row?.currency || '其他').toUpperCase()}建议价：${text}`);
  }
  return lines.join('；');
}

/**
 * Human-readable daily report. A failed scan is explicit (never reported as
 * zero), a genuine zero result is explicit, and data rows are aggregated by
 * canonicalGoodsSn with row count, stores, SAR suggested price, reasons and
 * remaining appeal counts.
 */
export function buildDailyReportText(scan) {
  const date = String(scan?.businessDate || '');
  const header = `今日待议价报告（${date}）`;
  if (scan?.ok !== true) {
    return `${header}\n待议价扫描未完成，本次不按 0 条处理，不生成发送内容。`;
  }
  if (Number(scan?.rowCount) === 0) {
    return [
      header,
      `当前待议价 0 条：全部 ${scan?.coverage?.succeededCount ?? 0}/${scan?.coverage?.expectedCount ?? 0} 店扫描成功，无需处理。`,
      `生成时间：${String(scan?.generatedAt || '')}`,
    ].join('\n');
  }
  const lines = [header, `共 ${scan.rowCount} 条待议价，按款号汇总如下：`, ''];
  for (const [index, group] of (scan?.summary || []).entries()) {
    const reasons = (group?.reasons || []).join('；') || '未说明';
    const appeals = (group?.appealCounts || []).length
      ? (group?.appealCounts || []).join('、')
      : '未知';
    lines.push(`${index + 1}. ${group?.canonicalGoodsSn}`);
    lines.push(`   - 条数：${group?.rowCount}`);
    lines.push(`   - 店铺：${(group?.stores || []).join('、')}`);
    lines.push(`   - ${priceLines(group) || '未给出'}`);
    lines.push(`   - 原因：${reasons}`);
    lines.push(`   - 剩余申诉次数：${appeals}`);
  }
  lines.push('', `生成时间：${String(scan?.generatedAt || '')}`, '完整明细见 scan.json（已脱敏）。');
  return lines.join('\n');
}

/**
 * Delivery receipt. Never carries the recipient id or the message id; the
 * receipt is the boolean proof (messageIdVerified) plus the idempotency key.
 */
export function buildDeliveryDocument({
  status,
  businessDate,
  idempotencyKey = '',
  at,
  reason = '',
  error = null,
  scanHash = '',
  reportSha256 = '',
}) {
  const document = {
    schemaVersion: PENDING_DISCUSS_DAILY_SCHEMA_VERSION,
    businessDate,
    status,
    at,
    messageIdVerified: status === 'ok',
  };
  if (status !== 'skipped') document.idempotencyKey = idempotencyKey;
  if (scanHash) document.scanHash = scanHash;
  if (reportSha256) document.reportSha256 = reportSha256;
  if (reason) document.reason = reason;
  if (error) document.error = redactError(error);
  return document;
}

/**
 * Strict send receipt: delivery is ok only when the process exited 0, the
 * response is parseable JSON, ok === true and message_id is non-empty.
 */
export function parseLarkSendResponse(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) {
    throw Object.assign(new Error('lark-cli response is not parseable JSON'), {code: 'LARK_SEND_UNPARSEABLE'});
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    throw Object.assign(new Error('lark-cli response is not parseable JSON'), {code: 'LARK_SEND_UNPARSEABLE'});
  }
  if (parsed?.ok !== true) {
    throw Object.assign(new Error('lark-cli response is not ok'), {code: 'LARK_SEND_NOT_OK'});
  }
  const messageId = String(
    parsed?.message_id
      || parsed?.message?.message_id
      || parsed?.data?.message_id
      || parsed?.data?.message?.message_id
      || parsed?.data?.data?.message_id
      || '',
  ).trim();
  if (!messageId) {
    throw Object.assign(new Error('lark-cli response is missing message_id'), {code: 'LARK_SEND_MESSAGE_ID_MISSING'});
  }
  return {ok: true, messageId};
}

/**
 * The daily command only accepts the group chat id from config/lark_report.json.
 * There is deliberately no user-id fallback and no environment fallback.
 */
export function resolveDailyRecipientChatId(config) {
  const chatId = String(config?.recipientChatId || '').trim();
  if (!chatId) {
    throw Object.assign(new Error('config/lark_report.json has no recipientChatId'), {code: 'LARK_RECIPIENT_CHAT_MISSING'});
  }
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
    throw Object.assign(new Error('recipientChatId must be a Feishu group chat id (oc_...)'), {code: 'LARK_RECIPIENT_CHAT_INVALID'});
  }
  return chatId;
}

export function resolveDailyIdentity(config) {
  const identity = String(config?.defaultIdentity || 'bot');
  if (identity !== 'bot') {
    throw Object.assign(new Error('pending-discuss daily delivery requires the production bot identity'), {code: 'LARK_IDENTITY_INVALID'});
  }
  return identity;
}
