import crypto from 'node:crypto';

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeString(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeNumberish(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sourceRef(draft) {
  return {
    sourceType: draft?.source?.type || 'unknown',
    storeKey: draft?.source?.storeKey || '',
    sourceDate: draft?.source?.date || '',
    sourceSkc: draft?.source?.skc || '',
    pointers: asArray(draft?.source?.pointers),
  };
}

function buildObservation(draftResult) {
  const draft = draftResult?.canonicalDraft || draftResult || {};
  const source = sourceRef(draft);
  const product = draft.product || {};
  const skc = asArray(draft.skcs)[0] || {};
  const sku = asArray(skc.skus)[0] || {};
  const raw = {
    categoryId: product.categoryId || '',
    productTypeId: product.productTypeId || '',
    categoryPath: product.categoryPath || [],
    brandCode: product.brandCode || '',
    brandName: product.brandName || '',
    names: draft.names || [],
    saleName: skc.saleName || '',
    saleAttribute: skc.sourceSkcRaw?.main_attr || skc.sourceSkcRaw?.mainAttr || null,
    sku: {
      sourceSkuCode: sku.sourceSkuCode || '',
      sourceSkuAttr: sku.sourceSkuAttr || '',
      sourceSupplierSku: sku.sourceSupplierSku || '',
      sourcePurchasePrice: sku.sourcePurchasePrice || '',
      sourceFinalPrice: sku.sourceFinalPrice || '',
    },
  };
  return {
    observationId: `obs_${source.storeKey || 'NA'}_${source.sourceSkc || 'NA'}_${source.sourceDate || 'unknown'}_${sha256Json(raw).slice(0, 10)}`,
    capturedAt: draft.generatedAt || nowIso(),
    ...source,
    confidence: draftResult?.readyForOpenApiSubmit ? 'high' : 'partial',
    rawHash: sha256Json(raw),
    normalized: raw,
  };
}

function buildTitleSet(draft) {
  return asArray(draft.names).map(row => ({
    language: row.language || '',
    title: safeString(row.name, 700),
    source: 'source_observation',
    status: row.name ? 'candidate' : 'missing',
  })).filter(row => row.language || row.title);
}

function buildAttributeSet(draft) {
  const out = [];
  for (const skc of asArray(draft.skcs)) {
    const attr = skc.sourceSkcRaw?.main_attr || skc.sourceSkcRaw?.mainAttr;
    if (!attr) continue;
    const attributeId = firstNonEmpty(attr.attribute_id, attr.attributeId);
    const attributeValueId = firstNonEmpty(attr.attribute_value_id, attr.attributeValueId);
    out.push({
      scope: 'sale_attribute',
      attributeId: attributeId ? String(attributeId) : '',
      attributeName: '',
      valueId: attributeValueId ? String(attributeValueId) : '',
      valueText: skc.saleName || '',
      valueUnit: '',
      source: 'source_observation',
      status: attributeId && attributeValueId ? 'candidate' : 'needs_review',
      conflictKey: attributeId ? `sale_attribute:${attributeId}` : 'sale_attribute:unknown',
    });
  }
  return out;
}

function buildSkuTemplates(draft) {
  return asArray(draft.skcs).flatMap((skc, skcIndex) => asArray(skc.skus).map((sku, skuIndex) => ({
    templateKey: `skc${skcIndex + 1}-sku${skuIndex + 1}`,
    variationText: safeString(sku.sourceSkuAttr || skc.saleName || ''),
    sourcePlatformSkuCode: safeString(sku.sourceSkuCode || ''),
    sourceSupplierSku: safeString(sku.sourceSupplierSku || ''),
    supplierSku: '',
    supplierSkuStatus: sku.sourceSupplierSku ? 'source_candidate' : 'missing_needs_manual_or_rule',
    platformSkuPolicy: {
      doNotGeneratePlatformSkuCode: true,
      note: '平台 sku_code / skc 通常由 SHEIN 审核或系统分配；母库只保存源平台 SKU 作为追溯，不把它当成新链接 SKU。',
    },
    dimensions: {
      length: null,
      width: null,
      height: null,
      weight: null,
      unit: 'cm/kg',
      status: 'missing_needs_edit_detail_or_manual',
    },
    costInfo: {
      currency: 'SAR',
      supplyPrice: null,
      costSource: '',
      status: 'missing_needs_cost_table_or_edit_detail',
    },
    stockPolicy: {
      initialStock: 100,
      status: 'default_by_user_rule',
    },
  })));
}

function buildConflictPlaceholders(candidate) {
  const conflicts = [];
  const needReviewFields = [
    ['categoryProfile.productTypeId', !candidate.categoryProfile.productTypeId],
    ['categoryAttributes.product_attribute_list', candidate.categoryAttributes.productAttributes.length === 0],
    ['skuTemplates.dimensions', candidate.skuTemplates.some(sku => sku.dimensions.status.startsWith('missing'))],
    ['skuTemplates.costInfo', false],
    ['skuTemplates.supplierSku', false],
  ];
  for (const [fieldPath, missing] of needReviewFields) {
    if (!missing) continue;
    conflicts.push({
      fieldPath,
      type: 'missing_required_for_openapi',
      status: 'needs_manual_or_detail_api',
      candidates: [],
      resolution: null,
      note: '当前源快照没有该字段；等商品编辑详情 WebAPI、成本表或人工核实补齐。',
    });
  }
  return conflicts;
}

export function buildProductMasterCandidateFromDraft(draftResult, options = {}) {
  const draft = draftResult?.canonicalDraft || draftResult || {};
  const product = draft.product || {};
  const observation = buildObservation(draftResult);
  const candidate = {
    schema: 'shein-product-master/v1',
    generatedAt: nowIso(),
    recordStatus: 'candidate',
    reviewStatus: 'needs_review',
    identity: {
      standardGoodsSn: safeString(product.standardGoodsSn || options.standardGoodsSn || ''),
      canonicalProductKey: safeString(product.standardGoodsSn || product.supplierCode || observation.sourceSkc || ''),
      productFamily: safeString(product.standardGoodsSn || product.supplierCode || ''),
      sourceGoodsSnList: [safeString(product.supplierCode || product.standardGoodsSn || '')].filter(Boolean),
    },
    categoryProfile: {
      categoryId: product.categoryId ? String(product.categoryId) : '',
      productTypeId: product.productTypeId ? String(product.productTypeId) : '',
      categoryName: safeString(product.categoryName || ''),
      categoryPath: asArray(product.categoryPath).map(v => safeString(v, 200)).filter(Boolean),
      brandCode: safeString(product.brandCode || ''),
      brandName: safeString(product.brandName || ''),
      status: product.categoryId ? 'candidate' : 'missing',
    },
    titleSet: buildTitleSet(draft),
    categoryAttributes: {
      model: 'dynamic_attribute_array',
      productAttributes: [],
      saleAttributes: buildAttributeSet(draft),
      note: '不同品类属性不同，不能固定成宽表；按 OpenAPI/WebAPI 的 attribute_id/value_id/value_text 动态数组保存。',
    },
    skuTemplates: buildSkuTemplates(draft),
    pricingPolicy: {
      mode: 'strategy_before_submit',
      defaultStrategies: [
        {code: 'target_margin_50_percent', label: '按商品 50% 利润率报价'},
        {code: 'max_approved_price_same_product', label: '按同款其它店铺最高核价报价'},
      ],
      manualOverrideAllowed: true,
      conflictPolicy: '不同店核价不视为商品资料冲突；执行前按策略生成本次报价。',
    },
    compliance: {
      certificateRefs: [],
      qualificationRefs: [],
      status: 'unknown_until_edit_detail_or_manual',
    },
    imagePolicy: {
      storeImagesInMaster: false,
      strategy: 'task_temp_material_package_only',
      note: '母库不保存图片 URL 或图片文件；复制/换图任务临时取源图或用户上传素材，执行后清理临时素材包。',
    },
    sourceObservations: [observation],
    conflicts: [],
    openapiMapping: {
      requiredStillMissing: asArray(draft.quality?.blockers || draftResult?.blockers),
      publishPayloadStatus: draftResult?.readyForOpenApiSubmit ? 'ready_candidate' : 'blocked_missing_fields',
    },
  };
  candidate.conflicts = buildConflictPlaceholders(candidate);
  candidate.reviewStatus = candidate.conflicts.length ? 'needs_review' : 'ready_candidate';
  return candidate;
}

function multiName(list, nameKey = 'productName') {
  return asArray(list).map(row => ({
    language: safeString(row?.language || ''),
    title: safeString(row?.[nameKey] || row?.productName || row?.name || '', 700),
    source: 'openapi_spu_info',
    status: row?.[nameKey] || row?.productName || row?.name ? 'candidate' : 'missing',
  })).filter(row => row.language || row.title);
}

function attributeMultiName(list, key) {
  const zh = asArray(list).find(row => String(row?.language || '').toLowerCase().includes('zh'));
  const en = asArray(list).find(row => String(row?.language || '').toLowerCase().includes('en'));
  return safeString(zh?.[key] || en?.[key] || asArray(list)[0]?.[key] || '');
}

function openApiAttribute(row, scope) {
  return {
    scope,
    attributeId: safeString(row?.attributeId || ''),
    attributeName: attributeMultiName(row?.attributeMultiList, 'attributeName'),
    valueId: safeString(row?.attributeValueId || ''),
    valueText: attributeMultiName(row?.attributeValueMultiList, 'attributeValueName') || safeString(row?.attributeValue || ''),
    valueUnit: '',
    source: 'openapi_spu_info',
    status: row?.attributeId ? 'candidate' : 'needs_review',
    conflictKey: `${scope}:${safeString(row?.attributeId || 'unknown')}`,
  };
}

function firstCurrencyCost(costInfoList, preferred = 'SAR') {
  const rows = asArray(costInfoList);
  return rows.find(row => String(row?.currency || '').toUpperCase() === preferred)
    || rows.find(row => row?.costPrice !== undefined && row?.costPrice !== null)
    || null;
}

function buildSkuTemplatesFromOpenApi(spuInfo) {
  const out = [];
  for (const [skcIndex, skc] of asArray(spuInfo?.skcInfoList).entries()) {
    for (const [skuIndex, sku] of asArray(skc?.skuInfoList).entries()) {
      const sellerWeight = sku?.sellerSkuWeight || {};
      const cost = firstCurrencyCost(sku?.costInfoList, 'SAR');
      const supplierSku = safeString(sku?.supplierSku || sku?.skuSupplierInfo?.supplierSku || '');
      out.push({
        templateKey: `skc${skcIndex + 1}-sku${skuIndex + 1}`,
        variationText: safeString(
          asArray(sku?.saleAttributeList).map(row => attributeMultiName(row?.attributeValueMultiList, 'attributeValueName')).filter(Boolean).join(' / ')
          || attributeMultiName(skc?.attributeValueMultiList, 'attributeValueName')
        ),
        sourcePlatformSkuCode: safeString(sku?.skuCode || ''),
        sourceSupplierSku: supplierSku,
        supplierSku: supplierSku,
        supplierSkuStatus: supplierSku ? 'source_candidate' : 'not_provided_by_platform_optional',
        platformSkuPolicy: {
          doNotGeneratePlatformSkuCode: true,
          note: '平台 sku_code / skc 是 SHEIN 产物；母库只保存源平台 SKU 作为追溯，不把它当成新链接 SKU。',
        },
        dimensions: {
          length: normalizeNumberish(sku?.length ?? sellerWeight?.length),
          width: normalizeNumberish(sku?.width ?? sellerWeight?.width),
          height: normalizeNumberish(sku?.height ?? sellerWeight?.height),
          weight: normalizeNumberish(sku?.weight ?? sellerWeight?.weight),
          unit: 'cm/g',
          status: (sku?.length || sellerWeight?.length) && (sku?.width || sellerWeight?.width) && (sku?.height || sellerWeight?.height) && (sku?.weight || sellerWeight?.weight)
            ? 'source_candidate'
            : 'missing_needs_edit_detail_or_manual',
        },
        costInfo: {
          currency: safeString(cost?.currency || 'SAR'),
          supplyPrice: normalizeNumberish(cost?.costPrice),
          costSource: cost ? 'openapi_spu_info.costInfoList' : '',
          status: cost ? 'source_candidate' : 'missing_use_pricing_policy',
        },
        stockPolicy: {
          initialStock: 100,
          status: 'default_by_user_rule',
        },
      });
    }
  }
  return out;
}

export function buildProductMasterCandidateFromOpenApiSpuInfo(spuInfo, options = {}) {
  const titleSet = multiName(spuInfo?.productMultiNameList, 'productName');
  const productAttributes = asArray(spuInfo?.productAttributeInfoList).map(row => openApiAttribute(row, 'product_attribute'));
  const saleAttributes = asArray(spuInfo?.skcInfoList).map(row => openApiAttribute(row, 'sale_attribute'));
  const candidate = {
    schema: 'shein-product-master/v1',
    generatedAt: nowIso(),
    recordStatus: 'candidate',
    reviewStatus: 'ready_candidate',
    identity: {
      standardGoodsSn: safeString(spuInfo?.supplierCode || options.standardGoodsSn || ''),
      canonicalProductKey: safeString(spuInfo?.supplierCode || spuInfo?.spuName || ''),
      productFamily: safeString(spuInfo?.supplierCode || ''),
      sourceGoodsSnList: [safeString(spuInfo?.supplierCode || '')].filter(Boolean),
    },
    categoryProfile: {
      categoryId: safeString(spuInfo?.categoryId || ''),
      productTypeId: safeString(spuInfo?.productTypeId || ''),
      categoryName: '',
      categoryPath: [],
      brandCode: safeString(spuInfo?.brandCode || ''),
      brandName: '',
      status: spuInfo?.categoryId && spuInfo?.productTypeId ? 'source_candidate' : 'missing',
    },
    titleSet,
    categoryAttributes: {
      model: 'dynamic_attribute_array',
      productAttributes,
      saleAttributes,
      note: 'OpenAPI spu-info 返回动态属性数组，母库按 attribute_id/value_id/value_text 保存。',
    },
    skuTemplates: buildSkuTemplatesFromOpenApi(spuInfo),
    pricingPolicy: {
      mode: 'strategy_before_submit',
      defaultStrategies: [
        {code: 'target_margin_50_percent', label: '按商品 50% 利润率报价'},
        {code: 'max_approved_price_same_product', label: '按同款其它店铺最高核价报价'},
      ],
      manualOverrideAllowed: true,
      conflictPolicy: '不同店核价不视为商品资料冲突；执行前按策略生成本次报价。',
    },
    compliance: {
      certificateRefs: [],
      qualificationRefs: [],
      status: 'unknown_until_compliance_api_or_manual',
    },
    imagePolicy: {
      storeImagesInMaster: false,
      strategy: 'task_temp_material_package_only',
      note: '母库不保存图片 URL 或图片文件；复制/换图任务临时取源图或用户上传素材，执行后清理临时素材包。',
    },
    sourceObservations: [{
      observationId: `obs_openapi_${safeString(options.storeKey || 'HL')}_${safeString(spuInfo?.spuName || 'spu')}_${sha256Json(spuInfo).slice(0, 10)}`,
      capturedAt: nowIso(),
      sourceType: 'shein_openapi_spu_info',
      storeKey: safeString(options.storeKey || ''),
      sourceDate: '',
      sourceSpu: safeString(spuInfo?.spuName || ''),
      sourceSkc: safeString(asArray(spuInfo?.skcInfoList)[0]?.skcName || ''),
      confidence: 'high',
      rawHash: sha256Json(spuInfo),
    }],
    conflicts: [],
    openapiMapping: {
      requiredStillMissing: [],
      publishPayloadStatus: 'source_candidate_needs_target_payload_mapping',
    },
  };
  candidate.conflicts = buildConflictPlaceholders(candidate);
  candidate.reviewStatus = candidate.conflicts.length ? 'needs_review' : 'ready_candidate';
  return candidate;
}

export function summarizeProductMasterCandidate(candidate) {
  return {
    standardGoodsSn: candidate?.identity?.standardGoodsSn || '',
    categoryId: candidate?.categoryProfile?.categoryId || '',
    productTypeId: candidate?.categoryProfile?.productTypeId || '',
    titleCount: candidate?.titleSet?.length || 0,
    productAttributeCount: candidate?.categoryAttributes?.productAttributes?.length || 0,
    saleAttributeCount: candidate?.categoryAttributes?.saleAttributes?.length || 0,
    skuTemplateCount: candidate?.skuTemplates?.length || 0,
    imageStoredInMaster: Boolean(candidate?.imagePolicy?.storeImagesInMaster),
    reviewStatus: candidate?.reviewStatus || '',
    conflictCount: candidate?.conflicts?.length || 0,
    missing: asArray(candidate?.conflicts).map(item => item.fieldPath),
  };
}
