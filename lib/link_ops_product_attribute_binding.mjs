#!/usr/bin/env node
/**
 * Controlled repair of a missing whitelisted product attribute on an
 * existing unsubmitted copy_product_draft task (two-step same-task flow).
 *
 * Step 1 (this module): verify and bind ONLY the whitelisted attribute
 * (1002328, Hazardous materials classification) from a live same-product
 * donor link, persist donor provenance/evidence, CAS the task revision and
 * invalidate the old preflight. The existing description binding is left
 * intentionally stale (its full-payload newPayloadHash no longer matches the
 * attribute-augmented payload); step 2 is a normal prepare-descriptions
 * rebind of the SAME reviewed material at the current revision, after which
 * preflight becomes the authority again. No new task, no image re-upload,
 * never publish.
 *
 * Same-product identity is STRICT and explicit only:
 *   - donor store identity (query-store-info) verifies the donor OpenAPI
 *     account against the authoritative store identity mapping;
 *   - the case-sensitive donor SKC must resolve to EXACTLY ONE SPU through
 *     the donor store searchProduct (case variants never match);
 *   - live spu-info must contain the exact-case donor SKC whose supplierCode
 *     equals the searchProduct supplierCode RAW-exact;
 *   - task raw code and donor raw code must each resolve to the same
 *     canonical through config/product_aliases.json EXACT alias/canonical
 *     entries only (no raw fallback, no prefix/descriptor inference);
 *     ignored/ambiguous/needs-review aliases reject, and the canonical must
 *     exist in config/product_catalog.json;
 *   - live product identity evidence is exactly ONE Product Model attribute
 *     (1000546) whose value equals the task payload's single 1000546 value;
 *   - the requested attribute must appear EXACTLY ONCE in the donor product
 *     attributes with a positive attribute_value_id.
 *
 * The persisted binding carries raw task/donor codes, the canonical
 * identity, alias/catalog registry fingerprints and evidence hashes only.
 * validateProductAttributeBindingLock additionally pins the description
 * content (contentSha256 + per-language hashes) and the image binding
 * fingerprint, so any tampering with donor provenance/value/alias registry,
 * the bound payload or previously bound materials blocks dry-run/execute.
 */
import {sha256StableJson, sha256Utf8} from './link_ops_product_descriptions.mjs';

export const PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION = 2;
export const PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1 = 1;
export const PRODUCT_ATTRIBUTE_BINDING_KIND = 'copy_product_draft';
export const PRODUCT_ATTRIBUTE_BINDING_AUTHORITY = 'official_live_openapi_donor';
export const PRODUCT_ATTRIBUTE_PAYLOAD_HASH_ALGORITHM = 'sha256-stable-json-v1';
export const PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND = 'append_missing';
export const PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT = 'adopt_existing';
export const PRODUCT_ATTRIBUTE_BINDING_MODES = Object.freeze([
  PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND,
  PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT,
]);

// Whitelist is intentionally minimal: Hazardous materials classification is
// the only attribute this controlled repair may touch.
export const PRODUCT_ATTRIBUTE_WHITELIST = Object.freeze({
  1002328: Object.freeze({attributeId: 1002328, name: 'Hazardous materials classification'}),
});
export const PRODUCT_ATTRIBUTE_WHITELIST_IDS = Object.freeze(new Set(
  Object.values(PRODUCT_ATTRIBUTE_WHITELIST).map(entry => entry.attributeId),
));

// Product Model(1000546) is the ONLY live product identity evidence accepted
// from the donor spu-info. Arbitrary attribute values are never evidence.
export const PRODUCT_MODEL_ATTRIBUTE_ID = 1000546;
export const DESCRIPTION_PINNED_LANGUAGES = Object.freeze(['ar', 'en', 'zh-cn']);

const STORE_KEY_RE = /^[A-Z0-9]{2,4}$/;
const SKC_RE = /^s[abv]\d{8,}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function blocker(code, message) {
  return {code, message: safeString(message, 500)};
}

export function normalizeProductAttributeId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function isWhitelistedProductAttribute(attributeId) {
  return PRODUCT_ATTRIBUTE_WHITELIST_IDS.has(normalizeProductAttributeId(attributeId));
}

export function whitelistedProductAttributeName(attributeId) {
  const id = normalizeProductAttributeId(attributeId);
  const entry = id === null ? null : PRODUCT_ATTRIBUTE_WHITELIST[id];
  return entry?.name || '';
}

export function productAttributeBindingRequestKey({
  taskId = '',
  targetStore = '',
  baseTaskRevision = 0,
  attributeId = 0,
  attributeValueId = 0,
  donorStore = '',
  donorSkc = '',
  donorSpu = '',
  evidenceSha256 = '',
} = {}) {
  return sha256Utf8([
    String(taskId || ''),
    String(targetStore || '').toUpperCase(),
    String(Number(baseTaskRevision) || 0),
    String(Number(attributeId) || 0),
    String(Number(attributeValueId) || 0),
    String(donorStore || '').toUpperCase(),
    String(donorSkc || ''),
    String(donorSpu || ''),
    String(evidenceSha256 || '').toLowerCase(),
  ].join('\n'));
}

/**
 * Schema v2 request key. It must bind the schema version, the explicit
 * binding mode, task identity, base revision, attribute/value pair, donor
 * store/SKC/SPU, donor evidence and BOTH payload hashes, so a coordinated
 * tamper cannot reuse a stale key and adopt/append identities can never be
 * confused with each other.
 */
export function productAttributeBindingRequestKeyV2({
  schemaVersion = PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
  bindingMode = '',
  taskId = '',
  targetStore = '',
  baseTaskRevision = 0,
  attributeId = 0,
  attributeValueId = 0,
  donorStore = '',
  donorSkc = '',
  donorSpu = '',
  evidenceSha256 = '',
  oldPayloadHash = '',
  newPayloadHash = '',
} = {}) {
  return sha256Utf8([
    `schema:${String(schemaVersion)}`,
    `mode:${String(bindingMode || '')}`,
    String(taskId || ''),
    String(targetStore || '').toUpperCase(),
    String(Number(baseTaskRevision) || 0),
    String(Number(attributeId) || 0),
    String(Number(attributeValueId) || 0),
    String(donorStore || '').toUpperCase(),
    String(donorSkc || ''),
    String(donorSpu || ''),
    String(evidenceSha256 || '').toLowerCase(),
    String(oldPayloadHash || '').toLowerCase(),
    String(newPayloadHash || '').toLowerCase(),
  ].join('\n'));
}

