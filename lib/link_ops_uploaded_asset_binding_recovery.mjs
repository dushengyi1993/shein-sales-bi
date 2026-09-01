import crypto from 'node:crypto';
import {normalizePublishPreparationOverrides} from './link_ops_publish_asset_binding.mjs';
import {isSheinSkc, normalizeSheinSkc} from './shein_product_identifiers.mjs';

export const LISTING_UPLOAD_BIND_CONTEXT_SCHEMA_VERSION = 1;
export const LISTING_UPLOAD_BIND_CONTEXT_KIND = 'copy_product_draft_prepare_upload';
export const LISTING_IMAGE_UPLOAD_AUDIT_TYPE = 'openapi-image-asset-upload-pic';
export const LISTING_BIND_RECOVERY_AUDIT_TYPE = 'link-ops-recover-uploaded-asset-binding';

export const RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT = 'USER_EXPLICIT_RECOVER_UPLOADED_ASSET_BINDING';

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function safeString(value, max = 500) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validatedUploadedImageUrl(value) {
  const raw = safeString(value, 3000);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid uploaded image URL: ${raw || '(missing)'}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported uploaded image URL protocol: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (!(host === 'shein.com' || host.endsWith('.shein.com') || host === 'ltwebstatic.com' || host.endsWith('.ltwebstatic.com'))) {
    throw new Error(`Uploaded image URL is not a SHEIN image host: ${host}`);
  }
  return raw;
}

