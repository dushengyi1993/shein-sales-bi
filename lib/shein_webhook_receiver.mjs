#!/usr/bin/env node
/**
 * Pure, transport-agnostic building blocks for a SHEIN WebHook receiver.
 * This module deliberately has no HTTP, database, queue, or notification I/O.
 */
import crypto from 'node:crypto';

export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_BYTES = 256 * 1024;
export const DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_DEPTH = 4;
export const DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_OBJECTS = 256;
export const WEBHOOK_AES_IV_SEED = 'space-station-default-iv';

const SENSITIVE_KEY = /(?:secret|password|token|authorization|cookie|phone|mobile|email|address|recipient|consignee|idcard|bank|eventdata)/i;
const FAILURE = /(?:fail|failed|reject|denied|invalid|expire|revok|cancel|close|off.?shelf|unshelf|delete|remove|zero)/i;
const SUCCESS = /(?:success|pass|approved|accept|valid|active|on.?shelf|enable|normal|completed)/i;

/** Current official directory, plus the path aliases needed for receiver routing. */
export const SUPPORTED_WEBHOOK_EVENTS = Object.freeze([
  {eventCode: '3001450', eventPath: '/product_document_audit_status_notice', family: 'product_audit', label: '商品审核通知'},
  {eventCode: '3000910', eventPath: '/product_document_receive_status_notice', family: 'product_receive', label: '商品接收通知'},
  {eventCode: '3001449', eventPath: '/product_document_audit_status_notice_all_channels', family: 'product_audit_all_channels', label: '商品发布公文审核通知（全渠道）'},
  {eventCode: '3000848', eventPath: '/product_shelves_notice', family: 'product_shelves', label: '商品上下架通知'},
  {eventCode: '3001061', eventPath: '/product_quota_change_notice', family: 'quota', label: '商品额度变动通知'},
  {eventCode: '3000804', eventPath: '/product_prices_abnormal_notice', family: 'price_abnormal', label: '商品价格异常通知'},
  {eventCode: '3000912', eventPath: '/product_price_audit_status_notice', family: 'price_audit', label: '商品涨价审批结果通知'},
  {eventCode: '3001792', eventPath: '/product_rrp_review_status_changed', family: 'rrp_review', label: '建议零售价审核状态更新'},
  {eventCode: '3001793', eventPath: '/product_rrp_validity_changed', family: 'rrp_validity', label: '建议零售价有效期变更'},
  {eventCode: '3001104', eventPath: '/product_compliance_change_notice', family: 'compliance', label: '商品合规信息失效通知'},
  {eventCode: '3001068', eventPath: '/inventory_warning_notice', family: 'inventory_warning', label: 'SKU库存预警通知'},
  {eventCode: '3001048', eventPath: '/out_of_stock_notice', family: 'out_of_stock', label: '推送缺货需求库存数'},
  {eventCode: '3001442', eventPath: '/order_push_notice', family: 'order', label: '订单同步通知'},
  {eventCode: '3000914', eventPath: '/return_order_push_notice', family: 'return', label: '退货单同步通知'},
  {eventCode: '3001082', eventPath: '/invoice_status_notice', family: 'invoice', label: 'cte开票通知'},
  {eventCode: '3001461', eventPath: '/logistics_order_result_notice', family: 'logistics_order', label: 'SHEIN合作物流单下单通知'},
  {eventCode: '3001435', eventPath: '/purchase_order_notice', family: 'purchase_order', label: '采购单通知'},
  {eventCode: '3001441', eventPath: '/delivery_modify_notice', family: 'delivery', label: '发货单变更通知'},
  {eventCode: '3001744', eventPath: '/purchase_order_return_application_notice', family: 'purchase_return_application', label: '采购退货申请单状态通知'},
  {eventCode: '3001765', eventPath: '/logistics_forecast_result_notice', family: 'logistics_forecast', label: '采购单合作物流通知'},
  {eventCode: '3001801', eventPath: '/purchase_order_return_notice', family: 'purchase_return', label: '采购退货单状态通知'},
  {eventCode: '3001503', eventPath: '/authorization_change_notice', family: 'authorization', label: '店铺授权关系变更通知'},
  {eventCode: '3001903', eventPath: '/product_delete_audit', family: 'product_delete_audit', label: '商品删除审核通知'},
].map(Object.freeze));

