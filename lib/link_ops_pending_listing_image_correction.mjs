import crypto from 'node:crypto';
import {applyApprovedImageBindingsToPublishPayload} from './link_ops_publish_asset_binding.mjs';
import {isSheinSkc, normalizeSheinSkc, sameSheinSkc} from './shein_product_identifiers.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function text(value, max = 500) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function normalizeSpu(value) {
  const raw = text(value, 160).toLowerCase();
  return /^[a-z]\d{10,}$/.test(raw) && !isSheinSkc(raw) ? raw : '';
}

function normalizeSku(value) {
  const raw = text(value, 160);
  return /^[a-z0-9][a-z0-9_-]{5,159}$/i.test(raw) ? raw : '';
}

function sourcePublishPayload(task) {
  for (const key of ['openapiPublishPayload', 'sheinOpenapiPublishPayload', 'publishPayload', 'publishOrEditPayload']) {
    const value = task?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return clone(value);
  }
  return null;
}

function publishExecutors(task) {
  return [
    ...asArray(task?.execution?.openApiProductExecutors),
    task?.execution?.hlOpenApiExecutor,
    task?.openApiProductExecutor,
  ].filter(Boolean);
}

function publishSucceeded(result) {
  if (!result || String(result.code ?? '') !== '0') return false;
  const info = result.info;
  return !(info && typeof info === 'object' && info.success === false);
}

function sourceWasSubmitted(task) {
  if (task?.execution?.actualWriteSubmitted === true || task?.execution?.writeAudit?.actualWriteSubmitted === true) return true;
  return publishExecutors(task).some(executor => publishSucceeded(executor?.publishResult));
}

function protectedProjection(payload) {
  const next = clone(payload || {});
  delete next.spu_name;
  delete next.spuName;
  delete next.is_spu_pic;
  delete next.isSpuPic;
  delete next.image_info;
  delete next.imageInfo;
  const skcRows = asArray(next.skc_list || next.skcList);
  next.skc_list = skcRows;
  delete next.skcList;
  for (const skc of skcRows) {
    if (!skc || typeof skc !== 'object') continue;
    delete skc.skc_name;
    delete skc.skcName;
    delete skc.image_info;
    delete skc.imageInfo;
    const skuRows = asArray(skc.sku_list || skc.skuList);
    skc.sku_list = skuRows;
    delete skc.skuList;
    for (const sku of skuRows) {
      if (!sku || typeof sku !== 'object') continue;
      delete sku.sku_code;
      delete sku.skuCode;
      delete sku.image_info;
      delete sku.imageInfo;
    }
  }
  return next;
}

function injectPlatformIdentity(payload, identity) {
  const next = clone(payload || {});
  const skcRows = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object');
  if (skcRows.length !== 1) throw new Error(`Pending listing image correction requires exactly one source SKC; received ${skcRows.length}`);
  const skuRows = asArray(skcRows[0].sku_list || skcRows[0].skuList).filter(row => row && typeof row === 'object');
  if (!skuRows.length || skuRows.length !== identity.skuCodes.length) {
    throw new Error(`Pending listing image correction SKU count mismatch: source=${skuRows.length} platform=${identity.skuCodes.length}`);
  }
  next.spu_name = identity.spuName;
  delete next.spuName;
  next.skc_list = skcRows;
  delete next.skcList;
  skcRows[0].skc_name = identity.skcName;
  delete skcRows[0].skcName;
  skcRows[0].sku_list = skuRows;
  delete skcRows[0].skuList;
  skuRows.forEach((sku, index) => {
    sku.sku_code = identity.skuCodes[index];
    delete sku.skuCode;
  });
  return next;
}

export function buildPendingListingImageCorrection({
  sourceTask,
  sourceTaskId,
  targetStore,
  identity,
  documentVersion,
  approvedBindings,
  approvedBindingFingerprint,
} = {}) {
  if (!sourceTask || typeof sourceTask !== 'object') throw new Error('Pending listing image correction requires a referenced source publish task');
  if (!sourceWasSubmitted(sourceTask)) throw new Error('Referenced source publish task has no successful real-submit evidence');
  const spuName = normalizeSpu(identity?.spuName || identity?.spu_name);
  const skcName = normalizeSheinSkc(identity?.skcName || identity?.skc_name);
  const skuCodes = [...new Set(asArray(identity?.skuCodes || identity?.sku_codes).map(normalizeSku).filter(Boolean))];
  if (!spuName || !skcName || !skuCodes.length) throw new Error('Pending listing image correction requires exact SPU, sv/sb/sh SKC and SKU identity');
  const version = text(documentVersion, 160);
  if (!/^SPMP[a-z0-9_-]+$/i.test(version)) throw new Error('Pending listing image correction requires the exact publish document version');
  const sourcePayload = sourcePublishPayload(sourceTask);
  if (!sourcePayload) throw new Error('Referenced source publish task does not contain a complete top-level publishOrEdit payload');
  const identified = injectPlatformIdentity(sourcePayload, {spuName, skcName, skuCodes});
  const bound = applyApprovedImageBindingsToPublishPayload(identified, approvedBindings, {sourceApproved: true});
  const sourceProtectedHash = sha256Stable(protectedProjection(sourcePayload));
  const republishProtectedHash = sha256Stable(protectedProjection(bound.payload));
  if (sourceProtectedHash !== republishProtectedHash) {
    throw new Error('Pending listing image correction changed protected title/price/inventory/supplier fields');
  }
  const bindingFingerprint = text(approvedBindingFingerprint, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(bindingFingerprint)) throw new Error('Pending listing image correction requires the approved image binding fingerprint');
  const correction = {
    schemaVersion: 1,
    kind: 'pending_new_listing_image_correction',
    targetStore: text(targetStore, 40).toUpperCase(),
    sourceTaskId: text(sourceTaskId || sourceTask?.id, 180),
    sourcePayloadHash: sha256Stable(sourcePayload),
    approvedBindingFingerprint: bindingFingerprint,
    identity: {spuName, skcName, skuCodes},
    documentVersion: version,
    republishPayload: bound.payload,
    republishPayloadHash: sha256Stable(bound.payload),
    protectedFieldsHash: sourceProtectedHash,
    allowedChanges: ['spu_name', 'skc_list[].skc_name', 'skc_list[].sku_list[].sku_code', 'SPU/SKC/SKU image fields'],
    protectedFields: ['title', 'category', 'attributes', 'supplier_code', 'supplier_sku', 'cost/price', 'stock/inventory', 'dimensions/weight'],
  };
  correction.correctionFingerprint = sha256Stable(correction);
  return correction;
}

