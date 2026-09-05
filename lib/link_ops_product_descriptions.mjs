#!/usr/bin/env node
/**
 * Strict reviewed-material product description contracts (Phase A).
 *
 * Only verbatim lines from human-reviewed 审核资料 “三语核心卖点” may enter a
 * SHEIN publish payload. This module never generates, translates, rewrites,
 * trims, normalizes or maps descriptions from any source OpenAPI field
 * (productMultiDescList etc.). It only:
 *
 *   1. validates the strict material JSON shape,
 *   2. builds the fixed ar/en publish rows (5 lines each, joined with "\n"),
 *   3. describes the material and publish payload with hashes only,
 *   4. gates a copy_product_draft publish payload on explicit ar/en
 *      descriptions (exactly 5 lines each), unless a separate default-off
 *      task/store/source/goods/image/payload lock records the user's current
 *      explicit instruction to leave descriptions empty.
 *
 * zh-cn lines are audit-only: they never enter the SHEIN payload.
 * Logs and audit records must only carry hashes/counts, never full text.
 */
import crypto from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

export const DESCRIPTION_SCHEMA_VERSION = 1;
export const DESCRIPTION_LINE_COUNT = 5;
export const DESCRIPTION_NAME_MAX_CHARS = 5000;
export const DESCRIPTION_PUBLISH_LANGUAGES = Object.freeze(['ar', 'en']);
export const DESCRIPTION_AUDIT_LANGUAGES = Object.freeze(['zh-cn']);
export const DESCRIPTION_ALL_LANGUAGES = Object.freeze(['ar', 'en', 'zh-cn']);
export const DESCRIPTION_PAYLOAD_HASH_ALGORITHM = 'sha256-stable-json-v1';
export const DESCRIPTION_SOURCE_PROOF = 'server_verified_html_section_s09';
export const DESCRIPTION_SOURCE_PROOF_S9 = 'server_verified_html_section_s9';
export const DESCRIPTION_SOURCE_PROOF_DOCX = 'server_verified_docx_ooxml_fixed_structure';
export const EMPTY_DESCRIPTION_AUTHORIZATION_SCHEMA_VERSION = 1;
export const EMPTY_DESCRIPTION_CONFIRM_TEXT = 'USER_EXPLICIT_EMPTY_DESCRIPTION';
export const EMPTY_DESCRIPTION_AUTHORITY = 'explicit_user_instruction';
export const EMPTY_DESCRIPTION_MODE = 'empty';

const SHA256_RE = /^[a-f0-9]{64}$/i;
const HTML_RE = /[<>]/;
const FORBIDDEN_DESCRIPTION_PAYLOAD_FIELDS = Object.freeze([
  'multiLanguageDescList',
  'productMultiDescList',
  'product_multi_desc_list',
]);
const DESCRIPTION_BINDING_KEYS = Object.freeze([
  'authority',
  'baseTaskRevision',
  'bindingRequestKey',
  'boundAt',
  'boundByUser',
  'contentSha256',
  'hashes',
  'imageBindingFingerprint',
  'kind',
  'lineCounts',
  'newPayloadHash',
  'payloadHashAlgorithm',
  'publishLanguages',
  'schemaVersion',
  'sourceApproved',
  'sourceByteLength',
  'sourceFileSha256',
  'sourceLabel',
  'sourceProof',
  'targetStore',
].sort());
const EMPTY_DESCRIPTION_AUTHORIZATION_KEYS = Object.freeze([
  'authority',
  'authorizationRequestKey',
  'authorizedAt',
  'authorizedByUser',
  'baseTaskRevision',
  'imageBindingFingerprint',
  'kind',
  'mode',
  'payloadHash',
  'payloadHashAlgorithm',
  'schemaVersion',
  'sourceSkc',
  'sourceStore',
  'standardGoodsSn',
  'targetStore',
  'taskId',
].sort());
// SHEIN official emoji pattern is a Java UTF-16 code-unit check:
// [\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27FF]. In JavaScript the regex must NOT
// use the /u flag for the surrogate ranges: under /u they only match lone
// surrogate code points and would miss astral emoji such as U+1F600 (😀).
// Without /u the ranges match any high/low surrogate code unit, i.e. every
// astral character, exactly like the platform. U+FE0F (variation selector)
// and U+200D (ZWJ) catch composed sequences such as ❤️ / 👨👩👧. Ordinary
// Arabic, English and Chinese text (including "360°", U+00B0) is unaffected.
const EMOJI_RE = /[\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27FF\uFE0F\u200D]/;

export class DescriptionMaterialError extends Error {
  constructor(message, {code = 'DESCRIPTION_MATERIAL_INVALID', details = {}} = {}) {
    super(message);
    this.name = 'DescriptionMaterialError';
    this.code = code;
    this.details = details;
  }
}

export function sha256Utf8(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function sha256Bytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256StableJson(value) {
  return sha256Utf8(stableJson(value));
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function uniqueNonEmpty(values, normalizer = value => String(value || '').trim()) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizer)
    .filter(Boolean))];
}

function taskWriteStores(task) {
  const values = Array.isArray(task?.targets?.writeStores) && task.targets.writeStores.length
    ? task.targets.writeStores
    : Array.isArray(task?.targets?.stores)
      ? task.targets.stores
      : [];
  return uniqueNonEmpty(values, normalizeStoreKey);
}

function taskSourceIdentity(task) {
  const sourceStores = uniqueNonEmpty(task?.targets?.sourceStores, normalizeStoreKey);
  const sourceSkc = typeof task?.targets?.sourceSkc === 'string'
    ? task.targets.sourceSkc.trim()
    : '';
  return {sourceStores, sourceSkc};
}

function taskStandardGoodsNumbers(task) {
  return uniqueNonEmpty([
    task?.targets?.standardGoodsSn,
    task?.standardGoodsSn,
    task?.publishPreparation?.standardGoodsSn,
    task?.targets?.publishPreparation?.standardGoodsSn,
    task?.publishAssetBinding?.publishPreparation?.standardGoodsSn,
  ]);
}

function descriptionPayloadFields(payload) {
  return ['multi_language_desc_list', ...FORBIDDEN_DESCRIPTION_PAYLOAD_FIELDS]
    .filter(field => Object.prototype.hasOwnProperty.call(payload || {}, field));
}

function emptyDescriptionAuthorizationRequestScope(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    mode: value.mode,
    authority: value.authority,
    taskId: value.taskId,
    targetStore: value.targetStore,
    sourceStore: value.sourceStore,
    sourceSkc: value.sourceSkc,
    standardGoodsSn: value.standardGoodsSn,
    baseTaskRevision: value.baseTaskRevision,
    authorizedAt: value.authorizedAt,
    authorizedByUser: value.authorizedByUser,
    imageBindingFingerprint: value.imageBindingFingerprint,
    payloadHash: value.payloadHash,
    payloadHashAlgorithm: value.payloadHashAlgorithm,
  };
}

/**
 * Remove every description field from a publish payload for an explicitly
 * authorized empty-description publish. The caller must still bind and verify
 * an exact task authorization; this helper alone never grants permission.
 */
export function stripPublishPayloadDescriptions(payload) {
  if (!isPlainObject(payload)) {
    throw new DescriptionMaterialError('publish payload must be a plain object', {
      code: 'EMPTY_DESCRIPTION_PAYLOAD_INVALID',
    });
  }
  const next = JSON.parse(JSON.stringify(payload));
  delete next.multi_language_desc_list;
  for (const field of FORBIDDEN_DESCRIPTION_PAYLOAD_FIELDS) delete next[field];
  return next;
}

/**
 * Build the server-owned authorization marker after the approved image and
 * destination payload have been bound to the same task. Identity is derived
 * only from the persisted task; no client-supplied store/SKC/goods values are
 * trusted here.
 */
export function buildEmptyDescriptionAuthorization({
  task,
  payload = task?.openapiPublishPayload,
  baseTaskRevision,
  authorizedAt,
  authorizedByUser,
} = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new DescriptionMaterialError('empty-description authorization requires a task', {
      code: 'EMPTY_DESCRIPTION_TASK_INVALID',
    });
  }
  const taskId = String(task.id || '').trim();
  const intents = uniqueNonEmpty(task.intents);
  const writeStores = taskWriteStores(task);
  const {sourceStores, sourceSkc} = taskSourceIdentity(task);
  const standardGoodsNumbers = taskStandardGoodsNumbers(task);
  const imageBinding = task?.publishAssetBinding;
  const imageBindingFingerprint = String(imageBinding?.bindingFingerprint || '').toLowerCase();
  const at = String(authorizedAt || '').trim();
  const user = String(authorizedByUser || '').trim();
  if (!taskId) throw new DescriptionMaterialError('empty-description authorization requires taskId', {code: 'EMPTY_DESCRIPTION_TASK_ID_MISSING'});
  if (intents.length !== 1 || intents[0] !== 'copy_product_draft') throw new DescriptionMaterialError('empty-description authorization only supports a single copy_product_draft intent', {code: 'EMPTY_DESCRIPTION_INTENT_INVALID'});
  if (writeStores.length !== 1) throw new DescriptionMaterialError('empty-description authorization requires one exact target store', {code: 'EMPTY_DESCRIPTION_TARGET_STORE_INVALID'});
  if (sourceStores.length !== 1 || !sourceSkc) throw new DescriptionMaterialError('empty-description authorization requires one exact source store/SKC', {code: 'EMPTY_DESCRIPTION_SOURCE_IDENTITY_INVALID'});
  if (standardGoodsNumbers.length !== 1) throw new DescriptionMaterialError('empty-description authorization requires one exact standardGoodsSn', {code: 'EMPTY_DESCRIPTION_STANDARD_GOODS_INVALID'});
  if (!Number.isSafeInteger(Number(baseTaskRevision)) || Number(baseTaskRevision) <= 0) throw new DescriptionMaterialError('empty-description authorization requires a positive baseTaskRevision', {code: 'EMPTY_DESCRIPTION_REVISION_INVALID'});
  if (!Number.isFinite(Date.parse(at)) || !user) throw new DescriptionMaterialError('empty-description authorization requires authorizedAt/authorizedByUser', {code: 'EMPTY_DESCRIPTION_ACTOR_INVALID'});
  if (imageBinding?.sourceApproved !== true || String(imageBinding?.authority || '') !== 'human_reviewed_source' || !SHA256_RE.test(imageBindingFingerprint)) {
    throw new DescriptionMaterialError('empty-description authorization requires an exact approved image binding fingerprint', {code: 'EMPTY_DESCRIPTION_IMAGE_BINDING_INVALID'});
  }
  if (!isPlainObject(payload) || descriptionPayloadFields(payload).length) {
    throw new DescriptionMaterialError('empty-description authorization payload must omit every description field', {code: 'EMPTY_DESCRIPTION_PAYLOAD_NOT_EMPTY'});
  }
  const payloadHash = sha256StableJson(payload);
  const base = {
    schemaVersion: EMPTY_DESCRIPTION_AUTHORIZATION_SCHEMA_VERSION,
    kind: 'copy_product_draft',
    mode: EMPTY_DESCRIPTION_MODE,
    authority: EMPTY_DESCRIPTION_AUTHORITY,
    taskId,
    targetStore: writeStores[0],
    sourceStore: sourceStores[0],
    sourceSkc,
    standardGoodsSn: standardGoodsNumbers[0],
    baseTaskRevision: Number(baseTaskRevision),
    authorizedAt: at,
    authorizedByUser: user,
    imageBindingFingerprint,
    payloadHash,
    payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  };
  return {
    ...base,
    authorizationRequestKey: sha256StableJson(emptyDescriptionAuthorizationRequestScope(base)),
  };
}

