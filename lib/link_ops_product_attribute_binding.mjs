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
// Request-only mode: re-sign an existing binding's provenance after fresh
// live donor verification. It is never persisted as a bindingMode.
export const PRODUCT_ATTRIBUTE_REQUEST_MODE_REFRESH = 'refresh_binding';

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
  resignSanitization = null,
} = {}) {
  const sanitization = resignSanitization && typeof resignSanitization === 'object'
    ? resignSanitization
    : null;
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
    ...(sanitization ? [
      `resign-removed-count:${String(sanitization.removedCount)}`,
      `resign-before:${String(sanitization.currentPayloadHashBeforeSanitization || '').toLowerCase()}`,
      `resign-after:${String(sanitization.currentPayloadHashAfterSanitization || '').toLowerCase()}`,
      `resign-path-digest:${String(sanitization.removedPathDigest || '').toLowerCase()}`,
      `resign-evidence:${String(sanitization.evidenceSha256 || '').toLowerCase()}`,
    ] : []),
  ].join('\n'));
}

export function productAttributeResignSanitizationEvidence({
  removedCount = 0,
  currentPayloadHashBeforeSanitization = '',
  currentPayloadHashAfterSanitization = '',
  removedPathSummary = [],
} = {}) {
  const paths = asArray(removedPathSummary).map(path => String(path || ''));
  const evidence = {
    removedCount: Number(removedCount),
    currentPayloadHashBeforeSanitization: String(currentPayloadHashBeforeSanitization || '').toLowerCase(),
    currentPayloadHashAfterSanitization: String(currentPayloadHashAfterSanitization || '').toLowerCase(),
    removedPathSummary: paths,
    removedPathDigest: sha256StableJson(paths),
  };
  return {
    ...evidence,
    evidenceSha256: sha256StableJson(evidence),
  };
}

/**
 * Deterministic refresh event key: identical retries (audit-pending) produce
 * the identical event key, and repeated CAS/history writes are impossible.
 */
export function productAttributeRefreshEventKey({
  taskId = '',
  previousBindingRequestKey = '',
  newBindingRequestKey = '',
} = {}) {
  return sha256Utf8([
    'refresh_binding',
    String(taskId || ''),
    String(previousBindingRequestKey || '').toLowerCase(),
    String(newBindingRequestKey || '').toLowerCase(),
  ].join('\n'));
}

export function productAttributeResignEventKey({
  taskId = '',
  previousBindingRequestKey = '',
  newBindingRequestKey = '',
  previousRepositoryRevision = 0,
  currentRepositoryRevision = 0,
} = {}) {
  return sha256Utf8([
    'resign_binding',
    String(taskId || ''),
    String(previousBindingRequestKey || '').toLowerCase(),
    String(newBindingRequestKey || '').toLowerCase(),
    String(Number(previousRepositoryRevision) || 0),
    String(Number(currentRepositoryRevision) || 0),
  ].join('\n'));
}

/**
 * v1 refresh history gate: a schema-v1 binding may only be refreshed when an
 * immutable original product_attribute_bound history event matches the
 * current binding field-for-field. Missing, conflicting or incomplete
 * history fails closed. This validator never mutates; a caller may use its
 * proof as one gate in a separately controlled, live-reverified v2 upgrade.
 */