export function productAttributeListRows(payload) {
  return asArray(payload?.product_attribute_list ?? payload?.productAttributeList)
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .map(row => ({...row}));
}

/**
 * A payload that simultaneously carries both product_attribute_list and
 * productAttributeList is ambiguous. The controlled repair must reject it
 * BEFORE any mutation: neither list may ever be silently deleted or
 * preferred over the other.
 */
export function payloadHasDualProductAttributeLists(payload) {
  return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'product_attribute_list')
    && Object.prototype.hasOwnProperty.call(payload, 'productAttributeList'));
}

export function productAttributeRowsForId(payload, attributeId) {
  const id = normalizeProductAttributeId(attributeId);
  if (id === null) return [];
  return productAttributeListRows(payload).filter(
    row => normalizeProductAttributeId(row?.attribute_id ?? row?.attributeId) === id,
  );
}

/**
 * adopt_existing preconditions on the CURRENT payload: exactly one
 * snake_case product_attribute_list (no dual field), exactly one row of the
 * whitelisted attribute with a positive attribute_value_id. The payload is
 * never mutated by adoption.
 */
export function adoptablePayloadAttributeRow(payload, attributeId) {
  const blockers = [];
  if (payloadHasDualProductAttributeLists(payload)) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_DUAL_LIST_PRESENT', 'payload 同时含 product_attribute_list 与 productAttributeList，禁止 adopt'));
  }
  const id = normalizeProductAttributeId(attributeId);
  if (id === null) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_NOT_WHITELISTED', `属性 ${safeString(attributeId, 40)} 不在受控白名单内`));
  }
  if (blockers.length) return {ok: false, valueId: null, blockers};
  const rows = productAttributeRowsForId(payload, id);
  if (rows.length !== 1) {
    blockers.push(blocker(
      rows.length === 0 ? 'PRODUCT_ATTRIBUTE_ADOPT_ROW_MISSING' : 'PRODUCT_ATTRIBUTE_ADOPT_ROW_DUPLICATE',
      `adopt_existing 要求 payload 恰好一行属性 ${id}（当前 ${rows.length} 行）`,
    ));
    return {ok: false, valueId: null, blockers};
  }
  const valueId = normalizeProductAttributeId(rows[0]?.attribute_value_id ?? rows[0]?.attributeValueId);
  if (valueId === null) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_ADOPT_VALUE_INVALID', `adopt_existing 要求属性 ${id} 的 attribute_value_id 为正整数`));
    return {ok: false, valueId: null, blockers};
  }
  return {ok: true, valueId, blockers};
}

/**
 * Every whitelisted attribute row in the payload. Used by the execution gate
 * to prove that donor-bound attributes can never exist without a valid
 * persisted binding.
 */
export function payloadWhitelistedProductAttributeRows(payload) {
  return productAttributeListRows(payload).filter(
    row => PRODUCT_ATTRIBUTE_WHITELIST_IDS.has(normalizeProductAttributeId(row?.attribute_id ?? row?.attributeId)),
  );
}

/**
 * The standard goods number (raw task code) of a single-SKC copy task is the
 * sole skc_list[0].supplier_code. Multi-SKC payloads cannot be repaired by
 * this flow because the same-product identity would be ambiguous.
 */
export function productAttributeTargetStandardGoodsSn(payload) {
  const skcs = asArray(payload?.skc_list ?? payload?.skcList)
    .filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (skcs.length !== 1) {
    return {
      ok: false,
      standardGoodsSn: '',
      blockers: [blocker('PAYLOAD_SKC_COUNT_NOT_SINGLE', `商品属性修复只支持恰好 1 个 SKC 的 payload（当前 ${skcs.length}）`)],
    };
  }
  const standardGoodsSn = safeString(skcs[0]?.supplier_code ?? skcs[0]?.supplierCode, 240);
  if (!standardGoodsSn) {
    return {
      ok: false,
      standardGoodsSn: '',
      blockers: [blocker('PAYLOAD_STANDARD_GOODS_SN_MISSING', 'payload 的 skc_list[0].supplier_code 为空，无法核验同货号商品身份')],
    };
  }
  return {ok: true, standardGoodsSn, blockers: []};
}

/**
 * The task payload's Product Model(1000546) must be exactly one row with a
 * non-empty value. It is the only live product identity evidence accepted.
 */
export function productModelFromPayload(payload) {
  const rows = productAttributeRowsForId(payload, PRODUCT_MODEL_ATTRIBUTE_ID);
  if (rows.length !== 1) {
    return {
      ok: false,
      value: '',
      blockers: [blocker('PAYLOAD_PRODUCT_MODEL_INVALID', `payload 的 Product Model(${PRODUCT_MODEL_ATTRIBUTE_ID}) 必须恰好一行（当前 ${rows.length}）`)],
    };
  }
  const value = safeString(rows[0]?.attribute_value ?? rows[0]?.attributeValue ?? rows[0]?.attribute_extra_value, 500);
  if (!value) {
    return {
      ok: false,
      value: '',
      blockers: [blocker('PAYLOAD_PRODUCT_MODEL_INVALID', `payload 的 Product Model(${PRODUCT_MODEL_ATTRIBUTE_ID}) 缺少值`)],
    };
  }
  return {ok: true, value, blockers: []};
}

/**
 * Fingerprint of every publish-payload field EXCEPT the product attribute
 * list. The binding must leave this fingerprint byte-identical, proving that
 * titles, price, inventory, images and descriptions are untouched.
 */
export function productAttributeAreaFingerprint(payload) {
  const stripped = JSON.parse(JSON.stringify(payload ?? {}));
  delete stripped.product_attribute_list;
  delete stripped.productAttributeList;
  return sha256StableJson(stripped);
}