const EVENT_BY_CODE = new Map(SUPPORTED_WEBHOOK_EVENTS.map(event => [event.eventCode, event]));
const EVENT_BY_PATH = new Map(SUPPORTED_WEBHOOK_EVENTS.map(event => [event.eventPath, event]));

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function assertNonEmpty(value, name) {
  if (!text(value)) throw new Error(`${name} is required`);
}

function bytes(rawBody) {
  if (Buffer.isBuffer(rawBody)) return Buffer.from(rawBody);
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new TypeError('rawBody must be a string, Buffer, or Uint8Array');
}

function parseContentType(contentType) {
  const value = text(contentType);
  if (!value) throw new Error('contentType is required');
  const [mediaType, ...params] = value.split(';');
  const parameters = new Map();
  for (const parameter of params) {
    const index = parameter.indexOf('=');
    if (index < 1) continue;
    const key = parameter.slice(0, index).trim().toLowerCase();
    let item = parameter.slice(index + 1).trim();
    if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) item = item.slice(1, -1);
    parameters.set(key, item);
  }
  return {mediaType: mediaType.trim().toLowerCase(), parameters};
}

function parseDisposition(value) {
  const [type, ...parts] = String(value || '').split(';');
  if (type.trim().toLowerCase() !== 'form-data') return null;
  const values = new Map();
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let item = part.slice(index + 1).trim();
    if (item.startsWith('"') && item.endsWith('"') && item.length >= 2) item = item.slice(1, -1);
    values.set(key, item);
  }
  return values;
}

function extractMultipartEventData(body, suppliedBoundary) {
  const boundary = text(suppliedBoundary);
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error('multipart boundary is invalid');
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  if (!body.subarray(0, delimiter.length).equals(delimiter)) throw new Error('multipart body does not start with boundary');
  let offset = delimiter.length;
  let eventData;
  let parts = 0;
  while (true) {
    if (body.subarray(offset, offset + 2).equals(Buffer.from('--'))) {
      offset += 2;
      if (offset !== body.length && !body.subarray(offset).equals(Buffer.from('\r\n'))) throw new Error('multipart closing boundary is malformed');
      break;
    }
    if (!body.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) throw new Error('multipart boundary must use CRLF');
    offset += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), offset);
    if (headerEnd < 0) throw new Error('multipart part headers are malformed');
    const headerLines = body.subarray(offset, headerEnd).toString('utf8').split('\r\n');
    const headers = new Map();
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error('multipart part header is malformed');
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const marker = Buffer.from(`\r\n--${boundary}`, 'utf8');
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(marker, contentStart);
    if (contentEnd < 0) throw new Error('multipart part has no terminating boundary');
    parts += 1;
    if (parts > 32) throw new Error('multipart body has too many parts');
    const disposition = parseDisposition(headers.get('content-disposition'));
    if (!disposition?.get('name')) throw new Error('multipart part has no form-data name');
    if (disposition.get('name') === 'eventData') {
      if (disposition.has('filename')) throw new Error('eventData must be a scalar form field');
      if (eventData !== undefined) throw new Error('eventData must occur exactly once');
      eventData = body.subarray(contentStart, contentEnd).toString('utf8');
    }
    offset = contentEnd + 2 + delimiter.length;
  }
  assertNonEmpty(eventData, 'eventData');
  return eventData;
}

/** Normalize Node, Fetch, and plain-object headers to lower-case string values. */
export function normalizeWebhookHeaders(headers) {
  if (!headers) return {};
  const output = {};
  const append = (key, value) => {
    const name = text(key).toLowerCase();
    if (!name) return;
    const normalized = Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
    output[name] = Object.hasOwn(output, name) ? `${output[name]}, ${normalized}` : normalized;
  };
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => append(key, value));
  } else if (typeof headers[Symbol.iterator] === 'function') {
    for (const pair of headers) append(pair?.[0], pair?.[1]);
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) append(key, value);
  } else {
    throw new TypeError('headers must be an object, iterable, or Headers instance');
  }
  return output;
}