export function validateV1ProductAttributeHistory(task, binding) {
  if (!binding || typeof binding !== 'object') {
    return {
      ok: false,
      blockers: [blocker('PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', 'v1 刷新要求存在原始 product_attribute_bound 历史事件')],
    };
  }
  const entries = asArray(task?.history).filter(entry => entry?.event === 'product_attribute_bound');
  if (!entries.length) {
    return {
      ok: false,
      blockers: [blocker('PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', 'v1 刷新要求存在原始 product_attribute_bound 历史事件')],
    };
  }
  const donor = binding.donor && typeof binding.donor === 'object' ? binding.donor : {};
  // Canonical full projection of every immutable binding field that the
  // original product_attribute_bound history must record. Future omissions
  // in either side fail closed instead of silently comparing a subset.
  const expected = {
    bindingRequestKey: String(binding.bindingRequestKey || '').toLowerCase(),
    attributeId: normalizeProductAttributeId(binding.attributeId),
    attributeValueId: normalizeProductAttributeId(binding.attributeValueId),
    donor: {
      storeKey: String(donor.storeKey || '').toUpperCase(),
      skc: String(donor.skc || ''),
      spu: String(donor.spu || ''),
      rawCode: String(donor.rawCode || ''),
    },
    taskRawCode: String(binding.taskRawCode || ''),
    canonicalCode: String(binding.canonicalCode || ''),
    taskModelValue: String(binding.taskModelValue || ''),
    evidenceSha256: String(binding.evidenceSha256 || '').toLowerCase(),
    oldPayloadHash: String(binding.oldPayloadHash || '').toLowerCase(),
    newPayloadHash: String(binding.newPayloadHash || '').toLowerCase(),
    payloadHashAlgorithm: String(binding.payloadHashAlgorithm || ''),
    baseTaskRevision: Number(binding.baseTaskRevision || 0),
    imageBindingFingerprint: String(binding.imageBindingFingerprint || ''),
    descriptionContentSha256: String(binding.descriptionContentSha256 || ''),
    descriptionHashes: {
      ar: String(binding.descriptionHashes?.ar || '').toLowerCase(),
      en: String(binding.descriptionHashes?.en || '').toLowerCase(),
      'zh-cn': String(binding.descriptionHashes?.['zh-cn'] || '').toLowerCase(),
    },
  };
  const entryIdentityMatches = entry => {
    const entryDonor = entry?.donor && typeof entry.donor === 'object' ? entry.donor : {};
    return normalizeProductAttributeId(entry?.attributeId) === expected.attributeId
      && String(entryDonor.storeKey || '').toUpperCase() === expected.donor.storeKey
      && String(entryDonor.skc || '') === expected.donor.skc
      && String(entryDonor.spu || '') === expected.donor.spu
      && String(entryDonor.rawCode || '') === expected.donor.rawCode
      && String(entry?.taskRawCode || '') === expected.taskRawCode
      && String(entry?.canonicalCode || '') === expected.canonicalCode;
  };

  // A v1 binding may have been legitimately re-signed by refresh_binding
  // before later task/image revisions. In that case the current key,
  // evidence and base revision no longer equal the original bound event.
  // Prove the complete immutable chain instead:
  //   original product_attribute_bound -> unique refresh event -> current v1.
  // The refresh validator binds the current side; the checks below bind its
  // recorded previous key/evidence/base revision back to exactly one original
  // event and preserve every field that refresh_binding is not allowed to
  // change.
  const refreshEvent = task?.productAttributeRefreshEvent && typeof task.productAttributeRefreshEvent === 'object'
    ? task.productAttributeRefreshEvent
    : null;
  const refreshHistoryEntries = asArray(task?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed');
  if (!refreshEvent && refreshHistoryEntries.length) {
    return {
      ok: false,
      blockers: [blocker(
        'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
        `v1 任务存在 ${refreshHistoryEntries.length} 条孤立 refresh 历史但缺少当前 refresh 事件`,
      )],
    };
  }
  if (refreshEvent) {
    const refreshGate = validateProductAttributeRefreshEvent(task, {requireFreshRevision: false});
    if (!refreshGate.ok) {
      return {
        ok: false,
        blockers: [blocker(
          'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
          `v1 历史的 refresh 事件无效：${refreshGate.blockers.map(row => row.message).join('；')}`,
        )],
      };
    }
    const refreshEntries = refreshHistoryEntries;
    const consumedRefreshEntries = new Set();
    const seenBindingKeys = new Set();
    let cursorKey = expected.bindingRequestKey;
    let immediatePreviousEvidence = String(refreshEvent.previousEvidenceSha256 || '').toLowerCase();
    let immediatePreviousBaseRevision = Number(refreshEvent.previousBaseTaskRevision || 0);
    let traversedRefreshCount = 0;
    let successorPreviousRevision = null;
    let oldestRefreshPreviousRevision = 0;
    while (true) {
      if (!SHA256_RE.test(cursorKey) || seenBindingKeys.has(cursorKey)) {
        return {
          ok: false,
          blockers: [blocker('PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', 'v1 refresh 历史存在无效 binding key 或循环链')],
        };
      }
      seenBindingKeys.add(cursorKey);
      const candidates = refreshEntries.filter((entry, index) => (
        !consumedRefreshEntries.has(index)
        && String(entry?.newBindingRequestKey || '').toLowerCase() === cursorKey
      ));
      if (!candidates.length) break;
      const candidate = candidates[0];
      const candidateRevision = Number(candidate?.currentRepositoryRevision || 0);
      const scopedCandidates = refreshEntries.filter((entry, index) => (
        !consumedRefreshEntries.has(index)
        && (String(entry?.newBindingRequestKey || '').toLowerCase() === cursorKey
          || Number(entry?.currentRepositoryRevision || 0) === candidateRevision)
      ));
      if (candidates.length !== 1 || scopedCandidates.length !== 1) {
        return {
          ok: false,
          blockers: [blocker(
            'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
            `v1 refresh 每一跳必须唯一（key 匹配 ${candidates.length}，范围 ${scopedCandidates.length}）`,
          )],
        };
      }
      const entryIndex = refreshEntries.indexOf(candidate);
      consumedRefreshEntries.add(entryIndex);
      const entryDonor = candidate?.donor && typeof candidate.donor === 'object' ? candidate.donor : {};
      const previousKey = String(candidate?.previousBindingRequestKey || '').toLowerCase();
      const recomputedNewKey = productAttributeBindingRequestKey({
        taskId: String(task?.id || ''),
        targetStore: String(binding.targetStore || ''),
        baseTaskRevision: Number(candidate?.baseTaskRevision || 0),
        attributeId: normalizeProductAttributeId(candidate?.attributeId),
        attributeValueId: normalizeProductAttributeId(candidate?.attributeValueId),
        donorStore: String(entryDonor.storeKey || ''),
        donorSkc: String(entryDonor.skc || ''),
        donorSpu: String(entryDonor.spu || ''),
        evidenceSha256: String(candidate?.evidenceSha256 || ''),
      });
      const recomputedEventKey = productAttributeRefreshEventKey({
        taskId: String(task?.id || ''),
        previousBindingRequestKey: previousKey,
        newBindingRequestKey: cursorKey,
      });
      const normalizedEntryMode = String(candidate?.bindingMode || PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND);
      const candidatePreviousRevision = Number(candidate?.previousRepositoryRevision || 0);
      const candidateCurrentRevision = Number(candidate?.currentRepositoryRevision || 0);
      const hopOk = SHA256_RE.test(previousKey)
        && String(candidate?.eventKey || '').toLowerCase() === recomputedEventKey
        && recomputedNewKey === cursorKey
        && Number(candidate?.schemaVersion) === PRODUCT_ATTRIBUTE_BINDING_SCHEMA_VERSION_V1
        && normalizedEntryMode === PRODUCT_ATTRIBUTE_BINDING_MODE_APPEND
        && candidateCurrentRevision === candidatePreviousRevision + 1
        && Number(candidate?.baseTaskRevision || 0) === candidatePreviousRevision
        && (successorPreviousRevision === null || candidateCurrentRevision <= successorPreviousRevision)
        && normalizeProductAttributeId(candidate?.attributeId) === expected.attributeId
        && normalizeProductAttributeId(candidate?.attributeValueId) === expected.attributeValueId
        && String(entryDonor.storeKey || '').toUpperCase() === expected.donor.storeKey
        && String(entryDonor.skc || '') === expected.donor.skc
        && String(entryDonor.spu || '') === expected.donor.spu
        && String(entryDonor.rawCode || '') === expected.donor.rawCode
        && String(candidate?.canonicalCode || '') === expected.canonicalCode
        && String(candidate?.oldPayloadHash || '').toLowerCase() === expected.oldPayloadHash
        && String(candidate?.newPayloadHash || '').toLowerCase() === expected.newPayloadHash
        && SHA256_RE.test(String(candidate?.evidenceSha256 || '').toLowerCase())
        && SHA256_RE.test(String(candidate?.aliasRegistryFingerprint || '').toLowerCase())
        && SHA256_RE.test(String(candidate?.catalogFingerprint || '').toLowerCase());
      if (!hopOk) {
        return {
          ok: false,
          blockers: [blocker('PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', 'v1 refresh 链存在字段、哈希、身份或 revision 不一致')],
        };
      }
      traversedRefreshCount += 1;
      successorPreviousRevision = candidatePreviousRevision;
      oldestRefreshPreviousRevision = candidatePreviousRevision;
      cursorKey = previousKey;
      if (traversedRefreshCount === 1) {
        const predecessorRefresh = refreshEntries.find(entry => (
          String(entry?.newBindingRequestKey || '').toLowerCase() === cursorKey
        ));
        if (predecessorRefresh) {
          if (String(predecessorRefresh?.evidenceSha256 || '').toLowerCase() !== immediatePreviousEvidence
            || Number(predecessorRefresh?.baseTaskRevision || 0) !== immediatePreviousBaseRevision) {
            return {
              ok: false,
              blockers: [blocker('PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID', 'v1 当前 refresh 事件与上一跳 evidence/base revision 不一致')],
            };
          }
          immediatePreviousEvidence = '';
          immediatePreviousBaseRevision = 0;
        }
      }
    }
    if (traversedRefreshCount < 1 || consumedRefreshEntries.size !== refreshEntries.length) {
      return {
        ok: false,
        blockers: [blocker(
          'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
          `v1 refresh 历史必须形成一条完整唯一链（已回溯 ${traversedRefreshCount}，总 ${refreshEntries.length}）`,
        )],
      };
    }
    const previousKey = cursorKey;
    const keyedOriginals = entries.filter(entry => String(entry?.bindingRequestKey || '').toLowerCase() === previousKey);
    const originalBaseRevision = immediatePreviousBaseRevision > 0
      ? immediatePreviousBaseRevision
      : Number(keyedOriginals[0]?.baseTaskRevision || 0);
    const scopedOriginals = entries.filter(entry => (
      String(entry?.bindingRequestKey || '').toLowerCase() === previousKey
      || (originalBaseRevision > 0
        && Number(entry?.baseTaskRevision || 0) === originalBaseRevision
        && entryIdentityMatches(entry))
    ));
    const matchingOriginals = scopedOriginals.filter(entry => {
      const entryDonor = entry?.donor && typeof entry.donor === 'object' ? entry.donor : {};
      const entryHashes = entry?.descriptionHashes && typeof entry.descriptionHashes === 'object' ? entry.descriptionHashes : {};
      const entryKey = String(entry?.bindingRequestKey || '').toLowerCase();
      const recomputedKey = productAttributeBindingRequestKey({
        taskId: String(task?.id || ''),
        targetStore: String(entry?.targetStore || ''),
        baseTaskRevision: Number(entry?.baseTaskRevision || 0),
        attributeId: normalizeProductAttributeId(entry?.attributeId),
        attributeValueId: normalizeProductAttributeId(entry?.attributeValueId),
        donorStore: String(entryDonor.storeKey || ''),
        donorSkc: String(entryDonor.skc || ''),
        donorSpu: String(entryDonor.spu || ''),
        evidenceSha256: String(entry?.evidenceSha256 || ''),
      });
      return entryKey === previousKey
        && entryKey === recomputedKey
        && (!immediatePreviousEvidence || immediatePreviousEvidence === String(entry?.evidenceSha256 || '').toLowerCase())
        && (!immediatePreviousBaseRevision || Number(entry?.baseTaskRevision || 0) === immediatePreviousBaseRevision)
        && Number(entry?.baseTaskRevision || 0) + 1 <= oldestRefreshPreviousRevision
        && String(entry?.targetStore || '').toUpperCase() === String(binding.targetStore || '').toUpperCase()
        && normalizeProductAttributeId(entry?.attributeId) === expected.attributeId
        && normalizeProductAttributeId(entry?.attributeValueId) === expected.attributeValueId
        && String(entryDonor.storeKey || '').toUpperCase() === expected.donor.storeKey
        && String(entryDonor.skc || '') === expected.donor.skc
        && String(entryDonor.spu || '') === expected.donor.spu
        && String(entryDonor.rawCode || '') === expected.donor.rawCode
        && String(entry?.taskRawCode || '') === expected.taskRawCode
        && String(entry?.canonicalCode || '') === expected.canonicalCode
        && String(entry?.taskModelValue || '') === expected.taskModelValue
        && String(entry?.oldPayloadHash || '').toLowerCase() === expected.oldPayloadHash
        && String(entry?.newPayloadHash || '').toLowerCase() === expected.newPayloadHash
        && String(entry?.payloadHashAlgorithm || '') === expected.payloadHashAlgorithm
        && String(entry?.imageBindingFingerprint || '') === expected.imageBindingFingerprint
        && String(entry?.descriptionContentSha256 || '') === expected.descriptionContentSha256
        && String(entryHashes.ar || '').toLowerCase() === expected.descriptionHashes.ar
        && String(entryHashes.en || '').toLowerCase() === expected.descriptionHashes.en
        && String(entryHashes['zh-cn'] || '').toLowerCase() === expected.descriptionHashes['zh-cn'];
    });
    if (scopedOriginals.length !== 1 || matchingOriginals.length !== 1) {
      return {
        ok: false,
        blockers: [blocker(
          'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
          `v1 refresh 链必须回溯到恰好一条完整原始绑定（范围 ${scopedOriginals.length}，完整 ${matchingOriginals.length}）；重复、冲突或不完整均拒绝`,
        )],
      };
    }
    return {ok: true, blockers: []};
  }
  const scopedEntries = entries.filter(entry => (
    String(entry?.bindingRequestKey || '').toLowerCase() === expected.bindingRequestKey
    || (Number(entry?.baseTaskRevision || 0) === expected.baseTaskRevision && entryIdentityMatches(entry))
  ));
  const fullyMatchingEntries = scopedEntries.filter(entry => {
    const entryDonor = entry?.donor && typeof entry.donor === 'object' ? entry.donor : {};
    const entryHashes = entry?.descriptionHashes && typeof entry.descriptionHashes === 'object' ? entry.descriptionHashes : {};
    return String(entry?.bindingRequestKey || '').toLowerCase() === expected.bindingRequestKey
      && normalizeProductAttributeId(entry?.attributeId) === expected.attributeId
      && normalizeProductAttributeId(entry?.attributeValueId) === expected.attributeValueId
      && String(entryDonor.storeKey || '').toUpperCase() === expected.donor.storeKey
      && String(entryDonor.skc || '') === expected.donor.skc
      && String(entryDonor.spu || '') === expected.donor.spu
      && String(entryDonor.rawCode || '') === expected.donor.rawCode
      && String(entry?.taskRawCode || '') === expected.taskRawCode
      && String(entry?.canonicalCode || '') === expected.canonicalCode
      && String(entry?.taskModelValue || '') === expected.taskModelValue
      && String(entry?.evidenceSha256 || '').toLowerCase() === expected.evidenceSha256
      && String(entry?.oldPayloadHash || '').toLowerCase() === expected.oldPayloadHash
      && String(entry?.newPayloadHash || '').toLowerCase() === expected.newPayloadHash
      && String(entry?.payloadHashAlgorithm || '') === expected.payloadHashAlgorithm
      && Number(entry?.baseTaskRevision || 0) === expected.baseTaskRevision
      && String(entry?.imageBindingFingerprint || '') === expected.imageBindingFingerprint
      && String(entry?.descriptionContentSha256 || '') === expected.descriptionContentSha256
      && String(entryHashes.ar || '').toLowerCase() === expected.descriptionHashes.ar
      && String(entryHashes.en || '').toLowerCase() === expected.descriptionHashes.en
      && String(entryHashes['zh-cn'] || '').toLowerCase() === expected.descriptionHashes['zh-cn'];
  });
  if (scopedEntries.length !== 1 || fullyMatchingEntries.length !== 1) {
    return {
      ok: false,
      blockers: [blocker(
        'PRODUCT_ATTRIBUTE_REFRESH_V1_HISTORY_INVALID',
        `v1 历史按 binding key/base revision/同一身份筛选后必须恰好一条完整匹配（范围 ${scopedEntries.length}，完整 ${fullyMatchingEntries.length}）；重复、冲突或不完整均拒绝`,
      )],
    };
  }
  return {ok: true, blockers: []};
}

/**
 * Refresh-event integrity: the persisted refreshEvent is never trusted.
 * The event key is recomputed from taskId + previous key + the CURRENT new
 * binding key; the stored newBindingRequestKey must equal the current
 * binding key; the current revision must be previousRepositoryRevision + 1;
 * and exactly ONE immutable history event must match the recomputed event
 * key, previous/new keys, previous/current revisions and full binding
 * identity. Missing/duplicate/conflicting history or any mismatch fails
 * closed with zero writes.
 */
export function validateProductAttributeRefreshEvent(task, {requireFreshRevision = true} = {}) {
  const blockers = [];
  const event = task?.productAttributeRefreshEvent && typeof task.productAttributeRefreshEvent === 'object'
    ? task.productAttributeRefreshEvent
    : null;
  const binding = task?.productAttributeBinding && typeof task.productAttributeBinding === 'object'
    ? task.productAttributeBinding
    : null;
  if (!event || !binding) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID', '缺少 refresh 事件或绑定'));
    return {ok: false, blockers, recomputedEventKey: ''};
  }
  const currentKey = String(binding.bindingRequestKey || '').toLowerCase();
  const previousKey = String(event.previousBindingRequestKey || '').toLowerCase();
  const storedNewKey = String(event.newBindingRequestKey || '').toLowerCase();
  const recomputedEventKey = productAttributeRefreshEventKey({
    taskId: String(task?.id || ''),
    previousBindingRequestKey: previousKey,
    newBindingRequestKey: currentKey,
  });
  if (!/^[a-f0-9]{64}$/.test(previousKey) || !/^[a-f0-9]{64}$/.test(currentKey)) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID', 'refresh 事件的 binding key 格式无效'));
  }
  if (storedNewKey !== currentKey) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID', 'refresh 事件的 newBindingRequestKey 与当前绑定不一致'));
  }
  if (String(event.eventKey || '').toLowerCase() !== recomputedEventKey) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID', 'refresh 事件 eventKey 与重算值不一致'));
  }
  const currentRevision = Number(task?.repositoryRevision || 0);
  if (requireFreshRevision && currentRevision !== Number(event.previousRepositoryRevision || 0) + 1) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID', 'refresh 事件 revision 不满足 current === previous + 1'));
  }
  // Multiple legitimate refresh lifecycles are allowed: earlier valid
  // refresh history rows remain, and the current event must match EXACTLY
  // ONE row filtered by the current recomputed event key, previous/new keys,
  // previous/current revisions and full binding identity. Duplicate or
  // conflicting matches still fail closed.
  const refreshEntries = asArray(task?.history).filter(entry => entry?.event === 'product_attribute_binding_refreshed');
  const bindingDonor = binding.donor && typeof binding.donor === 'object' ? binding.donor : {};
  const scopedEntries = refreshEntries.filter(entry => (
    String(entry?.eventKey || '').toLowerCase() === recomputedEventKey
    || (String(entry?.previousBindingRequestKey || '').toLowerCase() === previousKey
      && String(entry?.newBindingRequestKey || '').toLowerCase() === currentKey)
    || (Number(entry?.previousRepositoryRevision || 0) === Number(event.previousRepositoryRevision || 0)
      && Number(entry?.currentRepositoryRevision || 0) === Number(event.previousRepositoryRevision || 0) + 1)
  ));
  const matchingEntries = scopedEntries.filter(entry => {
    const entryDonor = entry?.donor && typeof entry.donor === 'object' ? entry.donor : {};
    return String(entry?.eventKey || '').toLowerCase() === recomputedEventKey
      && String(entry?.previousBindingRequestKey || '').toLowerCase() === previousKey
      && String(entry?.newBindingRequestKey || '').toLowerCase() === currentKey
      && Number(entry?.previousRepositoryRevision || 0) === Number(event.previousRepositoryRevision || 0)
      && Number(entry?.currentRepositoryRevision || 0) === Number(event.previousRepositoryRevision || 0) + 1
      && (!requireFreshRevision || Number(entry?.currentRepositoryRevision || 0) === currentRevision)
      && normalizeProductAttributeId(entry?.attributeId) === normalizeProductAttributeId(binding.attributeId)
      && normalizeProductAttributeId(entry?.attributeValueId) === normalizeProductAttributeId(binding.attributeValueId)
      && String(entryDonor.storeKey || '').toUpperCase() === String(bindingDonor.storeKey || '').toUpperCase()
      && String(entryDonor.skc || '') === String(bindingDonor.skc || '')
      && String(entryDonor.spu || '') === String(bindingDonor.spu || '')
      && String(entry?.canonicalCode || '') === String(binding.canonicalCode || '')
      && String(entry?.evidenceSha256 || '').toLowerCase() === String(binding.evidenceSha256 || '').toLowerCase()
      && String(entry?.oldPayloadHash || '').toLowerCase() === String(binding.oldPayloadHash || '').toLowerCase()
      && String(entry?.newPayloadHash || '').toLowerCase() === String(binding.newPayloadHash || '').toLowerCase()
      && Number(entry?.baseTaskRevision || 0) === Number(binding.baseTaskRevision || 0);
  });
  if (scopedEntries.length !== 1 || matchingEntries.length !== 1) {
    blockers.push(blocker(
      'PRODUCT_ATTRIBUTE_REFRESH_EVENT_INVALID',
      `refresh 历史事件按当前事件/绑定身份过滤后必须恰好匹配 1 条（范围 ${scopedEntries.length}，匹配 ${matchingEntries.length}，总 ${refreshEntries.length}）`,
    ));
  }
  return {ok: blockers.length === 0, blockers, recomputedEventKey};
}

