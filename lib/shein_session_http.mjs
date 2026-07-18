import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ORIGIN = 'https://sso.geiwohuo.com';

export async function loadSheinBrowserSession(root, storeKey) {
  const file = path.join(root, 'state', 'shein_browser_sessions', `${String(storeKey || '').toUpperCase()}.local.json`);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const cookie = (doc.cookies || [])
    .filter(item => item?.name && item?.value != null)
    .map(item => `${item.name}=${item.value}`)
    .join('; ');
  if (!cookie) throw new Error(`No cookies in ${path.relative(root, file)}`);
  return {...doc, cookie, sessionFile: file};
}

export async function sheinSessionPostJson(session, url, body = {}, options = {}) {
  const origin = String(options.origin || DEFAULT_ORIGIN).replace(/\/$/, '');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || 15_000));
  const fetchImpl = options.fetchImpl || fetch;
  const target = /^https?:\/\//i.test(String(url || '')) ? String(url) : `${origin}${url}`;
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      cookie: session.cookie,
      'user-agent': session.userAgent || 'Mozilla/5.0',
      origin,
      referer: `${origin}/`,
      ...(options.headers || {}),
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}: ${String(json?.msg || text).slice(0, 200)}`);
  }
  return json;
}
