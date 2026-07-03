import {assertSheinOk, stringList} from './common.mjs';

export const QUERY_DOCUMENT_STATE_ENDPOINT = '/open-api/goods/query-document-state';
export const DOCUMENT_STATE_LABELS = Object.freeze({
  '-1': '接受失败',
  1: '待审核',
  2: '审批成功',
  3: '审批失败',
  4: '已撤回',
  5: '申诉中',
});

export function buildQueryDocumentStatePayload(params = {}) {
  let spuList = [];
  if (Array.isArray(params.spuList)) {
    spuList = params.spuList.map(item => ({
      spuName: String(item?.spuName || item?.spu || '').trim(),
      ...(item?.version ? {version: String(item.version).trim()} : {}),
    })).filter(item => item.spuName);
  } else {
    spuList = stringList(params.spuNameList || params.spu || params.spuName, {name: 'spuList', max: 10})
      .map(spuName => ({spuName, ...(params.version ? {version: String(params.version).trim()} : {})}));
  }
  if (!spuList.length) throw new Error('query-document-state requires at least one spuName');
  if (spuList.length > 10) throw new Error('query-document-state accepts at most 10 spu items');
  return {spuList};
}

function normalizeRows(info = {}) {
  return (Array.isArray(info.data) ? info.data : []).map(row => ({
    spuName: row.spuName || '',
    version: row.version || '',
    skcList: (Array.isArray(row.skcList) ? row.skcList : []).map(skc => ({
      skcName: skc.skcName || '',
      documentSn: skc.documentSn || '',
      documentState: skc.documentState ?? null,
      documentStateLabel: DOCUMENT_STATE_LABELS[String(skc.documentState)] || '',
      failedReason: Array.isArray(skc.failedReason) ? skc.failedReason : [],
    })),
  }));
}

export async function executeQueryDocumentState(client, params, {mode = 'dry-run'} = {}) {
  let body;
  try { body = buildQueryDocumentStatePayload(params || {}); }
  catch (err) { return {ok: false, mode, endpoint: QUERY_DOCUMENT_STATE_ENDPOINT, blockers: [err.message]}; }
  const plan = {endpoint: QUERY_DOCUMENT_STATE_ENDPOINT, method: 'POST', body};
  if (mode !== 'execute') return {ok: true, mode: 'dry-run', endpoint: QUERY_DOCUMENT_STATE_ENDPOINT, plan, note: 'dry-run only validates payload; it does not call SHEIN.'};
  const response = await client.request(QUERY_DOCUMENT_STATE_ENDPOINT, {method: 'POST', body, headers: {language: 'zh-cn'}});
  const parsed = assertSheinOk(response, QUERY_DOCUMENT_STATE_ENDPOINT);
  return {ok: parsed.ok, mode: 'execute', endpoint: QUERY_DOCUMENT_STATE_ENDPOINT, code: parsed.code, msg: parsed.msg, traceId: parsed.traceId, result: {meta: parsed.info.meta || {}, data: normalizeRows(parsed.info)}, blockers: parsed.ok ? [] : [parsed.blocker]};
}