export function validateProductAttributeResignEvent(task, {requireFreshRevision = true} = {}) {
  const blockers = [];
  const event = task?.productAttributeResignEvent && typeof task.productAttributeResignEvent === 'object'
    ? task.productAttributeResignEvent
    : null;
  const binding = task?.productAttributeBinding && typeof task.productAttributeBinding === 'object'
    ? task.productAttributeBinding
    : null;
  if (!event || !binding) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', '缺少 resign 事件或当前绑定'));
    return {ok: false, blockers, recomputedEventKey: ''};
  }
  const previousKey = String(event.previousBindingRequestKey || '').toLowerCase();
  const currentKey = String(binding.bindingRequestKey || '').toLowerCase();
  const previousRevision = Number(event.previousRepositoryRevision || 0);
  const currentRevision = Number(event.currentRepositoryRevision || 0);
  const recomputedEventKey = productAttributeResignEventKey({
    taskId: String(task?.id || ''),
    previousBindingRequestKey: previousKey,
    newBindingRequestKey: currentKey,
    previousRepositoryRevision: previousRevision,
    currentRepositoryRevision: currentRevision,
  });
  if (!SHA256_RE.test(previousKey) || !SHA256_RE.test(currentKey)) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', 'resign 事件 binding key 格式无效'));
  }
  if (String(event.newBindingRequestKey || '').toLowerCase() !== currentKey) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', 'resign 事件 newBindingRequestKey 与当前绑定不一致'));
  }
  if (String(event.eventKey || '').toLowerCase() !== recomputedEventKey) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', 'resign 事件 eventKey 与重算值不一致'));
  }
  if (currentRevision !== previousRevision + 1
    || Number(binding.baseTaskRevision || 0) !== previousRevision) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', 'resign 事件/binding revision 链不满足 current === previous + 1'));
  }
  if (requireFreshRevision && Number(task?.repositoryRevision || 0) !== currentRevision) {
    blockers.push(blocker('PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID', 'resign 事件 current revision 与任务不一致'));
  }
  const donor = binding.donor && typeof binding.donor === 'object' ? binding.donor : {};
  const resignEntries = asArray(task?.history).filter(entry => entry?.event === 'product_attribute_resigned');
  const scopedEntries = resignEntries.filter(entry => (
    String(entry?.eventKey || '').toLowerCase() === recomputedEventKey
    || (Number(entry?.previousRepositoryRevision || 0) === previousRevision
      && Number(entry?.currentRepositoryRevision || 0) === currentRevision)
    || String(entry?.newBindingRequestKey || entry?.bindingRequestKey || '').toLowerCase() === currentKey
  ));
  const matchingEntries = scopedEntries.filter(entry => {
    const entryDonor = entry?.donor && typeof entry.donor === 'object' ? entry.donor : {};
    return String(entry?.eventKey || '').toLowerCase() === recomputedEventKey
      && String(entry?.previousBindingRequestKey || '').toLowerCase() === previousKey
      && String(entry?.newBindingRequestKey || entry?.bindingRequestKey || '').toLowerCase() === currentKey
      && Number(entry?.previousRepositoryRevision || 0) === previousRevision
      && Number(entry?.currentRepositoryRevision || 0) === currentRevision
      && String(entry?.bindingMode || '') === String(binding.bindingMode || '')
      && String(entry?.targetStore || '') === String(binding.targetStore || '')
      && normalizeProductAttributeId(entry?.attributeId) === normalizeProductAttributeId(binding.attributeId)
      && normalizeProductAttributeId(entry?.attributeValueId) === normalizeProductAttributeId(binding.attributeValueId)
      && String(entryDonor.storeKey || '') === String(donor.storeKey || '')
      && String(entryDonor.skc || '') === String(donor.skc || '')
      && String(entryDonor.spu || '') === String(donor.spu || '')
      && String(entry?.canonicalCode || '') === String(binding.canonicalCode || '')
      && String(entry?.evidenceSha256 || '').toLowerCase() === String(binding.evidenceSha256 || '').toLowerCase()
      && String(entry?.oldPayloadHash || '').toLowerCase() === String(binding.oldPayloadHash || '').toLowerCase()
      && String(entry?.newPayloadHash || '').toLowerCase() === String(binding.newPayloadHash || '').toLowerCase()
      && sha256StableJson(entry?.resignSanitization || null) === sha256StableJson(binding.resignSanitization || null);
  });
  if (scopedEntries.length !== 1 || matchingEntries.length !== 1) {
    blockers.push(blocker(
      'PRODUCT_ATTRIBUTE_RESIGN_EVENT_INVALID',
      `resign 历史按 event/revision/绑定身份过滤后必须恰好一条完整匹配（范围 ${scopedEntries.length}，完整 ${matchingEntries.length}）`,
    ));
  }
  return {ok: blockers.length === 0, blockers, recomputedEventKey};
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