export function validateEmptyDescriptionAuthorization(task, payload) {
  const blockers = [];
  const authorization = task?.emptyDescriptionAuthorization;
  const payloadSummary = describePublishPayloadDescription(payload);
  if (!isPlainObject(authorization)) {
    return {
      ok: false,
      blockers: ['任务缺少 emptyDescriptionAuthorization；空描述仅在用户明确授权并精确绑定当前任务时允许。'],
      summary: payloadSummary,
      authorization: null,
    };
  }
  if (JSON.stringify(Object.keys(authorization).sort()) !== JSON.stringify(EMPTY_DESCRIPTION_AUTHORIZATION_KEYS)) {
    blockers.push(`emptyDescriptionAuthorization 字段必须严格等于 ${EMPTY_DESCRIPTION_AUTHORIZATION_KEYS.join('/')}。`);
  }
  if (authorization.schemaVersion !== EMPTY_DESCRIPTION_AUTHORIZATION_SCHEMA_VERSION) blockers.push('emptyDescriptionAuthorization.schemaVersion 无效。');
  if (authorization.kind !== 'copy_product_draft' || authorization.mode !== EMPTY_DESCRIPTION_MODE || authorization.authority !== EMPTY_DESCRIPTION_AUTHORITY) {
    blockers.push('emptyDescriptionAuthorization 缺少受控 copy_product_draft / explicit_user_instruction / empty 标记。');
  }
  if (String(authorization.taskId || '') !== String(task?.id || '')) blockers.push('emptyDescriptionAuthorization.taskId 与当前任务不一致。');
  const intents = uniqueNonEmpty(task?.intents);
  if (intents.length !== 1 || intents[0] !== 'copy_product_draft') blockers.push('emptyDescriptionAuthorization 只能用于单一 copy_product_draft intent。');
  if (task?.descriptionMaterialBinding) blockers.push('emptyDescriptionAuthorization 不得与 descriptionMaterialBinding 并存。');
  const fields = descriptionPayloadFields(payload);
  if (fields.length) blockers.push(`空描述 payload 必须完全省略描述字段（当前 ${fields.join('/')}）。`);
  const writeStores = taskWriteStores(task);
  if (writeStores.length !== 1 || String(authorization.targetStore || '') !== writeStores[0]) blockers.push('emptyDescriptionAuthorization.targetStore 与任务唯一写入店不一致。');
  const {sourceStores, sourceSkc} = taskSourceIdentity(task);
  if (sourceStores.length !== 1 || String(authorization.sourceStore || '') !== sourceStores[0] || String(authorization.sourceSkc || '') !== sourceSkc) {
    blockers.push('emptyDescriptionAuthorization 源店/sourceSkc 与任务精确来源锁不一致。');
  }
  const goodsNumbers = taskStandardGoodsNumbers(task);
  if (goodsNumbers.length !== 1 || String(authorization.standardGoodsSn || '') !== goodsNumbers[0]) blockers.push('emptyDescriptionAuthorization.standardGoodsSn 与任务发布准备锁不一致。');
  if (!Number.isSafeInteger(Number(authorization.baseTaskRevision)) || Number(authorization.baseTaskRevision) <= 0) blockers.push('emptyDescriptionAuthorization.baseTaskRevision 必须是正安全整数。');
  if (!String(authorization.authorizedByUser || '').trim() || !Number.isFinite(Date.parse(String(authorization.authorizedAt || '')))) blockers.push('emptyDescriptionAuthorization 缺少有效 authorizedAt/authorizedByUser。');
  const imageFingerprint = String(task?.publishAssetBinding?.bindingFingerprint || '').toLowerCase();
  if (!SHA256_RE.test(String(authorization.imageBindingFingerprint || '')) || String(authorization.imageBindingFingerprint || '').toLowerCase() !== imageFingerprint) {
    blockers.push('emptyDescriptionAuthorization.imageBindingFingerprint 与当前已审图片绑定不一致。');
  }
  // Lock the persisted reviewed task. The executor separately locks its
  // normalized submission payload and must still omit all description fields.
  const taskPayload = task?.openapiPublishPayload;
  if (!isPlainObject(taskPayload) || descriptionPayloadFields(taskPayload).length) {
    blockers.push('任务 openapiPublishPayload 必须存在且完全省略描述字段。');
  }
  const actualPayloadHash = isPlainObject(taskPayload) ? sha256StableJson(taskPayload) : '';
  if (authorization.payloadHashAlgorithm !== DESCRIPTION_PAYLOAD_HASH_ALGORITHM
    || !SHA256_RE.test(String(authorization.payloadHash || ''))
    || String(authorization.payloadHash || '').toLowerCase() !== actualPayloadHash) {
    blockers.push('emptyDescriptionAuthorization.payloadHash 与当前任务 openapiPublishPayload 不一致。');
  }
  const expectedRequestKey = sha256StableJson(emptyDescriptionAuthorizationRequestScope(authorization));
  if (!SHA256_RE.test(String(authorization.authorizationRequestKey || ''))
    || String(authorization.authorizationRequestKey || '').toLowerCase() !== expectedRequestKey) {
    blockers.push('emptyDescriptionAuthorization.authorizationRequestKey 自洽性校验失败。');
  }
  return {
    ok: blockers.length === 0,
    blockers,
    summary: payloadSummary,
    authorization: {
      taskId: String(authorization.taskId || ''),
      targetStore: String(authorization.targetStore || ''),
      sourceStore: String(authorization.sourceStore || ''),
      sourceSkc: String(authorization.sourceSkc || ''),
      standardGoodsSn: String(authorization.standardGoodsSn || ''),
      baseTaskRevision: Number(authorization.baseTaskRevision || 0),
      imageBindingFingerprint: String(authorization.imageBindingFingerprint || ''),
      payloadHash: String(authorization.payloadHash || ''),
      authorizationRequestKey: String(authorization.authorizationRequestKey || ''),
    },
  };
}

/**
 * One policy gate for copy_product_draft descriptions. Reviewed descriptions
 * remain mandatory by default. A valid empty marker is a narrow alternative,
 * never a bypass for malformed/partial description rows or a stale binding.
 */
export function validateCopyProductDescriptionPolicy(task, payload) {
  const hasDescriptionField = descriptionPayloadFields(payload).length > 0;
  const hasBinding = isPlainObject(task?.descriptionMaterialBinding);
  const hasEmptyAuthorization = isPlainObject(task?.emptyDescriptionAuthorization);
  if (hasDescriptionField || hasBinding) {
    const payloadGate = validatePublishPayloadDescription(payload);
    const bindingGate = validateDescriptionBindingLock(task, payload);
    const blockers = [...payloadGate.blockers, ...bindingGate.blockers];
    if (hasEmptyAuthorization) blockers.push('emptyDescriptionAuthorization 不得与描述字段或 descriptionMaterialBinding 并存。');
    return {
      ok: blockers.length === 0,
      mode: 'reviewed_material',
      blockers,
      summary: payloadGate.summary,
      authorization: null,
    };
  }
  if (hasEmptyAuthorization) {
    const gate = validateEmptyDescriptionAuthorization(task, payload);
    return {...gate, mode: 'explicit_empty'};
  }
  const payloadGate = validatePublishPayloadDescription(payload);
  const bindingGate = validateDescriptionBindingLock(task, payload);
  return {
    ok: false,
    mode: 'blocked',
    blockers: [...payloadGate.blockers, ...bindingGate.blockers],
    summary: payloadGate.summary,
    authorization: null,
  };
}

// DOCX is intentionally handled here instead of through a general-purpose
// office converter.  prepare-descriptions accepts one narrow, text-only
// OOXML shape, so a bounded ZIP reader plus a strict XML tokenizer gives us a
// deterministic/fail-closed boundary without adding a large dependency.
const DOCX_MAX_ZIP_ENTRIES = 128;
const DOCX_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const DOCX_MAX_XML_TOKENS = 200_000;
const DOCX_MAX_XML_DEPTH = 64;
const DOCX_MAX_PARAGRAPHS = 5_000;
const DOCX_MAX_EXTRACTED_TEXT_CHARS = 1_000_000;
const DOCX_FIXED_STYLE_SEQUENCE = Object.freeze([
  'TitleEN', 'TitleAR',
  ...Array.from({length: DESCRIPTION_LINE_COUNT}, () => 'SellingPointEN'),
  ...Array.from({length: DESCRIPTION_LINE_COUNT}, () => 'SellingPointAR'),
  ...Array.from({length: DESCRIPTION_LINE_COUNT}, () => 'SellingPointZH'),
]);
const DOCX_FIXED_MARKERS = Object.freeze({
  titleEn: 'TITLE_EN',
  titleAr: 'TITLE_AR',
  sellingEn: 'SELLING_POINTS_EN',
  sellingAr: 'SELLING_POINTS_AR',
  sellingZh: 'SELLING_POINTS_ZH_CN',
});
const DOCX_FORBIDDEN_ENTRY_RE = /(?:^|\/)(?:vbaProject\.bin|embeddings|activeX|externalLinks|macros)(?:\/|$)|\.(?:bin|exe|ole|oleobject)$/i;
const DOCX_FORBIDDEN_XML_RE = /(?:vbaProject|oleObject|embeddedPackage|externalLink|attachedTemplate|altChunk|AlternateContent)/i;
const DOCX_IGNORED_BINARY_ENTRIES = new Set(['docProps/thumbnail.jpeg']);
const DOCX_FORBIDDEN_WORD_TAGS = new Set([
  'w:altChunk',
  'w:customXml',
  'w:del',
  'w:drawing',
  'w:fldChar',
  'w:fldSimple',
  'w:hyperlink',
  'w:ins',
  'w:instrText',
  'w:moveFrom',
  'w:moveTo',
  'w:object',
  'w:pict',
  'w:sdt',
  'w:subDoc',
  'w:tbl',
]);
const DOCX_REVIEWED_V3_ALLOWED_WORD_TAGS = new Set([
  'w:b', 'w:body', 'w:bottom', 'w:br', 'w:color', 'w:cols', 'w:docGrid', 'w:document',
  'w:end', 'w:footerReference', 'w:gridCol', 'w:headerReference', 'w:jc', 'w:p', 'w:pgMar',
  'w:pgSz', 'w:pPr', 'w:pStyle', 'w:r', 'w:rFonts', 'w:rPr', 'w:sectPr', 'w:shd',
  'w:spacing', 'w:start', 'w:sz', 'w:t', 'w:tbl', 'w:tblGrid', 'w:tblLayout', 'w:tblLook',
  'w:tblPr', 'w:tblStyle', 'w:tblW', 'w:tc', 'w:tcMar', 'w:tcPr', 'w:tcW', 'w:top',
  'w:tr', 'w:vAlign',
]);

function docxError(message, code = 'DESCRIPTION_DOCX_INVALID', details = {}) {
  return new DescriptionMaterialError(message, {code, details});
}

