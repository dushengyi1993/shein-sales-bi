export function parsePositiveInt(value, {name, min = 1, max = Number.MAX_SAFE_INTEGER, defaultValue} = {}) {
  if ((value === undefined || value === null || value === '') && defaultValue !== undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name || 'value'} must be an integer between ${min} and ${max}`);
  return n;
}

export function stringList(value, {name = 'list', max = 10, uppercase = false} = {}) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;/]+/);
  const out = [...new Set(raw.map(x => String(x || '').trim()).filter(Boolean).map(x => uppercase ? x.toUpperCase() : x))];
  if (out.length > max) throw new Error(`${name} accepts at most ${max} items`);
  return out;
}

export function assertSheinOk(response, endpoint) {
  const code = String(response?.data?.code ?? '');
  const ok = Boolean(response?.ok) && code === '0';
  if (ok) return {ok, code, msg: response.data?.msg || '', info: response.data?.info || {}, traceId: response.data?.traceId || ''};
  return {ok, code, msg: response?.data?.msg || response?.statusText || '', info: response?.data?.info || {}, traceId: response?.data?.traceId || '', blocker: `${endpoint} failed: code=${code || '(missing)'} msg=${response?.data?.msg || response?.statusText || ''}`};
}