/** Extract exactly one encrypted eventData field without any HTTP framework dependency. */
export function extractWebhookEventData({contentType, rawBody, boundary, maxBodyBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES} = {}) {
  const body = bytes(rawBody);
  const limit = Number(maxBodyBytes);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('maxBodyBytes must be a positive safe integer');
  if (body.length === 0) throw new Error('rawBody is empty');
  if (body.length > limit) throw new RangeError(`rawBody exceeds ${limit} bytes`);
  const parsed = parseContentType(contentType);
  let value;
  if (parsed.mediaType === 'multipart/form-data') {
    const actualBoundary = boundary ?? parsed.parameters.get('boundary');
    value = extractMultipartEventData(body, actualBoundary);
  } else if (parsed.mediaType === 'application/json') {
    let parsedBody;
    try { parsedBody = JSON.parse(body.toString('utf8')); }
    catch { throw new Error('application/json body is invalid JSON'); }
    if (!parsedBody || Array.isArray(parsedBody) || typeof parsedBody !== 'object') throw new Error('JSON body must be an object');
    if (!Object.hasOwn(parsedBody, 'eventData') || typeof parsedBody.eventData !== 'string') throw new Error('JSON eventData must be a string');
    value = parsedBody.eventData;
  } else if (parsed.mediaType === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(body.toString('utf8'));
    const values = form.getAll('eventData');
    if (values.length !== 1) throw new Error('urlencoded eventData must occur exactly once');
    value = values[0];
  } else {
    throw new Error(`unsupported webhook content type: ${parsed.mediaType || 'unknown'}`);
  }
  assertNonEmpty(value, 'eventData');
  return value;
}