export function validatePendingListingImageCorrection(task, {store = ''} = {}) {
  const correction = task?.pendingNewListingImageCorrection;
  if (!correction) return {present: false, ok: false, blockers: [], correction: null};
  const blockers = [];
  if (correction.kind !== 'pending_new_listing_image_correction' || Number(correction.schemaVersion) !== 1) blockers.push('待审核新品纠图计划版本无效。');
  const targetStore = text(correction.targetStore, 40).toUpperCase();
  if (!targetStore || (store && targetStore !== text(store, 40).toUpperCase())) blockers.push('待审核新品纠图计划店铺不匹配。');
  if (!text(correction.sourceTaskId, 180)) blockers.push('待审核新品纠图计划缺少源发布任务。');
  if (!/^[a-f0-9]{64}$/i.test(text(correction.approvedBindingFingerprint, 80))) blockers.push('待审核新品纠图计划缺少已审图片指纹。');
  if (text(task?.publishAssetBinding?.bindingFingerprint, 80).toLowerCase() !== text(correction.approvedBindingFingerprint, 80).toLowerCase()) blockers.push('已审图片绑定在计划生成后发生变化，必须重新准备。');
  const identity = correction.identity || {};
  const spuName = normalizeSpu(identity.spuName);
  const skcName = normalizeSheinSkc(identity.skcName);
  const skuCodes = asArray(identity.skuCodes).map(normalizeSku).filter(Boolean);
  if (!spuName || !skcName || !skuCodes.length) blockers.push('待审核新品纠图计划商品身份不完整。');
  if (!/^SPMP[a-z0-9_-]+$/i.test(text(correction.documentVersion, 160))) blockers.push('待审核新品纠图计划审核版本无效。');
  const payload = correction.republishPayload;
  if (!payload || typeof payload !== 'object') blockers.push('待审核新品纠图计划缺少完整重提 payload。');
  if (payload && sha256Stable(payload) !== text(correction.republishPayloadHash, 80).toLowerCase()) blockers.push('待审核新品纠图完整 payload 已漂移。');
  const skcRows = asArray(payload?.skc_list || payload?.skcList);
  if (payload && normalizeSpu(payload.spu_name || payload.spuName) !== spuName) blockers.push('待审核新品纠图 SPU 与锁定身份不一致。');
  if (skcRows.length !== 1 || !sameSheinSkc(skcRows[0]?.skc_name || skcRows[0]?.skcName, skcName)) blockers.push('待审核新品纠图 SKC 与锁定身份不一致。');
  const payloadSkuCodes = asArray(skcRows[0]?.sku_list || skcRows[0]?.skuList).map(row => normalizeSku(row?.sku_code || row?.skuCode)).filter(Boolean);
  if (payloadSkuCodes.length !== skuCodes.length || payloadSkuCodes.some((value, index) => value !== skuCodes[index])) blockers.push('待审核新品纠图 SKU 与锁定身份不一致。');
  const fingerprintInput = clone(correction);
  delete fingerprintInput.correctionFingerprint;
  if (sha256Stable(fingerprintInput) !== text(correction.correctionFingerprint, 80).toLowerCase()) blockers.push('待审核新品纠图计划指纹已漂移。');
  return {
    present: true,
    ok: blockers.length === 0,
    blockers,
    correction: blockers.length ? null : clone(correction),
  };
}

export function extractExactDocumentState(responseData, identity, version) {
  const targetSpu = normalizeSpu(identity?.spuName);
  const targetSkc = normalizeSheinSkc(identity?.skcName);
  const targetVersion = text(version, 160);
  const rows = asArray(responseData?.info?.data || responseData?.data?.info?.data);
  const exactSpuRows = rows.filter(row => normalizeSpu(row?.spuName || row?.spu_name) === targetSpu && text(row?.version, 160) === targetVersion);
  const skcRows = exactSpuRows.flatMap(row => asArray(row?.skcList || row?.skc_list)).filter(row => sameSheinSkc(row?.skcName || row?.skc_name, targetSkc));
  if (exactSpuRows.length !== 1 || skcRows.length !== 1) return {ok: false, documentState: null, reason: `expected one exact SPU/version/SKC row, received spu=${exactSpuRows.length} skc=${skcRows.length}`};
  const documentState = Number(skcRows[0]?.documentState ?? skcRows[0]?.document_state);
  return Number.isFinite(documentState)
    ? {ok: true, documentState, row: clone(skcRows[0])}
    : {ok: false, documentState: null, reason: 'documentState missing'};
}
