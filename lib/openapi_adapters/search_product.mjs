import {assertSheinOk, parsePositiveInt, stringList} from './common.mjs';

export const SEARCH_PRODUCT_ENDPOINT = '/open-api/goods/searchProduct';
const LIST_FIELDS = new Set(['categoryIds', 'spuNameList', 'skcNameList', 'skuCodeList', 'skcSupplierCodeList', 'supplierSkuList', 'languageList']);

export function buildSearchProductPayload(params = {}) {
  const body = {
    pageNum: parsePositiveInt(params.pageNum ?? params.page ?? 1, {name: 'pageNum', min: 1, max: 100000}),
    pageSize: parsePositiveInt(params.pageSize ?? params.limit ?? 10, {name: 'pageSize', min: 1, max: 10}),
  };
  for (const field of LIST_FIELDS) {
    const aliases = {
      categoryIds: ['categoryIds', 'categoryId', 'category'],
      spuNameList: ['spuNameList', 'spu', 'spuName'],
      skcNameList: ['skcNameList', 'skc', 'skcName'],
      skuCodeList: ['skuCodeList', 'skuCode'],
      skcSupplierCodeList: ['skcSupplierCodeList', 'supplierCode', 'productRef'],
      supplierSkuList: ['supplierSkuList', 'supplierSku'],
      languageList: ['languageList', 'language', 'languages'],
    }[field];
    const raw = aliases.map(k => params[k]).find(v => v !== undefined && v !== null && String(v).trim?.() !== '');
    if (raw !== undefined) {
      const list = stringList(raw, {name: field, max: field === 'languageList' ? 5 : 10});
      if (list.length) body[field] = field === 'categoryIds' ? list.map(x => parsePositiveInt(x, {name: 'categoryId'})) : list;
    }
  }
  for (const field of ['skcShelfStatus']) if (params[field] !== undefined && params[field] !== '') body[field] = parsePositiveInt(params[field], {name: field, min: 0, max: 1});
  for (const field of ['createTimeStart', 'createTimeEnd', 'updateTimeStart', 'updateTimeEnd']) if (params[field]) body[field] = String(params[field]).trim();
  return body;
}

function normalizeProductRows(info = {}) {
  return (Array.isArray(info.data) ? info.data : []).map(spu => ({
    spuName: spu.spuName || '',
    spuShelfStatus: spu.spuShelfStatus ?? null,
    categoryId: spu.categoryId || '',
    skcList: (Array.isArray(spu.skcList) ? spu.skcList : []).map(skc => ({
      skcName: skc.skcName || '',
      skcShelfStatus: skc.skcShelfStatus ?? null,
      supplierCode: skc.supplierCode || '',
      skcMainPicUrl: skc.skcMainPicUrl || '',
      skuList: Array.isArray(skc.skuList) ? skc.skuList : [],
      skcTitle: Array.isArray(skc.skcTitle) ? skc.skcTitle : [],
    })),
  }));
}

export async function executeSearchProduct(client, params, {mode = 'dry-run'} = {}) {
  let body;
  try { body = buildSearchProductPayload(params || {}); }
  catch (err) { return {ok: false, mode, endpoint: SEARCH_PRODUCT_ENDPOINT, blockers: [err.message]}; }
  const plan = {endpoint: SEARCH_PRODUCT_ENDPOINT, method: 'POST', body};
  if (mode !== 'execute') return {ok: true, mode: 'dry-run', endpoint: SEARCH_PRODUCT_ENDPOINT, plan, note: 'dry-run only validates payload; it does not call SHEIN.'};
  const response = await client.request(SEARCH_PRODUCT_ENDPOINT, {method: 'POST', body, headers: {language: 'zh-cn'}});
  const parsed = assertSheinOk(response, SEARCH_PRODUCT_ENDPOINT);
  return {ok: parsed.ok, mode: 'execute', endpoint: SEARCH_PRODUCT_ENDPOINT, code: parsed.code, msg: parsed.msg, traceId: parsed.traceId, result: {meta: parsed.info.meta || {}, data: normalizeProductRows(parsed.info)}, blockers: parsed.ok ? [] : [parsed.blocker]};
}