function officialWebhookCanonical({headers, requestPath}) {
  const path = String(requestPath ?? '');
  if (!path.startsWith('/') || /[?#]/.test(path)) throw new Error('requestPath must be the original callback URI path without query or fragment');
  const openKey = text(headers['x-lt-appid']) || text(headers['x-lt-openkeyid']);
  if (!openKey) throw new Error('open key is missing');
  return `${openKey}&${headers['x-lt-timestamp']}&${path}`;
}

/** Official SHEIN WebHook signature strategy. The random key is the first five signature characters. */
export const DEFAULT_WEBHOOK_SIGNATURE_STRATEGY = Object.freeze({
  name: 'shein-webhook-hmac-sha256-hex-base64',
  verify({canonical, appSecretKey, receivedSignature}) {
    const signature = String(receivedSignature || '');
    if (signature.length < 6) return {ok: false, reason: 'signature_invalid'};
    if (typeof canonical !== 'string') return {ok: false, reason: 'canonical_value_invalid'};
    const randomKey = signature.slice(0, 5);
    const hex = crypto.createHmac('sha256', `${appSecretKey}${randomKey}`).update(canonical, 'utf8').digest('hex');
    return {expectedSignature: `${randomKey}${Buffer.from(hex, 'utf8').toString('base64')}`};
  },
});

/** Helper for a deployment/test strategy after its canonical string is verified against an official sample. */
export function createHmacSha256SignatureStrategy({encoding = 'hex'} = {}) {
  if (!['hex', 'base64', 'base64url'].includes(encoding)) throw new Error('unsupported HMAC signature encoding');
  return Object.freeze({
    name: `hmac-sha256-${encoding}`,
    verify({canonical, appSecretKey}) {
      if (typeof canonical !== 'string') return {ok: false, reason: 'canonical_value_invalid'};
      return {expectedSignature: crypto.createHmac('sha256', appSecretKey).update(canonical, 'utf8').digest(encoding)};
    },
  });
}

function timeSafeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify the official replay window and signature. Custom canonical/strategy hooks are for
 * fixture testing or a future official contract revision; the default is the verified formula.
 */
export function verifyWebhookSignature({headers, eventData, appSecretKey, requestPath, nowMs = Date.now(), maxSkewMs = DEFAULT_WEBHOOK_MAX_SKEW_MS, canonical, signatureStrategy = DEFAULT_WEBHOOK_SIGNATURE_STRATEGY} = {}) {
  const normalizedHeaders = normalizeWebhookHeaders(headers);
  const result = {ok: false, reason: '', headers: normalizedHeaders, timestampMs: null, ageMs: null, strategy: signatureStrategy?.name || 'custom'};
  const required = ['x-lt-eventcode', 'x-lt-timestamp', 'x-lt-signature'];
  const missing = required.filter(name => !text(normalizedHeaders[name]));
  if (missing.length) return {...result, reason: `missing_required_header:${missing.join(',')}`};
  if (!text(normalizedHeaders['x-lt-appid']) && !text(normalizedHeaders['x-lt-openkeyid'])) return {...result, reason: 'missing_required_header:x-lt-appid_or_x-lt-openkeyid'};
  if (!text(eventData)) return {...result, reason: 'event_data_missing'};
  if (!text(appSecretKey)) return {...result, reason: 'app_secret_key_missing'};
  if (!/^\d{11,16}$/.test(text(normalizedHeaders['x-lt-timestamp']))) return {...result, reason: 'timestamp_invalid'};
  const timestampMs = Number(normalizedHeaders['x-lt-timestamp']);
  const clock = Number(nowMs);
  const skew = Number(maxSkewMs);
  if (!Number.isSafeInteger(timestampMs) || !Number.isFinite(clock) || !Number.isFinite(skew) || skew < 0) return {...result, reason: 'time_configuration_invalid'};
  const ageMs = clock - timestampMs;
  if (Math.abs(ageMs) > skew) return {...result, timestampMs, ageMs, reason: 'timestamp_outside_allowed_skew'};
  let canonicalValue;
  try {
    canonicalValue = typeof canonical === 'function'
      ? canonical({headers: normalizedHeaders, eventData, requestPath})
      : (canonical === undefined ? officialWebhookCanonical({headers: normalizedHeaders, requestPath}) : canonical);
  } catch {
    return {...result, timestampMs, ageMs, reason: 'canonicalization_failed'};
  }
  let verdict;
  try {
    verdict = signatureStrategy?.verify?.({headers: normalizedHeaders, eventData, appSecretKey, canonical: canonicalValue, receivedSignature: normalizedHeaders['x-lt-signature']});
  } catch {
    return {...result, timestampMs, ageMs, reason: 'signature_strategy_failed'};
  }
  if (verdict?.ok === false) return {...result, timestampMs, ageMs, reason: verdict.reason || 'signature_rejected'};
  if (!text(verdict?.expectedSignature)) return {...result, timestampMs, ageMs, reason: 'signature_strategy_did_not_produce_expected_signature'};
  const signatureMatches = timeSafeEqual(normalizedHeaders['x-lt-signature'], verdict.expectedSignature);
  return {
    ...result,
    timestampMs,
    ageMs,
    ok: signatureMatches,
    reason: signatureMatches ? 'verified' : 'signature_mismatch',
  };
}

function aesKey(appSecretKey) {
  const key = Buffer.alloc(16);
  Buffer.from(String(appSecretKey), 'utf8').copy(key, 0, 0, 16);
  return key;
}

function strictBase64(value) {
  const source = text(value);
  if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw new Error('eventData must be canonical base64');
  const decoded = Buffer.from(source, 'base64');
  if (!decoded.length || decoded.toString('base64') !== source) throw new Error('eventData must be canonical base64');
  return decoded;
}

/** Decrypt the AES-128-CBC/PKCS5 event body and parse the required JSON payload. */
export function decryptWebhookEventData(eventData, appSecretKey) {
  assertNonEmpty(appSecretKey, 'appSecretKey');
  const ciphertext = strictBase64(eventData);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey(appSecretKey), Buffer.from(WEBHOOK_AES_IV_SEED, 'utf8').subarray(0, 16));
  decipher.setAutoPadding(true);
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'); }
  catch { throw new Error('eventData AES decryption failed'); }
  try { return JSON.parse(plaintext); }
  catch { throw new Error('decrypted eventData is not valid JSON'); }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * SHEIN's quota notification wraps the business object in a JSON string named
 * `data`; the compliance notification can itself be a JSON string. Unpack only
 * those forms, with explicit resource limits, before business normalization.
 */
export function unpackWebhookPayload(payload, {
  maxBytes = DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_BYTES,
  maxDepth = DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_DEPTH,
  maxObjects = DEFAULT_WEBHOOK_MAX_EMBEDDED_DATA_OBJECTS,
} = {}) {
  const byteLimit = Number(maxBytes);
  const depthLimit = Number(maxDepth);
  const objectLimit = Number(maxObjects);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new RangeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(depthLimit) || depthLimit < 0) throw new RangeError('maxDepth must be a non-negative safe integer');
  if (!Number.isSafeInteger(objectLimit) || objectLimit < 1) throw new RangeError('maxObjects must be a positive safe integer');
  let objects = 0;
  const parse = (value, depth, label) => {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > byteLimit) throw new RangeError(`${label} exceeds ${byteLimit} bytes`);
      try { value = JSON.parse(value); }
      catch { throw new Error(`${label} is not valid JSON`); }
    }
    if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
    objects += 1;
    if (objects > objectLimit) throw new RangeError(`embedded webhook payload exceeds ${objectLimit} objects`);
    if (typeof value.data === 'string') {
      if (depth >= depthLimit) throw new RangeError(`embedded webhook payload exceeds ${depthLimit} levels`);
      const data = parse(value.data, depth + 1, 'payload.data');
      return {...value, data};
    }
    return value;
  };
  return parse(payload, 0, 'payload');
}