function assertDocxBuffer(sourceFileBytes) {
  if (!Buffer.isBuffer(sourceFileBytes) && !(sourceFileBytes instanceof Uint8Array)) {
    throw docxError('DOCX source file bytes are required', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  const bytes = Buffer.from(sourceFileBytes);
  if (!bytes.length) throw docxError('DOCX source file is empty', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  return bytes;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readZipUInt16(bytes, offset, label) {
  if (offset < 0 || offset + 2 > bytes.length) throw docxError(`DOCX ZIP ${label} 超出文件边界`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  return bytes.readUInt16LE(offset);
}

function readZipUInt32(bytes, offset, label) {
  if (offset < 0 || offset + 4 > bytes.length) throw docxError(`DOCX ZIP ${label} 超出文件边界`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  return bytes.readUInt32LE(offset);
}

function decodeZipEntryName(bytes, offset, length) {
  if (!length || offset < 0 || offset + length > bytes.length) {
    throw docxError('DOCX ZIP entry name is invalid', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  let name;
  try {
    name = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset, offset + length));
  } catch {
    throw docxError('DOCX ZIP entry name is not valid UTF-8', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  const pathName = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!pathName || name.includes('\u0000') || name.includes('\\') || name.startsWith('/')
    || pathName.split('/').some(part => !part || part === '.' || part === '..')) {
    throw docxError(`DOCX ZIP entry path is not a safe relative name: ${name || '(empty)'}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  if (DOCX_FORBIDDEN_ENTRY_RE.test(name)) {
    throw docxError(`DOCX 包含禁止的宏/嵌入对象成员：${name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
  }
  if (!name.endsWith('/') && !/\.xml$/i.test(name) && !/\.rels$/i.test(name)
    && !DOCX_IGNORED_BINARY_ENTRIES.has(name)) {
    throw docxError(`DOCX 只接受纯 XML OOXML 成员，发现非 XML 成员：${name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
  }
  return name;
}

function unzipOrdinaryDocx(sourceFileBytes) {
  const bytes = assertDocxBuffer(sourceFileBytes);
  if (bytes.length < 22) throw docxError('DOCX ZIP 末尾记录缺失', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readZipUInt32(bytes, offset, 'EOCD signature') === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw docxError('DOCX ZIP EOCD 记录缺失或损坏', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  const diskNumber = readZipUInt16(bytes, eocdOffset + 4, 'disk number');
  const centralDisk = readZipUInt16(bytes, eocdOffset + 6, 'central disk number');
  const diskEntries = readZipUInt16(bytes, eocdOffset + 8, 'disk entry count');
  const totalEntries = readZipUInt16(bytes, eocdOffset + 10, 'entry count');
  const centralSize = readZipUInt32(bytes, eocdOffset + 12, 'central directory size');
  const centralOffset = readZipUInt32(bytes, eocdOffset + 16, 'central directory offset');
  const commentLength = readZipUInt16(bytes, eocdOffset + 20, 'comment length');
  if (commentLength !== 0 || eocdOffset + 22 + commentLength !== bytes.length) {
    throw docxError('DOCX ZIP 包含不支持的注释或尾部数据', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries < 1 || totalEntries > DOCX_MAX_ZIP_ENTRIES) {
    throw docxError('DOCX ZIP 必须是单磁盘、非 ZIP64 的普通包', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  if ([centralSize, centralOffset].some(value => value === 0xffffffff)
    || centralOffset + centralSize !== eocdOffset || centralOffset < 0 || centralOffset > eocdOffset) {
    throw docxError('DOCX ZIP central directory 边界无效或使用了 ZIP64', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }

  const entries = new Map();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readZipUInt32(bytes, cursor, `central entry ${index} signature`) !== 0x02014b50) {
      throw docxError('DOCX ZIP central directory entry 损坏', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    const flags = readZipUInt16(bytes, cursor + 8, `central entry ${index} flags`);
    const method = readZipUInt16(bytes, cursor + 10, `central entry ${index} method`);
    const crc = readZipUInt32(bytes, cursor + 16, `central entry ${index} crc`);
    const compressedSize = readZipUInt32(bytes, cursor + 20, `central entry ${index} compressed size`);
    const uncompressedSize = readZipUInt32(bytes, cursor + 24, `central entry ${index} uncompressed size`);
    const nameLength = readZipUInt16(bytes, cursor + 28, `central entry ${index} name length`);
    const extraLength = readZipUInt16(bytes, cursor + 30, `central entry ${index} extra length`);
    const entryCommentLength = readZipUInt16(bytes, cursor + 32, `central entry ${index} comment length`);
    const localOffset = readZipUInt32(bytes, cursor + 42, `central entry ${index} local offset`);
    if (flags & 0x0001 || flags & 0x0008 || flags & 0x0040 || flags & 0x2000
      || [compressedSize, uncompressedSize, localOffset].some(value => value === 0xffffffff)) {
      throw docxError('DOCX ZIP 使用了加密、数据描述符或 ZIP64，拒绝解析', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    if (cursor + recordLength > eocdOffset) throw docxError('DOCX ZIP central directory 截断', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    const name = decodeZipEntryName(bytes, cursor + 46, nameLength);
    if (entries.has(name)) throw docxError(`DOCX ZIP 存在重复成员：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    if (uncompressedSize > DOCX_MAX_UNCOMPRESSED_BYTES || totalUncompressed + uncompressedSize > DOCX_MAX_UNCOMPRESSED_BYTES) {
      throw docxError('DOCX 解压后内容超过受控大小上限', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    if (localOffset + 30 > bytes.length || readZipUInt32(bytes, localOffset, `${name} local signature`) !== 0x04034b50) {
      throw docxError(`DOCX ZIP local header 损坏：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    const localFlags = readZipUInt16(bytes, localOffset + 6, `${name} local flags`);
    const localMethod = readZipUInt16(bytes, localOffset + 8, `${name} local method`);
    const localCompressedSize = readZipUInt32(bytes, localOffset + 18, `${name} local compressed size`);
    const localUncompressedSize = readZipUInt32(bytes, localOffset + 22, `${name} local uncompressed size`);
    const localNameLength = readZipUInt16(bytes, localOffset + 26, `${name} local name length`);
    const localExtraLength = readZipUInt16(bytes, localOffset + 28, `${name} local extra length`);
    if (localFlags !== flags || localMethod !== method || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
      || localNameLength !== nameLength) {
      throw docxError(`DOCX ZIP central/local header 不一致：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    const localName = decodeZipEntryName(bytes, localOffset + 30, localNameLength);
    if (localName !== name) throw docxError(`DOCX ZIP local member name 不一致：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > bytes.length || dataEnd > centralOffset) {
      throw docxError(`DOCX ZIP member 数据越界：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let content;
    try {
      if (method === 0) {
        if (compressedSize !== uncompressedSize) throw new Error('stored size mismatch');
        content = Buffer.from(compressed);
      } else if (method === 8) {
        content = inflateRawSync(compressed, {maxOutputLength: DOCX_MAX_UNCOMPRESSED_BYTES});
      } else {
        throw new Error(`unsupported compression method ${method}`);
      }
    } catch (error) {
      throw docxError(`DOCX ZIP member 无法可靠解压：${name}（${error?.message || 'invalid data'}）`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    if (content.length !== uncompressedSize || crc32(content) !== crc) {
      throw docxError(`DOCX ZIP member CRC/长度校验失败：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    if (name.endsWith('/')) {
      if (method !== 0 || compressedSize !== 0 || uncompressedSize !== 0 || content.length !== 0) {
        throw docxError(`DOCX ZIP directory entry 必须为空：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
      }
    } else {
      entries.set(name, content);
    }
    totalUncompressed += content.length;
    cursor += recordLength;
  }
  if (cursor !== eocdOffset) throw docxError('DOCX ZIP central directory 末尾不一致', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  return entries;
}

function decodeDocxXml(bytes, name) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw docxError(`DOCX XML 不是有效 UTF-8：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
}

function decodeXmlEntities(value, name) {
  const text = String(value || '');
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const amp = text.indexOf('&', cursor);
    if (amp < 0) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, amp);
    const semi = text.indexOf(';', amp + 1);
    if (semi < 0) throw docxError(`DOCX XML 实体未闭合：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    const entity = text.slice(amp + 1, semi);
    let decoded;
    if (entity === 'amp') decoded = '&';
    else if (entity === 'lt') decoded = '<';
    else if (entity === 'gt') decoded = '>';
    else if (entity === 'quot') decoded = '"';
    else if (entity === 'apos') decoded = "'";
    else if (/^#x[0-9a-f]+$/i.test(entity)) decoded = String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    else if (/^#[0-9]+$/.test(entity)) decoded = String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    else throw docxError(`DOCX XML 包含未知实体：&${entity};`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    if (!decoded || decoded.codePointAt(0) === 0 || decoded.codePointAt(0) > 0x10ffff) {
      throw docxError(`DOCX XML 实体 code point 无效：&${entity};`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    result += decoded;
    cursor = semi + 1;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) {
    throw docxError(`DOCX XML 包含非法控制字符：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  return result;
}

function xmlNameEnd(text, start) {
  let end = start;
  while (end < text.length && /[A-Za-z0-9_.:-]/.test(text[end])) end += 1;
  if (end === start || !/[A-Za-z_:]/.test(text[start])) return -1;
  return end;
}

function parseXmlStartTag(content, name) {
  let cursor = 0;
  while (/\s/.test(content[cursor] || '')) cursor += 1;
  const nameEnd = xmlNameEnd(content, cursor);
  if (nameEnd < 0) throw docxError(`DOCX XML 起始标签无效：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  const tagName = content.slice(cursor, nameEnd);
  cursor = nameEnd;
  const attrs = {};
  while (cursor < content.length) {
    while (/\s/.test(content[cursor] || '')) cursor += 1;
    if (cursor >= content.length) break;
    const attrEnd = xmlNameEnd(content, cursor);
    if (attrEnd < 0) throw docxError(`DOCX XML 属性名无效：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    const attrName = content.slice(cursor, attrEnd);
    cursor = attrEnd;
    while (/\s/.test(content[cursor] || '')) cursor += 1;
    if (content[cursor] !== '=') throw docxError(`DOCX XML 属性缺少等号：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    cursor += 1;
    while (/\s/.test(content[cursor] || '')) cursor += 1;
    const quote = content[cursor];
    if (quote !== '"' && quote !== "'") throw docxError(`DOCX XML 属性必须使用引号：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    cursor += 1;
    const valueStart = cursor;
    while (cursor < content.length && content[cursor] !== quote) cursor += 1;
    if (cursor >= content.length) throw docxError(`DOCX XML 属性值未闭合：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    if (Object.hasOwn(attrs, attrName)) throw docxError(`DOCX XML 存在重复属性：${attrName}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    attrs[attrName] = decodeXmlEntities(content.slice(valueStart, cursor), name);
    cursor += 1;
  }
  return {name: tagName, attrs};
}

function tokenizeStrictXml(xml, name) {
  const source = String(xml || '');
  const tokens = [];
  const pushToken = token => {
    if (tokens.length >= DOCX_MAX_XML_TOKENS) {
      throw docxError(`DOCX XML token 数超过上限：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    tokens.push(token);
  };
  let cursor = 0;
  let rootSeen = false;
  const stack = [];
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const end = next < 0 ? source.length : next;
      const text = decodeXmlEntities(source.slice(cursor, end), name);
      if (text) pushToken({type: 'text', text});
      cursor = end;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0) throw docxError(`DOCX XML 注释未闭合：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', cursor)) {
      const end = source.indexOf('?>', cursor + 2);
      if (end < 0 || stack.length || rootSeen || !/^<\?xml\b/i.test(source.slice(cursor, end + 2))) {
        throw docxError(`DOCX XML 处理指令不被允许：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('<!', cursor)) {
      throw docxError(`DOCX XML 禁止 DOCTYPE/CDATA/实体声明：${name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
    }
    if (source.startsWith('</', cursor)) {
      const end = source.indexOf('>', cursor + 2);
      if (end < 0) throw docxError(`DOCX XML 结束标签未闭合：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
      const closing = source.slice(cursor + 2, end).trim();
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(closing) || stack.at(-1) !== closing) {
        throw docxError(`DOCX XML 标签嵌套不合法：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
      }
      stack.pop();
      pushToken({type: 'end', name: closing});
      cursor = end + 1;
      continue;
    }
    let end = cursor + 1;
    let quote = '';
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= source.length || quote) throw docxError(`DOCX XML 起始标签未闭合：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    let content = source.slice(cursor + 1, end);
    const selfClosing = /\/\s*$/.test(content);
    if (selfClosing) content = content.replace(/\/\s*$/, '');
    const parsed = parseXmlStartTag(content, name);
    if (!rootSeen) rootSeen = true;
    if (stack.length >= DOCX_MAX_XML_DEPTH) {
      throw docxError(`DOCX XML 嵌套深度超过上限：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    }
    stack.push(parsed.name);
    pushToken({type: 'start', name: parsed.name, attrs: parsed.attrs});
    if (selfClosing) {
      stack.pop();
      pushToken({type: 'end', name: parsed.name});
    }
    cursor = end + 1;
  }
  if (!rootSeen || stack.length) throw docxError(`DOCX XML 根节点/闭合标签缺失：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  return tokens;
}

function parseWordDocumentParagraphs(documentXml) {
  const tokens = tokenizeStrictXml(documentXml, 'word/document.xml');
  const stack = [];
  const paragraphs = [];
  let bodySeen = false;
  let bodyOpen = false;
  let paragraph = null;
  for (const token of tokens) {
    if (token.type === 'text') {
      if (stack.at(-1) === 'w:t' && paragraph) paragraph.text += token.text;
      else if (token.text.trim()) throw docxError('DOCX 固定结构之外出现正文文本', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      continue;
    }
    if (token.type === 'start') {
      const parent = stack.at(-1) || '';
      if (token.name.includes(':') && !token.name.startsWith('w:') && !token.name.startsWith('xml:')) {
        throw docxError(`DOCX 使用了不受控的 WordprocessingML 命名空间：${token.name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
      }
      if (DOCX_FORBIDDEN_WORD_TAGS.has(token.name)) {
        throw docxError(`DOCX 包含禁止的对象/字段结构：${token.name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
      }
      if (!stack.length && token.name !== 'w:document') throw docxError('DOCX document.xml 根节点必须是 w:document', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      if (token.name === 'w:body') {
        if (parent !== 'w:document' || bodySeen) throw docxError('DOCX 必须恰有一个直接 w:body', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        bodySeen = true;
        bodyOpen = true;
      } else if (token.name === 'w:p') {
        if (!bodyOpen || parent !== 'w:body' || paragraph) throw docxError('DOCX 卖点必须是 w:body 的直接段落', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        paragraph = {style: '', text: ''};
      } else if (token.name === 'w:pStyle') {
        if (!paragraph || parent !== 'w:pPr' || paragraph.style) throw docxError('DOCX 每个段落只能有一个直接 w:pStyle', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        paragraph.style = String(token.attrs['w:val'] ?? token.attrs.val ?? '');
        if (!paragraph.style) throw docxError('DOCX w:pStyle 缺少 w:val', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      } else if (token.name === 'w:t') {
        if (!paragraph || parent !== 'w:r') throw docxError('DOCX 文本必须位于 w:r/w:t', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      } else if (token.name === 'w:sectPr') {
        if (!bodyOpen || parent !== 'w:body' || paragraph) throw docxError('DOCX w:sectPr 位置不符合固定结构', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      } else if (paragraph && ['w:tab', 'w:br', 'w:cr'].includes(token.name)) {
        throw docxError('DOCX 段落不得包含 tab/换行控制节点', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      }
      stack.push(token.name);
      continue;
    }
    const expected = stack.pop();
    if (expected !== token.name) throw docxError('DOCX XML 标签栈不一致', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    if (token.name === 'w:p') {
      if (!paragraph) throw docxError('DOCX 结束了不存在的段落', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      paragraphs.push(paragraph);
      paragraph = null;
    } else if (token.name === 'w:body') {
      bodyOpen = false;
    }
  }
  if (!bodySeen || paragraph || stack.length) throw docxError('DOCX document.xml 缺少完整 w:body', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  return paragraphs;
}

function parseReviewedV3WordDocumentParagraphs(documentXml) {
  const tokens = tokenizeStrictXml(documentXml, 'word/document.xml');
  const stack = [];
  const paragraphs = [];
  let bodySeen = false;
  let paragraph = null;
  let extractedTextChars = 0;
  for (const token of tokens) {
    if (token.type === 'text') {
      if (paragraph && stack.at(-1) === 'w:t') paragraph.lines.at(-1).text += token.text;
      else if (token.text.trim()) throw docxError('DOCX V3 固定结构之外出现正文文本', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      continue;
    }
    if (token.type === 'start') {
      if (!DOCX_REVIEWED_V3_ALLOWED_WORD_TAGS.has(token.name)) {
        throw docxError(`DOCX V3 包含未批准的 WordprocessingML 标签：${token.name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
      }
      if (!stack.length && token.name !== 'w:document') {
        throw docxError('DOCX V3 document.xml 根节点必须是 w:document', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      }
      if (token.name === 'w:body') {
        if (stack.at(-1) !== 'w:document' || bodySeen) throw docxError('DOCX V3 必须恰有一个 w:body', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        bodySeen = true;
      } else if (token.name === 'w:p') {
        if (paragraph) throw docxError('DOCX V3 不接受嵌套段落', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        if (paragraphs.length >= DOCX_MAX_PARAGRAPHS) {
          throw docxError('DOCX V3 段落数超过上限', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
        }
        paragraph = {style: '', lines: [{text: ''}], inTable: stack.includes('w:tbl')};
      } else if (token.name === 'w:pStyle' && paragraph && !paragraph.style) {
        paragraph.style = String(token.attrs['w:val'] ?? token.attrs.val ?? '');
      } else if (token.name === 'w:br' && paragraph) {
        paragraph.lines.push({text: ''});
      }
      stack.push(token.name);
      continue;
    }
    const expected = stack.pop();
    if (expected !== token.name) throw docxError('DOCX V3 XML 标签栈不一致', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
    if (token.name === 'w:p') {
      if (!paragraph) throw docxError('DOCX V3 结束了不存在的段落', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      // Keep physical line slots intact.  In particular, a reviewed copy box
      // with six slots where one is blank must not collapse to a seemingly
      // valid five-line material lock.
      const lines = paragraph.lines.map(row => row.text);
      extractedTextChars += lines.reduce((sum, line) => sum + line.length, 0);
      if (extractedTextChars > DOCX_MAX_EXTRACTED_TEXT_CHARS) {
        throw docxError('DOCX V3 提取文本超过上限', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
      }
      if (lines.some(line => line !== '')) {
        paragraphs.push({style: paragraph.style, lines, text: lines.join('\n'), inTable: paragraph.inTable});
      }
      paragraph = null;
    }
  }
  if (!bodySeen || paragraph || stack.length) throw docxError('DOCX V3 document.xml 缺少完整 w:body', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  return paragraphs;
}

function oneReviewedV3RowIndex(rows, predicate, label) {
  const indexes = rows.map((row, index) => predicate(row) ? index : -1).filter(index => index >= 0);
  if (indexes.length !== 1) throw docxError(`DOCX V3 ${label} 必须恰好出现一次（当前 ${indexes.length}）`, 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  return indexes[0];
}

function extractReviewedV3DocxStructure(documentXml) {
  const rows = parseReviewedV3WordDocumentParagraphs(documentXml);
  const titleStart = oneReviewedV3RowIndex(rows, row => /^Main Title 3(?:｜|\|)/.test(row.text), 'Main Title 3');
  const titleEnd = rows.findIndex((row, index) => index > titleStart && row.text === '首测标题');
  if (titleEnd < 0) throw docxError('DOCX V3 Main Title 3 后缺少首测标题边界', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  if (titleEnd <= titleStart) throw docxError('DOCX V3 Main Title 3 边界顺序无效', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  const titleRows = rows.slice(titleStart, titleEnd);
  const englishScore = oneReviewedV3RowIndex(titleRows, row => row.text === '英文评分', 'Main Title 3 英文评分');
  const arabicMeaning = oneReviewedV3RowIndex(titleRows, row => row.text === '阿文中文释义', 'Main Title 3 阿文中文释义');
  const englishTitle = nonEmptyDocxLine(titleRows[englishScore + 2]?.text, 'Main Title 3 English');
  const arabicTitle = nonEmptyDocxLine(titleRows[arabicMeaning + 2]?.text, 'Main Title 3 Arabic');
  if (!/^[\x20-\x7e]+$/.test(englishTitle) || englishTitle.length < 80 || !/[\u0600-\u06ff]/.test(arabicTitle) || arabicTitle.length < 60) {
    throw docxError('DOCX V3 Main Title 3 英文/阿文固定位置或语言特征无效', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  }

  const sellingStart = oneReviewedV3RowIndex(rows, row => row.text === '9. 三语核心卖点', '三语核心卖点章节');
  const sellingEnd = oneReviewedV3RowIndex(rows, row => /^10\. /.test(row.text), '三语核心卖点结束边界');
  if (sellingEnd <= sellingStart) throw docxError('DOCX V3 三语核心卖点边界顺序无效', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  const sellingRows = rows.slice(sellingStart, sellingEnd);
  const englishIntro = oneReviewedV3RowIndex(sellingRows, row => row.text.startsWith('英文卖点评分：'), '英文卖点说明');
  const arabicIntro = oneReviewedV3RowIndex(sellingRows, row => row.text.startsWith('阿文卖点评分：'), '阿文卖点说明');
  const chineseIntro = oneReviewedV3RowIndex(sellingRows, row => row.text.startsWith('中文仅用于内部核对'), '中文卖点说明');
  const extractFive = (index, language) => {
    const copyBox = sellingRows[index + 1];
    const lines = copyBox?.lines || [];
    if (copyBox?.inTable !== true || lines.length !== DESCRIPTION_LINE_COUNT
      || lines.some(line => !line || line.trim() !== line || line.includes('\r') || line.includes('\n'))) {
      throw docxError(`DOCX V3 ${language} 卖点必须在固定复制框内恰好5行`, 'DESCRIPTION_DOCX_SELLING_POINTS_REQUIRED');
    }
    return [...lines];
  };
  return {
    title: {en: englishTitle, ar: arabicTitle},
    en: {lines: extractFive(englishIntro, '英文')},
    ar: {lines: extractFive(arabicIntro, '阿文')},
    'zh-cn': {lines: extractFive(chineseIntro, '中文')},
  };
}

function nonEmptyDocxLine(value, label) {
  const line = String(value ?? '');
  if (!line || !line.trim() || line.includes('\r') || line.includes('\n')) {
    throw docxError(`DOCX ${label} 必须是单个非空文本行`, 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
  }
  return line;
}

function extractFixedDocxStructure(paragraphs) {
  const styleMatches = paragraphs.length === DOCX_FIXED_STYLE_SEQUENCE.length
    && paragraphs.every((row, index) => row.style === DOCX_FIXED_STYLE_SEQUENCE[index]);
  if (styleMatches) {
    return {
      title: {
        en: nonEmptyDocxLine(paragraphs[0].text, 'TitleEN'),
        ar: nonEmptyDocxLine(paragraphs[1].text, 'TitleAR'),
      },
      en: {lines: paragraphs.slice(2, 7).map((row, index) => nonEmptyDocxLine(row.text, `SellingPointEN[${index}]`))},
      ar: {lines: paragraphs.slice(7, 12).map((row, index) => nonEmptyDocxLine(row.text, `SellingPointAR[${index}]`))},
      'zh-cn': {lines: paragraphs.slice(12, 17).map((row, index) => nonEmptyDocxLine(row.text, `SellingPointZH[${index}]`))},
    };
  }
  const markerRows = paragraphs.map(row => ({...row, text: String(row.text || '')}));
  const markerAt = (index, value) => markerRows[index]?.style === '' && markerRows[index]?.text === value;
  if (markerAt(0, DOCX_FIXED_MARKERS.titleEn) && markerAt(2, DOCX_FIXED_MARKERS.titleAr)
    && markerAt(4, DOCX_FIXED_MARKERS.sellingEn) && markerAt(10, DOCX_FIXED_MARKERS.sellingAr)
    && markerAt(16, DOCX_FIXED_MARKERS.sellingZh)) {
    if (markerRows.length !== 22) throw docxError('DOCX 固定标题/卖点结构包含额外或缺失段落', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
    return {
      title: {
        en: nonEmptyDocxLine(markerRows[1].text, 'TITLE_EN'),
        ar: nonEmptyDocxLine(markerRows[3].text, 'TITLE_AR'),
      },
      en: {lines: markerRows.slice(5, 10).map((row, index) => nonEmptyDocxLine(row.text, `SELLING_POINTS_EN[${index}]`))},
      ar: {lines: markerRows.slice(11, 16).map((row, index) => nonEmptyDocxLine(row.text, `SELLING_POINTS_AR[${index}]`))},
      'zh-cn': {lines: markerRows.slice(17, 22).map((row, index) => nonEmptyDocxLine(row.text, `SELLING_POINTS_ZH_CN[${index}]`))},
    };
  }
  const titleOnly = paragraphs.length <= 4
    && paragraphs.some(row => /^Title(?:EN|AR)?$/.test(row.style) || Object.values(DOCX_FIXED_MARKERS).includes(row.text));
  if (titleOnly) {
    throw docxError('DOCX 只有标题或未提供完整双语卖点：必须有 ar/en/zh-cn 各5行，禁止生成/翻译', 'DESCRIPTION_DOCX_SELLING_POINTS_REQUIRED');
  }
  throw docxError('DOCX 未匹配固定 TitleEN/TitleAR + SellingPointEN/AR/ZH 结构，拒绝模糊解析', 'DESCRIPTION_DOCX_STRUCTURE_INVALID');
}

function assertOrdinaryDocxPackage(entries) {
  const required = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
  for (const name of required) if (!entries.has(name)) throw docxError(`DOCX 缺少必需 OOXML 成员：${name}`, 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  for (const [name, bytes] of entries) {
    if (DOCX_IGNORED_BINARY_ENTRIES.has(name)) continue;
    const xml = decodeDocxXml(bytes, name);
    if (DOCX_FORBIDDEN_XML_RE.test(xml) || /TargetMode\s*=\s*["']External["']/i.test(xml)
      || /\bTarget\s*=\s*["'](?:https?|file|ftp):/i.test(xml)) {
      throw docxError(`DOCX 包含宏、外链或嵌入对象关系：${name}`, 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
    }
    tokenizeStrictXml(xml, name);
  }
  const contentTypes = decodeDocxXml(entries.get('[Content_Types].xml'), '[Content_Types].xml');
  if (!/<(?:[A-Za-z_][\w.-]*:)?Types\b/i.test(contentTypes)
    || !/PartName\s*=\s*["']\/?word\/document\.xml["']/i.test(contentTypes)) {
    throw docxError('DOCX [Content_Types].xml 未声明 word/document.xml', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  const rootRels = decodeDocxXml(entries.get('_rels/.rels'), '_rels/.rels');
  if (!/Target\s*=\s*["'][^"']*document\.xml["']/i.test(rootRels)) {
    throw docxError('DOCX 根关系未指向 word/document.xml', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  return decodeDocxXml(entries.get('word/document.xml'), 'word/document.xml');
}

/**
 * Verifies a normal text-only OOXML .docx against the fixed reviewed-material
 * template. The title paragraphs are required as structure evidence, while
 * only the exact ar/en/zh-cn five-line rows enter the material schema.
 */
export function verifyDescriptionMaterialAgainstDocx(sourceFileBytes, options = {}) {
  const {material = null, sourceFileBasename = '', sourceFileSha256 = '', section = 'auto'} = options;
  if (String(section || 'auto').trim().toLowerCase() !== 'auto') {
    throw docxError('DOCX 资料不接受 HTML section 选择；请使用 --section auto', 'DESCRIPTION_DOCX_SECTION_INVALID');
  }
  const bytes = assertDocxBuffer(sourceFileBytes);
  const actualSha = sha256Bytes(bytes);
  const basename = String(sourceFileBasename || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!basename || !/\.docx$/i.test(basename) || basename !== String(sourceFileBasename || '').trim()) {
    throw docxError('DOCX sourceFileBasename 必须是普通 .docx basename', 'DESCRIPTION_DOCX_PACKAGE_INVALID');
  }
  const materialProvided = Boolean(material && typeof material === 'object' && !Array.isArray(material));
  const declaredSha = String(materialProvided ? (sourceFileSha256 || material.sourceFileSha256 || '') : (sourceFileSha256 || '')).toLowerCase();
  if ((materialProvided && !declaredSha) || (declaredSha && declaredSha !== actualSha)) {
    throw new DescriptionMaterialError(
      `sourceFileSha256 与用户提供的实际 DOCX 字节不符：声明=${declaredSha || '(missing)'} 实际=${actualSha}`,
      {code: 'DESCRIPTION_SOURCE_SHA_MISMATCH'},
    );
  }
  const documentXml = assertOrdinaryDocxPackage(unzipOrdinaryDocx(bytes));
  const reviewedV3 = documentXml.includes('Main Title 3') && documentXml.includes('9. 三语核心卖点');
  const extracted = reviewedV3
    ? extractReviewedV3DocxStructure(documentXml)
    : extractFixedDocxStructure(parseWordDocumentParagraphs(documentXml));
  const rows = {};
  for (const language of ['en', 'ar', 'zh-cn']) {
    rows[language] = {
      language,
      lines: [...extracted[language].lines],
      sha256: sha256Utf8(extracted[language].lines.join('\n')),
    };
  }
  if (materialProvided) {
    for (const language of ['en', 'ar', 'zh-cn']) {
      const expected = rows[language].lines;
      const actual = Array.isArray(material.rows?.[language]?.lines) ? material.rows[language].lines : null;
      if (!actual || actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
        throw new DescriptionMaterialError(
          `material rows.${language} 与 DOCX 固定卖点文本逐字不一致；禁止改写/翻译审核资料`,
          {code: 'DESCRIPTION_MATERIAL_MISMATCH_SOURCE'},
        );
      }
      const declaredRowSha = String(material.rows[language].sha256 || '').toLowerCase();
      if (declaredRowSha && declaredRowSha !== rows[language].sha256) {
        throw new DescriptionMaterialError(
          `material rows.${language}.sha256 与 DOCX 逐字行不符：声明=${declaredRowSha} 实际=${rows[language].sha256}`,
          {code: 'DESCRIPTION_MATERIAL_SHA_MISMATCH'},
        );
      }
    }
  }
  return {
    material: {schemaVersion: 1, sourceLabel: basename, sourceFileSha256: actualSha, rows},
    extracted,
    sectionUsed: 'docx',
  };
}

export function descriptionBindingRequestKey({
  taskId = '',
  targetStore = '',
  baseTaskRevision = 0,
  contentSha256 = '',
  sourceProof = '',
} = {}) {
  return sha256Utf8([
    String(taskId || ''),
    String(targetStore || '').toUpperCase(),
    String(Number(baseTaskRevision) || 0),
    String(contentSha256 || '').toLowerCase(),
    ...(String(sourceProof || '').trim() ? [String(sourceProof).trim()] : []),
  ].join('\n'));
}

function materialError(message, details = {}) {
  return new DescriptionMaterialError(message, {code: 'DESCRIPTION_MATERIAL_INVALID', details});
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateLanguageRow(row, language) {
  if (!isPlainObject(row)) throw materialError(`rows.${language} must be an object`);
  const keys = Object.keys(row).sort();
  if (keys.join(',') !== 'language,lines,sha256') {
    throw materialError(`rows.${language} must contain exactly language/lines/sha256`);
  }
  if (String(row.language ?? '') !== language) {
    throw materialError(`rows.${language}.language must equal "${language}"`);
  }
  const lines = row.lines;
  if (!Array.isArray(lines) || lines.length !== DESCRIPTION_LINE_COUNT) {
    throw materialError(`rows.${language}.lines must be exactly ${DESCRIPTION_LINE_COUNT} lines (received ${Array.isArray(lines) ? lines.length : 'not-an-array'})`);
  }
  const cleanedLines = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (typeof line !== 'string') {
      throw materialError(`rows.${language}.lines[${lineIndex}] must be a string`);
    }
    if (line.length === 0) {
      throw materialError(`rows.${language}.lines[${lineIndex}] is empty; material lines must be verbatim non-empty text`);
    }
    if (line.includes('\r') || line.includes('\n')) {
      throw materialError(`rows.${language}.lines[${lineIndex}] contains embedded CR/LF; split lines before declaring the material`);
    }
    if (HTML_RE.test(line)) {
      throw materialError(`rows.${language}.lines[${lineIndex}] contains HTML (angle brackets are not allowed)`);
    }
    if (EMOJI_RE.test(line)) {
      throw materialError(`rows.${language}.lines[${lineIndex}] contains emoji or surrogate characters, which SHEIN rejects`);
    }
    cleanedLines.push(line);
  }
  const joined = cleanedLines.join('\n');
  const declared = String(row.sha256 ?? '');
  if (!SHA256_RE.test(declared)) {
    throw materialError(`rows.${language}.sha256 must be a lowercase hex sha256`);
  }
  const actual = sha256Utf8(joined);
  if (declared.toLowerCase() !== actual) {
    throw materialError(`rows.${language}.sha256 does not match the joined UTF-8 lines (declared=${declared.toLowerCase()} actual=${actual})`);
  }
  return {
    language,
    lines: cleanedLines,
    sha256: declared.toLowerCase(),
  };
}

/**
 * Strict material JSON schema:
 *   {schemaVersion: 1, sourceLabel, sourceFileSha256,
 *    rows: {ar: {language, lines[5], sha256}, en: {...}, 'zh-cn': {...}}}
 *
 * Validation never trims, normalizes or rewrites line content. Allowed content
 * checks are exactly: line non-empty, no embedded CR/LF, no HTML, no
 * emoji/surrogates, and the declared joined UTF-8 sha256 must match.
 */
export function validateDescriptionMaterialJson(value, options = {}) {
  if (!isPlainObject(value)) throw materialError('description material must be a JSON object');
  if (value.schemaVersion !== DESCRIPTION_SCHEMA_VERSION) {
    throw materialError(`description material schemaVersion must equal ${DESCRIPTION_SCHEMA_VERSION}`);
  }
  const sourceLabel = String(value.sourceLabel ?? '');
  if (!sourceLabel || sourceLabel.length > 240) {
    throw materialError('description material sourceLabel must be a non-empty string of at most 240 characters');
  }
  if (sourceLabel.includes('/') || sourceLabel.includes('\\')) {
    throw materialError('description material sourceLabel must be a bare file name (basename), never a local path');
  }
  const sourceFileSha256 = String(value.sourceFileSha256 ?? '');
  if (!SHA256_RE.test(sourceFileSha256)) {
    throw materialError('description material sourceFileSha256 must be a lowercase hex sha256 of the reviewed source file');
  }
  if (options.sourceFileSha256 && String(options.sourceFileSha256).toLowerCase() !== sourceFileSha256.toLowerCase()) {
    throw materialError('description material sourceFileSha256 does not match the provided source file sha256');
  }
  const rows = value.rows;
  if (!isPlainObject(rows)) throw materialError('description material rows must be an object');
  const rowKeys = Object.keys(rows);
  if (rowKeys.length !== DESCRIPTION_ALL_LANGUAGES.length
    || !DESCRIPTION_ALL_LANGUAGES.every(language => rowKeys.includes(language))) {
    throw materialError(`description material rows must contain exactly ${DESCRIPTION_ALL_LANGUAGES.join('/')}`);
  }
  const normalizedRows = {};
  for (const language of DESCRIPTION_ALL_LANGUAGES) {
    normalizedRows[language] = validateLanguageRow(rows[language], language);
  }
  return {
    schemaVersion: DESCRIPTION_SCHEMA_VERSION,
    sourceLabel,
    sourceFileSha256: sourceFileSha256.toLowerCase(),
    rows: normalizedRows,
  };
}

/**
 * Verifies the material's sourceFileSha256 against the actual bytes of the
 * reviewed source file supplied by the user and forces sourceLabel to be the
 * bare file basename. Never trusts a self-declared hash or a local path.
 */
export function verifyDescriptionMaterialSourceFile(material, sourceFileBytes, {sourceFileBasename = ''} = {}) {
  if (!Buffer.isBuffer(sourceFileBytes) && !(sourceFileBytes instanceof Uint8Array)) {
    throw materialError('source file bytes are required to verify sourceFileSha256');
  }
  const actualSha = sha256Bytes(Buffer.from(sourceFileBytes));
  const declared = String(material?.sourceFileSha256 ?? '');
  if (declared.toLowerCase() !== actualSha) {
    throw new DescriptionMaterialError(
      `material sourceFileSha256 与用户提供的实际源文件字节不符：声明=${declared || '(missing)'} 实际=${actualSha}；请提供与 material 同一份审核资料源文件`,
      {code: 'DESCRIPTION_SOURCE_SHA_MISMATCH'},
    );
  }
  const basename = String(sourceFileBasename || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!basename) throw materialError('sourceFileBasename is required and must not be a path');
  return validateDescriptionMaterialJson({
    ...material,
    sourceLabel: basename,
    sourceFileSha256: actualSha,
  });
}

/**
 * Fixed publish rows: ar then en, each `{language, name}` where name is the
 * 5 verbatim lines joined with "\n" (never trimmed or rewritten). zh-cn never
 * enters the payload. Platform name limit (5000 characters) is enforced here.
 */
export function buildDescriptionPayloadRows(material) {
  const normalized = validateDescriptionMaterialJson(material);
  return DESCRIPTION_PUBLISH_LANGUAGES.map(language => {
    const name = normalized.rows[language].lines.join('\n');
    if (name.length > DESCRIPTION_NAME_MAX_CHARS) {
      throw new DescriptionMaterialError(
        `rows.${language} joined description exceeds ${DESCRIPTION_NAME_MAX_CHARS} characters (${name.length})`,
        {code: 'DESCRIPTION_NAME_TOO_LONG'},
      );
    }
    return {language, name};
  });
}

/**
 * Hash-only summary of the material. Never contains line text.
 */
export function describeDescriptionMaterial(material) {
  const normalized = validateDescriptionMaterialJson(material);
  const hashes = Object.fromEntries(
    DESCRIPTION_ALL_LANGUAGES.map(language => [language, normalized.rows[language].sha256]),
  );
  const contentSha256 = sha256Utf8(
    [normalized.sourceFileSha256, hashes.ar, hashes.en, hashes['zh-cn']].join('\n'),
  );
  return {
    schemaVersion: DESCRIPTION_SCHEMA_VERSION,
    sourceLabel: normalized.sourceLabel,
    sourceFileSha256: normalized.sourceFileSha256,
    contentSha256,
    languages: [...DESCRIPTION_ALL_LANGUAGES],
    publishLanguages: [...DESCRIPTION_PUBLISH_LANGUAGES],
    lineCounts: Object.fromEntries(
      DESCRIPTION_ALL_LANGUAGES.map(language => [language, DESCRIPTION_LINE_COUNT]),
    ),
    hashes,
  };
}

function descriptionRowsFromPayload(payload) {
  const list = Array.isArray(payload?.multi_language_desc_list)
    ? payload.multi_language_desc_list
    : [];
  return list
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      language: String(row.language ?? ''),
      name: String(row.name ?? ''),
    }))
    .filter(row => row.language);
}

function rawDescriptionRows(payload) {
  return Array.isArray(payload?.multi_language_desc_list)
    ? payload.multi_language_desc_list
    : [];
}

/**
 * Hash/count summary of the publish payload description section. No text.
 */
export function describePublishPayloadDescription(payload) {
  const rows = descriptionRowsFromPayload(payload);
  const lineCounts = {};
  const hashes = {};
  for (const row of rows) {
    lineCounts[row.language] = row.name === '' ? 0 : row.name.split('\n').length;
    hashes[row.language] = sha256Utf8(row.name);
  }
  return {
    descriptionCount: rows.length,
    descriptionLanguages: rows.map(row => row.language),
    descriptionLineCounts: lineCounts,
    descriptionHashes: hashes,
  };
}

function validatePayloadDescriptionName(name, language, blockers) {
  if (name.length === 0) {
    blockers.push(`multi_language_desc_list.${language} 描述为空。`);
    return;
  }
  if (name.includes('\r')) {
    blockers.push(`multi_language_desc_list.${language} 描述包含 CR。`);
  }
  if (HTML_RE.test(name)) {
    blockers.push(`multi_language_desc_list.${language} 描述包含 HTML（不允许尖括号）。`);
  }
  if (EMOJI_RE.test(name)) {
    blockers.push(`multi_language_desc_list.${language} 描述包含 emoji/代理项字符。`);
  }
  if (name.length > DESCRIPTION_NAME_MAX_CHARS) {
    blockers.push(`multi_language_desc_list.${language} 描述超过平台上限 ${DESCRIPTION_NAME_MAX_CHARS} 字符（当前 ${name.length}）。`);
  }
  const lines = name.split('\n');
  if (lines.length !== DESCRIPTION_LINE_COUNT || lines.some(line => line.length === 0)) {
    blockers.push(`multi_language_desc_list.${language} 必须是恰好${DESCRIPTION_LINE_COUNT}行且每行非空（当前 ${lines.length} 段）。`);
  }
}

/**
 * copy_product_draft publish payload gate: the final payload must contain
 * exactly ar and en descriptions, each exactly 5 lines, each within the
 * platform 5000-character limit. Nothing may be auto-mapped from source
 * productMultiDescList; only an explicit reviewed-material binding satisfies
 * this gate.
 */
export function validatePublishPayloadDescription(payload) {
  const blockers = [];
  const rawRows = rawDescriptionRows(payload);
  if (!Array.isArray(payload?.multi_language_desc_list)) {
    blockers.push('缺官方字段 multi_language_desc_list；不接受 camelCase 或其他描述字段替代。');
  }
  for (const field of FORBIDDEN_DESCRIPTION_PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, field)) {
      blockers.push(`发布 payload 禁止携带描述别名字段 ${field}；只允许官方 multi_language_desc_list。`);
    }
  }
  for (const [index, row] of rawRows.entries()) {
    if (!isPlainObject(row)) {
      blockers.push(`multi_language_desc_list[${index}] 必须是对象。`);
      continue;
    }
    const keys = Object.keys(row).sort();
    if (keys.join(',') !== 'language,name') {
      blockers.push(`multi_language_desc_list[${index}] 必须只包含 language/name。`);
    }
    if (typeof row.language !== 'string' || typeof row.name !== 'string') {
      blockers.push(`multi_language_desc_list[${index}] 的 language/name 必须是字符串。`);
    }
  }
  const rows = descriptionRowsFromPayload(payload);
  if (!rows.length) {
    blockers.push('缺 multi_language_desc_list：copy_product_draft 最终 publish payload 必须通过审核资料显式绑定 ar/en 各5行描述；禁止自动从源商品描述映射。');
    return {ok: false, blockers, summary: describePublishPayloadDescription(payload)};
  }
  const unknownLanguages = [...new Set(rows.map(row => row.language).filter(language => !DESCRIPTION_PUBLISH_LANGUAGES.includes(language)))];
  if (unknownLanguages.length) {
    blockers.push(`multi_language_desc_list 包含不允许的语言：${unknownLanguages.join('/')}（只允许 ar/en 两条）。`);
  }
  const arCount = rows.filter(row => row.language === 'ar').length;
  const enCount = rows.filter(row => row.language === 'en').length;
  if (rows.length !== 2 || arCount !== 1 || enCount !== 1) {
    blockers.push(`multi_language_desc_list 必须恰好是 ar+en 两条且各一条（当前共 ${rows.length} 条，ar=${arCount} en=${enCount}）。`);
  }
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const row = rows.find(entry => entry.language === language);
    if (row) validatePayloadDescriptionName(row.name, language, blockers);
  }
  return {ok: blockers.length === 0, blockers, summary: describePublishPayloadDescription(payload)};
}

/**
 * Locks the task's descriptionMaterialBinding hashes onto the final publish
 * payload before dry-run/execute. Passing the 5-line shape alone is not
 * enough: if the ar/en description bytes were rewritten after binding, the
 * per-language sha256 will differ and submission must be blocked.
 */
export function validateDescriptionBindingLock(task, payload) {
  const blockers = [];
  const payloadDescription = describePublishPayloadDescription(payload);
  const binding = task?.descriptionMaterialBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    blockers.push('任务缺少 descriptionMaterialBinding；禁止提交未由服务端核验实际审核 HTML 的描述。');
    return {ok: false, blockers, summary: payloadDescription};
  }
  const bindingKeys = Object.keys(binding).sort();
  if (JSON.stringify(bindingKeys) !== JSON.stringify(DESCRIPTION_BINDING_KEYS)) {
    blockers.push(`descriptionMaterialBinding 字段必须严格等于 ${DESCRIPTION_BINDING_KEYS.join('/')}，禁止额外或缺失 metadata。`);
  }
  const bindingHashes = binding.hashes && typeof binding.hashes === 'object' ? binding.hashes : {};
  if (binding.schemaVersion !== DESCRIPTION_SCHEMA_VERSION) {
    blockers.push(`descriptionMaterialBinding.schemaVersion 必须为 ${DESCRIPTION_SCHEMA_VERSION}。`);
  }
  if (binding.kind !== 'copy_product_draft' || binding.sourceApproved !== true || binding.authority !== 'human_reviewed_source') {
    blockers.push('descriptionMaterialBinding 缺少受控 copy_product_draft / human_reviewed_source 授权标记。');
  }
  if (![DESCRIPTION_SOURCE_PROOF, DESCRIPTION_SOURCE_PROOF_S9, DESCRIPTION_SOURCE_PROOF_DOCX].includes(binding.sourceProof)) {
    blockers.push(`descriptionMaterialBinding.sourceProof 必须为 ${DESCRIPTION_SOURCE_PROOF}、${DESCRIPTION_SOURCE_PROOF_S9} 或 ${DESCRIPTION_SOURCE_PROOF_DOCX}。`);
  }
  if (binding.payloadHashAlgorithm !== DESCRIPTION_PAYLOAD_HASH_ALGORITHM) {
    blockers.push(`descriptionMaterialBinding.payloadHashAlgorithm 必须为 ${DESCRIPTION_PAYLOAD_HASH_ALGORITHM}。`);
  }
  const sourceLabel = String(binding.sourceLabel || '');
  if (!sourceLabel || sourceLabel.includes('/') || sourceLabel.includes('\\')) {
    blockers.push('descriptionMaterialBinding.sourceLabel 必须是非空文件 basename。');
  }
  if (!Number.isSafeInteger(Number(binding.sourceByteLength)) || Number(binding.sourceByteLength) <= 0) {
    blockers.push('descriptionMaterialBinding.sourceByteLength 必须是正整数。');
  }
  if (!Number.isSafeInteger(Number(binding.baseTaskRevision)) || Number(binding.baseTaskRevision) <= 0) {
    blockers.push('descriptionMaterialBinding.baseTaskRevision 必须是正整数。');
  }
  if (!String(binding.boundByUser || '').trim() || !Number.isFinite(Date.parse(String(binding.boundAt || '')))) {
    blockers.push('descriptionMaterialBinding 必须包含有效 boundAt/boundByUser。');
  }
  const taskWriteStores = Array.isArray(task?.targets?.writeStores) && task.targets.writeStores.length
    ? task.targets.writeStores
    : Array.isArray(task?.targets?.stores)
      ? task.targets.stores
      : [];
  const normalizedWriteStores = [...new Set(taskWriteStores.map(value => String(value || '').trim().toUpperCase()).filter(Boolean))];
  const bindingTargetStore = String(binding.targetStore || '').trim().toUpperCase();
  if (normalizedWriteStores.length !== 1 || bindingTargetStore !== normalizedWriteStores[0]) {
    blockers.push(`descriptionMaterialBinding.targetStore 必须等于任务唯一写入店（binding=${bindingTargetStore || '(missing)'} task=${normalizedWriteStores.join('/') || '(empty)'}）。`);
  }
  if (JSON.stringify(binding.publishLanguages) !== JSON.stringify(DESCRIPTION_PUBLISH_LANGUAGES)) {
    blockers.push('descriptionMaterialBinding.publishLanguages 必须固定为 ar/en。');
  }
  const bindingLineCounts = isPlainObject(binding.lineCounts) ? binding.lineCounts : {};
  if (JSON.stringify(Object.keys(bindingLineCounts).sort()) !== JSON.stringify([...DESCRIPTION_ALL_LANGUAGES].sort())) {
    blockers.push('descriptionMaterialBinding.lineCounts 必须严格只含 ar/en/zh-cn。');
  }
  if (JSON.stringify(Object.keys(bindingHashes).sort()) !== JSON.stringify([...DESCRIPTION_ALL_LANGUAGES].sort())) {
    blockers.push('descriptionMaterialBinding.hashes 必须严格只含 ar/en/zh-cn。');
  }
  for (const language of DESCRIPTION_ALL_LANGUAGES) {
    if (Number(bindingLineCounts[language]) !== DESCRIPTION_LINE_COUNT) {
      blockers.push(`descriptionMaterialBinding.lineCounts.${language} 必须为 ${DESCRIPTION_LINE_COUNT}。`);
    }
    if (!SHA256_RE.test(String(bindingHashes[language] || ''))) {
      blockers.push(`descriptionMaterialBinding 缺少 ${language} 的有效绑定描述 hash。`);
    }
  }
  if (!SHA256_RE.test(String(binding.newPayloadHash || ''))) {
    blockers.push('descriptionMaterialBinding.newPayloadHash 缺失或格式无效。');
  }
  // Full-payload integrity belongs to the persisted binding; execution may
  // normalize supplier codes. Its description bytes remain pinned below, and
  // the executor locks the complete final payload in its confirmation scope.
  const taskPayload = task?.openapiPublishPayload;
  if (!isPlainObject(taskPayload)) {
    blockers.push('任务缺少绑定时的 openapiPublishPayload，无法核对 descriptionMaterialBinding.newPayloadHash。');
  } else {
    const actualBoundPayloadHash = sha256StableJson(taskPayload);
    if (String(binding.newPayloadHash || '').toLowerCase() !== actualBoundPayloadHash) {
      blockers.push(`descriptionMaterialBinding.newPayloadHash 与任务当前 openapiPublishPayload 不一致（binding=${String(binding.newPayloadHash || '') || '(missing)'} actual=${actualBoundPayloadHash}）。`);
    }
  }
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const expected = String(bindingHashes[language] || '').toLowerCase();
    const actual = String(payloadDescription.descriptionHashes?.[language] || '').toLowerCase();
    if (SHA256_RE.test(expected) && actual !== expected) {
      blockers.push(`发布 payload 的 ${language} 描述 hash 与审核资料绑定不一致（binding=${expected} payload=${actual || '(missing)'}）；禁止提交被改写后的描述。`);
    }
  }
  if (payloadDescription.descriptionCount !== 2) {
    blockers.push('发布 payload 描述必须恰好是 ar/en 两条。');
  }
  const sourceFileSha256 = String(binding.sourceFileSha256 || '').toLowerCase();
  const declaredContentSha = String(binding.contentSha256 || '').toLowerCase();
  if (!SHA256_RE.test(sourceFileSha256)) {
    blockers.push('descriptionMaterialBinding.sourceFileSha256 缺失或格式无效。');
  }
  if (!SHA256_RE.test(declaredContentSha)) {
    blockers.push('descriptionMaterialBinding.contentSha256 缺失或格式无效。');
  }
  if (SHA256_RE.test(sourceFileSha256)
    && SHA256_RE.test(declaredContentSha)
    && DESCRIPTION_ALL_LANGUAGES.every(language => SHA256_RE.test(String(bindingHashes[language] || '')))) {
    const recomputed = sha256Utf8([
      sourceFileSha256,
      String(bindingHashes.ar || '').toLowerCase(),
      String(bindingHashes.en || '').toLowerCase(),
      String(bindingHashes['zh-cn'] || '').toLowerCase(),
    ].join('\n'));
    if (recomputed !== declaredContentSha) {
      blockers.push('descriptionMaterialBinding contentSha256 与三语 hash/sourceFileSha256 不一致（绑定记录自洽性校验失败）。');
    }
  }
  const expectedRequestKey = descriptionBindingRequestKey({
    taskId: task?.id || '',
    targetStore: bindingTargetStore,
    baseTaskRevision: Number(binding.baseTaskRevision || 0),
    contentSha256: declaredContentSha,
    sourceProof: binding.sourceProof,
  });
  const legacyS09RequestKey = binding.sourceProof === DESCRIPTION_SOURCE_PROOF
    ? descriptionBindingRequestKey({
        taskId: task?.id || '',
        targetStore: bindingTargetStore,
        baseTaskRevision: Number(binding.baseTaskRevision || 0),
        contentSha256: declaredContentSha,
      })
    : '';
  const actualRequestKey = String(binding.bindingRequestKey || '').toLowerCase();
  if (!SHA256_RE.test(actualRequestKey)
    || (actualRequestKey !== expectedRequestKey && actualRequestKey !== legacyS09RequestKey)) {
    blockers.push('descriptionMaterialBinding.bindingRequestKey 与 task/store/base revision/content hash/source proof 不一致。');
  }
  const expectedImageFingerprint = String(task?.publishAssetBinding?.bindingFingerprint || '');
  const bindingImageFingerprint = String(binding.imageBindingFingerprint || '');
  if ((bindingImageFingerprint && !SHA256_RE.test(bindingImageFingerprint)) || bindingImageFingerprint !== expectedImageFingerprint) {
    blockers.push('descriptionMaterialBinding.imageBindingFingerprint 与任务当前审核图片绑定不一致。');
  }
  return {ok: blockers.length === 0, blockers, summary: payloadDescription};
}

function spuInfoDescriptionRows(spuInfo) {
  const listPresent = Boolean(spuInfo
    && typeof spuInfo === 'object'
    && !Array.isArray(spuInfo)
    && Object.prototype.hasOwnProperty.call(spuInfo, 'productMultiDescList'));
  const list = listPresent && Array.isArray(spuInfo.productMultiDescList)
    ? spuInfo.productMultiDescList
    : null;
  const rows = [];
  const malformed = [];
  if (list) {
    for (const [index, row] of list.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        malformed.push({index, reason: 'row_not_object'});
        continue;
      }
      const language = String(row.language ?? '').trim().toLowerCase();
      const hasProductDesc = Object.prototype.hasOwnProperty.call(row, 'productDesc')
        && typeof row.productDesc === 'string';
      if (!language) malformed.push({index, reason: 'language_missing'});
      if (!hasProductDesc) malformed.push({index, reason: 'productDesc_missing_or_non_string'});
      if (!language || !hasProductDesc) continue;
      rows.push({language, productDesc: row.productDesc});
    }
  }
  return {
    rows,
    evidence: {
      listPresent,
      listIsArray: Boolean(list),
      rowCount: list?.length || 0,
      parsedRowCount: rows.length,
      malformedCount: malformed.length,
      malformed,
    },
  };
}

/**
 * Live spu-info description readback gate. Requires ar/en to each appear
 * exactly once and their per-language sha256 (of the live productDesc string)
 * to equal the task's descriptionMaterialBinding hashes byte-for-byte.
 * Returns hashes/lineCounts only; never full text.
 */
export function evaluateDescriptionReadback(binding, spuInfo) {
  const parsed = spuInfoDescriptionRows(spuInfo);
  const rows = parsed.rows;
  const summary = {
    evidence: {
      listPresent: parsed.evidence.listPresent,
      listIsArray: parsed.evidence.listIsArray,
      rowCount: parsed.evidence.rowCount,
      parsedRowCount: parsed.evidence.parsedRowCount,
      malformedCount: parsed.evidence.malformedCount,
    },
  };
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const entries = rows.filter(row => row.language === language);
    summary[language] = {
      count: entries.length,
      lineCounts: entries.map(entry => entry.productDesc === '' ? 0 : entry.productDesc.split('\n').length),
      hashes: entries.map(entry => sha256Utf8(entry.productDesc)),
    };
  }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    const evidenceBlockers = [];
    if (!parsed.evidence.listPresent || !parsed.evidence.listIsArray) {
      evidenceBlockers.push('spu-info 未明确返回 productMultiDescList 数组，无法证明商品描述为空');
    }
    if (parsed.evidence.malformedCount) {
      evidenceBlockers.push(`spu-info productMultiDescList 含 ${parsed.evidence.malformedCount} 个不可判定字段，无法证明商品描述为空`);
    }
    if (evidenceBlockers.length) {
      return {
        ok: false,
        status: 'description_readback_unverifiable',
        blockers: evidenceBlockers,
        summary,
      };
    }
    if (rows.some(row => row.productDesc !== '')) {
      return {
        ok: false,
        status: 'description_readback_unverifiable',
        blockers: ['spu-info 返回了商品描述但没有任务描述绑定，无法核验'],
        summary,
      };
    }
    return {ok: true, status: 'description_readback_not_required', blockers: [], summary};
  }
  const bindingHashes = binding.hashes && typeof binding.hashes === 'object' ? binding.hashes : {};
  const blockers = [];
  let status = 'description_readback_matched';
  if (!parsed.evidence.listPresent || !parsed.evidence.listIsArray) {
    blockers.push('spu-info 未明确返回 productMultiDescList 数组，描述终态不可核验');
    status = 'description_readback_unverifiable';
  }
  if (parsed.evidence.malformedCount) {
    blockers.push(`spu-info productMultiDescList 含 ${parsed.evidence.malformedCount} 个不可判定字段，描述终态不可核验`);
    status = 'description_readback_unverifiable';
  }
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const entries = rows.filter(row => row.language === language);
    const expected = String(bindingHashes[language] || '').toLowerCase();
    if (entries.length !== 1) {
      const reason = entries.length === 0 ? 'missing' : 'duplicate';
      blockers.push(`spu-info ${language} 描述条目 ${entries.length}（应为恰好1条，当前 ${reason}）`);
      if (status === 'description_readback_matched' || status === 'description_readback_mismatch') {
        status = reason === 'missing' ? 'description_readback_missing' : 'description_readback_duplicate';
      }
      continue;
    }
    const actual = sha256Utf8(entries[0].productDesc);
    if (!SHA256_RE.test(expected) || actual !== expected) {
      blockers.push(`spu-info ${language} 描述 hash 与审核资料绑定不一致（binding=${expected || '(missing)'} live=${actual}）`);
      status = 'description_readback_mismatch';
    }
  }
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'description_readback_matched' : status,
    blockers,
    summary,
  };
}

/**
 * Terminal CLI output for prepare-descriptions: hashes/counts/languages only.
 * Assembles the printable object so tests can prove it never contains line
 * text or local paths.
 */
export function buildPrepareDescriptionsCliOutput({summary, binding = {}, dryRun = {}, taskId = '', store = ''} = {}) {
  const boundOk = binding.sameTask === true
    && binding.targetStore === store
    && SHA256_RE.test(String(binding.newPayloadHash || ''))
    && binding.preflightInvalidated === true
    && binding.imageBindingFingerprintUnchanged === true;
  const dryRunOk = dryRun.state === 'openapi_product_preflight_ready'
    && dryRun.ok === true
    && Number(dryRun.blockerCount || 0) === 0
    && SHA256_RE.test(String(dryRun.payloadHash || ''))
    && dryRun.descriptionBindingLocked === true
    && Number(dryRun.descriptionCount || 0) === 2
    && JSON.stringify(dryRun.descriptionLanguages || []) === JSON.stringify(DESCRIPTION_PUBLISH_LANGUAGES)
    && DESCRIPTION_PUBLISH_LANGUAGES.every(language => (
      Number(dryRun.descriptionLineCounts?.[language]) === DESCRIPTION_LINE_COUNT
      && String(dryRun.descriptionHashes?.[language] || '').toLowerCase() === String(summary?.hashes?.[language] || '').toLowerCase()
    ));
  return {
    ok: boundOk && dryRunOk,
    aiInvoked: false,
    command: 'prepare-descriptions',
    taskId: String(taskId || ''),
    store: String(store || ''),
    material: {
      sourceLabel: String(summary?.sourceLabel || ''),
      sourceFileSha256: String(summary?.sourceFileSha256 || ''),
      contentSha256: String(summary?.contentSha256 || ''),
      publishLanguages: Array.isArray(summary?.publishLanguages) ? [...summary.publishLanguages] : [],
      lineCounts: summary?.lineCounts && typeof summary.lineCounts === 'object' ? {...summary.lineCounts} : {},
      hashes: summary?.hashes && typeof summary.hashes === 'object' ? {...summary.hashes} : {},
    },
    bound: {
      sameTask: binding.sameTask === true,
      targetStore: String(binding.targetStore || store || ''),
      sourceProof: String(binding.sourceProof || ''),
      newPayloadHash: String(binding.newPayloadHash || ''),
      preflightInvalidated: binding.preflightInvalidated === true,
      imageBindingFingerprintUnchanged: binding.imageBindingFingerprintUnchanged === true,
    },
    dryRun: {
      state: String(dryRun.state || ''),
      ok: dryRun.ok === true,
      blockerCount: Number(dryRun.blockerCount || 0),
      payloadHash: String(dryRun.payloadHash || ''),
      descriptionCount: Number(dryRun.descriptionCount || 0),
      descriptionLanguages: Array.isArray(dryRun.descriptionLanguages) ? [...dryRun.descriptionLanguages] : [],
      descriptionLineCounts: isPlainObject(dryRun.descriptionLineCounts) ? {...dryRun.descriptionLineCounts} : {},
      descriptionHashes: isPlainObject(dryRun.descriptionHashes) ? {...dryRun.descriptionHashes} : {},
      descriptionBindingLocked: dryRun.descriptionBindingLocked === true,
    },
    safety: {
      verbatimOnly: true,
      noAutoMapFromSource: true,
      realPublishOccurred: false,
      nextStep: '核对新预演的 payloadHash 和描述 hash；只有用户明确确认后才调用 execute。',
    },
  };
}

/**
 * Description-material audit identity used by bindings, history and audits.
 * Hash-only; safe to persist and display.
 */
export function descriptionMaterialAuditIdentity(material) {
  const summary = describeDescriptionMaterial(material);
  return {
    sourceLabel: summary.sourceLabel,
    sourceFileSha256: summary.sourceFileSha256,
    contentSha256: summary.contentSha256,
    publishLanguages: [...summary.publishLanguages],
    lineCounts: {...summary.lineCounts},
    hashes: {...summary.hashes},
  };
}

// ---------------------------------------------------------------------------
// Phase B: historical update_description (maintenance partialEdit) contracts.
//
// The publish path (Phase A) binds descriptions to a copy_product_draft
// openapiPublishPayload. The maintenance path binds the SAME server-verified
// material to a separate update_description task whose partialEdit body is
// minimal: exactly spu_name + multi_language_desc_list. No title/image/
// attribute field may be mixed in, the old publish task is only source
// evidence (never modified), and the binding lock is its own exact-key schema
// so Phase A locks are never relaxed.
// ---------------------------------------------------------------------------

export const DESCRIPTION_UPDATE_BINDING_KEYS = Object.freeze([
  'authority',
  'baseTaskRevision',
  'bindingRequestKey',
  'boundAt',
  'boundByUser',
  'contentSha256',
  'hashes',
  'kind',
  'lineCounts',
  'newPayloadHash',
  'payloadHashAlgorithm',
  'publishLanguages',
  'schemaVersion',
  'sourceApproved',
  'sourceByteLength',
  'sourceFileSha256',
  'sourceLabel',
  'sourceProof',
  'targetSpu',
  'targetStore',
].sort());

function validateUpdateDescriptionSpuName(spuName) {
  const value = String(spuName ?? '').trim();
  if (!value || value.length > 120 || /\s/.test(value)) {
    throw new DescriptionMaterialError(
      'update_description 必须携带唯一 SPU：spuName 非空、≤120 字符且不含空白',
      {code: 'DESCRIPTION_UPDATE_SPU_INVALID'},
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{3,}$/.test(value)) {
    throw new DescriptionMaterialError(
      `update_description spuName 格式不符合 SHEIN SPU 形态（${value.slice(0, 40)}）`,
      {code: 'DESCRIPTION_UPDATE_SPU_INVALID'},
    );
  }
  return value;
}

/**
 * Minimal partialEdit body for historical update_description: exactly
 * spu_name + multi_language_desc_list (ar/en, 5 verbatim lines each). The
 * material rows come only from the server-verified reviewed HTML.
 */
export function buildUpdateDescriptionPayload(material, spuName) {
  const spu = validateUpdateDescriptionSpuName(spuName);
  return {
    spu_name: spu,
    multi_language_desc_list: buildDescriptionPayloadRows(material),
  };
}

/**
 * Hash/count summary of the minimal partialEdit payload. Never contains text.
 */
export function describeUpdateDescriptionPayload(payload) {
  const description = describePublishPayloadDescription(payload);
  return {
    spuName: String(payload?.spu_name ?? ''),
    descriptionCount: description.descriptionCount,
    descriptionLanguages: [...(description.descriptionLanguages || [])],
    descriptionLineCounts: {...(description.descriptionLineCounts || {})},
    descriptionHashes: {...(description.descriptionHashes || {})},
    payloadHash: sha256StableJson(payload),
    payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  };
}

/**
 * Minimal-shape gate for the update_description partialEdit body. The body
 * must contain exactly spu_name + multi_language_desc_list; any extra field
 * (title/image/attribute or description aliases) is a blocker.
 */
export function validateUpdateDescriptionPayloadShape(payload) {
  const blockers = [];
  if (!isPlainObject(payload)) {
    return {ok: false, blockers: ['update_description payload 必须是对象'], summary: null};
  }
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== 'multi_language_desc_list,spu_name') {
    blockers.push(`update_description partialEdit body 必须严格只含 spu_name/multi_language_desc_list（当前 ${keys.join('/') || '(empty)'}）；禁止混入 title/image/attribute 或其他字段。`);
  }
  const spuName = String(payload.spu_name ?? '').trim();
  if (!spuName || spuName.length > 120 || /\s/.test(spuName)) {
    blockers.push('update_description payload.spu_name 必须是唯一非空 SPU（≤120 字符、无空白）。');
  }
  if (!Array.isArray(payload.multi_language_desc_list)) {
    blockers.push('update_description payload 缺官方字段 multi_language_desc_list。');
    return {ok: blockers.length === 0, blockers, summary: describeUpdateDescriptionPayload(payload)};
  }
  for (const field of FORBIDDEN_DESCRIPTION_PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      blockers.push(`update_description payload 禁止携带描述别名字段 ${field}。`);
    }
  }
  for (const [index, row] of payload.multi_language_desc_list.entries()) {
    if (!isPlainObject(row)) {
      blockers.push(`multi_language_desc_list[${index}] 必须是对象。`);
      continue;
    }
    const rowKeys = Object.keys(row).sort();
    if (rowKeys.join(',') !== 'language,name') {
      blockers.push(`multi_language_desc_list[${index}] 必须只包含 language/name。`);
    }
  }
  const rows = descriptionRowsFromPayload(payload);
  const unknownLanguages = [...new Set(rows.map(row => row.language).filter(language => !DESCRIPTION_PUBLISH_LANGUAGES.includes(language)))];
  if (unknownLanguages.length) {
    blockers.push(`multi_language_desc_list 包含不允许的语言：${unknownLanguages.join('/')}（只允许 ar/en 两条）。`);
  }
  const arCount = rows.filter(row => row.language === 'ar').length;
  const enCount = rows.filter(row => row.language === 'en').length;
  if (rows.length !== 2 || arCount !== 1 || enCount !== 1) {
    blockers.push(`multi_language_desc_list 必须恰好是 ar+en 两条且各一条（当前共 ${rows.length} 条，ar=${arCount} en=${enCount}）。`);
  }
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const row = rows.find(entry => entry.language === language);
    if (row) validatePayloadDescriptionName(row.name, language, blockers);
  }
  return {ok: blockers.length === 0, blockers, summary: describeUpdateDescriptionPayload(payload)};
}

function taskSingleSpuName(task) {
  const parameterSpu = String(task?.parameters?.spuName || task?.planning?.parameters?.spuName || '').trim().toLowerCase();
  const refs = Array.isArray(task?.targets?.productRefs)
    ? task.targets.productRefs.map(value => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const candidates = [...new Set([parameterSpu, ...refs].filter(Boolean))];
  if (candidates.length !== 1) return '';
  return candidates[0];
}

/**
 * Locks the update_description task binding onto its minimal partialEdit
 * body before dry-run/execute. This is the maintenance-path analogue of
 * validateDescriptionBindingLock with its own exact key set: no image
 * fingerprint (there is no publishAssetBinding on a maintenance task) and the
 * single target SPU is part of the binding identity.
 */
export function validateUpdateDescriptionBindingLock(task, payload) {
  const blockers = [];
  const shape = validateUpdateDescriptionPayloadShape(payload);
  if (!shape.ok) blockers.push(...shape.blockers);
  const summary = describeUpdateDescriptionPayload(payload);
  const binding = task?.descriptionMaterialBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    blockers.push('任务缺少 descriptionMaterialBinding；禁止提交未由服务端核验实际审核 HTML 的描述。');
    return {ok: blockers.length === 0, blockers, summary};
  }
  const bindingKeys = Object.keys(binding).sort();
  if (JSON.stringify(bindingKeys) !== JSON.stringify(DESCRIPTION_UPDATE_BINDING_KEYS)) {
    blockers.push(`descriptionMaterialBinding 字段必须严格等于 ${DESCRIPTION_UPDATE_BINDING_KEYS.join('/')}，禁止额外或缺失 metadata。`);
  }
  if (binding.schemaVersion !== DESCRIPTION_SCHEMA_VERSION) {
    blockers.push(`descriptionMaterialBinding.schemaVersion 必须为 ${DESCRIPTION_SCHEMA_VERSION}。`);
  }
  if (binding.kind !== 'update_description' || binding.sourceApproved !== true || binding.authority !== 'human_reviewed_source') {
    blockers.push('descriptionMaterialBinding 缺少受控 update_description / human_reviewed_source 授权标记。');
  }
  if (![DESCRIPTION_SOURCE_PROOF, DESCRIPTION_SOURCE_PROOF_S9].includes(binding.sourceProof)) {
    blockers.push(`descriptionMaterialBinding.sourceProof 必须为 ${DESCRIPTION_SOURCE_PROOF} 或 ${DESCRIPTION_SOURCE_PROOF_S9}。`);
  }
  if (binding.payloadHashAlgorithm !== DESCRIPTION_PAYLOAD_HASH_ALGORITHM) {
    blockers.push(`descriptionMaterialBinding.payloadHashAlgorithm 必须为 ${DESCRIPTION_PAYLOAD_HASH_ALGORITHM}。`);
  }
  const sourceLabel = String(binding.sourceLabel || '');
  if (!sourceLabel || sourceLabel.includes('/') || sourceLabel.includes('\\')) {
    blockers.push('descriptionMaterialBinding.sourceLabel 必须是非空文件 basename。');
  }
  if (!Number.isSafeInteger(Number(binding.sourceByteLength)) || Number(binding.sourceByteLength) <= 0) {
    blockers.push('descriptionMaterialBinding.sourceByteLength 必须是正整数。');
  }
  if (!Number.isSafeInteger(Number(binding.baseTaskRevision)) || Number(binding.baseTaskRevision) <= 0) {
    blockers.push('descriptionMaterialBinding.baseTaskRevision 必须是正整数。');
  }
  if (!String(binding.boundByUser || '').trim() || !Number.isFinite(Date.parse(String(binding.boundAt || '')))) {
    blockers.push('descriptionMaterialBinding 必须包含有效 boundAt/boundByUser。');
  }
  const taskWriteStoresRaw = Array.isArray(task?.targets?.writeStores) && task.targets.writeStores.length
    ? task.targets.writeStores
    : Array.isArray(task?.targets?.stores) && task.targets.stores.length
      ? task.targets.stores
      : [];
  const normalizedWriteStores = [...new Set(taskWriteStoresRaw.map(value => String(value || '').trim().toUpperCase()).filter(Boolean))];
  const bindingTargetStore = String(binding.targetStore || '').trim().toUpperCase();
  if (normalizedWriteStores.length !== 1 || bindingTargetStore !== normalizedWriteStores[0]) {
    blockers.push(`descriptionMaterialBinding.targetStore 必须等于任务唯一写入店（binding=${bindingTargetStore || '(missing)'} task=${normalizedWriteStores.join('/') || '(empty)'}）。`);
  }
  const payloadSpu = String(payload?.spu_name || '').trim().toLowerCase();
  const bindingSpu = String(binding.targetSpu || '').trim().toLowerCase();
  const taskSpu = taskSingleSpuName(task);
  if (!bindingSpu || bindingSpu !== payloadSpu || (taskSpu && taskSpu !== payloadSpu)) {
    blockers.push(`descriptionMaterialBinding.targetSpu 必须等于 payload.spu_name 且为任务唯一 SPU（binding=${bindingSpu || '(missing)'} payload=${payloadSpu || '(missing)'} task=${taskSpu || '(empty)'}）。`);
  }
  if (JSON.stringify(binding.publishLanguages) !== JSON.stringify(DESCRIPTION_PUBLISH_LANGUAGES)) {
    blockers.push('descriptionMaterialBinding.publishLanguages 必须固定为 ar/en。');
  }
  const bindingLineCounts = isPlainObject(binding.lineCounts) ? binding.lineCounts : {};
  const bindingHashes = isPlainObject(binding.hashes) ? binding.hashes : {};
  if (JSON.stringify(Object.keys(bindingLineCounts).sort()) !== JSON.stringify([...DESCRIPTION_ALL_LANGUAGES].sort())) {
    blockers.push('descriptionMaterialBinding.lineCounts 必须严格只含 ar/en/zh-cn。');
  }
  if (JSON.stringify(Object.keys(bindingHashes).sort()) !== JSON.stringify([...DESCRIPTION_ALL_LANGUAGES].sort())) {
    blockers.push('descriptionMaterialBinding.hashes 必须严格只含 ar/en/zh-cn。');
  }
  for (const language of DESCRIPTION_ALL_LANGUAGES) {
    if (Number(bindingLineCounts[language]) !== DESCRIPTION_LINE_COUNT) {
      blockers.push(`descriptionMaterialBinding.lineCounts.${language} 必须为 ${DESCRIPTION_LINE_COUNT}。`);
    }
    if (!SHA256_RE.test(String(bindingHashes[language] || ''))) {
      blockers.push(`descriptionMaterialBinding 缺少 ${language} 的有效绑定描述 hash。`);
    }
  }
  if (!SHA256_RE.test(String(binding.newPayloadHash || ''))) {
    blockers.push('descriptionMaterialBinding.newPayloadHash 缺失或格式无效。');
  }
  const actualPayloadHash = sha256StableJson(payload);
  if (String(binding.newPayloadHash || '').toLowerCase() !== actualPayloadHash) {
    blockers.push(`descriptionMaterialBinding.newPayloadHash 与任务当前 descriptionUpdatePayload 不一致（binding=${String(binding.newPayloadHash || '') || '(missing)'} actual=${actualPayloadHash}）。`);
  }
  const payloadRef = task?.descriptionUpdatePayloadRef;
  if (payloadRef && typeof payloadRef === 'object' && !Array.isArray(payloadRef)) {
    if (String(payloadRef.payloadHash || '') !== actualPayloadHash) {
      blockers.push('任务持久化 descriptionUpdatePayloadRef.payloadHash 与本次 payload hash 不一致。');
    }
    if (!String(payloadRef.relativePath || '').startsWith('state/description-material/')) {
      blockers.push('任务 descriptionUpdatePayloadRef.relativePath 必须位于受控 state/description-material/ 目录。');
    }
  } else if (Object.prototype.hasOwnProperty.call(task || {}, 'descriptionUpdatePayload')) {
    blockers.push('任务记录禁止持久化 descriptionUpdatePayload 描述明文；只允许受控 descriptionUpdatePayloadRef 指针。');
  }
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const expected = String(bindingHashes[language] || '').toLowerCase();
    const actual = String(summary.descriptionHashes?.[language] || '').toLowerCase();
    if (SHA256_RE.test(expected) && actual !== expected) {
      blockers.push(`partialEdit 描述 ${language} hash 与审核资料绑定不一致（binding=${expected} payload=${actual || '(missing)'}）；禁止提交被改写后的描述。`);
    }
  }
  if (summary.descriptionCount !== 2) {
    blockers.push('partialEdit 描述必须恰好是 ar/en 两条。');
  }
  const sourceFileSha256 = String(binding.sourceFileSha256 || '').toLowerCase();
  const declaredContentSha = String(binding.contentSha256 || '').toLowerCase();
  if (!SHA256_RE.test(sourceFileSha256)) blockers.push('descriptionMaterialBinding.sourceFileSha256 缺失或格式无效。');
  if (!SHA256_RE.test(declaredContentSha)) blockers.push('descriptionMaterialBinding.contentSha256 缺失或格式无效。');
  if (SHA256_RE.test(sourceFileSha256)
    && SHA256_RE.test(declaredContentSha)
    && DESCRIPTION_ALL_LANGUAGES.every(language => SHA256_RE.test(String(bindingHashes[language] || '')))) {
    const recomputed = sha256Utf8([
      sourceFileSha256,
      String(bindingHashes.ar || '').toLowerCase(),
      String(bindingHashes.en || '').toLowerCase(),
      String(bindingHashes['zh-cn'] || '').toLowerCase(),
    ].join('\n'));
    if (recomputed !== declaredContentSha) {
      blockers.push('descriptionMaterialBinding contentSha256 与三语 hash/sourceFileSha256 不一致（绑定记录自洽性校验失败）。');
    }
  }
  const expectedRequestKey = descriptionBindingRequestKey({
    taskId: task?.id || '',
    targetStore: bindingTargetStore,
    baseTaskRevision: Number(binding.baseTaskRevision || 0),
    contentSha256: declaredContentSha,
  });
  if (!SHA256_RE.test(String(binding.bindingRequestKey || '')) || String(binding.bindingRequestKey || '').toLowerCase() !== expectedRequestKey) {
    blockers.push('descriptionMaterialBinding.bindingRequestKey 与 task/store/base revision/content hash/source proof 不一致。');
  }
  return {ok: blockers.length === 0, blockers, summary};
}

/**
 * Extracts the SPU identity from a live spu-info response (info level or
 * embedded product rows). Hash-free, safe to persist.
 */
export function extractSpuInfoIdentity(spuInfo) {
  const info = spuInfo && typeof spuInfo === 'object' && !Array.isArray(spuInfo)
    ? spuInfo
    : {};
  const direct = String(info.spuName || info.spu_name || info.spu || '').trim();
  if (direct) return {spuName: direct, skcNames: []};
  const q = [info];
  const seen = new Set();
  const skcNames = [];
  let spuName = '';
  while (q.length && !spuName) {
    const cur = q.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) { q.push(...cur); continue; }
    spuName = String(cur.spuName || cur.spu_name || cur.spu || '').trim();
    if (spuName) break;
    q.push(...Object.values(cur));
  }
  const q2 = [info];
  const seen2 = new Set();
  while (q2.length && skcNames.length < 100) {
    const cur = q2.shift();
    if (!cur || typeof cur !== 'object' || seen2.has(cur)) continue;
    seen2.add(cur);
    if (Array.isArray(cur)) { q2.push(...cur); continue; }
    const skc = String(cur.skcName || cur.skc_name || cur.skc || '').trim();
    if (skc) skcNames.push(skc);
    q2.push(...Object.values(cur));
  }
  return {spuName, skcNames: [...new Set(skcNames)]};
}

/**
 * Live spu-info readback gate for update_description: the returned SPU
 * identity must match the expected single SPU, and the live ar/en
 * productMultiDescList hashes must equal the binding hashes byte-for-byte.
 * Any mismatch classifies the task as pending manual resolve.
 */
export function evaluateUpdateDescriptionReadback(binding, spuInfo, {expectedSpuName = ''} = {}) {
  const identity = extractSpuInfoIdentity(spuInfo);
  const expected = String(expectedSpuName || '').trim().toLowerCase();
  if (expected && identity.spuName) {
    if (String(identity.spuName).trim().toLowerCase() !== expected) {
      return {
        ok: false,
        status: 'description_readback_spu_identity_mismatch',
        needsManualResolve: true,
        blockers: [`spu-info 返回 SPU 身份 ${identity.spuName} 与任务目标 ${expected} 不一致`],
        summary: {spuName: identity.spuName, skcCount: identity.skcNames.length},
      };
    }
  } else if (expected && !identity.spuName) {
    return {
      ok: false,
      status: 'description_readback_spu_identity_missing',
      needsManualResolve: true,
      blockers: [`spu-info 未返回可核验的 SPU 身份（期望 ${expected}）`],
      summary: {spuName: '', skcCount: identity.skcNames.length},
    };
  }
  const gate = evaluateDescriptionReadback(binding, spuInfo);
  if (gate.ok) {
    return {...gate, summary: {spuName: identity.spuName, ...gate.summary}};
  }
  return {
    ...gate,
    needsManualResolve: true,
    summary: {spuName: identity.spuName, ...gate.summary},
  };
}

/**
 * Lifecycle classification for the submitted update_description write.
 * matched only when the live spu-info description hash is byte-exact;
 * anything else stays pending/manual resolve.
 */
export function classifyUpdateDescriptionLifecycle({executeOk = false, readback = null} = {}) {
  if (!executeOk) return {lifecycleStatus: 'blocked', status: 'blocked', needsManualResolve: false};
  if (readback?.ok === true) {
    return {lifecycleStatus: 'submitted_readback_matched', status: 'submitted_readback_matched', needsManualResolve: false};
  }
  return {
    lifecycleStatus: 'submitted_readback_pending',
    status: 'submitted_readback_pending',
    needsManualResolve: true,
  };
}
