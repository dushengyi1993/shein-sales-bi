export const TRANSFORM_PIC_ENDPOINT = '/open-api/goods/transform-pic';
export const SHEIN_IMAGE_TYPE_LABELS = Object.freeze({
  1: 'main',
  2: 'detail',
  5: 'square',
  6: 'color_swatch',
  7: 'site_detail',
});
const VALID_IMAGE_TYPES = new Set(Object.keys(SHEIN_IMAGE_TYPE_LABELS).map(Number));

function normalizeImageType(imageType) {
  const n = Number(imageType);
  return Number.isInteger(n) ? n : NaN;
}

export function inspectTransformPicInput({imageType, originalUrl}) {
  const type = normalizeImageType(imageType);
  const blockers = [];
  if (!VALID_IMAGE_TYPES.has(type)) blockers.push(`image_type must be one of 1/2/5/6/7; got ${imageType}`);
  const url = String(originalUrl || '').trim();
  if (!url) blockers.push('originalUrl is required');
  else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) blockers.push(`originalUrl must use http/https; got ${parsed.protocol}`);
    } catch {
      blockers.push(`originalUrl is not a valid URL: ${url}`);
    }
  }
  return {
    ok: blockers.length === 0,
    blockers,
    imageType: type,
    imageTypeLabel: SHEIN_IMAGE_TYPE_LABELS[type] || '',
    originalUrl: url,
  };
}

export function buildTransformPicPlan(input) {
  return {
    endpoint: TRANSFORM_PIC_ENDPOINT,
    method: 'POST',
    body: {image_type: input.imageType, original_url: input.originalUrl},
    imageTypeLabel: input.imageTypeLabel,
  };
}

export async function executeTransformPic(client, params, {mode = 'dry-run'} = {}) {
  const input = inspectTransformPicInput(params || {});
  const plan = buildTransformPicPlan(input);
  if (!input.ok) return {ok: false, mode, endpoint: TRANSFORM_PIC_ENDPOINT, plan, blockers: input.blockers};
  if (mode !== 'execute') {
    return {ok: true, mode: 'dry-run', endpoint: TRANSFORM_PIC_ENDPOINT, plan, note: 'dry-run only validates URL and payload; it does not call SHEIN.'};
  }
  const response = await client.request(TRANSFORM_PIC_ENDPOINT, {method: 'POST', body: plan.body, headers: {language: 'zh-cn'}});
  const code = String(response.data?.code ?? '');
  const ok = response.ok && code === '0';
  const info = response.data?.info || {};
  return {
    ok,
    mode: 'execute',
    endpoint: TRANSFORM_PIC_ENDPOINT,
    code,
    msg: response.data?.msg || '',
    traceId: response.data?.traceId || '',
    result: {
      originalUrl: info.original || input.originalUrl,
      transformedUrl: info.transformed || '',
      failureReason: info.failure_reason || '',
    },
    blockers: ok ? [] : [`transform-pic failed: code=${code || '(missing)'} msg=${response.data?.msg || response.statusText || ''}`],
  };
}