function lookupEvent(eventCode, eventPath) {
  const code = text(eventCode);
  const path = text(eventPath).replace(/^https?:\/\/[^/]+/i, '') || '';
  return EVENT_BY_CODE.get(code) || EVENT_BY_PATH.get(path) || {eventCode: code, eventPath: path, family: 'unknown', label: '未知事件'};
}

function candidates(payload) {
  if (!isPlainObject(payload)) return [];
  return [payload, payload.data, payload.info, payload.result, payload.body].filter(isPlainObject);
}

function firstField(payload, names) {
  for (const source of candidates(payload)) {
    for (const name of names) {
      const value = source[name];
      if (value !== undefined && value !== null && text(value)) return text(value);
    }
  }
  return '';
}

function numberField(payload, names) {
  const raw = firstField(payload, names);
  if (!raw || !/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  return Number(raw);
}

function firstDocumentDetail(payload) {
  for (const source of candidates(payload)) {
    const details = source.document_details ?? source.documentDetails;
    if (Array.isArray(details)) {
      const detail = details.find(isPlainObject);
      if (detail) return detail;
    }
  }
  return {};
}

function shelfChangeRows(payload) {
  const rows = [];
  for (const source of candidates(payload)) {
    const groups = source.shelfChangeInfos ?? source.shelf_change_infos;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group)) continue;
      const sites = group.siteChangeInfos ?? group.site_change_infos;
      if (!Array.isArray(sites)) continue;
      for (const site of sites) {
        if (!isPlainObject(site) || rows.length >= 64) continue;
        rows.push(Object.freeze({
          site: text(site.site ?? site.siteAbbr ?? site.site_abbr).slice(0, 80),
          shelfState: text(site.shelfState ?? site.shelf_state).slice(0, 20),
          firstShelfTime: text(site.firstShelfTime ?? site.first_shelf_time).slice(0, 80),
          lastShelfTime: text(site.lastShelfTime ?? site.last_shelf_time).slice(0, 80),
          recycleState: text(site.recycleState ?? site.recycle_state).slice(0, 20),
        }));
      }
    }
  }
  return Object.freeze(rows);
}

function actionFor(event, payload) {
  const declared = firstField(payload, ['operationType', 'operation_type', 'operateType', 'operate_type', 'action', 'eventType', 'event_type', 'changeType', 'change_type', 'documentType', 'document_type', 'auditType', 'audit_type', 'type']).toLowerCase();
  if (event.family === 'product_audit' || event.family === 'product_audit_all_channels') {
    return /delete|remove|cancel/.test(declared) ? 'delete_audit' : 'audit';
  }
  if (event.family === 'product_delete_audit') return 'delete_audit';
  if (event.family === 'product_shelves') return /off|down|un|delete|remove|(?:^|_)0(?:$|_)/.test(declared) ? 'off_shelf' : (declared || 'shelves_changed');
  return declared || event.family;
}

