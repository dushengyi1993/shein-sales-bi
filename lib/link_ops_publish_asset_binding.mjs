import path from 'node:path';
import {isSheinSkc, normalizeSheinSkc} from './shein_product_identifiers.mjs';

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeString(value, max = 500) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function finiteNumber(value, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function validatedImageUrl(value) {
  const raw = safeString(value, 3000);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`Invalid uploaded image URL: ${raw || '(missing)'}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported uploaded image URL protocol: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (!(host === 'shein.com' || host.endsWith('.shein.com') || host === 'ltwebstatic.com' || host.endsWith('.ltwebstatic.com'))) {
    throw new Error(`Uploaded image URL is not a SHEIN image host: ${host}`);
  }
  return url.toString();
}

function normalizedBinding(value, index) {
  if (!value || typeof value !== 'object') throw new Error(`Invalid uploaded image binding at index ${index}`);
  const role = safeString(value.role, 80);
  const allowedRoles = new Set(['mainCover', 'detail', 'squareImage', 'carouselSecondCover', 'skuImage']);
  if (!allowedRoles.has(role)) throw new Error(`Unsupported uploaded image role: ${role || '(missing)'}`);
  const expectedType = role === 'detail' ? 2 : role === 'squareImage' ? 5 : 1;
  const imageType = Number(value.imageType ?? value.image_type ?? expectedType);
  if (imageType !== expectedType) throw new Error(`Image role ${role} requires imageType=${expectedType}`);
  return {
    name: safeString(value.name || value.relativePath || `image-${index + 1}`, 240),
    relativePath: safeString(value.relativePath || value.name || '', 500),
    imageUrl: validatedImageUrl(value.imageUrl || value.image_url),
    imageType,
    role,
    order: Number.isFinite(Number(value.order)) ? Number(value.order) : index,
    width: Math.max(0, Math.trunc(Number(value.width || 0))),
    height: Math.max(0, Math.trunc(Number(value.height || 0))),
    sha256: /^[a-f0-9]{64}$/i.test(String(value.sha256 || '')) ? String(value.sha256).toLowerCase() : '',
  };
}

export function normalizeApprovedImageBindings(bindings, {sourceApproved = false} = {}) {
  if (sourceApproved !== true) throw new Error('Image binding requires explicit reviewed/approved source confirmation');
  const rows = asArray(bindings).map(normalizedBinding);
  if (!rows.length) throw new Error('No uploaded images were provided for task binding');
  const deduped = [];
  const seenUrls = new Set();
  for (const row of rows.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
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

function projectionImageType(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') return null;
  const imageType = Number(value);
  return Number.isInteger(imageType) && imageType > 0 ? imageType : null;
}

function projectionImageUrl(value) {
  return safeString(value, 3000);
}

function compareImageProjectionRows(a, b) {
  if (a.role !== b.role) return a.role < b.role ? -1 : 1;
  if (a.imageSort !== b.imageSort) return a.imageSort - b.imageSort;
  if (a.imageType !== b.imageType) return a.imageType - b.imageType;
  return a.imageUrl < b.imageUrl ? -1 : a.imageUrl > b.imageUrl ? 1 : 0;
}

function projectionImageSort(value, fallback = 1, {allowMissing = true} = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return allowMissing ? fallback : null;
  }
  if (typeof value === 'boolean') return null;
  const imageSort = Number(value);
  // An explicitly present but invalid order is drift, not a missing field.
  // Returning null keeps it visible in the canonical comparison instead of
  // silently replacing it with the array index.
  return Number.isInteger(imageSort) && imageSort > 0 ? imageSort : null;
}

function exclusiveAliasValue(row, aliases, label, {required = false} = {}) {
  const present = aliases.filter(key => Object.hasOwn(row || {}, key));
  if (present.length > 1) throw new Error(`publish payload image ${label} uses conflicting aliases: ${present.join('/')}`);
  if (!present.length) {
    if (required) throw new Error(`publish payload image ${label} is missing`);
    return undefined;
  }
  return row[present[0]];
}

function imageProjectionRow(row, role, imageSort = 1, {requireExplicitSort = false} = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('publish payload image row must be an object');
  const rawUrl = exclusiveAliasValue(row, ['imageUrl', 'image_url', 'url'], 'URL', {required: true});
  const imageUrl = projectionImageUrl(rawUrl);
  if (!imageUrl) throw new Error('publish payload image URL is empty');
  const rawImageSort = exclusiveAliasValue(row, ['imageSort', 'image_sort'], 'sort', {required: requireExplicitSort});
  const rawImageType = exclusiveAliasValue(row, ['imageType', 'image_type'], 'type', {required: requireExplicitSort});
  const normalizedSort = rawImageSort === undefined ? imageSort : projectionImageSort(rawImageSort, imageSort, {allowMissing: !requireExplicitSort});
  const normalizedType = projectionImageType(rawImageType);
  if (normalizedSort === null) throw new Error('publish payload image sort is invalid');
  if (normalizedType === null) throw new Error('publish payload image type is invalid');
  return {
    role,
    imageSort: normalizedSort,
    imageType: normalizedType,
    imageUrl,
  };
}

function payloadImageInfoRows(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return [];
  const imageInfo = exclusiveAliasValue(container, ['image_info', 'imageInfo'], 'container');
  if (imageInfo === undefined) return [];
  if (!imageInfo || typeof imageInfo !== 'object' || Array.isArray(imageInfo)) throw new Error('publish payload image container is invalid');
  const rows = exclusiveAliasValue(imageInfo, ['image_info_list', 'imageInfoList'], 'list', {required: true});
  if (!Array.isArray(rows)) throw new Error('publish payload image list is not an array');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('publish payload image list contains a non-object row');
  }
  return rows;
}

function skcImageProjectionRole(imageType) {
  if (imageType === 1) return 'mainCover';
  if (imageType === 2) return 'detail';
  if (imageType === 5) return 'squareImage';
  // Keep unsupported/unknown platform image types in the projection. They can
  // never silently disappear from a protected comparison and therefore remain
  // a deterministic mismatch against the approved role set.
  return `skcImageType:${imageType}`;
}

/**
 * Canonical protected image projection for an approved binding. The payload
 * does not carry the local name/size/hash fields, so comparison is limited to
 * the role, semantic image slot, platform image type, and bound URL. The
 * projection mirrors applyApprovedImageBindingsToPublishPayload: the local
 * binding order becomes the SKC image_sort sequence, while the two legal
 * split locations each have their own sequence.
 */
export function normalizeApprovedImageBindingProjection(bindings, {sourceApproved = false} = {}) {
  const normalized = normalizeApprovedImageBindings(bindings, {sourceApproved});
  const main = normalized.find(row => row.role === 'mainCover');
  const details = normalized.filter(row => row.role === 'detail');
  const square = normalized.find(row => row.role === 'squareImage');
  const skcRows = [main, ...details, square]
    .filter(Boolean)
    .map((row, index) => imageProjectionRow(row, row.role, index + 1));
  const splitRows = normalized
    .filter(row => row.role === 'carouselSecondCover' || row.role === 'skuImage')
    .map(row => imageProjectionRow(row, row.role, 1));
  return [...skcRows, ...splitRows]
    .filter(Boolean)
    .sort(compareImageProjectionRows);
}

/**
 * Canonical protected image projection for an OpenAPI publish payload.
 *
 * A copy-product payload deliberately stores the approved image roles in
 * three different locations:
 *   - main/detail/square in skc_list[].image_info;
 *   - carouselSecondCover in the top-level image_info;
 *   - skuImage in skc_list[].sku_list[].image_info.
 * Comparing only the SKC list would turn the valid 14-image binding (12 SKC
 * images + carousel + SKU image) into a false 14-vs-12 drift.
 */
export function normalizePublishPayloadImageProjection(payload) {
  const rows = [];
  const rawSkcList = exclusiveAliasValue(payload || {}, ['skc_list', 'skcList'], 'SKC list');
  const skcList = asArray(rawSkcList)
    .filter(row => row && typeof row === 'object' && !Array.isArray(row));
  const canonicalSkcProjections = [];
  const canonicalSkuProjections = [];
  for (const skc of skcList) {
    const skcRows = [];
    for (const [index, row] of payloadImageInfoRows(skc).entries()) {
      const imageType = projectionImageType(exclusiveAliasValue(row, ['imageType', 'image_type'], 'type', {required: true}));
      const projected = imageProjectionRow(row, skcImageProjectionRole(imageType), index + 1, {requireExplicitSort: true});
      skcRows.push(projected);
    }
    canonicalSkcProjections.push(skcRows.sort(compareImageProjectionRows));
    const rawSkuList = exclusiveAliasValue(skc, ['sku_list', 'skuList'], 'SKU list');
    const skuList = asArray(rawSkuList)
      .filter(row => row && typeof row === 'object' && !Array.isArray(row));
    const perSku = [];
    for (const sku of skuList) {
      const skuRows = [];
      for (const [index, row] of payloadImageInfoRows(sku).entries()) {
        const projected = imageProjectionRow(row, 'skuImage', index + 1, {requireExplicitSort: true});
        skuRows.push(projected);
      }
      perSku.push(skuRows.sort(compareImageProjectionRows));
    }
    if (perSku.length) {
      const first = JSON.stringify(perSku[0]);
      if (perSku.some(group => JSON.stringify(group) !== first)) throw new Error('publish payload SKU image bindings are inconsistent across SKUs');
      canonicalSkuProjections.push(perSku[0]);
    }
  }
  if (canonicalSkcProjections.length) {
    const first = JSON.stringify(canonicalSkcProjections[0]);
    if (canonicalSkcProjections.some(group => JSON.stringify(group) !== first)) throw new Error('publish payload image bindings are inconsistent across SKCs');
    rows.push(...canonicalSkcProjections[0]);
  }
  if (canonicalSkuProjections.length) {
    const first = JSON.stringify(canonicalSkuProjections[0]);
    if (canonicalSkuProjections.some(group => JSON.stringify(group) !== first)) throw new Error('publish payload SKU image bindings are inconsistent across SKCs');
    rows.push(...canonicalSkuProjections[0]);
  }
  for (const [index, row] of payloadImageInfoRows(payload).entries()) {
    const projected = imageProjectionRow(row, 'carouselSecondCover', index + 1, {requireExplicitSort: true});
    if (projected) rows.push(projected);
  }
  return rows.sort(compareImageProjectionRows);
}

function imageInfoRow(row, imageSort) {
  return {
    image_type: row.imageType,
    image_sort: imageSort,
    image_url: row.imageUrl,
  };
}

export function applyApprovedImageBindingsToPublishPayload(payload, bindings, {sourceApproved = false} = {}) {
  const normalized = normalizeApprovedImageBindings(bindings, {sourceApproved});
  const next = clone(payload || {});
  const skcList = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object');
  if (!skcList.length) throw new Error('Publish payload has no SKC to receive approved images');
  next.skc_list = skcList;
  if ('skcList' in next) delete next.skcList;

  const main = normalized.find(row => row.role === 'mainCover');
  const details = normalized.filter(row => row.role === 'detail');
  const square = normalized.find(row => row.role === 'squareImage');
  const carousel = normalized.find(row => row.role === 'carouselSecondCover') || null;
  const sku = normalized.find(row => row.role === 'skuImage') || null;
  const skcImages = [main, ...details, square].map((row, index) => imageInfoRow(row, index + 1));
  for (const skcRow of skcList) {
    skcRow.image_info = {image_info_list: clone(skcImages)};
    if ('imageInfo' in skcRow) delete skcRow.imageInfo;
    for (const skuRow of asArray(skcRow.sku_list || skcRow.skuList)) {
      if (!skuRow || typeof skuRow !== 'object') continue;
      if (sku) {
        skuRow.image_info = {image_info_list: [imageInfoRow({...sku, imageType: 1}, 1)]};
        if ('imageInfo' in skuRow) delete skuRow.imageInfo;
      } else {
        delete skuRow.image_info;
        delete skuRow.imageInfo;
      }
    }
  }
  if (carousel) {
    next.is_spu_pic = true;
    next.image_info = {image_info_list: [imageInfoRow({...carousel, imageType: 1}, 1)]};
    if ('imageInfo' in next) delete next.imageInfo;
  } else {
    delete next.is_spu_pic;
    delete next.isSpuPic;
    delete next.image_info;
    delete next.imageInfo;
  }
  return {
    payload: next,
    bindings: normalized,
    evidence: {
      sourceApproved: true,
      payloadSource: 'task',
      boundImageCount: normalized.length,
      boundNames: normalized.map(row => row.name),
      mainImage: main.name,
      squareImage: square.name,
      squareDimensions: square.width && square.height ? `${square.width}x${square.height}` : '',
      carouselImage: carousel?.name || '',
      detailCount: details.length,
      skuImage: sku?.name || '',
    },
  };
}

function normalizePlatformIdentifier(value, {kind}) {
  const raw = safeString(value, 160);
  if (kind === 'skc') return normalizeSheinSkc(raw);
  const text = kind === 'sku' ? raw : raw.toLowerCase();
  if (!text) return '';
  if (kind === 'spu') return /^[a-z]\d{10,}$/.test(text) && !isSheinSkc(text) ? text : '';
  if (kind === 'sku') return /^[a-z0-9][a-z0-9_-]{5,159}$/i.test(text) ? text : '';
  return '';
}

export function applyApprovedImageBindingsToMaintenancePayload(identity, bindings, {sourceApproved = false} = {}) {
  const spuName = normalizePlatformIdentifier(identity?.spuName ?? identity?.spu_name ?? identity?.spu, {kind: 'spu'});
  const skcName = normalizePlatformIdentifier(identity?.skcName ?? identity?.skc_name ?? identity?.skc, {kind: 'skc'});
  const skuCodes = [...new Set(asArray(identity?.skuCodes ?? identity?.sku_codes ?? identity?.skuCodeList)
    .map(value => normalizePlatformIdentifier(value, {kind: 'sku'}))
    .filter(Boolean))];
  if (!spuName) throw new Error('Approved maintenance image binding requires one explicit real SPU');
  if (!skcName) throw new Error('Approved maintenance image binding requires one explicit real sv/sb/sh SKC');
  const normalizedBindings = normalizeApprovedImageBindings(bindings, {sourceApproved});
  const hasSkuImage = normalizedBindings.some(row => row.role === 'skuImage');
  if (hasSkuImage && !skuCodes.length) {
    throw new Error('Approved maintenance image binding includes skuImage but no exact SKU code was supplied');
  }
  const base = {
    spu_name: spuName,
    skc_list: [{
      skc_name: skcName,
      ...(hasSkuImage ? {sku_list: skuCodes.map(skuCode => ({sku_code: skuCode}))} : {}),
    }],
  };
  const bound = applyApprovedImageBindingsToPublishPayload(base, normalizedBindings, {sourceApproved: true});
  return {
    ...bound,
    identity: {spuName, skcName, skuCodes},
    evidence: {
      ...bound.evidence,
      payloadSource: 'task.imageEditPayload',
      maintenanceOnly: true,
      touchedFields: ['spu_name', 'is_spu_pic', 'image_info', 'skc_list[].skc_name', 'skc_list[].image_info', ...(hasSkuImage ? ['skc_list[].sku_list[].sku_code', 'skc_list[].sku_list[].image_info'] : [])],
    },
  };
}

export function normalizePublishPreparationOverrides(value = {}) {
  const nestedTitles = value?.titles && typeof value.titles === 'object' ? value.titles : {};
  const targetStore = safeString(value.targetStore ?? value.target_store ?? value.store, 20).toUpperCase();
  const rawTitleGroup = safeString(value.titleGroup ?? value.title_group ?? value.titleStyleGroup, 40).toLowerCase();
  const titleGroup = /^title[123]$/.test(rawTitleGroup) ? rawTitleGroup : '';
  const standardGoodsSn = safeString(value.standardGoodsSn ?? value.standard_goods_sn, 240);
  const supplierSku = safeString(value.supplierSku ?? value.supplier_sku, 240);
  const supplyPrice = finiteNumber(value.supplyPrice ?? value.supply_price, {min: 0, max: 1_000_000_000});
  const inventory = finiteNumber(value.inventory ?? value.stockQty ?? value.stock_qty, {min: 0, max: 1_000_000_000});
  const categoryIdRaw = finiteNumber(value.categoryId ?? value.category_id, {min: 1, max: 1_000_000_000});
  const titleAr = safeString(value.titleAr ?? value.title_ar ?? nestedTitles.ar, 1000);
  const titleEn = safeString(value.titleEn ?? value.title_en ?? nestedTitles.en, 1000);
  const attributeOverrides = asArray(value.attributeOverrides || value.attribute_overrides)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}))
    .slice(0, 100);
  return {
    targetStore,
    titleGroup,
    standardGoodsSn,
    supplierSku,
    supplyPrice,
    inventory: inventory === null ? null : Math.trunc(inventory),
    categoryId: categoryIdRaw === null ? null : Math.trunc(categoryIdRaw),
    titles: {...(titleAr ? {ar: titleAr} : {}), ...(titleEn ? {en: titleEn} : {})},
    attributeOverrides,
  };
}

export function applyExplicitPublishPreparationOverrides(payload, rawOverrides = {}) {
  const overrides = normalizePublishPreparationOverrides(rawOverrides);
  const next = clone(payload || {});
  const applied = [];
  if (overrides.categoryId !== null) {
    next.category_id = overrides.categoryId;
    delete next.categoryId;
    applied.push('category_id.explicit');
  }
  const existingNames = asArray(next.multi_language_name_list || next.multiLanguageNameList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}));
  const namesByLanguage = new Map(existingNames.map(row => [safeString(row.language || row.lang, 40).toLowerCase(), row]));
  for (const [language, name] of Object.entries(overrides.titles)) {
    namesByLanguage.set(language, {language, name});
    applied.push(`multi_language_name_list.${language}.explicit`);
  }
  if (Object.keys(overrides.titles).length) {
    next.multi_language_name_list = [...namesByLanguage.values()].filter(row => row.language && safeString(row.name, 1000));
    delete next.multiLanguageNameList;
  }

  const skcList = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object');
  next.skc_list = skcList;
  delete next.skcList;
  for (const [skcIndex, skc] of skcList.entries()) {
    if (overrides.standardGoodsSn) {
      skc.supplier_code = overrides.standardGoodsSn;
      delete skc.supplierCode;
      applied.push(`skc_list[${skcIndex}].supplier_code.explicit`);
    }
    for (const [skuIndex, sku] of asArray(skc.sku_list || skc.skuList).entries()) {
      if (!sku || typeof sku !== 'object') continue;
      const targetSupplierSku = overrides.supplierSku || overrides.standardGoodsSn;
      if (targetSupplierSku) {
        sku.supplier_sku = targetSupplierSku;
        delete sku.supplierSku;
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].supplier_sku.${overrides.supplierSku ? 'unique_override' : 'explicit'}`);
      }
      if (overrides.supplyPrice !== null) {
        const costInfo = sku.cost_info || sku.costInfo || {};
        sku.cost_info = {...costInfo, currency: safeString(costInfo.currency || 'SAR', 20) || 'SAR', cost_price: overrides.supplyPrice.toFixed(2)};
        delete sku.costInfo;
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].cost_info.cost_price.explicit`);
      }
      if (overrides.inventory !== null) {
        let stockRows = asArray(sku.stock_info_list || sku.stockInfoList).filter(row => row && typeof row === 'object').map(row => ({...row}));
        if (!stockRows.length) stockRows = [{inventory_num: overrides.inventory}];
        else {
          stockRows = stockRows.map(row => {
            const nextRow = {...row};
            let assigned = false;
            for (const key of ['inventory_num', 'inventoryNum', 'stock', 'stock_num', 'stockNum', 'quantity']) {
              if (Object.hasOwn(nextRow, key)) {
                nextRow[key] = overrides.inventory;
                assigned = true;
              }
            }
            if (!assigned) nextRow.inventory_num = overrides.inventory;
            return nextRow;
          });
        }
        sku.stock_info_list = stockRows;
        delete sku.stockInfoList;
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].stock_info_list.inventory.explicit`);
      }
    }
  }
  return {
    payload: next,
    applied: [...new Set(applied)],
    evidence: {
      targetStore: overrides.targetStore || null,
      titleGroup: overrides.titleGroup || null,
      standardGoodsSn: overrides.standardGoodsSn || null,
      supplierSku: overrides.supplierSku || overrides.standardGoodsSn || null,
      supplyPrice: overrides.supplyPrice,
      supplyPriceCurrency: overrides.supplyPrice === null ? null : 'SAR',
      inventory: overrides.inventory,
      categoryId: overrides.categoryId,
      titleLanguages: Object.keys(overrides.titles),
      attributeOverrideIds: overrides.attributeOverrides
        .map(row => Number(row.attribute_id ?? row.attributeId ?? row.id))
        .filter(Number.isFinite),
    },
    overrides,
  };
}

export function taskHasUnboundImageAssets(task) {
  if (task?.publishAssetBinding?.boundAt || task?.metadata?.publishAssetBinding?.boundAt) return false;
  return asArray(task?.assets).some(asset => String(asset?.mime || asset?.type || '').toLowerCase().startsWith('image/'));
}

export function imageBindingDisplayName(binding) {
  return safeString(binding?.name || path.basename(String(binding?.relativePath || '')), 240);
}