/**
 * Appends exactly one whitelisted attribute row to a cloned payload. It never
 * rewrites other rows; if the attribute is already present the resulting
 * payload has duplicates and fails the lock validation (fail closed).
 */
export function bindProductAttributeToPayload(payload, {attributeId, attributeValueId}) {
  if (payloadHasDualProductAttributeLists(payload)) {
    const error = new Error('payload 同时含 product_attribute_list 与 productAttributeList，拒绝绑定（不得静默删除任一列表）');
    error.code = 'PRODUCT_ATTRIBUTE_DUAL_LIST_PRESENT';
    throw error;
  }
  const id = normalizeProductAttributeId(attributeId);
  const valueId = normalizeProductAttributeId(attributeValueId);
  if (id === null || valueId === null) {
    const error = new Error('商品属性绑定需要正整数 attributeId 与 attributeValueId');
    error.code = 'PRODUCT_ATTRIBUTE_VALUE_INVALID';
    throw error;
  }
  const next = JSON.parse(JSON.stringify(payload ?? {}));
  next.product_attribute_list = [
    ...productAttributeListRows(next),
    {attribute_id: id, attribute_value_id: valueId},
  ];
  delete next.productAttributeList;
  return {payload: next, row: {attribute_id: id, attribute_value_id: valueId}};
}

// ---------------------------------------------------------------------------
// Strict explicit alias registry
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic alias context from the parsed
 * config/product_aliases.json and config/product_catalog.json documents plus
 * the caller-computed file fingerprints. No raw fallback and no prefix
 * inference ever leaves this module.
 */
export function buildProductAliasContext({
  aliasRegistryJson = null,
  catalogJson = null,
  aliasRegistryFingerprint = '',
  catalogFingerprint = '',
  aliasRegistrySource = '',
  catalogSource = '',
} = {}) {
  const registry = aliasRegistryJson && typeof aliasRegistryJson === 'object' ? aliasRegistryJson : {};
  const catalog = catalogJson && typeof catalogJson === 'object' ? catalogJson : {};
  const aliasMap = new Map();
  const canonicals = new Set();
  const needsReview = new Set();
  for (const entry of asArray(registry.aliases)) {
    const canonical = safeString(entry?.canonical, 240);
    if (!canonical) continue;
    canonicals.add(canonical);
    if (entry?.needsReview === true || entry?.ignored === true) needsReview.add(canonical);
    for (const alias of asArray(entry?.aliases)) {
      const key = safeString(alias, 240);
      if (!key) continue;
      if (!aliasMap.has(key)) aliasMap.set(key, new Set());
      aliasMap.get(key).add(canonical);
    }
  }
  const ignored = new Set();
  for (const entry of asArray(registry.ignoredAliases)) {
    for (const alias of asArray(entry?.aliases)) {
      const key = safeString(alias, 240);
      if (key) ignored.add(key);
    }
  }
  const catalogSet = new Set([
    ...asArray(catalog.standards),
    ...asArray(catalog.extraConfirmedStandards),
  ].map(value => safeString(value, 240)).filter(Boolean));
  return {
    available: true,
    aliasMap,
    canonicals,
    needsReview,
    ignored,
    catalogSet,
    aliasRegistryFingerprint: safeString(aliasRegistryFingerprint, 120),
    catalogFingerprint: safeString(catalogFingerprint, 120),
    aliasRegistrySource: safeString(aliasRegistrySource, 240),
    catalogSource: safeString(catalogSource, 240),
  };
}

/**
 * Strict explicit alias resolution. Accepts ONLY an exact alias entry (or the
 * exact canonical listed in the registry); rejected: ignored aliases,
 * multi-canonical ambiguity, needs-review canonicals, canonicals missing from
 * the product catalog, raw fallback and any prefix/descriptor inference.
 */
export function resolveExplicitProductAlias(context, rawCode) {
  const raw = safeString(rawCode, 240);
  if (!raw) {
    return {ok: false, canonical: '', blockers: [blocker('PRODUCT_ALIAS_EMPTY', '商品别名解析收到空代码')]};
  }
  if (!context?.available) {
    return {ok: false, canonical: '', blockers: [blocker('PRODUCT_ALIAS_REGISTRY_UNAVAILABLE', '货号别名注册表不可用')]};
  }
  if (context.ignored?.has(raw)) {
    return {ok: false, canonical: '', blockers: [blocker('PRODUCT_ALIAS_IGNORED', `货号 ${raw} 在忽略别名清单中，禁止作为同货号依据`)]};
  }
  const matches = context.aliasMap?.get(raw);
  if (!matches || !matches.size) {
    if (context.canonicals?.has(raw)) {
      if (context.needsReview?.has(raw)) {
        return {ok: false, canonical: raw, blockers: [blocker('PRODUCT_ALIAS_NEEDS_REVIEW', `canonical ${raw} 标记待确认，禁止作为同货号依据`)]};
      }
      if (!context.catalogSet?.has(raw)) {
        return {ok: false, canonical: raw, blockers: [blocker('PRODUCT_ALIAS_CANONICAL_NOT_IN_CATALOG', `canonical ${raw} 不在 config/product_catalog.json 标准清单`)]};
      }
      return {ok: true, canonical: raw, blockers: []};
    }
    return {ok: false, canonical: '', blockers: [blocker('PRODUCT_ALIAS_NOT_FOUND', `货号 ${raw} 不在明确别名/标准清单中（不做原始回退或前缀推断）`)]};
  }
  const distinct = [...matches];
  if (distinct.length > 1) {
    return {ok: false, canonical: '', blockers: [blocker('PRODUCT_ALIAS_AMBIGUOUS', `货号 ${raw} 在别名注册表命中多个 canonical（${distinct.join('、')}）`)]};
  }
  const canonical = distinct[0];
  if (context.needsReview?.has(canonical)) {
    return {ok: false, canonical, blockers: [blocker('PRODUCT_ALIAS_NEEDS_REVIEW', `canonical ${canonical} 标记待确认，禁止作为同货号依据`)]};
  }
  if (!context.catalogSet?.has(canonical)) {
    return {ok: false, canonical, blockers: [blocker('PRODUCT_ALIAS_CANONICAL_NOT_IN_CATALOG', `canonical ${canonical} 不在 config/product_catalog.json 标准清单`)]};
  }
  return {ok: true, canonical, blockers: []};
}

