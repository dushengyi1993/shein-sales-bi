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
 *      descriptions (exactly 5 lines each).
 *
 * zh-cn lines are audit-only: they never enter the SHEIN payload.
 * Logs and audit records must only carry hashes/counts, never full text.
 */
import crypto from 'node:crypto';

export const DESCRIPTION_SCHEMA_VERSION = 1;
export const DESCRIPTION_LINE_COUNT = 5;
export const DESCRIPTION_NAME_MAX_CHARS = 5000;
export const DESCRIPTION_PUBLISH_LANGUAGES = Object.freeze(['ar', 'en']);
export const DESCRIPTION_AUDIT_LANGUAGES = Object.freeze(['zh-cn']);
export const DESCRIPTION_ALL_LANGUAGES = Object.freeze(['ar', 'en', 'zh-cn']);
export const DESCRIPTION_PAYLOAD_HASH_ALGORITHM = 'sha256-stable-json-v1';
export const DESCRIPTION_SOURCE_PROOF = 'server_verified_html_section_s09';

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

export function descriptionBindingRequestKey({taskId = '', targetStore = '', baseTaskRevision = 0, contentSha256 = ''} = {}) {
  return sha256Utf8([
    String(taskId || ''),
    String(targetStore || '').toUpperCase(),
    String(Number(baseTaskRevision) || 0),
    String(contentSha256 || '').toLowerCase(),
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
  if (binding.sourceProof !== DESCRIPTION_SOURCE_PROOF) {
    blockers.push(`descriptionMaterialBinding.sourceProof 必须为 ${DESCRIPTION_SOURCE_PROOF}。`);
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
  });
  if (!SHA256_RE.test(String(binding.bindingRequestKey || '')) || String(binding.bindingRequestKey || '').toLowerCase() !== expectedRequestKey) {
    blockers.push('descriptionMaterialBinding.bindingRequestKey 与 task/store/base revision/content hash 不一致。');
  }
  const expectedImageFingerprint = String(task?.publishAssetBinding?.bindingFingerprint || '');
  const bindingImageFingerprint = String(binding.imageBindingFingerprint || '');
  if ((bindingImageFingerprint && !SHA256_RE.test(bindingImageFingerprint)) || bindingImageFingerprint !== expectedImageFingerprint) {
    blockers.push('descriptionMaterialBinding.imageBindingFingerprint 与任务当前审核图片绑定不一致。');
  }
  return {ok: blockers.length === 0, blockers, summary: payloadDescription};
}

function spuInfoDescriptionRows(spuInfo) {
  const list = Array.isArray(spuInfo?.productMultiDescList)
    ? spuInfo.productMultiDescList
    : [];
  return list
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      language: String(row.language ?? '').toLowerCase(),
      productDesc: String(row.productDesc ?? row.name ?? ''),
    }))
    .filter(row => row.language);
}

/**
 * Live spu-info description readback gate. Requires ar/en to each appear
 * exactly once and their per-language sha256 (of the live productDesc string)
 * to equal the task's descriptionMaterialBinding hashes byte-for-byte.
 * Returns hashes/lineCounts only; never full text.
 */
export function evaluateDescriptionReadback(binding, spuInfo) {
  const rows = spuInfoDescriptionRows(spuInfo);
  const summary = {};
  for (const language of DESCRIPTION_PUBLISH_LANGUAGES) {
    const entries = rows.filter(row => row.language === language);
    summary[language] = {
      count: entries.length,
      lineCounts: entries.map(entry => entry.productDesc === '' ? 0 : entry.productDesc.split('\n').length),
      hashes: entries.map(entry => sha256Utf8(entry.productDesc)),
    };
  }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
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