function normalizeRecoveredImageBindings(bindings, {sourceApproved = false} = {}) {
  if (sourceApproved !== true) throw new Error('Image binding requires explicit reviewed/approved source confirmation');
  const allowedRoles = new Set(['mainCover', 'detail', 'squareImage', 'carouselSecondCover', 'skuImage']);
  const normalized = asArray(bindings).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid uploaded image binding at index ${index}`);
    const role = safeString(value.role, 80);
    if (!allowedRoles.has(role)) throw new Error(`Unsupported uploaded image role: ${role || '(missing)'}`);
    const expectedType = role === 'detail' ? 2 : role === 'squareImage' ? 5 : 1;
    const imageType = Number(value.imageType ?? value.image_type ?? expectedType);
    if (imageType !== expectedType) throw new Error(`Image role ${role} requires imageType=${expectedType}`);
    return {
      name: safeString(value.name || value.relativePath || `image-${index + 1}`, 240),
      relativePath: safeString(value.relativePath || value.name || '', 500),
      imageUrl: validatedUploadedImageUrl(value.imageUrl || value.image_url),
      imageType,
      role,
      order: Number.isFinite(Number(value.order)) ? Number(value.order) : index,
      width: Math.max(0, Math.trunc(Number(value.width || 0))),
      height: Math.max(0, Math.trunc(Number(value.height || 0))),
      sha256: /^[a-f0-9]{64}$/i.test(String(value.sha256 || '')) ? String(value.sha256).toLowerCase() : '',
    };
  }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const deduped = [];
  const seenUrls = new Set();
  for (const row of normalized) {
    if (seenUrls.has(row.imageUrl)) continue;
    seenUrls.add(row.imageUrl);
    deduped.push(row);
  }
  const main = deduped.filter(row => row.role === 'mainCover');
  const square = deduped.filter(row => row.role === 'squareImage');
  if (main.length !== 1) throw new Error(`Approved image binding requires exactly one mainCover; received ${main.length}`);
  if (square.length !== 1) throw new Error(`Approved image binding requires exactly one squareImage; received ${square.length}`);
  if (square[0].width && square[0].height) {
    const ratio = square[0].width / square[0].height;
    if (ratio < 0.95 || ratio > 1.05) throw new Error(`squareImage is not 1:1: ${square[0].width}x${square[0].height}`);
  }
  if (deduped.filter(row => row.role === 'carouselSecondCover').length > 1) throw new Error('Approved image binding supports at most one carouselSecondCover');
  if (deduped.filter(row => row.role === 'skuImage').length > 1) throw new Error('Approved image binding supports at most one skuImage');
  if (deduped.filter(row => row.role === 'detail').length > 10) throw new Error('Approved image binding supports at most 10 SKC detail images');
  return deduped;
}

function bindingPayloadImage(row, imageSort) {
  return {image_type: row.imageType, image_sort: imageSort, image_url: row.imageUrl};
}

function bindRecoveredImagesToPublishPayload(payload, bindings, {sourceApproved = false} = {}) {
  const normalized = normalizeRecoveredImageBindings(bindings, {sourceApproved});
  const next = clone(payload || {});
  const main = normalized.find(row => row.role === 'mainCover');
  const details = normalized.filter(row => row.role === 'detail');
  const square = normalized.find(row => row.role === 'squareImage');
  const carousel = normalized.find(row => row.role === 'carouselSecondCover');
  const skuImage = normalized.find(row => row.role === 'skuImage');
  const skcImages = [main, ...details, square].filter(Boolean).map((row, index) => bindingPayloadImage(row, index + 1));
  const skcList = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object' && !Array.isArray(row));
  if (!skcList.length) {
    throw listingBindRecoveryError('Task openapiPublishPayload lacks skc_list for recovered image binding', {code: 'RECOVER_TASK_PAYLOAD_MISSING'});
  }
  next.skc_list = skcList;
  delete next.skcList;
  for (const skc of next.skc_list) {
    skc.image_info = {image_info_list: skcImages.map(row => ({...row}))};
    delete skc.imageInfo;
    const skuList = asArray(skc.sku_list || skc.skuList).filter(row => row && typeof row === 'object' && !Array.isArray(row));
    if (skuList.length) {
      skc.sku_list = skuList;
      delete skc.skuList;
      for (const sku of skuList) {
        if (!skuImage) {
          delete sku.image_info;
          delete sku.imageInfo;
          continue;
        }
        sku.image_info = {image_info_list: [bindingPayloadImage(skuImage, 1)]};
        delete sku.imageInfo;
      }
    } else if (skuImage) {
      throw listingBindRecoveryError('Task openapiPublishPayload lacks sku_list for recovered SKU image binding', {code: 'RECOVER_TASK_PAYLOAD_MISSING'});
    }
  }
  if (carousel) {
    next.is_spu_pic = true;
    next.image_info = {image_info_list: [bindingPayloadImage(carousel, 1)]};
    delete next.imageInfo;
  } else {
    delete next.is_spu_pic;
    delete next.isSpuPic;
    delete next.image_info;
    delete next.imageInfo;
  }
  return {
    payload: next,
    applied: ['recovered_uploaded_assets.bound_to_same_task_payload'],
    images: normalized,
  };
}

export function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function listingBindRecoveryError(message, extra = {}) {
  const error = new Error(message);
  error.status = extra.status || 409;
  error.code = extra.code || 'LISTING_BIND_RECOVERY_REJECTED';
  error.response = {
    ok: false,
    error: message,
    code: error.code,
    ...(extra.response || {}),
  };
  return error;
}

function normalizePublishPreparationForRecoveryFingerprint(value = {}) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const titles = src.titles && typeof src.titles === 'object' && !Array.isArray(src.titles) ? src.titles : {};
  const rawAttributes = asArray(src.attributeOverrides || src.attribute_overrides);
  const normalized = {
    targetStore: safeString(src.targetStore || src.store || src.storeKey || '', 80).toUpperCase(),
    standardGoodsSn: safeString(src.standardGoodsSn || src.standard_goods_sn || '', 160),
    supplyPrice: src.supplyPrice ?? src.supply_price ?? null,
    inventory: src.inventory ?? src.stock ?? null,
    categoryId: src.categoryId ?? src.category_id ?? null,
    titles: {
      ar: safeString(titles.ar || src.titleAr || src.title_ar || '', 500),
      en: safeString(titles.en || src.titleEn || src.title_en || '', 500),
      zhCn: safeString(titles.zhCn || titles.zh_cn || src.titleZhCn || src.title_zh_cn || '', 500),
    },
    attributeOverrides: rawAttributes.map(row => ({
      attribute_id: Number(row?.attribute_id ?? row?.attributeId ?? 0),
      attribute_extra_value: safeString(row?.attribute_extra_value ?? row?.attributeExtraValue ?? '', 500),
      attribute_unit: safeString(row?.attribute_unit ?? row?.attributeUnit ?? '', 80),
      attribute_value_id: Number(row?.attribute_value_id ?? row?.attributeValueId ?? 0) || undefined,
      label: safeString(row?.label || '', 160),
      source: safeString(row?.source || '', 120),
    })).filter(row => Number.isSafeInteger(row.attribute_id) && row.attribute_id > 0)
      .sort((a, b) => a.attribute_id - b.attribute_id),
  };
  normalized.attributeOverrides = normalized.attributeOverrides.map(row => {
    const next = {...row};
    if (!next.attribute_value_id) delete next.attribute_value_id;
    return next;
  });
  return normalized;
}

function canonicalRecoveredPublishAssetBindingImages(images) {
  return asArray(images).map(row => ({
    name: safeString(row?.name || '', 240),
    role: safeString(row?.role || '', 80),
    imageType: Number(row?.imageType ?? row?.image_type ?? 0),
    imageUrl: safeString(row?.imageUrl || row?.image_url || '', 3000),
    sha256: safeString(row?.sha256 || '', 80).toLowerCase(),
  }));
}

export function canonicalRecoveredPublishAssetBindingFingerprint(task, {images, publishPreparation = task?.publishPreparation || task?.targets?.publishPreparation || {}, targetStore = ''} = {}) {
  return sha256Hex(canonicalJson({
    targetStore: safeString(targetStore || task?.publishAssetBinding?.targetStore || task?.targets?.targetStore || task?.store || '', 80).toUpperCase(),
    bindings: canonicalRecoveredPublishAssetBindingImages(images),
    publishPreparation: normalizePublishPreparationOverrides(publishPreparation),
  }));
}

export function canonicalRecoveredPublishPayloadHash(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw listingBindRecoveryError('Task openapiPublishPayload is missing or invalid', {
      code: 'RECOVER_TASK_PAYLOAD_MISSING',
    });
  }
  return sha256Hex(canonicalJson(payload));
}

export function normalizeListingBindContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const conflictCode = 'RECOVER_UPLOADED_BINDING_AUDIT_CONTEXT_CONFLICT';
  return {
    schemaVersion: extractNonEmptyNumber([value.schemaVersion], 'listingBindContext.schemaVersion', {conflictCode}),
    kind: extractNonEmptyString([value.kind], 'listingBindContext.kind', {conflictCode}),
    taskId: extractNonEmptyString([value.taskId, value.task?.id], 'listingBindContext.taskId', {conflictCode}),
    store: extractNonEmptyString([value.store, value.storeKey], 'listingBindContext.store', {
      conflictCode,
      transform: s => s.toUpperCase(),
    }),
    standardGoodsSn: extractNonEmptyString([value.standardGoodsSn], 'listingBindContext.standardGoodsSn', {conflictCode}),
    sourceStore: extractNonEmptyString([value.sourceStore], 'listingBindContext.sourceStore', {
      conflictCode,
      transform: s => s.toUpperCase(),
    }),
    sourceSkc: extractNonEmptyString([value.sourceSkc], 'listingBindContext.sourceSkc', {conflictCode}),
    repositoryRevision: extractNonEmptyNumber(
      [value.repositoryRevision, value.revision, value.taskRevision],
      'listingBindContext.repositoryRevision',
      {conflictCode}
    ),
    releaseId: extractNonEmptyString(
      [value.releaseId, value.deploymentTag, value.releaseTag, value.buildId],
      'listingBindContext.releaseId',
      {conflictCode}
    ),
    prepareBatchId: extractNonEmptyString([value.prepareBatchId], 'listingBindContext.prepareBatchId', {
      conflictCode,
      transform: s => s.toLowerCase(),
    }),
    role: extractNonEmptyString([value.role], 'listingBindContext.role', {conflictCode}),
    name: extractNonEmptyString(
      [value.name, value.fileName, value.filename],
      'listingBindContext.name',
      {conflictCode}
    ),
    width: extractNonEmptyNumber([value.width], 'listingBindContext.width', {conflictCode}),
    height: extractNonEmptyNumber([value.height], 'listingBindContext.height', {conflictCode}),
    imageType: extractNonEmptyNumber([value.imageType, value.image_type], 'listingBindContext.imageType', {conflictCode}),
    sha256: extractNonEmptyString([value.sha256], 'listingBindContext.sha256', {
      conflictCode,
      transform: s => s.toLowerCase(),
    }),
  };
}

export function isListingBindContextComplete(ctx) {
  return Boolean(
    ctx
    && ctx.schemaVersion === LISTING_UPLOAD_BIND_CONTEXT_SCHEMA_VERSION
    && ctx.kind === LISTING_UPLOAD_BIND_CONTEXT_KIND
    && ctx.taskId
    && ctx.store
    && ctx.standardGoodsSn
    && ctx.sourceStore
    && ctx.sourceSkc
    && Number.isSafeInteger(ctx.repositoryRevision)
    && ctx.repositoryRevision > 0
    && ctx.releaseId
    && /^[a-f0-9]{64}$/.test(ctx.prepareBatchId)
    && ctx.role
    && ctx.name
    && ctx.width === 1000
    && ctx.height === 1000
    && Number.isInteger(ctx.imageType)
    && [1, 2, 5, 6, 7].includes(ctx.imageType)
    && /^[a-f0-9]{64}$/.test(ctx.sha256)
  );
}

function extractNonEmptyString(values, label, {
  conflictCode = 'RECOVER_TASK_IDENTITY_CONFLICT',
  invalidCode = conflictCode,
  transform = s => s,
} = {}) {
  const present = new Set();
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') {
      throw listingBindRecoveryError(`Invalid non-string value for ${label}: ${JSON.stringify(v)}`, {
        code: invalidCode,
      });
    }
    const normalized = v.normalize('NFKC').trim();
    if (normalized.length > 500) {
      throw listingBindRecoveryError(`${label} exceeds the 500-character deterministic limit`, {
        code: invalidCode,
      });
    }
    const s = transform(normalized);
    if (s) present.add(s);
  }
  if (present.size > 1) {
    throw listingBindRecoveryError(
      `Conflicting non-empty values for ${label}: [${[...present].join(', ')}]`,
      {code: conflictCode}
    );
  }
  return present.size === 1 ? [...present][0] : '';
}

function extractNonEmptyNumber(values, label, {
  conflictCode = 'RECOVER_TASK_IDENTITY_CONFLICT',
  invalidCode = conflictCode,
} = {}) {
  const present = new Set();
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
        throw listingBindRecoveryError(`Invalid integer value for ${label}: ${JSON.stringify(v)}`, {
          code: invalidCode,
        });
      }
      present.add(v);
    }
  }
  if (present.size > 1) {
    throw listingBindRecoveryError(
      `Conflicting non-empty values for ${label}: [${[...present].join(', ')}]`,
      {code: conflictCode}
    );
  }
  return present.size === 1 ? [...present][0] : null;
}

function extractSingleObject(values, label, {
  missingCode = 'RECOVER_UPLOADED_BINDING_AUDIT_CONTEXT_INCOMPLETE',
  conflictCode = 'RECOVER_UPLOADED_BINDING_AUDIT_CONTEXT_CONFLICT',
} = {}) {
  const objects = values.filter(value => value !== undefined && value !== null);
  if (!objects.length) {
    throw listingBindRecoveryError(`${label} is missing`, {code: missingCode});
  }
  if (objects.some(value => typeof value !== 'object' || Array.isArray(value))) {
    throw listingBindRecoveryError(`${label} must be an object`, {code: missingCode});
  }
  const distinct = new Map(objects.map(value => [canonicalJson(value), value]));
  if (distinct.size > 1) {
    throw listingBindRecoveryError(`${label} aliases conflict`, {code: conflictCode});
  }
  return objects[0];
}

function canonicalUtcTimestamp(value, label, {
  missingCode = 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_MISSING',
  invalidCode = 'RECOVER_UPLOADED_BINDING_AUDIT_TIMESTAMP_INVALID',
} = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw listingBindRecoveryError(`${label} is missing`, {code: missingCode});
  }

  let epochMilliseconds;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw listingBindRecoveryError(`${label} must be an integer epoch-millisecond value`, {code: invalidCode});
    }
    epochMilliseconds = value;
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (/^-?\d+$/.test(raw)) {
      epochMilliseconds = Number(raw);
      if (!Number.isSafeInteger(epochMilliseconds)) {
        throw listingBindRecoveryError(`${label} epoch-millisecond value is outside the safe integer range`, {
          code: invalidCode,
        });
      }
    } else {
      const deterministicIso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
      if (!deterministicIso8601.test(raw)) {
        throw listingBindRecoveryError(
          `${label} must be ISO-8601 with an explicit timezone or integer epoch milliseconds`,
          {code: invalidCode}
        );
      }
      epochMilliseconds = Date.parse(raw);
    }
  } else {
    throw listingBindRecoveryError(`${label} must be a timestamp string or integer epoch milliseconds`, {
      code: invalidCode,
    });
  }

  if (!Number.isFinite(epochMilliseconds)) {
    throw listingBindRecoveryError(`${label} is not a parseable timestamp`, {code: invalidCode});
  }
  const parsed = new Date(epochMilliseconds);
  if (!Number.isFinite(parsed.getTime())) {
    throw listingBindRecoveryError(`${label} is outside the supported timestamp range`, {code: invalidCode});
  }
  return parsed.toISOString();
}

function extractExactTimestamp(values, label, options = {}) {
  const present = values.filter(value => value !== undefined && value !== null && String(value).trim() !== '');
  if (!present.length) {
    throw listingBindRecoveryError(`${label} is missing`, {
      code: options.missingCode || 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_MISSING',
    });
  }
  const normalized = new Set(present.map(value => canonicalUtcTimestamp(value, label, options)));
  if (normalized.size > 1) {
    throw listingBindRecoveryError(`${label} aliases refer to different instants`, {
      code: options.conflictCode || 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_CONFLICT',
    });
  }
  return [...normalized][0];
}

function requireExpectedPrepareBatchId(value) {
  if (value === undefined || value === null || value === '') {
    throw listingBindRecoveryError('expectedPrepareBatchId is required', {
      code: 'RECOVER_UPLOADED_BINDING_PREPARE_BATCH_REQUIRED',
    });
  }
  if (typeof value !== 'string') {
    throw listingBindRecoveryError('expectedPrepareBatchId must be a string', {
      code: 'RECOVER_UPLOADED_BINDING_PREPARE_BATCH_INVALID',
    });
  }
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw listingBindRecoveryError('expectedPrepareBatchId must be exactly 64 hexadecimal characters', {
      code: 'RECOVER_UPLOADED_BINDING_PREPARE_BATCH_INVALID',
    });
  }
  return normalized;
}

export function extractTaskExactIdentity(task) {
  if (!task || typeof task !== 'object') {
    throw listingBindRecoveryError('Target task is missing or invalid', {
      code: 'RECOVER_TASK_MISSING',
    });
  }

  const taskId = extractNonEmptyString([
    task.id,
    task.taskId,
    task.task?.id,
    task.task?.taskId,
  ], 'taskId');

  const sourceStoreRaw = extractNonEmptyString([
    task.sourceStore,
    task.targets?.sourceStore,
    task.exactSourceLock?.sourceStore,
    task.publishPreparation?.sourceStore,
    task.targets?.publishPreparation?.sourceStore,
  ], 'sourceStore');
  const sourceStore = sourceStoreRaw.toUpperCase();

  const rawSourceSkc = extractNonEmptyString([
    task.sourceSkc,
    task.targets?.sourceSkc,
    task.exactSourceLock?.sourceSkc,
    task.publishPreparation?.sourceSkc,
    task.targets?.publishPreparation?.sourceSkc,
  ], 'sourceSkc');
  const sourceSkc = isSheinSkc(rawSourceSkc) ? normalizeSheinSkc(rawSourceSkc) : rawSourceSkc;

  const standardGoodsSn = extractNonEmptyString([
    task.standardGoodsSn,
    task.targets?.standardGoodsSn,
    task.publishPreparation?.standardGoodsSn,
    task.targets?.publishPreparation?.standardGoodsSn,
  ], 'standardGoodsSn');

  const targetStoreRaw = extractNonEmptyString([
    task.targetStore,
    task.targets?.targetStore,
    task.storeKey,
    task.store,
    Array.isArray(task.writeStores) && task.writeStores.length === 1 ? task.writeStores[0] : undefined,
    Array.isArray(task.targets?.writeStores) && task.targets?.writeStores.length === 1 ? task.targets.writeStores[0] : undefined,
  ], 'targetStore');
  const targetStore = targetStoreRaw.toUpperCase();

  const repositoryRevision = extractNonEmptyNumber([
    task.repositoryRevision,
    task.revision,
    task.casRevision,
  ], 'repositoryRevision');

  const releaseId = extractNonEmptyString([
    task.releaseId,
    task.deploymentTag,
    task.buildId,
    task.releaseTag,
    task.releaseReceiptHash,
  ], 'releaseId');

  return {
    taskId,
    targetStore,
    standardGoodsSn,
    sourceStore,
    sourceSkc,
    repositoryRevision,
    releaseId,
  };
}

export function validateTaskFourWriteSlotsAreFalse(task, {skipLifecycleStateCheck = false} = {}) {
  if (!task || typeof task !== 'object') {
    throw listingBindRecoveryError('Target task is missing or invalid', {
      code: 'RECOVER_TASK_MISSING',
    });
  }

  const execution = task.execution && typeof task.execution === 'object' ? task.execution : null;
  const writeAudit = execution && typeof execution.writeAudit === 'object' ? execution.writeAudit : null;

  // 1. submitted
  const submittedValues = [task.submitted, execution?.submitted, writeAudit?.submitted].filter(v => v !== undefined);
  if (submittedValues.length === 0 || submittedValues.some(v => v !== false)) {
    throw listingBindRecoveryError(
      `Task write slot 'submitted' must be explicitly false across all locations, got ${JSON.stringify(submittedValues)}`,
      {code: 'RECOVER_TASK_WRITE_SLOT_NOT_FALSE'}
    );
  }

  // 2. actualWriteSubmitted
  const actualWriteSubmittedValues = [task.actualWriteSubmitted, execution?.actualWriteSubmitted, writeAudit?.actualWriteSubmitted].filter(v => v !== undefined);
  if (actualWriteSubmittedValues.length === 0 || actualWriteSubmittedValues.some(v => v !== false)) {
    throw listingBindRecoveryError(
      `Task write slot 'actualWriteSubmitted' must be explicitly false across all locations, got ${JSON.stringify(actualWriteSubmittedValues)}`,
      {code: 'RECOVER_TASK_WRITE_SLOT_NOT_FALSE'}
    );
  }

  // 3. issuedExecuteToExecutor
  const issuedExecuteValues = [task.issuedExecuteToExecutor, execution?.issuedExecuteToExecutor, writeAudit?.issuedExecuteToExecutor].filter(v => v !== undefined);
  if (issuedExecuteValues.length === 0 || issuedExecuteValues.some(v => v !== false)) {
    throw listingBindRecoveryError(
      `Task write slot 'issuedExecuteToExecutor' must be explicitly false across all locations, got ${JSON.stringify(issuedExecuteValues)}`,
      {code: 'RECOVER_TASK_WRITE_SLOT_NOT_FALSE'}
    );
  }

  // 4. sheinWriteAttempted
  const sheinWriteAttemptedValues = [task.sheinWriteAttempted, execution?.sheinWriteAttempted, writeAudit?.sheinWriteAttempted].filter(v => v !== undefined);
  if (sheinWriteAttemptedValues.length === 0 || sheinWriteAttemptedValues.some(v => v !== false)) {
    throw listingBindRecoveryError(
      `Task write slot 'sheinWriteAttempted' must be explicitly false across all locations, got ${JSON.stringify(sheinWriteAttemptedValues)}`,
      {code: 'RECOVER_TASK_WRITE_SLOT_NOT_FALSE'}
    );
  }

  // publishResult must be strictly null
  const publishResultValues = [task.publishResult, execution?.publishResult].filter(v => v !== undefined);
  if (publishResultValues.length === 0 || publishResultValues.some(v => v !== null)) {
    throw listingBindRecoveryError(
      `Task publishResult must be explicitly null, got ${JSON.stringify(publishResultValues)}`,
      {code: 'RECOVER_TASK_PUBLISH_RESULT_NOT_NULL'}
    );
  }

  // assets must be empty array or absent
  const assets = task.assets;
  if (assets !== undefined && assets !== null) {
    if (!Array.isArray(assets) || assets.length > 0) {
      throw listingBindRecoveryError(
        `Task assets must be empty, got ${Array.isArray(assets) ? assets.length + ' items' : typeof assets}`,
        {code: 'RECOVER_TASK_ASSETS_NOT_EMPTY'}
      );
    }
  }

  if (skipLifecycleStateCheck) return true;

  // lifecycle / execution state must be prewrite recoverable
  const executionState = safeString(execution?.state).toLowerCase();
  if (['submitted', 'executing', 'committed', 'completed', 'executing_submitted'].includes(executionState)) {
    throw listingBindRecoveryError(`Task execution state is '${executionState}', cannot recover binding`, {
      code: 'RECOVER_TASK_EXECUTION_STATE_INVALID',
    });
  }

  const lifecycleStatus = extractNonEmptyString([
    task?.lifecycle?.lifecycleStatus,
    task?.lifecycle?.status,
    task?.status,
  ], 'lifecycleStatus', {
    conflictCode: 'RECOVER_TASK_LIFECYCLE_STATE_INVALID',
    transform: s => s.toLowerCase(),
  });
  const allowedLifecycleStatuses = new Set([
    'draft',
    'created',
    'waiting_review',
    'waiting_confirmation',
    'preflight_ready',
    'ready_for_submit',
    'needs_preflight',
    'needs_repreflight',
    'publish_pre_valid_failed',
    'preflight_failed',
    'binding_failed',
    'waiting_upload',
  ]);

  if (!lifecycleStatus || lifecycleStatus === 'unknown' || !allowedLifecycleStatuses.has(lifecycleStatus)) {
    throw listingBindRecoveryError(`Task lifecycle status '${lifecycleStatus}' is not a valid prewrite recoverable state`, {
      code: 'RECOVER_TASK_LIFECYCLE_STATE_INVALID',
    });
  }

  return true;
}

function requireExactAuditString(value, label, {transform = s => s} = {}) {
  if (typeof value !== 'string') {
    throw listingBindRecoveryError(`${label} must be a string`, {
      code: value === undefined || value === null
        ? 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_MISSING'
        : 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_INVALID',
    });
  }
  const normalized = transform(value.normalize('NFKC').trim());
  if (!normalized) {
    throw listingBindRecoveryError(`${label} is missing`, {
      code: 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_MISSING',
    });
  }
  return normalized;
}

function requireExactAuditInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw listingBindRecoveryError(`${label} must be a safe integer`, {
      code: value === undefined || value === null
        ? 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_MISSING'
        : 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_INVALID',
    });
  }
  return value;
}

function requestedUploadTupleKey(tuple) {
  return canonicalJson({name: tuple.name, imageUrl: tuple.imageUrl, sha256: tuple.sha256});
}

function normalizeRequestedUploadTuples(tuples) {
  const rows = asArray(tuples);
  if (rows.length !== 6) {
    throw listingBindRecoveryError(`Recovered uploaded asset binding requires exactly 6 uploaded-image tuples; received ${rows.length}`, {
      code: 'RECOVER_UPLOADED_BINDING_TUPLE_COUNT_INVALID',
    });
  }
  const seenNames = new Set();
  const seenUrls = new Set();
  const seenSha256s = new Set();
  const seenTuples = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw listingBindRecoveryError(`uploaded-image tuple at index ${index} must be an object`, {
        code: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      });
    }
    const name = extractNonEmptyString([row.name, row.fileName], `tuple[${index}].name`, {
      conflictCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      invalidCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
    });
    const rawImageUrl = extractNonEmptyString([row.imageUrl, row.image_url], `tuple[${index}].imageUrl`, {
      conflictCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      invalidCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
    });
    const sha256 = extractNonEmptyString([row.sha256], `tuple[${index}].sha256`, {
      conflictCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      invalidCode: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      transform: value => value.toLowerCase(),
    });
    let imageUrl;
    try {
      imageUrl = validatedUploadedImageUrl(rawImageUrl);
    } catch (error) {
      throw listingBindRecoveryError(error.message, {code: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID'});
    }
    if (!name || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw listingBindRecoveryError(`uploaded-image tuple at index ${index} requires name, SHEIN URL, and 64-char SHA-256`, {
        code: 'RECOVER_UPLOADED_BINDING_TUPLE_INVALID',
      });
    }
    if (seenNames.has(name)) {
      throw listingBindRecoveryError(`Duplicate filename across uploaded-image tuples: ${name}`, {
        code: 'RECOVER_UPLOADED_BINDING_DUPLICATE_NAME',
      });
    }
    if (seenUrls.has(imageUrl)) {
      throw listingBindRecoveryError(`Duplicate imageUrl across uploaded-image tuples: ${imageUrl}`, {
        code: 'RECOVER_UPLOADED_BINDING_DUPLICATE_URL',
      });
    }
    if (seenSha256s.has(sha256)) {
      throw listingBindRecoveryError(`Duplicate sha256 across uploaded-image tuples: ${sha256}`, {
        code: 'RECOVER_UPLOADED_BINDING_DUPLICATE_SHA256',
      });
    }
    const normalized = {name, imageUrl, sha256};
    const key = requestedUploadTupleKey(normalized);
    if (seenTuples.has(key)) {
      throw listingBindRecoveryError(`Duplicate uploaded-image tuple at index ${index}`, {
        code: 'RECOVER_UPLOADED_BINDING_TUPLE_DUPLICATE',
      });
    }
    seenNames.add(name);
    seenUrls.add(imageUrl);
    seenSha256s.add(sha256);
    seenTuples.add(key);
    return normalized;
  });
}

function isTrueContextlessUploadAudit(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (safeString(entry.type) !== LISTING_IMAGE_UPLOAD_AUDIT_TYPE) return false;
  return entry.listingBindContext === undefined
    && entry.role === undefined
    && entry.prepareBatchId === undefined
    && entry.prepare_batch_id === undefined
    && entry.batchId === undefined
    && entry.batch_id === undefined
    && entry.request?.prepareBatchId === undefined
    && entry.request?.prepare_batch_id === undefined
    && entry.body?.prepareBatchId === undefined
    && entry.body?.prepare_batch_id === undefined;
}

function basicAuditTuple(entry) {
  if (typeof entry?.file?.name !== 'string'
    || typeof entry?.result?.imageUrl !== 'string'
    || typeof entry?.file?.sha256 !== 'string') return null;
  const name = entry.file.name.normalize('NFKC').trim();
  const imageUrl = entry.result.imageUrl.normalize('NFKC').trim();
  const sha256 = entry.file.sha256.normalize('NFKC').trim().toLowerCase();
  if (!name || !imageUrl || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  return {name, imageUrl, sha256};
}

function normalizeMatchedContextlessAudit(entry, auditIndex, taskIdentity) {
  const tuple = basicAuditTuple(entry);
  if (!tuple) {
    throw listingBindRecoveryError(`Matched upload audit at index ${auditIndex} lacks the exact producer tuple`, {
      code: 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_INVALID',
    });
  }
  try {
    tuple.imageUrl = validatedUploadedImageUrl(tuple.imageUrl);
  } catch (error) {
    throw listingBindRecoveryError(error.message, {code: 'RECOVER_UPLOADED_BINDING_AUDIT_FIELD_INVALID'});
  }
  const store = requireExactAuditString(entry.storeKey, `upload audit[${auditIndex}].storeKey`, {
    transform: value => value.toUpperCase(),
  });
  if (store !== taskIdentity.targetStore) {
    throw listingBindRecoveryError(`Upload audit at index ${auditIndex} belongs to store ${store}, expected ${taskIdentity.targetStore}`, {
      code: 'RECOVER_UPLOADED_BINDING_AUDIT_STORE_MISMATCH',
    });
  }
  const imageType = requireExactAuditInteger(entry.imageType, `upload audit[${auditIndex}].imageType`);
  const width = Number.isSafeInteger(entry.result?.width) && entry.result.width > 0 ? entry.result.width : 0;
  const height = Number.isSafeInteger(entry.result?.height) && entry.result.height > 0 ? entry.result.height : 0;
  const traceId = typeof entry.result?.traceId === 'string'
    ? entry.result.traceId.normalize('NFKC').trim()
    : '';
  const parsedAt = typeof entry.at === 'string' && entry.at.trim() ? new Date(entry.at) : null;
  const uploadedAt = parsedAt && Number.isFinite(parsedAt.getTime()) ? parsedAt.toISOString() : '';
  return {...tuple, store, imageType, width, height, traceId, uploadedAt, auditIndex, original: entry};
}

function canonicalRecoveredAuditBindings(bindings) {
  return asArray(bindings).map(row => ({
    name: row.name,
    role: row.role,
    imageType: row.imageType,
    imageUrl: row.imageUrl,
    sha256: row.sha256,
    order: row.order,
  }));
}

function recoveredAuditTupleHash(bindings) {
  return sha256Hex(canonicalJson(canonicalRecoveredAuditBindings(bindings)));
}

export function validateAuditUploadTuples(
  tuples,
  auditLogs,
  taskIdentity,
  {expectedPrepareBatchId} = {}
) {
  const expectedBatch = requireExpectedPrepareBatchId(expectedPrepareBatchId);
  if (!taskIdentity || typeof taskIdentity !== 'object' || !taskIdentity.targetStore) {
    throw listingBindRecoveryError('Task identity requires an exact targetStore', {
      code: 'RECOVER_UPLOADED_BINDING_AUDIT_UNBOUND',
    });
  }
  const requested = normalizeRequestedUploadTuples(tuples);
  const requestedByKey = new Map(requested.map(tuple => [requestedUploadTupleKey(tuple), tuple]));
  const matchesByKey = new Map([...requestedByKey.keys()].map(key => [key, []]));
  const auditRows = asArray(auditLogs);
  for (let auditIndex = 0; auditIndex < auditRows.length; auditIndex += 1) {
    const entry = auditRows[auditIndex];
    if (!isTrueContextlessUploadAudit(entry)) continue;
    const tuple = basicAuditTuple(entry);
    if (!tuple) continue;
    const key = requestedUploadTupleKey(tuple);
    if (!matchesByKey.has(key)) continue;
    matchesByKey.get(key).push(normalizeMatchedContextlessAudit(entry, auditIndex, taskIdentity));
  }

  const matchedAudits = [];
  for (const [key, requestedTuple] of requestedByKey) {
    const matches = matchesByKey.get(key) || [];
    if (!matches.length) {
      throw listingBindRecoveryError(`uploaded-image tuple ${requestedTuple.name} does not have an exact contextless producer audit match`, {
        code: 'RECOVER_UPLOADED_BINDING_TUPLE_NOT_IN_AUDIT',
      });
    }
    if (matches.length !== 1) {
      throw listingBindRecoveryError(`uploaded-image tuple ${requestedTuple.name} matched ${matches.length} producer audit rows; audit order is ambiguous`, {
        code: 'RECOVER_UPLOADED_BINDING_AUDIT_AMBIGUOUS',
      });
    }
    matchedAudits.push(matches[0]);
  }
  matchedAudits.sort((a, b) => a.auditIndex - b.auditIndex);
  if (matchedAudits.length !== 6 || new Set(matchedAudits.map(row => row.auditIndex)).size !== 6) {
    throw listingBindRecoveryError('Exactly six uniquely ordered producer audit rows are required', {
      code: 'RECOVER_UPLOADED_BINDING_AUDIT_AMBIGUOUS',
    });
  }
  const typeCounts = new Map([1, 2, 5].map(type => [type, matchedAudits.filter(row => row.imageType === type).length]));
  if (matchedAudits.some(row => !typeCounts.has(row.imageType))
    || typeCounts.get(1) !== 2
    || typeCounts.get(5) !== 1
    || typeCounts.get(2) !== 3) {
    throw listingBindRecoveryError(
      `Recovered audit composition must be imageType 1x2, 5x1, 2x3; received 1x${typeCounts.get(1)}, 5x${typeCounts.get(5)}, 2x${typeCounts.get(2)}`,
      {code: 'RECOVER_UPLOADED_BINDING_TYPE_COMPOSITION_INVALID'}
    );
  }

  let typeOneSeen = 0;
  const normalizedBindings = matchedAudits.map((audit, order) => {
    let role;
    if (audit.imageType === 1) {
      role = typeOneSeen === 0 ? 'mainCover' : 'carouselSecondCover';
      typeOneSeen += 1;
    } else if (audit.imageType === 5) {
      role = 'squareImage';
    } else {
      role = 'detail';
    }
    return {
      order,
      role,
      imageType: audit.imageType,
      imageUrl: audit.imageUrl,
      sha256: audit.sha256,
      traceId: audit.traceId,
      name: audit.name,
      relativePath: audit.name,
      width: audit.width,
      height: audit.height,
      uploadedAt: audit.uploadedAt,
    };
  });

  try {
    normalizeRecoveredImageBindings(normalizedBindings, {sourceApproved: true});
  } catch (error) {
    throw listingBindRecoveryError(`Image composition invalid: ${error.message}`, {
      code: 'RECOVER_UPLOADED_BINDING_ROLE_INVALID',
    });
  }
  return {
    normalizedBindings,
    prepareBatchId: expectedBatch,
    matchedAuditEntries: matchedAudits.map(row => row.original),
    tupleHash: recoveredAuditTupleHash(normalizedBindings),
  };
}

export function createUploadedAssetBindingRecoveryPlan({
  task,
  tuples,
  auditLogs,
  expectedRevision,
  expectedReleaseId,
  expectedPrepareBatchId,
  confirmMarker,
  actor = 'system',
} = {}) {
  if (confirmMarker !== RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT) {
    throw listingBindRecoveryError(
      `Recovery requires explicit user confirmation marker: ${RECOVER_UPLOADED_ASSET_BINDING_CONFIRM_TEXT}`,
      {code: 'RECOVER_UPLOADED_BINDING_CONFIRM_REQUIRED'}
    );
  }

  if (!task || typeof task !== 'object') {
    throw listingBindRecoveryError('Target task is missing or invalid', {
      code: 'RECOVER_UPLOADED_BINDING_TASK_MISSING',
    });
  }

  validateTaskFourWriteSlotsAreFalse(task);

  const taskIdentity = extractTaskExactIdentity(task);
  if (!taskIdentity.taskId) {
    throw listingBindRecoveryError('Task is missing taskId', {code: 'RECOVER_TASK_ID_MISSING'});
  }
  if (!taskIdentity.targetStore) {
    throw listingBindRecoveryError('Task is missing targetStore', {code: 'RECOVER_TARGET_STORE_MISSING'});
  }
  if (!taskIdentity.sourceStore || !taskIdentity.sourceSkc) {
    throw listingBindRecoveryError('Task is missing exact sourceStore/sourceSkc lock', {
      code: 'RECOVER_SOURCE_LOCK_MISSING',
    });
  }
  if (!taskIdentity.standardGoodsSn) {
    throw listingBindRecoveryError('Task is missing standardGoodsSn', {
      code: 'RECOVER_STANDARD_GOODS_SN_MISSING',
    });
  }

  // CAS expectedRepositoryRevision check
  if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
    throw listingBindRecoveryError('expectedRevision is required and must be an explicit positive integer', {
      code: 'RECOVER_REVISION_REQUIRED',
    });
  }
  const expRevNum = expectedRevision;
  if (typeof expRevNum !== 'number' || !Number.isSafeInteger(expRevNum) || expRevNum <= 0) {
    throw listingBindRecoveryError('expectedRevision must be an explicit positive integer', {
      code: 'RECOVER_REVISION_INVALID',
    });
  }

  const liveRevision = taskIdentity.repositoryRevision;
  if (!Number.isSafeInteger(liveRevision) || liveRevision <= 0) {
    throw listingBindRecoveryError('Task repositoryRevision is missing or invalid for CAS claim', {
      code: 'RECOVER_TASK_REVISION_INVALID',
    });
  }
  if (expRevNum !== liveRevision) {
    throw listingBindRecoveryError(
      `Task CAS revision conflict: expected ${expRevNum}, live is ${liveRevision}`,
      {code: 'RECOVER_CAS_REVISION_CONFLICT'}
    );
  }

  // CAS expectedReleaseId check
  if (typeof expectedReleaseId !== 'string' || !expectedReleaseId.trim()) {
    throw listingBindRecoveryError('expectedReleaseId is required and must be a non-empty string', {
      code: 'RECOVER_RELEASE_REQUIRED',
    });
  }
  const expRelStr = expectedReleaseId.normalize('NFKC').trim();
  if (!taskIdentity.releaseId) {
    throw listingBindRecoveryError('Task release identity is missing or empty', {
      code: 'RECOVER_TASK_RELEASE_MISSING',
    });
  }
  if (expRelStr !== taskIdentity.releaseId) {
    throw listingBindRecoveryError(
      `Release mismatch: expected ${expRelStr}, task has ${taskIdentity.releaseId}`,
      {code: 'RECOVER_RELEASE_MISMATCH'}
    );
  }

  const expectedBatch = requireExpectedPrepareBatchId(expectedPrepareBatchId);

  // Existing binding check
  const existing = task.publishAssetBinding;
  if (existing && typeof existing === 'object' && !Array.isArray(existing) && asArray(existing.images).length > 0) {
    throw listingBindRecoveryError('Task already carries a publish asset binding, cannot overwrite', {
      code: 'RECOVER_SUBSEQUENT_BINDING_CONFLICT',
    });
  }

  const {normalizedBindings, prepareBatchId, tupleHash} = validateAuditUploadTuples(
    tuples,
    auditLogs,
    taskIdentity,
    {expectedPrepareBatchId: expectedBatch}
  );

  const requestHash = sha256Hex(canonicalJson({
    taskId: taskIdentity.taskId,
    targetStore: taskIdentity.targetStore,
    standardGoodsSn: taskIdentity.standardGoodsSn,
    sourceStore: taskIdentity.sourceStore,
    sourceSkc: taskIdentity.sourceSkc,
    expectedRevision: liveRevision,
    expectedReleaseId: expRelStr,
    expectedPrepareBatchId: expectedBatch,
    prepareBatchId,
    tupleHash,
    confirmMarker,
  }));

  const bindingFingerprint = canonicalRecoveredPublishAssetBindingFingerprint(task, {
    targetStore: taskIdentity.targetStore,
    images: normalizedBindings,
    publishPreparation: task.publishPreparation || task.targets?.publishPreparation || {},
  });

  const plan = {
    schemaVersion: 1,
    kind: 'uploaded_asset_binding_recovery_plan',
    taskId: taskIdentity.taskId,
    targetStore: taskIdentity.targetStore,
    standardGoodsSn: taskIdentity.standardGoodsSn,
    sourceStore: taskIdentity.sourceStore,
    sourceSkc: taskIdentity.sourceSkc,
    expectedPrepareBatchId: expectedBatch,
    prepareBatchId,
    expectedRevision: liveRevision,
    nextRevision: liveRevision + 1,
    casPrecondition: {
      taskId: taskIdentity.taskId,
      expectedRevision: liveRevision,
      expectedReleaseId: expRelStr,
      expectedPrepareBatchId: expectedBatch,
      fourWriteSlots: {
        submitted: false,
        actualWriteSubmitted: false,
        issuedExecuteToExecutor: false,
        sheinWriteAttempted: false,
      },
      publishResult: null,
      assetsEmpty: true,
    },
    tupleHash,
    requestHash,
    bindingFingerprint,
    recoveredBinding: {
      schemaVersion: 1,
      kind: 'copy_product_draft',
      sourceApproved: true,
      authority: 'human_reviewed_source',
      targetStore: taskIdentity.targetStore,
      bindingFingerprint,
      prepareBatchId,
      imageCount: normalizedBindings.length,
      images: normalizedBindings.map(row => ({
        name: row.name,
        relativePath: row.relativePath,
        role: row.role,
        imageType: row.imageType,
        imageUrl: row.imageUrl,
        width: row.width,
        height: row.height,
        sha256: row.sha256,
        traceId: row.traceId,
        order: row.order,
        uploadedAt: row.uploadedAt,
      })),
      evidence: {
        recoveredFromAudit: true,
        auditType: LISTING_BIND_RECOVERY_AUDIT_TYPE,
        prepareBatchId,
        tupleHash,
        recoveryIdentity: {
          taskId: taskIdentity.taskId,
          targetStore: taskIdentity.targetStore,
          sourceStore: taskIdentity.sourceStore,
          sourceSkc: taskIdentity.sourceSkc,
          standardGoodsSn: taskIdentity.standardGoodsSn,
        },
        preflightInvalidated: true,
      },
    },
    actor,
  };

  return plan;
}

export const createUploadedAssetBindingRecoveryProposal = createUploadedAssetBindingRecoveryPlan;
export const extractTaskIdentity = extractTaskExactIdentity;

export function extractAuthoritativeUploadTuplesFromAudit(
  auditLogs,
  taskIdentity,
  {expectedPrepareBatchId, tuples} = {}
) {
  const validation = validateAuditUploadTuples(tuples, auditLogs, taskIdentity, {expectedPrepareBatchId});
  return {
    tuples: validation.normalizedBindings,
    prepareBatchId: validation.prepareBatchId,
    matchedAuditEntries: validation.matchedAuditEntries,
  };
}

function idempotentReplayDrift(message, code) {
  throw listingBindRecoveryError(message, {code});
}

export function validateUploadedAssetBindingRecoveryReplay({
  task,
  tuples,
  auditLogs,
  expectedPrepareBatchId,
} = {}) {
  validateTaskFourWriteSlotsAreFalse(task, {skipLifecycleStateCheck: true});
  const taskIdentity = extractTaskExactIdentity(task);
  const expectedBatch = requireExpectedPrepareBatchId(expectedPrepareBatchId);
  const binding = task?.publishAssetBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.sourceApproved !== true
    || binding.authority !== 'human_reviewed_source'
    || binding.evidence?.recoveredFromAudit !== true) {
    idempotentReplayDrift('Current task does not carry a committed recovered binding', 'RECOVER_IDEMPOTENT_REPLAY_BINDING_MISSING');
  }
  const existingBatch = safeString(binding.prepareBatchId || binding.evidence?.prepareBatchId).toLowerCase();
  if (existingBatch !== expectedBatch) {
    idempotentReplayDrift(`Recovered binding prepareBatchId drifted: current=${existingBatch || '(missing)'} expected=${expectedBatch}`, 'RECOVER_IDEMPOTENT_REPLAY_BATCH_DRIFT');
  }

  const expectedIdentity = {
    taskId: taskIdentity.taskId,
    targetStore: taskIdentity.targetStore,
    sourceStore: taskIdentity.sourceStore,
    sourceSkc: taskIdentity.sourceSkc,
    standardGoodsSn: taskIdentity.standardGoodsSn,
  };
  const committedIdentity = binding.evidence?.recoveryIdentity;
  if (!committedIdentity || canonicalJson(committedIdentity) !== canonicalJson(expectedIdentity)) {
    idempotentReplayDrift('Current task taskId/targetStore/sourceStore/sourceSkc/standardGoodsSn differs from the committed recovery identity', 'RECOVER_IDEMPOTENT_REPLAY_IDENTITY_DRIFT');
  }
  if (safeString(binding.targetStore).toUpperCase() !== taskIdentity.targetStore) {
    idempotentReplayDrift('Recovered binding targetStore differs from the current task targetStore', 'RECOVER_IDEMPOTENT_REPLAY_IDENTITY_DRIFT');
  }

  const validation = validateAuditUploadTuples(tuples, auditLogs, taskIdentity, {expectedPrepareBatchId: expectedBatch});
  const expectedImages = canonicalRecoveredPublishAssetBindingImages(validation.normalizedBindings);
  const currentImages = canonicalRecoveredPublishAssetBindingImages(binding.images);
  if (currentImages.length !== 6 || canonicalJson(currentImages) !== canonicalJson(expectedImages)) {
    idempotentReplayDrift('Current recovered binding no longer matches the exact six uploaded-image tuples and derived roles', 'RECOVER_IDEMPOTENT_REPLAY_TUPLE_DRIFT');
  }
  if (binding.imageCount !== 6 && Number(binding.imageCount) !== 6) {
    idempotentReplayDrift(`Current recovered binding imageCount is ${binding.imageCount ?? '(missing)'}, expected 6`, 'RECOVER_IDEMPOTENT_REPLAY_TUPLE_DRIFT');
  }
  if (safeString(binding.evidence?.tupleHash).toLowerCase() !== validation.tupleHash) {
    idempotentReplayDrift('Current recovered binding tupleHash does not match the selected producer audit rows', 'RECOVER_IDEMPOTENT_REPLAY_TUPLE_DRIFT');
  }

  const currentPayloadHash = canonicalRecoveredPublishPayloadHash(task.openapiPublishPayload);
  if (safeString(binding.evidence?.payloadHash).toLowerCase() !== currentPayloadHash) {
    idempotentReplayDrift('Current task openapiPublishPayload differs from the committed recovered payload', 'RECOVER_IDEMPOTENT_REPLAY_PAYLOAD_DRIFT');
  }
  const rebound = bindRecoveredImagesToPublishPayload(task.openapiPublishPayload, validation.normalizedBindings, {sourceApproved: true});
  if (canonicalJson(rebound.payload) !== canonicalJson(task.openapiPublishPayload)) {
    idempotentReplayDrift('Current task payload image projection no longer matches the exact six uploaded-image tuples', 'RECOVER_IDEMPOTENT_REPLAY_PAYLOAD_DRIFT');
  }

  const taskPreparation = task?.publishPreparation || task?.targets?.publishPreparation || null;
  const bindingPreparation = binding.publishPreparation || null;
  if (taskPreparation && bindingPreparation
    && canonicalJson(normalizePublishPreparationOverrides(taskPreparation)) !== canonicalJson(normalizePublishPreparationOverrides(bindingPreparation))) {
    idempotentReplayDrift('Current task and recovered binding publishPreparation declarations differ', 'RECOVER_IDEMPOTENT_REPLAY_FINGERPRINT_DRIFT');
  }
  const recomputedFingerprint = canonicalRecoveredPublishAssetBindingFingerprint(task, {
    targetStore: taskIdentity.targetStore,
    images: binding.images,
    publishPreparation: bindingPreparation || taskPreparation || {},
  });
  if (!/^[a-f0-9]{64}$/.test(safeString(binding.bindingFingerprint).toLowerCase())
    || safeString(binding.bindingFingerprint).toLowerCase() !== recomputedFingerprint) {
    idempotentReplayDrift('Current recovered binding fingerprint does not match canonical recomputation', 'RECOVER_IDEMPOTENT_REPLAY_FINGERPRINT_DRIFT');
  }

  return {
    taskIdentity,
    normalizedBindings: validation.normalizedBindings,
    matchedAuditEntries: validation.matchedAuditEntries,
    tupleHash: validation.tupleHash,
    payloadHash: currentPayloadHash,
    bindingFingerprint: recomputedFingerprint,
    prepareBatchId: expectedBatch,
  };
}

export function buildRecoveredTaskFromPlan(task, plan, {actorUser = 'system'} = {}) {
  if (!task || typeof task !== 'object') {
    throw listingBindRecoveryError('Task is missing or invalid', {code: 'RECOVER_TASK_MISSING'});
  }
  if (!plan || typeof plan !== 'object' || !plan.recoveredBinding) {
    throw listingBindRecoveryError('Recovery plan is missing or invalid', {code: 'RECOVER_PLAN_INVALID'});
  }

  const rawPublishPayload = task.openapiPublishPayload;
  if (!rawPublishPayload || typeof rawPublishPayload !== 'object' || Array.isArray(rawPublishPayload)) {
    throw listingBindRecoveryError('Task openapiPublishPayload is missing or invalid for recovery binding', {
      code: 'RECOVER_TASK_PAYLOAD_MISSING',
    });
  }

  const bound = bindRecoveredImagesToPublishPayload(
    rawPublishPayload,
    plan.recoveredBinding.images,
    {sourceApproved: true},
  );

  const now = new Date().toISOString();
  const nextTask = {
    ...task,
    openapiPublishPayload: bound.payload,
    publishAssetBinding: {
      schemaVersion: 1,
      kind: plan.recoveredBinding.kind,
      sourceApproved: true,
      authority: 'human_reviewed_source',
      targetStore: plan.targetStore,
      boundAt: now,
      boundByUser: actorUser,
      bindingFingerprint: plan.bindingFingerprint,
      prepareBatchId: plan.prepareBatchId,
      imageCount: plan.recoveredBinding.imageCount,
      images: plan.recoveredBinding.images.map(img => ({
        name: img.name,
        relativePath: img.relativePath,
        role: img.role,
        imageType: img.imageType,
        imageUrl: img.imageUrl,
        width: img.width,
        height: img.height,
        sha256: img.sha256,
        traceId: img.traceId,
        order: img.order,
        uploadedAt: img.uploadedAt,
      })),
      evidence: {
        ...plan.recoveredBinding.evidence,
        recoveredAt: now,
        tupleHash: plan.tupleHash,
        requestHash: plan.requestHash,
        payloadHash: canonicalRecoveredPublishPayloadHash(bound.payload),
        preflightInvalidated: true,
      },
      publishPreparation: task.publishPreparation ? JSON.parse(JSON.stringify(task.publishPreparation)) : null,
    },
    execution: {
      ...(task.execution && typeof task.execution === 'object' ? task.execution : {}),
      state: 'needs_repreflight',
      openApiProductExecutors: [],
      preflight: {
        ok: false,
        blockers: ['已上传图片绑定已从权威审计日志恢复，旧预演已作废，需要重新执行 dry-run 预演。'],
        warnings: [],
      },
    },
    note: '已上传图片素材已从权威审计记录恢复绑定至同一任务；旧预演已作废，必须重新预演后方可提交。',
    updatedAt: now,
  };

  const history = Array.isArray(task.history) ? task.history.slice(-80) : [];
  history.push({
    at: now,
    event: 'uploaded_assets_binding_recovered',
    user: actorUser,
    targetStore: plan.targetStore,
    bindingFingerprint: plan.bindingFingerprint,
    imageCount: plan.recoveredBinding.imageCount,
    prepareBatchId: plan.prepareBatchId,
    tupleHash: plan.tupleHash,
  });
  nextTask.history = history;

  return nextTask;
}