/** Convert a decrypted business payload to a compact, schema-tolerant safe event record. */
export function normalizeWebhookBusinessEvent({eventCode, eventPath, payload, storeKey = '', receivedAt = new Date().toISOString()} = {}) {
  const event = lookupEvent(eventCode, eventPath);
  const source = unpackWebhookPayload(payload);
  const documentDetail = firstDocumentDetail(source);
  const declaredStatus = firstField(source, ['audit_state', 'auditState', 'auditStatus', 'audit_status', 'status', 'reviewStatus', 'review_status', 'resultStatus', 'result_status', 'authorizationStatus', 'authorization_status', 'complianceStatus', 'compliance_status', 'shelfStatus', 'shelf_status', 'state']);
  const productId = firstField(source, ['spuName', 'spu_name', 'spu', 'productId', 'product_id', 'goodsSn', 'goods_sn', 'productCode', 'product_code']);
  const skc = firstField(source, ['skcName', 'skc_name', 'skc', 'skcCode', 'skc_code', 'skcId', 'skc_id', 'styleCode', 'style_code']) || firstField(documentDetail, ['skc_name', 'skcName']);
  const firstSku = Array.isArray(documentDetail.sku_list) ? documentDetail.sku_list.find(isPlainObject) || {} : {};
  const sku = firstField(source, ['sku', 'skuCode', 'sku_code', 'skuId', 'sku_id']) || firstField(firstSku, ['sku_code', 'skuCode']);
  const orderId = firstField(source, ['orderNo', 'order_no', 'orderId', 'order_id', 'orderNumber', 'order_number']);
  const returnId = firstField(source, ['returnOrderNo', 'return_order_no', 'returnOrderId', 'return_order_id', 'returnNo', 'return_no']);
  const documentId = firstField(source, ['documentSn', 'document_sn', 'documentNo', 'document_no', 'documentId', 'document_id', 'documentCode', 'document_code']) || firstField(documentDetail, ['document_sn', 'documentSn']) || firstField(source, ['version']);
  const authorizationId = firstField(source, ['authorizationId', 'authorization_id', 'authId', 'auth_id', 'openKeyId', 'open_key_id', 'srmSupplierId', 'supplierId']);
  const quota = numberField(source, ['availableLimit', 'quota', 'availableQuota', 'available_quota', 'shelfQuota', 'shelf_quota', 'remainingQuota', 'remaining_quota']);
  const eventTime = firstField(source, ['eventTime', 'event_time', 'audit_time', 'auditTime', 'updateTime', 'changeTime', 'audit_complete_time', 'sendTimeStamp']);
  const version = firstField(source, ['version']);
  const receivedSuccess = firstField(source, ['received_success', 'receivedSuccess']);
  const auditState = firstField(source, ['audit_state', 'auditState']);
  const authType = firstField(source, ['type', 'authType', 'auth_type']);
  const supplierId = firstField(source, ['supplierId', 'srmSupplierId']);
  const complianceRequired = firstField(source, ['isRequired', 'is_required', 'required']);
  const complianceMissing = firstField(source, ['isMiss', 'is_miss', 'missing']);
  const shelfChanges = shelfChangeRows(source);
  const shelfStates = shelfChanges.map(change => change.shelfState).filter(Boolean);
  // The current official 3000848 payload does not contain these fields. Keep
  // schema-tolerant extraction so a future platform extension can be shown,
  // while an absent value is omitted from user-facing copy rather than being
  // guessed from recycle state.
  const shelfReason = firstField(source, [
    'offShelfReason', 'off_shelf_reason', 'shelfReason', 'shelf_reason',
    'reasonDesc', 'reason_desc', 'reasonName', 'reason_name',
  ]);
  const shelfOperator = firstField(source, [
    'operatorName', 'operator_name', 'operateUserName', 'operate_user_name',
    'operator', 'operateBy', 'operate_by', 'updatedBy', 'updated_by',
  ]);
  const shelfOperatorType = firstField(source, ['operatorType', 'operator_type', 'operateType', 'operate_type']);
  const status = event.family === 'product_receive'
    ? receivedSuccess
    : event.family === 'product_shelves'
      ? (shelfStates.includes('0') ? '0' : shelfStates.includes('1') ? '1' : declaredStatus)
      : event.family === 'authorization'
        ? authType
        : event.family === 'order'
          ? firstField(source, ['orderStatus', 'order_status', 'status'])
          : declaredStatus;
  const businessId = orderId || returnId || documentId || productId || skc || sku || authorizationId || firstField(source, ['id', 'requestId']);
  return Object.freeze({
    eventCode: event.eventCode || text(eventCode),
    eventPath: event.eventPath || text(eventPath),
    eventFamily: event.family,
    eventLabel: event.label,
    action: event.family === 'product_shelves' && shelfStates.includes('0') ? 'off_shelf' : event.family === 'product_shelves' && shelfStates.length && shelfStates.every(state => state === '1') ? 'on_shelf' : actionFor(event, source),
    status,
    businessId,
    productId,
    skc,
    sku,
    orderId,
    returnId,
    documentId,
    authorizationId,
    quota,
    availableLimit: quota,
    eventTime,
    version,
    receivedSuccess,
    auditState,
    authType,
    supplierId,
    complianceRequired,
    complianceMissing,
    shelfStates: Object.freeze(shelfStates),
    shelfChanges,
    shelfReason,
    shelfOperator,
    shelfOperatorType,
    storeKey: text(storeKey),
    receivedAt: text(receivedAt),
  });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/** Compute a deterministic idempotency hash without retaining raw payload values. */
export function computeWebhookIdempotencyKey({headers, eventCode, eventPath, payload, businessId} = {}) {
  const normalized = normalizeWebhookHeaders(headers);
  const event = lookupEvent(eventCode || normalized['x-lt-eventcode'], eventPath);
  const unpacked = unpackWebhookPayload(payload);
  const business = normalizeWebhookBusinessEvent({eventCode: event.eventCode, eventPath: event.eventPath, payload: unpacked});
  const normalizedBusiness = businessId || business.businessId;
  // Most SHEIN events carry an intrinsic business timestamp, so retries must
  // ignore the delivery timestamp.  The authorization-change event does not:
  // two real revocations can otherwise collapse forever onto the first receipt
  // after a successful probe has reopened the gate.  In that one documented
  // shape, use the signed delivery timestamp as the occurrence boundary.
  const occurrence = event.family === 'authorization' && !business.eventTime
    ? normalized['x-lt-timestamp'] || ''
    : '';
  const fields = [
    normalized['x-lt-appid'] || '',
    normalized['x-lt-openkeyid'] || '',
    event.eventCode || text(eventCode),
    event.eventPath || text(eventPath),
    normalizedBusiness || '',
    business.action,
    business.status,
    business.eventTime,
    occurrence,
    stableJson(unpacked),
  ];
  return crypto.createHash('sha256').update(fields.join('\u0000'), 'utf8').digest('hex');
}

function isFailure(status) { return FAILURE.test(text(status)); }
function isSuccess(status) { return SUCCESS.test(text(status)); }

/** Assign severity and notification eligibility. P0 is intentionally restricted to operationally critical exceptions. */
export function classifyWebhookSeverity(input = {}) {
  const event = input.normalizedEvent || normalizeWebhookBusinessEvent(input);
  const status = text(event.status);
  const action = text(event.action);
  const family = event.eventFamily;
  const authorizationException = family === 'authorization';
  // Current product audit/delete notifications use 2=passed and 3=failed in
  // addition to textual values. Treat only the documented failure code as P0.
  const auditFailure = ['product_audit', 'product_audit_all_channels'].includes(family) && (isFailure(status) || status === '3');
  const unexpectedRemoval = family === 'product_shelves' && /off|down|delete|remove|un/.test(action);
  const deleteFailure = action === 'delete_audit' && (isFailure(status) || status === '3');
  const requiredComplianceMissing = family === 'compliance' && /^(?:1|true|yes|required)$/i.test(text(event.complianceRequired)) && /^(?:1|true|yes)$/i.test(text(event.complianceMissing));
  const complianceLoss = family === 'compliance' && (requiredComplianceMissing || isFailure(status));
  const deleteApproved = family === 'product_delete_audit' && status === '2';
  const quotaZero = family === 'quota' && event.quota === 0;
  if (authorizationException || auditFailure || unexpectedRemoval || deleteFailure || deleteApproved || complianceLoss || quotaZero) {
    return Object.freeze({severity: 'P0', notifyFeishu: true, reason: authorizationException ? 'authorization_exception' : unexpectedRemoval || deleteApproved ? 'unexpected_product_removal' : auditFailure ? 'audit_failed' : deleteFailure ? 'delete_audit_failed' : complianceLoss ? 'required_compliance_invalid' : 'quota_zero'});
  }
  const productReceiveFailure = family === 'product_receive'
    && (/^(?:0|false|no)$/i.test(text(event.receivedSuccess)) || isFailure(status));
  const priceWorkflowFailure = ['price_audit', 'rrp_review', 'rrp_validity'].includes(family)
    && (isFailure(status) || status === '3');
  const supportingWorkflowFailure = ['invoice', 'logistics_order', 'logistics_forecast'].includes(family)
    && isFailure(status);
  const operationalWorkflowChange = ['purchase_order', 'delivery', 'purchase_return_application', 'purchase_return'].includes(family);
  if (productReceiveFailure || priceWorkflowFailure || supportingWorkflowFailure || operationalWorkflowChange
    || ['price_abnormal', 'inventory_warning', 'out_of_stock'].includes(family)) {
    return Object.freeze({severity: 'P1', notifyFeishu: false, reason: family});
  }
  return Object.freeze({severity: 'P3', notifyFeishu: false, reason: family === 'unknown' ? 'unknown_event' : 'normal_or_non_alerting_event'});
}

/** Safe view-model for browser/UI use: only explicit operational fields, never the raw decrypted payload. */
export function projectWebhookEventForFrontend(event = {}) {
  const normalized = event.normalizedEvent || event;
  const severity = event.severity || classifyWebhookSeverity({normalizedEvent: normalized});
  const output = {
    eventCode: text(normalized.eventCode),
    eventPath: text(normalized.eventPath),
    eventFamily: text(normalized.eventFamily),
    eventLabel: text(normalized.eventLabel),
    action: text(normalized.action),
    status: text(normalized.status),
    businessId: text(normalized.businessId),
    productId: text(normalized.productId),
    skc: text(normalized.skc),
    sku: text(normalized.sku),
    orderId: text(normalized.orderId),
    returnId: text(normalized.returnId),
    documentId: text(normalized.documentId),
    quota: Number.isFinite(normalized.quota) ? normalized.quota : null,
    eventTime: text(normalized.eventTime),
    version: text(normalized.version),
    auditState: text(normalized.auditState),
    receivedSuccess: text(normalized.receivedSuccess),
    authType: text(normalized.authType),
    supplierId: text(normalized.supplierId),
    complianceRequired: text(normalized.complianceRequired),
    complianceMissing: text(normalized.complianceMissing),
    shelfStates: Array.isArray(normalized.shelfStates) ? normalized.shelfStates.map(text) : [],
    shelfChanges: Array.isArray(normalized.shelfChanges) ? normalized.shelfChanges.map(change => ({
      site: text(change?.site),
      shelfState: text(change?.shelfState),
      firstShelfTime: text(change?.firstShelfTime),
      lastShelfTime: text(change?.lastShelfTime),
      recycleState: text(change?.recycleState),
    })) : [],
    shelfReason: text(normalized.shelfReason),
    shelfOperator: text(normalized.shelfOperator),
    shelfOperatorType: text(normalized.shelfOperatorType),
    storeKey: text(normalized.storeKey),
    receivedAt: text(normalized.receivedAt),
    severity: text(severity.severity),
    notifyFeishu: Boolean(severity.notifyFeishu),
  };
  for (const key of Object.keys(output)) if (SENSITIVE_KEY.test(key)) delete output[key];
  return Object.freeze(output);
}
