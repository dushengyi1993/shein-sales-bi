import {assertSheinOk, parsePositiveInt} from './common.mjs';

export const QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT = '/open-api/goods/query-publish-fill-in-standard';

export function buildQueryPublishFillInStandardPayload(params = {}) {
  const body = {};
  if (params.categoryId !== undefined && params.categoryId !== '') body.category_id = parsePositiveInt(params.categoryId, {name: 'category_id'});
  if (params.category_id !== undefined && params.category_id !== '') body.category_id = parsePositiveInt(params.category_id, {name: 'category_id'});
  if (params.spuName || params.spu_name) body.spu_name = String(params.spuName || params.spu_name).trim();
  return body;
}

function normalizeStandards(info = {}) {
  return {
    currency: info.currency || '',
    defaultLanguage: info.default_language || '',
    defaultLanguageTitleMaxLength: info.default_language_title_max_length ?? null,
    fillInStandardList: Array.isArray(info.fill_in_standard_list) ? info.fill_in_standard_list : [],
    pictureConfigList: Array.isArray(info.picture_config_list) ? info.picture_config_list : [],
    weightConfig: info.weight_config || null,
    lengthWidthHeightConfig: info.length_width_height_config || null,
    supportSaleAttributeSort: info.support_sale_attribute_sort ?? null,
    raw: info,
  };
}

export async function executeQueryPublishFillInStandard(client, params, {mode = 'dry-run'} = {}) {
  let body;
  try { body = buildQueryPublishFillInStandardPayload(params || {}); }
  catch (err) { return {ok: false, mode, endpoint: QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT, blockers: [err.message]}; }
  const plan = {endpoint: QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT, method: 'POST', body};
  if (mode !== 'execute') return {ok: true, mode: 'dry-run', endpoint: QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT, plan, note: 'dry-run only validates payload; it does not call SHEIN.'};
  const response = await client.request(QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT, {method: 'POST', body, headers: {language: 'zh-cn'}});
  const parsed = assertSheinOk(response, QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT);
  return {ok: parsed.ok, mode: 'execute', endpoint: QUERY_PUBLISH_FILL_IN_STANDARD_ENDPOINT, code: parsed.code, msg: parsed.msg, traceId: parsed.traceId, result: normalizeStandards(parsed.info), blockers: parsed.ok ? [] : [parsed.blocker]};
}