function donorAliasCode(code) {
  return code && code.startsWith('PRODUCT_ALIAS_') ? `DONOR_ALIAS_${code.slice('PRODUCT_ALIAS_'.length)}` : code;
}

// ---------------------------------------------------------------------------
// Live donor evidence
// ---------------------------------------------------------------------------

function openApiSearchProductRows(envelope) {
  const info = envelope?.info && typeof envelope.info === 'object' ? envelope.info : {};
  const rows = asArray(info.data ?? info.list);
  return rows.filter(row => row && typeof row === 'object');
}

function openApiSkcRows(productRow) {
  const direct = productRow?.skcName || productRow?.skc_name
    ? [{skcName: productRow.skcName ?? productRow.skc_name, supplierCode: productRow.supplierCode ?? productRow.supplier_code}]
    : [];
  return [
    ...direct,
    ...asArray(productRow?.skcList ?? productRow?.skc_list ?? productRow?.skcInfoList ?? productRow?.skc_info_list),
  ].filter(row => row && typeof row === 'object');
}

function rowSkcName(row) {
  return safeString(row?.skcName ?? row?.skc_name ?? row?.skc, 160);
}

function rowSupplierCode(row) {
  return safeString(row?.supplierCode ?? row?.supplier_code, 240);
}

function openApiSpuName(productRow) {
  return safeString(productRow?.spuName ?? productRow?.spu_name, 160);
}

function donorSearchProductEvidence(envelope, donorSkc) {
  if (String(envelope?.code ?? '') !== '0') {
    return {
      ok: false,
      blockers: [blocker('DONOR_SEARCH_QUERY_FAILED', `donor searchProduct 返回 code=${safeString(envelope?.code ?? '', 80)}`)],
      donorSpu: '',
      supplierCode: '',
    };
  }
  const matchedSpus = new Set();
  const matchedSupplierCodes = new Set();
  for (const productRow of openApiSearchProductRows(envelope)) {
    const spuName = openApiSpuName(productRow);
    for (const skcRow of openApiSkcRows(productRow)) {
      if (rowSkcName(skcRow) !== String(donorSkc)) continue; // case-sensitive exact match
      if (spuName) matchedSpus.add(spuName);
      const supplierCode = rowSupplierCode(skcRow);
      if (supplierCode) matchedSupplierCodes.add(supplierCode);
    }
  }
  if (!matchedSpus.size) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SKC_SEARCH_NOT_FOUND', `donor searchProduct 未找到大小写精确匹配的 SKC ${donorSkc}`)],
      donorSpu: '',
      supplierCode: '',
    };
  }
  if (matchedSpus.size > 1) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SKC_SEARCH_AMBIGUOUS', `donor SKC ${donorSkc} 在 searchProduct 命中 ${matchedSpus.size} 个 SPU，无法唯一确证`)],
      donorSpu: '',
      supplierCode: '',
    };
  }
  if (matchedSupplierCodes.size !== 1) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SKC_SEARCH_AMBIGUOUS', `donor SKC ${donorSkc} 命中唯一 SPU 但 supplierCode 不唯一（${matchedSupplierCodes.size} 个），无法唯一确证`)],
      donorSpu: [...matchedSpus][0],
      supplierCode: '',
    };
  }
  return {
    ok: true,
    blockers: [],
    donorSpu: [...matchedSpus][0],
    supplierCode: [...matchedSupplierCodes][0],
  };
}

function openApiSpuInfoSkcRows(info) {
  return asArray(info?.skcInfoList ?? info?.skc_info_list).filter(row => row && typeof row === 'object');
}

function openApiProductAttributeRows(info) {
  return asArray(info?.productAttributeInfoList ?? info?.product_attribute_info_list)
    .filter(row => row && typeof row === 'object');
}

