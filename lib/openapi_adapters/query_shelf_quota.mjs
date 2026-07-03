import {assertSheinOk} from './common.mjs';

export const QUERY_SHELF_QUOTA_ENDPOINT = '/open-api/goods/query-shelf-quota';

export function buildQueryShelfQuotaPayload() {
  return {};
}

function normalizeShelfQuota(info = {}) {
  return {
    need: Boolean(info.need),
    totalQuotaCount: Number(info.total_quota_count ?? 0),
    onShelfCount: Number(info.on_shelf_count ?? 0),
    remainCount: Number(info.remain_count ?? 0),
    raw: info,
  };
}

export async function executeQueryShelfQuota(client, params, {mode = 'dry-run'} = {}) {
  const body = buildQueryShelfQuotaPayload(params || {});
  const plan = {endpoint: QUERY_SHELF_QUOTA_ENDPOINT, method: 'POST', body};
  if (mode !== 'execute') return {ok: true, mode: 'dry-run', endpoint: QUERY_SHELF_QUOTA_ENDPOINT, plan, note: 'dry-run only validates payload; it does not call SHEIN.'};
  const response = await client.request(QUERY_SHELF_QUOTA_ENDPOINT, {method: 'POST', body, headers: {language: 'zh-cn'}});
  const parsed = assertSheinOk(response, QUERY_SHELF_QUOTA_ENDPOINT);
  return {ok: parsed.ok, mode: 'execute', endpoint: QUERY_SHELF_QUOTA_ENDPOINT, code: parsed.code, msg: parsed.msg, traceId: parsed.traceId, result: normalizeShelfQuota(parsed.info), blockers: parsed.ok ? [] : [parsed.blocker]};
}
