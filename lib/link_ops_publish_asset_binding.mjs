import path from 'node:path';

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
  const sku = normalized.find(row => row.role === 'skuImage') || main;
  const skcImages = [main, ...details, square].map((row, index) => imageInfoRow(row, index + 1));
  for (const skcRow of skcList) {
    skcRow.image_info = {image_info_list: clone(skcImages)};
    if ('imageInfo' in skcRow) delete skcRow.imageInfo;
    for (const skuRow of asArray(skcRow.sku_list || skcRow.skuList)) {
      if (!skuRow || typeof skuRow !== 'object') continue;
      skuRow.image_info = {image_info_list: [imageInfoRow({...sku, imageType: 1}, 1)]};
      if ('imageInfo' in skuRow) delete skuRow.imageInfo;
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

export function normalizePublishPreparationOverrides(value = {}) {
  const nestedTitles = value?.titles && typeof value.titles === 'object' ? value.titles : {};
  const standardGoodsSn = safeString(value.standardGoodsSn ?? value.standard_goods_sn, 240);
  const supplyPrice = finiteNumber(value.supplyPrice ?? value.supply_price, {min: 0, max: 1_000_000_000});
  const inventory = finiteNumber(value.inventory ?? value.stockQty ?? value.stock_qty, {min: 0, max: 1_000_000_000});
  const categoryIdRaw = finiteNumber(value.categoryId ?? value.category_id, {min: 1, max: 1_000_000_000});
  const titleAr = safeString(value.titleAr ?? value.title_ar ?? nestedTitles.ar, 1000);
  const titleEn = safeString(value.titleEn ?? value.title_en ?? nestedTitles.en, 1000);
  return {
    standardGoodsSn,
    supplyPrice,
    inventory: inventory === null ? null : Math.trunc(inventory),
    categoryId: categoryIdRaw === null ? null : Math.trunc(categoryIdRaw),
    titles: {...(titleAr ? {ar: titleAr} : {}), ...(titleEn ? {en: titleEn} : {})},
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
      if (overrides.standardGoodsSn) {
        sku.supplier_sku = overrides.standardGoodsSn;
        delete sku.supplierSku;
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].supplier_sku.explicit`);
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
      standardGoodsSn: overrides.standardGoodsSn || null,
      supplyPrice: overrides.supplyPrice,
      supplyPriceCurrency: overrides.supplyPrice === null ? null : 'SAR',
      inventory: overrides.inventory,
      categoryId: overrides.categoryId,
      titleLanguages: Object.keys(overrides.titles),
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