function donorSpuInfoEvidence(envelope, {donorSkc, donorSpu, searchSupplierCode, taskModelValue, attributeId}) {
  if (String(envelope?.code ?? '') !== '0') {
    return {
      ok: false,
      blockers: [blocker('DONOR_SPU_INFO_QUERY_FAILED', `donor spu-info 返回 code=${safeString(envelope?.code ?? '', 80)}`)],
      supplierCode: '',
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  const info = envelope?.info && typeof envelope.info === 'object' ? envelope.info : {};
  const skcRow = openApiSpuInfoSkcRows(info).find(row => rowSkcName(row) === String(donorSkc));
  if (!skcRow) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SPU_INFO_SKC_MISMATCH', `donor spu-info(${donorSpu}) 不含大小写精确匹配的 SKC ${donorSkc}`)],
      supplierCode: '',
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  const supplierCode = rowSupplierCode(skcRow);
  if (!supplierCode) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SPU_INFO_SUPPLIER_CODE_MISSING', `donor spu-info SKC ${donorSkc} 缺少 supplierCode`)],
      supplierCode: '',
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  // donor searchProduct supplierCode vs donor spu-info supplierCode: RAW-exact.
  if (supplierCode !== String(searchSupplierCode || '')) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SUPPLIER_CODE_CONFLICT', `donor searchProduct supplierCode(${searchSupplierCode}) 与 live spu-info supplierCode(${supplierCode}) 不一致`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  // Live product identity evidence: exactly ONE Product Model(1000546) row
  // whose value equals the task payload's single 1000546 value. Arbitrary
  // attribute values are never identity evidence.
  const modelRows = openApiProductAttributeRows(info).filter(
    row => normalizeProductAttributeId(row?.attribute_id ?? row?.attributeId) === PRODUCT_MODEL_ATTRIBUTE_ID,
  );
  if (!modelRows.length) {
    return {
      ok: false,
      blockers: [blocker('DONOR_PRODUCT_MODEL_MISSING', `donor spu-info(${donorSpu}) 缺少 Product Model(${PRODUCT_MODEL_ATTRIBUTE_ID}) 身份证据`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  if (modelRows.length > 1) {
    return {
      ok: false,
      blockers: [blocker('DONOR_PRODUCT_MODEL_DUPLICATE', `donor spu-info(${donorSpu}) 的 Product Model(${PRODUCT_MODEL_ATTRIBUTE_ID}) 出现 ${modelRows.length} 次，必须恰好一次`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue: '',
    };
  }
  const donorModelValue = safeString(
    modelRows[0]?.attributeValue ?? modelRows[0]?.attribute_value ?? modelRows[0]?.value,
    500,
  );
  if (!donorModelValue || donorModelValue !== String(taskModelValue || '')) {
    return {
      ok: false,
      blockers: [blocker('DONOR_PRODUCT_MODEL_MISMATCH', `donor spu-info(${donorSpu}) 的 Product Model(${donorModelValue || '(empty)'}) 与任务(${taskModelValue}) 不是同一商品`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue,
    };
  }
  const attributeRows = openApiProductAttributeRows(info).filter(
    row => normalizeProductAttributeId(row?.attribute_id ?? row?.attributeId) === attributeId,
  );
  if (!attributeRows.length) {
    return {
      ok: false,
      blockers: [blocker('DONOR_ATTRIBUTE_MISSING', `donor spu-info(${donorSpu}) 缺少目标属性 ${attributeId}`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue,
    };
  }
  if (attributeRows.length > 1) {
    return {
      ok: false,
      blockers: [blocker('DONOR_ATTRIBUTE_DUPLICATE', `donor spu-info(${donorSpu}) 目标属性 ${attributeId} 出现 ${attributeRows.length} 次，必须恰好一次`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue,
    };
  }
  const attributeValueId = normalizeProductAttributeId(attributeRows[0]?.attribute_value_id ?? attributeRows[0]?.attributeValueId);
  if (attributeValueId === null) {
    return {
      ok: false,
      blockers: [blocker('DONOR_ATTRIBUTE_VALUE_INVALID', `donor spu-info(${donorSpu}) 目标属性 ${attributeId} 缺少正整数 attribute_value_id`)],
      supplierCode,
      attributeValueId: null,
      donorModelValue,
    };
  }
  return {ok: true, blockers: [], supplierCode, attributeValueId, donorModelValue};
}

/**
 * Evaluates the complete live donor evidence chain. searchEnvelope and
 * spuInfoEnvelope are the raw SHEIN OpenAPI response envelopes ({code, msg,
 * info}) captured by the server; identity is the reduced store identity
 * verification ({ok, evidenceSha256}) which never carries raw account data;
 * aliasContext is the deterministic strict alias registry context.
 */
export function evaluateDonorProductAttributeEvidence({
  donorStore = '',
  donorSkc = '',
  attributeId = 0,
  aliasContext = null,
  taskRawCode = '',
  taskModelValue = '',
  identity = null,
  searchEnvelope = null,
  spuInfoEnvelope = null,
  verifiedAt = '',
} = {}) {
  const blockers = [];
  const id = normalizeProductAttributeId(attributeId);
  if (id === null || !isWhitelistedProductAttribute(id)) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_NOT_WHITELISTED', `属性 ${safeString(attributeId, 40)} 不在受控白名单（仅 1002328）内`));
  }
  if (!identity || identity.ok !== true || !SHA256_RE.test(String(identity?.evidenceSha256 || ''))) {
    blockers.push(blocker('DONOR_STORE_IDENTITY_UNVERIFIED', `donor 店铺 ${donorStore} 的 OpenAPI 店铺身份未通过独立核验`));
  }
  if (!STORE_KEY_RE.test(String(donorStore || '').toUpperCase())) {
    blockers.push(blocker('DONOR_STORE_INVALID', `donor 店铺 ${safeString(donorStore, 40)} 不是有效店铺代码`));
  }
  const skc = safeString(donorSkc, 160);
  if (!SKC_RE.test(skc)) {
    blockers.push(blocker('DONOR_SKC_INVALID', `donor SKC ${skc || '(empty)'} 不符合 SHEIN SKC 格式`));
  }
  const timestamp = safeString(verifiedAt, 80);
  if (!ISO_DATE_RE.test(timestamp)) {
    blockers.push(blocker('DONOR_EVIDENCE_TIMESTAMP_INVALID', 'donor 证据缺少有效 verifiedAt 时间戳'));
  }
  const taskAlias = resolveExplicitProductAlias(aliasContext, taskRawCode);
  if (!taskAlias.ok) {
    blockers.push(blocker('TASK_SUPPLIER_CODE_ALIAS_UNRESOLVED', `任务标准货号(${taskRawCode}) 别名解析失败：${taskAlias.blockers[0]?.message || '未知原因'}`));
  }
  if (blockers.length) {
    return {ok: false, blockers, evidence: null, attributeValueId: null, donorSpu: '', donorSupplierCode: '', canonicalCode: ''};
  }
  const search = donorSearchProductEvidence(searchEnvelope, skc);
  if (!search.ok) {
    return {ok: false, blockers: search.blockers, evidence: null, attributeValueId: null, donorSpu: '', donorSupplierCode: '', canonicalCode: ''};
  }
  const spuInfo = donorSpuInfoEvidence(spuInfoEnvelope, {
    donorSkc: skc,
    donorSpu: search.donorSpu,
    searchSupplierCode: search.supplierCode,
    taskModelValue: safeString(taskModelValue, 500),
    attributeId: id,
  });
  if (!spuInfo.ok) {
    return {ok: false, blockers: spuInfo.blockers, evidence: null, attributeValueId: null, donorSpu: search.donorSpu, donorSupplierCode: spuInfo.supplierCode, canonicalCode: ''};
  }
  const donorAlias = resolveExplicitProductAlias(aliasContext, spuInfo.supplierCode);
  if (!donorAlias.ok) {
    return {
      ok: false,
      blockers: [blocker(donorAliasCode(donorAlias.blockers[0]?.code) || 'DONOR_ALIAS_UNRESOLVED', `donor supplierCode(${spuInfo.supplierCode}) 别名解析失败：${donorAlias.blockers[0]?.message || '未知原因'}`)],
      evidence: null,
      attributeValueId: null,
      donorSpu: search.donorSpu,
      donorSupplierCode: spuInfo.supplierCode,
      canonicalCode: donorAlias.canonical,
    };
  }
  if (donorAlias.canonical !== taskAlias.canonical) {
    return {
      ok: false,
      blockers: [blocker('DONOR_SUPPLIER_CODE_ALIAS_MISMATCH', `donor canonical(${donorAlias.canonical}) 与任务 canonical(${taskAlias.canonical}) 不是同一商品`)],
      evidence: null,
      attributeValueId: null,
      donorSpu: search.donorSpu,
      donorSupplierCode: spuInfo.supplierCode,
      canonicalCode: donorAlias.canonical,
    };
  }
  const identityEvidenceSha256 = String(identity?.evidenceSha256 || '').toLowerCase();
  const evidence = {
    donorStore: String(donorStore || '').toUpperCase(),
    donorSkc: skc,
    donorSpu: search.donorSpu,
    rawDonorCode: spuInfo.supplierCode,
    rawTaskCode: String(taskRawCode || ''),
    canonicalCode: donorAlias.canonical,
    taskModelValue: safeString(taskModelValue, 500),
    donorModelValue: spuInfo.donorModelValue,
    attributeId: id,
    attributeValueId: spuInfo.attributeValueId,
    verifiedAt: timestamp,
    identityOk: true,
    identityEvidenceSha256,
    aliasRegistryFingerprint: safeString(aliasContext?.aliasRegistryFingerprint, 120),
    aliasRegistrySource: safeString(aliasContext?.aliasRegistrySource, 240),
    catalogFingerprint: safeString(aliasContext?.catalogFingerprint, 120),
    catalogSource: safeString(aliasContext?.catalogSource, 240),
    calls: {
      searchProduct: {code: String(searchEnvelope?.code ?? '')},
      spuInfo: {code: String(spuInfoEnvelope?.code ?? '')},
    },
  };
  evidence.evidenceSha256 = sha256StableJson({
    donorStore: evidence.donorStore,
    donorSkc: evidence.donorSkc,
    donorSpu: evidence.donorSpu,
    rawDonorCode: evidence.rawDonorCode,
    rawTaskCode: evidence.rawTaskCode,
    canonicalCode: evidence.canonicalCode,
    taskModelValue: evidence.taskModelValue,
    donorModelValue: evidence.donorModelValue,
    attributeId: evidence.attributeId,
    attributeValueId: evidence.attributeValueId,
    verifiedAt: evidence.verifiedAt,
    identityEvidenceSha256,
    aliasRegistryFingerprint: evidence.aliasRegistryFingerprint,
    catalogFingerprint: evidence.catalogFingerprint,
  });
  return {
    ok: true,
    blockers: [],
    evidence,
    attributeValueId: spuInfo.attributeValueId,
    donorSpu: search.donorSpu,
    donorSupplierCode: spuInfo.supplierCode,
    canonicalCode: donorAlias.canonical,
  };
}

// ---------------------------------------------------------------------------
// Persisted binding lock
// ---------------------------------------------------------------------------

function bindingBlocker(code, message) {
  return {code, message: safeString(message, 500)};
}

/**
 * Strict persisted-binding lock. The binding is KNOWN only when it is a
 * plain object matching the exact schema, the task payload carries the bound
 * attribute/value exactly once, the current payload hash matches, the
 * previously bound image fingerprint and the description CONTENT (hashes,
 * not the rebind-sensitive request key) are unchanged, and the alias/catalog
 * registry fingerprints are valid sha256 evidence.
 */
export function validateProductAttributeBindingLock(task, payload) {
  const blockers = [];
  const binding = task?.productAttributeBinding && typeof task.productAttributeBinding === 'object'
    ? task.productAttributeBinding
    : null;
  if (!binding) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_MISSING', '任务没有商品属性绑定记录'));
    return {ok: false, blockers};
  }
  if (payloadHasDualProductAttributeLists(payload)) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_DUAL_LIST_PRESENT', 'payload 同时含 product_attribute_list 与 productAttributeList，禁止系统检查/执行'));
  }
  const schemaVersion = Number(binding.schemaVersion);
  const isV2 = schemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION;
  const isV1 = schemaVersion === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1;
  if (!isV1 && !isV2) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_SCHEMA_INVALID', `属性绑定 schemaVersion 无效（当前 ${schemaVersion || '(missing)'}，仅支持 1/2）`));
  }
  if (isV2 && !PRODUCT_ATTRIBUTE_BINDING_MODES.includes(String(binding.bindingMode || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_MODE_INVALID', 'schema v2 属性绑定缺少有效 bindingMode（append_missing/adopt_existing）'));
  }
  if (String(binding.kind || '') !== PRODUCT_ATTRIBUTE_BINDING_KIND) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_KIND_INVALID', '属性绑定 kind 必须是 copy_product_draft'));
  }
  if (String(binding.authority || '') !== PRODUCT_ATTRIBUTE_BINDING_AUTHORITY) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_AUTHORITY_INVALID', '属性绑定 authority 无效'));
  }
  if (!Number.isSafeInteger(Number(binding.baseTaskRevision)) || Number(binding.baseTaskRevision) <= 0) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_BASE_REVISION_INVALID', '属性绑定缺少正整数 baseTaskRevision'));
  }
  if (!SHA256_RE.test(String(binding.bindingRequestKey || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_REQUEST_KEY_INVALID', '属性绑定 bindingRequestKey 不是 sha256'));
  }
  const attributeId = normalizeProductAttributeId(binding.attributeId);
  if (attributeId === null || !isWhitelistedProductAttribute(attributeId)) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_NOT_WHITELISTED', '属性绑定 attributeId 不在白名单'));
  }
  const attributeValueId = normalizeProductAttributeId(binding.attributeValueId);
  if (attributeValueId === null) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_VALUE_INVALID', '属性绑定 attributeValueId 不是正整数'));
  }
  if (!STORE_KEY_RE.test(String(binding.targetStore || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_TARGET_STORE_INVALID', '属性绑定 targetStore 无效'));
  }
  const donor = binding.donor && typeof binding.donor === 'object' ? binding.donor : {};
  if (!STORE_KEY_RE.test(String(donor.storeKey || '').toUpperCase())) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DONOR_STORE_INVALID', '属性绑定 donor.storeKey 无效'));
  }
  const donorSkc = safeString(donor.skc, 160);
  if (!SKC_RE.test(donorSkc)) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DONOR_SKC_INVALID', '属性绑定 donor.skc 无效'));
  }
  const donorSpu = safeString(donor.spu, 160);
  if (!donorSpu) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DONOR_SPU_INVALID', '属性绑定 donor.spu 缺失'));
  }
  const rawDonorCode = safeString(donor.rawCode, 240);
  if (!rawDonorCode) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DONOR_RAW_CODE_INVALID', '属性绑定缺少 donor 原始货号'));
  }
  const rawTaskCode = safeString(binding.taskRawCode, 240);
  if (!rawTaskCode) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_TASK_RAW_CODE_INVALID', '属性绑定缺少任务原始货号'));
  }
  const donorModelValue = safeString(binding.donorModelValue, 500);
  if (!donorModelValue) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DONOR_MODEL_INVALID', '属性绑定缺少 donor Product Model 证据，无法重算证据链'));
  }
  const canonicalCode = safeString(binding.canonicalCode, 240);
  if (!canonicalCode) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_CANONICAL_INVALID', '属性绑定缺少 canonical 身份'));
  }
  if (!ISO_DATE_RE.test(String(binding.verifiedAt || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_VERIFIED_AT_INVALID', '属性绑定 verifiedAt 无效'));
  }
  if (binding.identityOk !== true || !SHA256_RE.test(String(binding.identityEvidenceSha256 || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_IDENTITY_EVIDENCE_INVALID', '属性绑定缺少店铺身份证据'));
  }
  if (!SHA256_RE.test(String(binding.evidenceSha256 || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_EVIDENCE_SHA_INVALID', '属性绑定 evidenceSha256 无效'));
  }
  if (!SHA256_RE.test(String(binding.aliasRegistryFingerprint || ''))
    || !SHA256_RE.test(String(binding.catalogFingerprint || ''))
    || !safeString(binding.aliasRegistrySource, 240)
    || !safeString(binding.catalogSource, 240)) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_ALIAS_REGISTRY_EVIDENCE_INVALID', '属性绑定缺少货号别名注册表/商品目录指纹证据'));
  }
  if (String(binding.payloadHashAlgorithm || '') !== PRODUCT_ATTRIBUTE_PAYLOAD_HASH_ALGORITHM) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_HASH_ALGORITHM_INVALID', '属性绑定 payloadHashAlgorithm 无效'));
  }
  if (!SHA256_RE.test(String(binding.oldPayloadHash || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_OLD_PAYLOAD_HASH_INVALID', '属性绑定 oldPayloadHash 不是 sha256'));
  }
  if (!SHA256_RE.test(String(binding.newPayloadHash || ''))) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_NEW_PAYLOAD_HASH_INVALID', '属性绑定 newPayloadHash 不是 sha256'));
  }
  const oldHash = String(binding.oldPayloadHash || '').toLowerCase();
  const newHash = String(binding.newPayloadHash || '').toLowerCase();
  if (isV2 && SHA256_RE.test(oldHash) && SHA256_RE.test(newHash)) {
    if (String(binding.bindingMode || '') === PRODUCT_ATTRIBUTE_BINDING_MODE_ADOPT && oldHash !== newHash) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_MODE_HASH_INVARIANT', 'adopt_existing 要求 oldPayloadHash === newPayloadHash（payload 未变更）'));
    }
    if (String(binding.bindingMode || '') === PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND && oldHash === newHash) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_MODE_HASH_INVARIANT', 'append_missing 要求 oldPayloadHash !== newPayloadHash（必须恰好追加一行）'));
    }
  }
  // v1 compatibility is restricted to genuine historical append bindings: a
  // v2 adopt binding downgraded to v1 (bindingMode removed, old v1 request
  // key recomputed) must never verify, because adopt is old==new.
  if (isV1 && SHA256_RE.test(oldHash) && SHA256_RE.test(newHash) && oldHash === newHash) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_V1_HASH_INVARIANT', 'schema v1 仅兼容历史 append_missing 绑定：oldPayloadHash 必须 != newPayloadHash（adopt 形态拒绝）'));
  }
  const currentImageFingerprint = String(task?.publishAssetBinding?.bindingFingerprint || '');
  if (String(binding.imageBindingFingerprint || '') !== currentImageFingerprint) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_IMAGE_FINGERPRINT_DRIFT', '属性绑定后图片绑定指纹发生变化，禁止沿用旧绑定'));
  }
  // Description content pinning: contentSha256 + per-language hashes are
  // stable across a legitimate step-2 prepare-descriptions rebind of the
  // same material (the rebind only advances baseTaskRevision/request key).
  const currentDescription = task?.descriptionMaterialBinding && typeof task.descriptionMaterialBinding === 'object'
    ? task.descriptionMaterialBinding
    : null;
  const currentDescriptionContent = String(currentDescription?.contentSha256 || '');
  const currentDescriptionHashes = currentDescription?.hashes && typeof currentDescription.hashes === 'object'
    ? currentDescription.hashes
    : {};
  if (String(binding.descriptionContentSha256 || '') !== currentDescriptionContent) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DESCRIPTION_CONTENT_DRIFT', '属性绑定后描述内容 hash 发生变化，禁止沿用旧绑定'));
  }
  for (const language of DESCRIPTION_PINNED_LANGUAGES) {
    const expected = String(binding.descriptionHashes?.[language] || '').toLowerCase();
    const actual = String(currentDescriptionHashes?.[language] || '').toLowerCase();
    if (expected !== actual) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_DESCRIPTION_HASH_DRIFT', `属性绑定后描述 ${language} hash 发生变化，禁止沿用旧绑定`));
    }
  }
  if (attributeId !== null && attributeValueId !== null) {
    const rows = productAttributeRowsForId(payload, attributeId);
    const exact = rows.length === 1
      && normalizeProductAttributeId(rows[0]?.attribute_value_id ?? rows[0]?.attributeValueId) === attributeValueId;
    if (!exact) {
      blockers.push(bindingBlocker(
        'PRODUCT_ATTRIBUTE_PAYLOAD_MISMATCH',
        `payload 中属性 ${attributeId}=${attributeValueId} 必须恰好出现一次（当前 ${rows.length} 行）`,
      ));
    }
  }
  if (String(binding.newPayloadHash || '').toLowerCase() !== sha256StableJson(payload ?? {})) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_PAYLOAD_HASH_DRIFT', 'payload hash 与属性绑定锁定值不一致'));
  }
  // Deterministic recomputation. The persisted evidence chain must be fully
  // reproducible from canonical binding fields: a coordinated mutation of
  // payload value + binding.attributeValueId + newPayloadHash that keeps the
  // OLD evidenceSha256/bindingRequestKey can never satisfy these equalities.
  // Legacy/malformed records without donorModelValue already failed above.
  if (attributeId !== null && attributeValueId !== null && donorModelValue) {
    const recomputedEvidenceSha256 = sha256StableJson({
      donorStore: String(donor.storeKey || ''),
      donorSkc: String(donor.skc || ''),
      donorSpu: String(donor.spu || ''),
      rawDonorCode: String(donor.rawCode || ''),
      rawTaskCode: String(binding.taskRawCode || ''),
      canonicalCode: String(binding.canonicalCode || ''),
      taskModelValue: String(binding.taskModelValue || ''),
      donorModelValue,
      attributeId,
      attributeValueId,
      verifiedAt: String(binding.verifiedAt || ''),
      identityEvidenceSha256: String(binding.identityEvidenceSha256 || '').toLowerCase(),
      aliasRegistryFingerprint: String(binding.aliasRegistryFingerprint || ''),
      catalogFingerprint: String(binding.catalogFingerprint || ''),
    });
    if (recomputedEvidenceSha256 !== String(binding.evidenceSha256 || '').toLowerCase()) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_EVIDENCE_SHA_DRIFT', '属性绑定 evidenceSha256 与持久化 donor 证据链重算值不一致，禁止沿用旧绑定'));
    }
    const recomputedRequestKey = isV2
      ? productAttributeBindingRequestKeyV2({
          schemaVersion: PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION,
          bindingMode: String(binding.bindingMode || ''),
          taskId: String(task?.id || ''),
          targetStore: String(binding.targetStore || ''),
          baseTaskRevision: Number(binding.baseTaskRevision || 0),
          attributeId,
          attributeValueId,
          donorStore: String(donor.storeKey || ''),
          donorSkc: String(donor.skc || ''),
          donorSpu: String(donor.spu || ''),
          evidenceSha256: String(binding.evidenceSha256 || ''),
          oldPayloadHash: String(binding.oldPayloadHash || ''),
          newPayloadHash: String(binding.newPayloadHash || ''),
        })
      : productAttributeBindingRequestKey({
          taskId: String(task?.id || ''),
          targetStore: String(binding.targetStore || ''),
          baseTaskRevision: Number(binding.baseTaskRevision || 0),
          attributeId,
          attributeValueId,
          donorStore: String(donor.storeKey || ''),
          donorSkc: String(donor.skc || ''),
          donorSpu: String(donor.spu || ''),
          evidenceSha256: String(binding.evidenceSha256 || ''),
        });
    if (recomputedRequestKey !== String(binding.bindingRequestKey || '').toLowerCase()) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_BINDING_REQUEST_KEY_DRIFT', '属性绑定 bindingRequestKey 与任务身份/属性值/donor 证据重算值不一致，禁止沿用旧绑定'));
    }
  }
  return {ok: blockers.length === 0, blockers};
}

