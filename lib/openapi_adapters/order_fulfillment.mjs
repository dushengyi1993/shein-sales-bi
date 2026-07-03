import crypto from 'node:crypto';
import {assertSheinOk, parsePositiveInt, stringList} from './common.mjs';

export const ORDER_FULFILLMENT_ACTIONS = Object.freeze({
  export_address: {endpoint: '/open-api/order/export-address'},
  import_express: {endpoint: '/open-api/order/import-batch-multiple-express'},
  place_express_order: {endpoint: '/open-api/gsp/place-express-order'},
  print_express_info: {endpoint: '/open-api/order/print-express-info'},
});

function nonEmpty(value, name) {
  const out = String(value || '').trim();
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeOrderFulfillmentAction(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = new Map([
    ['export_address', 'export_address'], ['export-address', 'export_address'], ['address', 'export_address'],
    ['import_express', 'import_express'], ['import-express', 'import_express'], ['upload_express', 'import_express'], ['upload-waybill', 'import_express'],
    ['place_express_order', 'place_express_order'], ['place-express-order', 'place_express_order'], ['place_order', 'place_express_order'],
    ['print_express_info', 'print_express_info'], ['print-express-info', 'print_express_info'], ['print_label', 'print_express_info'],
  ]);
  const normalized = aliases.get(raw) || raw;
  if (!ORDER_FULFILLMENT_ACTIONS[normalized]) throw new Error(`unknown order fulfillment action: ${value}`);
  return normalized;
}

export function buildExportAddressPayload(params = {}) {
  const handleType = parsePositiveInt(params.handleType ?? 1, {name: 'handleType', min: 1, max: 2});
  return {orderNo: nonEmpty(params.orderNo, 'orderNo'), handleType};
}

export function buildImportExpressPayload(params = {}) {
  const infoList = Array.isArray(params.infoList) && params.infoList.length ? params.infoList : [{
    expressCode: params.expressCode,
    expressIdCode: params.expressIdCode,
    expressChannelCode: params.expressChannelCode,
    goodsId: params.goodsId,
    status: params.status ?? 2,
  }];
  if (infoList.length > 100) throw new Error('infoList accepts at most 100 items');
  return {
    orderNo: nonEmpty(params.orderNo, 'orderNo'),
    infoList: infoList.map((item, index) => ({
      expressCode: nonEmpty(item.expressCode, `infoList[${index}].expressCode`),
      expressIdCode: nonEmpty(item.expressIdCode, `infoList[${index}].expressIdCode`),
      ...(item.expressChannelCode ? {expressChannelCode: String(item.expressChannelCode).trim()} : {}),
      goodsId: parsePositiveInt(item.goodsId, {name: `infoList[${index}].goodsId`, min: 1}),
      status: parsePositiveInt(item.status ?? 2, {name: `infoList[${index}].status`, min: 1, max: 2}),
    })),
  };
}

export function buildPlaceExpressOrderPayload(params = {}) {
  let packageInfoList = Array.isArray(params.packageInfoList) ? params.packageInfoList : [];
  if (!packageInfoList.length) packageInfoList = [{orderNo: params.orderNo, goodsIds: stringList(params.goodsIds || params.goodsId, {name: 'goodsIds', max: 100})}];
  return {
    expressChannelCode: nonEmpty(params.expressChannelCode, 'expressChannelCode'),
    preRequestId: nonEmpty(params.preRequestId, 'preRequestId'),
    packageInfoList: packageInfoList.map((pkg, index) => ({
      orderNo: nonEmpty(pkg.orderNo, `packageInfoList[${index}].orderNo`),
      goodsIds: stringList(pkg.goodsIds, {name: `packageInfoList[${index}].goodsIds`, max: 100}).map(x => parsePositiveInt(x, {name: `packageInfoList[${index}].goodsIds`})),
    })),
  };
}

export function buildPrintExpressInfoPayload(params = {}) {
  const body = {};
  if (params.deliveryNo) body.deliveryNo = String(params.deliveryNo).trim();
  else {
    body.orderNo = nonEmpty(params.orderNo, 'orderNo');
    const packageNo = stringList(params.packageNo || params.packageNos, {name: 'packageNo', max: 100});
    if (!packageNo.length) throw new Error('packageNo is required when deliveryNo is not provided');
    body.packageNo = packageNo;
  }
  return body;
}

export function buildOrderFulfillmentPayload(action, params = {}) {
  const normalized = normalizeOrderFulfillmentAction(action);
  if (normalized === 'export_address') return buildExportAddressPayload(params);
  if (normalized === 'import_express') return buildImportExpressPayload(params);
  if (normalized === 'place_express_order') return buildPlaceExpressOrderPayload(params);
  if (normalized === 'print_express_info') return buildPrintExpressInfoPayload(params);
  throw new Error(`unsupported action: ${action}`);
}

function normalizeResult(action, info) {
  if (action === 'export_address') return {receiveMsgList: Array.isArray(info?.receiveMsgList) ? info.receiveMsgList : []};
  if (action === 'import_express') return {items: Array.isArray(info) ? info : []};
  if (action === 'place_express_order') return {deliveryNo: info?.deliveryNo || '', placeRequestId: info?.placeRequestId || ''};
  if (action === 'print_express_info') return {items: Array.isArray(info) ? info : []};
  return info || {};
}

export async function executeOrderFulfillment(client, action, params, {mode = 'dry-run'} = {}) {
  let normalized, body;
  try {
    normalized = normalizeOrderFulfillmentAction(action);
    body = buildOrderFulfillmentPayload(normalized, params || {});
  } catch (err) {
    return {ok: false, mode, action, blockers: [err.message]};
  }
  const endpoint = ORDER_FULFILLMENT_ACTIONS[normalized].endpoint;
  const plan = {action: normalized, endpoint, method: 'POST', body};
  const payloadHash = sha256(plan);
  if (mode !== 'execute') return {ok: true, mode: 'dry-run', action: normalized, endpoint, plan, payloadHash, note: 'dry-run only validates payload; it does not call SHEIN.'};
  const response = await client.request(endpoint, {method: 'POST', body, headers: {language: 'zh-cn'}});
  const parsed = assertSheinOk(response, endpoint);
  return {ok: parsed.ok, mode: 'execute', action: normalized, endpoint, payloadHash, code: parsed.code, msg: parsed.msg, traceId: parsed.traceId, result: normalizeResult(normalized, parsed.info), blockers: parsed.ok ? [] : [parsed.blocker]};
}