const SANITIZABLE_PRODUCT_ATTRIBUTE_LIST_KEYS = new Set([
  'product_attribute_list',
  'productAttributeList',
  'sale_attribute_list',
  'saleAttributeList',
  'product_sku_attribute_list',
  'productSkuAttributeList',
]);

function isArrayIndexKey(key) {
  if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff;
}

/**
 * Re-sign-only payload hygiene for legacy incremental payloads.
 *
 * Recursively visits the payload and, only for the explicit SHEIN publish
 * attribute-list field allowlist above, removes rows whose
 * attribute_id/attributeId is not a positive safe integer. Near-match audit
 * or custom fields are never sanitized. Data descriptors, own __proto__
 * fields and object/array prototypes are preserved while cloning. This helper
 * never adds, rewrites or reorders a valid attribute and is intentionally not
 * used by the ordinary bind path.
 */
export function sanitizeInvalidProductAttributeListRows(payload) {
  const removed = [];
  const clones = new WeakMap();
  const visit = (value, path = '$', parentKey = '') => {
    if (Array.isArray(value)) {
      if (clones.has(value)) return clones.get(value);
      const sanitizeRows = SANITIZABLE_PRODUCT_ATTRIBUTE_LIST_KEYS.has(String(parentKey));
      const next = [];
      Object.setPrototypeOf(next, Object.getPrototypeOf(value));
      clones.set(value, next);
      let nextIndex = 0;
      for (let index = 0; index < value.length; index += 1) {
        const sourceDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        const row = sourceDescriptor && Object.prototype.hasOwnProperty.call(sourceDescriptor, 'value')
          ? sourceDescriptor.value
          : undefined;
        if (sanitizeRows) {
          const rawId = row && typeof row === 'object' && !Array.isArray(row)
            ? (row.attribute_id ?? row.attributeId)
            : undefined;
          if (normalizeProductAttributeId(rawId) === null) {
            removed.push({path: `${path}[${index}]`, attributeId: rawId ?? null});
            continue;
          }
        }
        if (!sourceDescriptor) {
          nextIndex += 1;
          continue;
        }
        const targetIndex = sanitizeRows ? nextIndex : index;
        const descriptor = {...sourceDescriptor};
        if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          descriptor.value = visit(descriptor.value, `${path}[${index}]`, '');
        }
        Object.defineProperty(next, String(targetIndex), descriptor);
        nextIndex += 1;
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length' || isArrayIndexKey(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        const clonedDescriptor = {...descriptor};
        if (Object.prototype.hasOwnProperty.call(clonedDescriptor, 'value')) {
          clonedDescriptor.value = visit(clonedDescriptor.value, `${path}.${String(key)}`, key);
        }
        Object.defineProperty(next, key, clonedDescriptor);
      }
      const sourceLength = Object.getOwnPropertyDescriptor(value, 'length');
      if (sourceLength) {
        Object.defineProperty(next, 'length', {
          ...sourceLength,
          value: sanitizeRows ? nextIndex : value.length,
        });
      }
      return next;
    }
    if (!value || typeof value !== 'object') return value;
    if (clones.has(value)) return clones.get(value);
    const next = Object.create(Object.getPrototypeOf(value));
    clones.set(value, next);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      const clonedDescriptor = {...descriptor};
      if (Object.prototype.hasOwnProperty.call(clonedDescriptor, 'value')) {
        clonedDescriptor.value = visit(clonedDescriptor.value, `${path}.${String(key)}`, key);
      }
      Object.defineProperty(next, key, clonedDescriptor);
    }
    return next;
  };
  return {
    payload: visit(payload ?? {}),
    removedCount: removed.length,
    removed,
  };
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
  const hasResignSanitization = Object.prototype.hasOwnProperty.call(binding, 'resignSanitization');
  const resignSanitization = hasResignSanitization && binding.resignSanitization && typeof binding.resignSanitization === 'object'
    ? binding.resignSanitization
    : null;
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
  if (hasResignSanitization && (!isV2 || !resignSanitization)) {
    blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_INVALID', 'resignSanitization 仅允许 schema v2 的完整对象'));
  }
  if (resignSanitization) {
    const removedCount = Number(resignSanitization.removedCount);
    const beforeHash = String(resignSanitization.currentPayloadHashBeforeSanitization || '').toLowerCase();
    const afterHash = String(resignSanitization.currentPayloadHashAfterSanitization || '').toLowerCase();
    const paths = asArray(resignSanitization.removedPathSummary).map(path => String(path || ''));
    const computedSanitization = productAttributeResignSanitizationEvidence({
      removedCount,
      currentPayloadHashBeforeSanitization: beforeHash,
      currentPayloadHashAfterSanitization: afterHash,
      removedPathSummary: paths,
    });
    if (!Number.isSafeInteger(removedCount) || removedCount < 0 || removedCount !== paths.length || paths.some(path => !path)) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_COUNT_INVALID', 'resignSanitization removedCount 必须等于非空删除路径数量'));
    }
    if (!SHA256_RE.test(beforeHash) || !SHA256_RE.test(afterHash)) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_HASH_INVALID', 'resignSanitization before/after hash 必须是 sha256'));
    }
    if (afterHash !== newHash || afterHash !== sha256StableJson(payload ?? {})) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_AFTER_HASH_DRIFT', 'resignSanitization afterHash 必须等于 newPayloadHash 与当前 payload hash'));
    }
    if ((removedCount > 0 && beforeHash === afterHash) || (removedCount === 0 && beforeHash !== afterHash)) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_TRANSITION_INVALID', 'resignSanitization 删除数量与 before/after hash 变化不一致'));
    }
    if (String(resignSanitization.removedPathDigest || '').toLowerCase() !== computedSanitization.removedPathDigest) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_PATH_DIGEST_DRIFT', 'resignSanitization 删除路径摘要与重算值不一致'));
    }
    if (String(resignSanitization.evidenceSha256 || '').toLowerCase() !== computedSanitization.evidenceSha256) {
      blockers.push(bindingBlocker('PRODUCT_ATTRIBUTE_RESIGN_SANITIZATION_EVIDENCE_DRIFT', 'resignSanitization evidenceSha256 与重算值不一致'));
    }
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
          resignSanitization,
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
  const resignSanitization = binding.resignSanitization && typeof binding.resignSanitization === 'object'
    ? {
        removedCount: Number(binding.resignSanitization.removedCount),
        currentPayloadHashBeforeSanitization: String(binding.resignSanitization.currentPayloadHashBeforeSanitization || ''),
        currentPayloadHashAfterSanitization: String(binding.resignSanitization.currentPayloadHashAfterSanitization || ''),
        removedPathDigest: String(binding.resignSanitization.removedPathDigest || ''),
        evidenceSha256: String(binding.resignSanitization.evidenceSha256 || ''),
      }
    : null;
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
    ...(resignSanitization ? {resignSanitization} : {}),
    preflightInvalidated: true,
    imageBindingFingerprintUnchanged: true,
    descriptionContentPinned: true,
    idempotentReplay,
  };
}