/**
 * Client-safe projection of the persisted binding: provenance and hashes
 * only, never payload content or raw account identity.
 */
export function projectProductAttributeBindingCommit(task, {idempotentReplay = false} = {}) {
  const binding = task?.productAttributeBinding && typeof task.productAttributeBinding === 'object'
    ? task.productAttributeBinding
    : {};
  const donor = binding.donor && typeof binding.donor === 'object' ? binding.donor : {};
  return {
    schemaVersion: Number(binding.schemaVersion) === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
      ? PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
      : Number(binding.schemaVersion) === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION
        ? PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION
        : 0,
    bindingMode: String(binding.bindingMode || PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND),
    targetStore: String(binding.targetStore || ''),
    attributeId: normalizeProductAttributeId(binding.attributeId),
    attributeValueId: normalizeProductAttributeId(binding.attributeValueId),
    attributeName: whitelistedProductAttributeName(binding.attributeId),
    donorStore: String(donor.storeKey || ''),
    donorSkc: String(donor.skc || ''),
    donorSpu: String(donor.spu || ''),
    rawDonorCode: String(donor.rawCode || ''),
    rawTaskCode: String(binding.taskRawCode || ''),
    canonicalCode: String(binding.canonicalCode || ''),
    taskModelValue: String(binding.taskModelValue || ''),
    verifiedAt: String(binding.verifiedAt || ''),
    identityOk: binding.identityOk === true,
    identityEvidenceSha256: String(binding.identityEvidenceSha256 || ''),
    evidenceSha256: String(binding.evidenceSha256 || ''),
    aliasRegistryFingerprint: String(binding.aliasRegistryFingerprint || ''),
    aliasRegistrySource: String(binding.aliasRegistrySource || ''),
    catalogFingerprint: String(binding.catalogFingerprint || ''),
    catalogSource: String(binding.catalogSource || ''),
    oldPayloadHash: String(binding.oldPayloadHash || ''),
    newPayloadHash: String(binding.newPayloadHash || ''),
    payloadHashAlgorithm: String(binding.payloadHashAlgorithm || ''),
    baseTaskRevision: Number(binding.baseTaskRevision || 0),
    bindingRequestKey: String(binding.bindingRequestKey || ''),
    preflightInvalidated: true,
    imageBindingFingerprintUnchanged: true,
    descriptionContentPinned: true,
    idempotentReplay,
  };
}
