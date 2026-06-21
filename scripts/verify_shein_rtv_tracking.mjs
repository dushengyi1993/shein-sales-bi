#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {loadSheinWebApiSession, fetchSheinWebApiJson} from '../lib/shein_webapi_session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const ORIGIN = 'https://sso.geiwohuo.com';
const AFTER_SALES_ROUTE = `${ORIGIN}/#/gsp/order-management/after-sales-list`;

const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));
const storeMap = new Map((storesConfig.stores || []).filter(s => s.enabled !== false).map(s => [String(s.storeKey || '').toUpperCase(), s]));

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    stores: null,
    priorities: ['high', 'medium'],
    limit: 300,
    caseLimit: 25,
    includeNoCases: false,
    visible: false,
    transport: process.env.SHEIN_RTV_TRANSPORT || 'browser',
    json: false,
    maxRuntimeMs: Number(process.env.SHEIN_RTV_VERIFY_TIMEOUT_MS || 3600000),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--store') args.stores = [String(argv[++i] || '').trim().toUpperCase()].filter(Boolean);
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--priority') args.priorities = String(argv[++i] || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    else if (a === '--limit') args.limit = Math.max(1, Number(argv[++i] || 300));
    else if (a === '--case-limit') args.caseLimit = Math.max(1, Number(argv[++i] || 25));
    else if (a === '--max-runtime-ms') args.maxRuntimeMs = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--include-no-cases') args.includeNoCases = true;
    else if (a === '--visible') args.visible = true;
    else if (a === '--headless') args.visible = false;
    else if (a === '--transport') args.transport = String(argv[++i] || args.transport).toLowerCase();
    else if (a === '--json') args.json = true;
    else if (a === '--max-runtime-ms') args.maxRuntimeMs = Math.max(30_000, Number(argv[++i] || 3600000));
  }
  if (!['browser', 'webapi'].includes(args.transport)) {
    throw new Error('--transport must be browser or webapi');
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeTracking(value) {
  const text = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return text || null;
}

function sqlQuote(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  if (value === null || value === undefined) return 'NULL';
  return `${sqlQuote(JSON.stringify(value))}::jsonb`;
}

function digest(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function isLoginError(err) {
  return /20302|GMPSSO|login redirect|登录|登入|login/i.test(String(err?.message || err || ''));
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const first = [raw.indexOf('{'), raw.indexOf('[')].filter(x => x >= 0).sort((a, b) => a - b)[0];
  if (first == null) return null;
  try { return JSON.parse(raw.slice(first)); } catch { return null; }
}

async function runNode(script, args = [], timeoutMs = 240000) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}\nTimed out after ${timeoutMs}ms`.trim(),
      });
    }, timeoutMs);
    child.stdout.on('data', chunk => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: String(err?.stack || err)});
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function runPsql(args, sql) {
  const useWsl = process.platform === 'win32';
  const useSudoDocker =
    !useWsl &&
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0 &&
    process.env.SHEIN_DOCKER_NO_SUDO !== '1';
  const command = useWsl ? 'wsl' : useSudoDocker ? 'sudo' : 'docker';
  const dockerArgs = [
    'exec',
    '-i',
    args.container,
    'psql',
    '-U',
    args.user,
    '-d',
    args.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-t',
    '-A',
    '-P',
    'pager=off',
  ];
  const commandArgs = useWsl
    ? [
        '-d',
        args.distro,
        '--',
        'bash',
        '-lc',
        `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1 -t -A -P pager=off`,
      ]
    : useSudoDocker
      ? ['-n', 'docker', ...dockerArgs]
      : dockerArgs;
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', chunk => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  child.stdin.write(sql);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (code !== 0) {
    throw new Error(`psql failed (${code})\n${stderr || stdout}`);
  }
  return stdout;
}

function parseCandidateCases(text) {
  return String(text || '')
    .split(' || ')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const m = part.match(/^([A-Z?]+)\s+·\s+([^·]+)\s+·\s+退货单\s+([^·]+)\s+·\s+售后单\s+([^·]+)\s+·\s+SHEIN物流\s+([^·]+)\s+·\s+(\d{4}-\d{2}-\d{2})$/);
      if (!m) return null;
      return {
        storeKey: String(m[1] || '').trim().toUpperCase(),
        orderNo: String(m[2] || '').trim(),
        returnOrderNo: String(m[3] || '').trim(),
        aftersalesOrderNo: String(m[4] || '').trim(),
        sheinExpressNo: String(m[5] || '').trim(),
        requestDate: String(m[6] || '').trim(),
      };
    })
    .filter(Boolean);
}

function addTracking(map, raw, source) {
  const normalized = normalizeTracking(raw);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, {normalized, raw: String(raw || ''), source});
}

function extractTrackingTokens(text) {
  const found = [];
  const add = raw => {
    const normalized = normalizeTracking(raw);
    if (!normalized) return;
    if (/^\d{11,13}$/.test(normalized) && /(?:^966|^800)/.test(normalized)) return;
    found.push({raw: String(raw || ''), normalized});
  };
  const input = String(text || '');
  const explicitPatterns = [
    /new\s+waybill\s+number\s*\[([A-Z0-9-]{8,})\]/ig,
    /new\s+waybill(?:\s+no\.?)?\s*[:：]?\s*([A-Z0-9-]{8,})/ig,
    /waybill\s+number\s*\[([A-Z0-9-]{8,})\]/ig,
    /tracking\s+number\s*\[([A-Z0-9-]{8,})\]/ig,
    /新的?\s*运单号\s*[［\[]\s*([A-Z0-9-]{8,})\s*[］\]]/ig,
    /新\s*运单号\s*[:：]\s*([A-Z0-9-]{8,})/ig,
    /更换[^。；;\n]{0,80}?运单号\s*[［\[]\s*([A-Z0-9-]{8,})\s*[］\]]/ig,
    /运单(?:已)?(?:在[^。；;\n]{0,80})?更换[^。；;\n]{0,80}?([A-Z0-9-]{8,})/ig,
  ];
  for (const re of explicitPatterns) {
    let m;
    while ((m = re.exec(input))) add(m[1]);
  }
  if (/waybill|shipment|tracking|express|运单|物流|包裹|快递/i.test(input)) {
    for (const re of [/\b(?:JTE|GC)[A-Z0-9]{8,}\b/g, /\b\d{10,}\b/g]) {
      let m;
      while ((m = re.exec(input))) add(m[0]);
    }
  }
  const unique = new Map();
  for (const item of found) {
    if (!unique.has(item.normalized)) unique.set(item.normalized, item);
  }
  return Array.from(unique.values());
}

function compactRouteSummary(routeType, routeInfo, deliveryItem) {
  const detailRows = [
    ...(routeInfo?.returnExpressRouteDetailResponses || []).map(x => ({channel: 'return', ...x})),
    ...(routeInfo?.refundExpressRouteDetailResponses || []).map(x => ({channel: 'refund', ...x})),
    ...(routeInfo?.expressRouteDetailResponses || []).map(x => ({channel: 'order', ...x})),
  ];
  return detailRows.slice(0, 20).map(row => ({
    route_type: routeType,
    channel: row.channel,
    express_type: deliveryItem?.expressType ?? null,
    current_express_no: deliveryItem?.returnExpressNo || deliveryItem?.orderExpressNo || null,
    handle_time: row.g_zcs_handleTime || row.handleTime || null,
    description: row.description || null,
    package_status: row.gspPackageStatus || row.packageStatus || null,
    first_status: row.firstStatus || null,
    secondary_status: row.secondaryStatus || null,
    handle_content: row.handleContent || null,
  }));
}

async function connectCdp(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(4000)});
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /geiwohuo|shein/i.test(String(t.url || ''))) || targets.find(t => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error(`No Chrome page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return {ws, send};
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function navigate(send, url, waitMs = 2200) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
}

async function pageFetch(send, endpoint, payload = {}, options = {}) {
  const method = String(options.method || 'POST').toUpperCase();
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin-Path': options.originPath || '/order-management/after-sales-list',
    'Origin-Url': options.originUrl || AFTER_SALES_ROUTE,
    ...(options.headers || {}),
  };
  const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const method = ${JSON.stringify(method)};
    const payload = ${JSON.stringify(payload ?? {})};
    const headers = ${JSON.stringify(headers)};
    return fetch(endpoint, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload)
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json, href: location.href, title: document.title};
    });
  })()`;
  const value = await evaluate(send, expression);
  if (!value?.json) {
    throw new Error(`Non-JSON response from ${endpoint}: status=${value?.status} text=${String(value?.text || '').slice(0, 300)}`);
  }
  const code = String(value.json.code ?? value.json.status ?? '');
  if (code && code !== '0') {
    throw new Error(`${endpoint} failed: code=${code} msg=${value.json.msg || value.json.message || ''}`);
  }
  return value.json;
}

async function launchStoreIfNeeded(store, visible) {
  const result = await runNode('launch_store_browser.mjs', [store.storeKey, visible ? '--visible' : '--headless'], 60000);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `launch store ${store.storeKey} failed`);
  await sleep(2500);
}

async function autoReloginStore(storeKey, visible) {
  return await runNode('auto_relogin_shein_store.mjs', [storeKey, '--date', new Date().toISOString().slice(0, 10), visible ? '--visible' : '--headless'], 240000);
}

async function ensureStoreContext(store, args) {
  if (args.transport === 'webapi') {
    const session = await loadSheinWebApiSession(store.storeKey);
    return {
      store,
      mode: 'webapi',
      session,
      send: null,
      ws: null,
      reloginTried: true,
    };
  }
  let conn;
  try {
    conn = await connectCdp(store.port);
  } catch {
    await launchStoreIfNeeded(store, args.visible);
    conn = await connectCdp(store.port);
  }
  await navigate(conn.send, AFTER_SALES_ROUTE, 2500);
  return {
    store,
    send: conn.send,
    ws: conn.ws,
    reloginTried: false,
  };
}

async function reconnectStore(ctx) {
  if (ctx.mode === 'webapi') return;
  try { ctx.ws?.close(); } catch {}
  const conn = await connectCdp(ctx.store.port);
  ctx.send = conn.send;
  ctx.ws = conn.ws;
  await navigate(ctx.send, AFTER_SALES_ROUTE, 2500);
}

async function fetchWithRelogin(ctx, endpoint, payload, options, args) {
  if (ctx.mode === 'webapi') {
    return await fetchSheinWebApiJson(ctx.session, endpoint, payload, {
      ...(options || {}),
      originPath: options?.originPath || '/order-management/after-sales-list',
      originUrl: options?.originUrl || AFTER_SALES_ROUTE,
    });
  }
  try {
    return await pageFetch(ctx.send, endpoint, payload, options);
  } catch (err) {
    if (!ctx.reloginTried && isLoginError(err)) {
      ctx.reloginTried = true;
      const relogin = await autoReloginStore(ctx.store.storeKey, args.visible);
      if (!relogin.ok) {
        throw new Error(`auto relogin failed for ${ctx.store.storeKey}: ${relogin.stderr || relogin.stdout || relogin.code}`);
      }
      await reconnectStore(ctx);
      return await pageFetch(ctx.send, endpoint, payload, options);
    }
    throw err;
  }
}

async function loadCandidates(args) {
  const priorities = (args.priorities || []).map(x => x.toLowerCase()).filter(Boolean);
  const prioritySql = priorities.length
    ? `AND c.review_priority IN (${priorities.map(sqlQuote).join(', ')})`
    : '';
  const storeSql = args.stores?.length
    ? `AND (c.store_key_guess IN (${args.stores.map(sqlQuote).join(', ')}) OR c.candidate_cases ~ ${sqlQuote(`^(${args.stores.join('|')}) ·`)})`
    : '';
  const candidateCaseSql = args.includeNoCases ? '' : 'AND c.candidate_case_count > 0';
  const sql = `
SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text
FROM (
  SELECT
    c.return_order_id,
    c.rtv,
    c.et_shipment_number_raw,
    c.et_shipment_number,
    c.suspected_emile_handoff,
    c.status_name,
    c.store_name_in,
    c.to_instock_name,
    c.in_quantity,
    c.create_time,
    c.standard_goods_sn,
    c.match_key,
    c.sku_code,
    c.store_key_guess,
    c.barcode,
    c.goods_title,
    c.received_quantity,
    c.exact_match_count,
    c.candidate_case_count,
    c.candidate_cases,
    c.review_reason,
    c.review_priority,
    v.last_verified_at
  FROM mart.rtv_manual_review_candidates c
  LEFT JOIN LATERAL (
    SELECT max(verified_at) AS last_verified_at
    FROM ops.rtv_tracking_verification v
    WHERE v.et_return_order_id = c.return_order_id
      AND v.match_status <> 'matched'
  ) v ON true
  WHERE 1 = 1
    ${prioritySql}
    ${storeSql}
    ${candidateCaseSql}
  ORDER BY
    CASE c.review_priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
    v.last_verified_at NULLS FIRST,
    CASE WHEN c.candidate_case_count > 0 THEN 0 ELSE 1 END,
    c.create_time DESC NULLS LAST,
    c.return_order_id DESC
  LIMIT ${Number(args.limit || 300)}
) t;
`;
  return parseJsonLoose(await runPsql(args, sql)) || [];
}

async function loadDynamicCasesForCandidate(args, candidate) {
  const createTimeSql = candidate.create_time ? sqlQuote(candidate.create_time) : 'NULL';
  const guessedStoreSql = candidate.store_key_guess ? sqlQuote(candidate.store_key_guess) : 'NULL';
  const etTrackingSql = candidate.et_shipment_number || normalizeTracking(candidate.et_shipment_number_raw)
    ? sqlQuote(candidate.et_shipment_number || normalizeTracking(candidate.et_shipment_number_raw))
    : 'NULL';
  const sql = `
WITH direct_jt_case_rows AS (
  SELECT
    ai.store_key AS "storeKey",
    ai.order_no AS "orderNo",
    ai.return_order_no AS "returnOrderNo",
    ai.aftersales_order_no AS "aftersalesOrderNo",
    string_agg(
      DISTINCT nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), ''),
      ' / '
    ) FILTER (WHERE nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL) AS "sheinExpressNo",
    to_char(ai.request_time, 'YYYY-MM-DD') AS "requestDate",
    ai.request_time AS request_time_sort,
    CASE
      WHEN ${createTimeSql}::timestamptz IS NULL OR ai.request_time IS NULL THEN NULL
      ELSE abs(extract(epoch FROM (ai.request_time - ${createTimeSql}::timestamptz)))
    END AS request_gap_seconds,
    CASE
      WHEN ${guessedStoreSql} IS NULL OR ${guessedStoreSql} = '' THEN 0
      WHEN ai.store_key = ${guessedStoreSql} THEN 0
      ELSE 1
    END AS store_rank,
    0 AS source_rank
  FROM fact.after_sales_item ai
  LEFT JOIN LATERAL jsonb_array_elements(coalesce(ai.raw_summary->'case'->'returnExpressInfoList','[]'::jsonb)) x ON true
  WHERE coalesce(ai.return_order_no,'') <> ''
    AND coalesce(ai.order_no,'') <> ''
    AND ${etTrackingSql} IS NOT NULL
    AND ${etTrackingSql} ~ '^JT'
    AND nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') = ${etTrackingSql}
  GROUP BY ai.store_key, ai.order_no, ai.return_order_no, ai.aftersales_order_no, ai.request_time
),
product_case_rows AS (
  SELECT
    ai.store_key AS "storeKey",
    ai.order_no AS "orderNo",
    ai.return_order_no AS "returnOrderNo",
    ai.aftersales_order_no AS "aftersalesOrderNo",
    string_agg(
      DISTINCT nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), ''),
      ' / '
    ) FILTER (WHERE nullif(regexp_replace(upper(coalesce(x->>'expressNo','')), '[^0-9A-Z]', '', 'g'), '') IS NOT NULL) AS "sheinExpressNo",
    to_char(ai.request_time, 'YYYY-MM-DD') AS "requestDate",
    ai.request_time AS request_time_sort,
    CASE
      WHEN ${createTimeSql}::timestamptz IS NULL OR ai.request_time IS NULL THEN NULL
      ELSE abs(extract(epoch FROM (ai.request_time - ${createTimeSql}::timestamptz)))
    END AS request_gap_seconds,
    CASE
      WHEN ${guessedStoreSql} IS NULL OR ${guessedStoreSql} = '' THEN 0
      WHEN ai.store_key = ${guessedStoreSql} THEN 0
      ELSE 1
    END AS store_rank,
    1 AS source_rank
  FROM fact.after_sales_item ai
  LEFT JOIN LATERAL jsonb_array_elements(coalesce(ai.raw_summary->'case'->'returnExpressInfoList','[]'::jsonb)) x ON true
  WHERE coalesce(ai.return_order_no,'') <> ''
    AND coalesce(ai.order_no,'') <> ''
    AND dim.product_match_key(ai.standard_goods_sn) = ${sqlQuote(candidate.match_key)}
    AND (
      ${createTimeSql}::timestamptz IS NULL
      OR ai.request_time IS NULL
      OR ai.request_time BETWEEN ${createTimeSql}::timestamptz - interval '90 days' AND ${createTimeSql}::timestamptz + interval '15 days'
    )
  GROUP BY ai.store_key, ai.order_no, ai.return_order_no, ai.aftersales_order_no, ai.request_time
),
case_rows AS (
  SELECT * FROM direct_jt_case_rows
  UNION
  SELECT * FROM product_case_rows
)
SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text
FROM (
  SELECT "storeKey", "orderNo", "returnOrderNo", "aftersalesOrderNo", "sheinExpressNo", "requestDate"
  FROM case_rows
  ORDER BY source_rank, request_gap_seconds NULLS LAST, store_rank, request_time_sort DESC NULLS LAST, "aftersalesOrderNo" DESC
  LIMIT ${Number(args.caseLimit || 25)}
) t;
`;
  return parseJsonLoose(await runPsql(args, sql)) || [];
}

function buildVerificationId(candidate, kase) {
  return digest([
    candidate.return_order_id || '',
    candidate.et_shipment_number || candidate.et_shipment_number_raw || '',
    kase.storeKey || '',
    kase.aftersalesOrderNo || '',
  ].join('|'));
}

async function verifyCase(ctx, candidate, kase, args) {
  const currentNumbers = new Map();
  const discoveredNumbers = new Map();
  const routeSummary = [];
  const routeRaw = [];
  const etNorm = normalizeTracking(candidate.et_shipment_number || candidate.et_shipment_number_raw);
  for (const no of String(kase.sheinExpressNo || '').split('/')) {
    addTracking(currentNumbers, no, 'summary_return_express');
  }

  const detail = await fetchWithRelogin(ctx, '/gsp/aftersalesOrder/detail', {aftersalesOrderNo: kase.aftersalesOrderNo}, {}, args);
  const info = detail?.info || {};
  const deliveryItems = info?.returnDeliveryInfo?.deliveryItems || [];
  for (const item of deliveryItems) {
    addTracking(currentNumbers, item?.returnExpressNo, 'detail_return_express');
    addTracking(currentNumbers, item?.orderExpressNo, 'detail_order_express');
  }

  let returnDetail = null;
  if (info.returnOrderId) {
    try {
      returnDetail = await fetchWithRelogin(ctx, `/gsp/returnOrder/detail?id=${encodeURIComponent(info.returnOrderId)}`, {}, {method: 'GET'}, args);
      addTracking(currentNumbers, returnDetail?.info?.platformExpressNo, 'return_detail_platform');
      addTracking(currentNumbers, returnDetail?.info?.returnExpressNo, 'return_detail');
    } catch {}
  }

  for (const item of deliveryItems) {
    if (Number(item?.showTrack || 0) !== 1) continue;
    let route = null;
    let routeType = 'return';
    try {
      if (Number(item?.expressType) === 4 && item?.orderId && item?.orderExpressNo) {
        routeType = 'order';
        const sellerNo = item?.orderSellerNo || item?.orderExpressNo || '';
        route = await fetchWithRelogin(
          ctx,
          `/gsp/order/expressRoute?id=${encodeURIComponent(item.orderId)}&expressNo=${encodeURIComponent(item.orderExpressNo)}&sellerNo=${encodeURIComponent(sellerNo)}`,
          {},
          {method: 'GET'},
          args,
        );
      } else if (info.returnOrderId) {
        const expressRouteType = Number(item?.expressType || info.returnExpressType || info.returnOrderType || 1) || 1;
        route = await fetchWithRelogin(
          ctx,
          `/gsp/returnOrder/expressRoute?id=${encodeURIComponent(info.returnOrderId)}&expressRouteType=${encodeURIComponent(expressRouteType)}`,
          {},
          {method: 'GET'},
          args,
        );
      }
    } catch {
      route = null;
    }
    if (!route) continue;
    routeRaw.push({routeType, item, response: route});
    addTracking(currentNumbers, route?.info?.returnExpressCode, `${routeType}_return_code`);
    addTracking(currentNumbers, route?.info?.refundExpressCode, `${routeType}_refund_code`);
    addTracking(currentNumbers, route?.info?.expressCode, `${routeType}_express_code`);
    for (const row of compactRouteSummary(routeType, route?.info || {}, item)) {
      routeSummary.push(row);
      for (const token of extractTrackingTokens(`${row.handle_content || ''} ${row.description || ''}`)) {
        addTracking(discoveredNumbers, token.raw, `${routeType}_route_text`);
      }
    }
  }

  let matchStatus = 'unmatched';
  let matchSource = null;
  let matchedTrackingNo = null;
  if (etNorm && currentNumbers.has(etNorm)) {
    matchStatus = 'matched';
    matchSource = currentNumbers.get(etNorm)?.source || 'current_express';
    matchedTrackingNo = currentNumbers.get(etNorm)?.raw || candidate.et_shipment_number_raw || candidate.et_shipment_number;
  } else if (etNorm && discoveredNumbers.has(etNorm)) {
    matchStatus = 'matched';
    matchSource = discoveredNumbers.get(etNorm)?.source || 'route_detail';
    matchedTrackingNo = discoveredNumbers.get(etNorm)?.raw || candidate.et_shipment_number_raw || candidate.et_shipment_number;
  }

  return {
    verification_id: buildVerificationId(candidate, kase),
    store_key: kase.storeKey,
    et_return_order_id: candidate.return_order_id || null,
    et_shipment_number: candidate.et_shipment_number || normalizeTracking(candidate.et_shipment_number_raw) || null,
    et_shipment_number_raw: candidate.et_shipment_number_raw || null,
    standard_goods_sn: candidate.standard_goods_sn || null,
    shein_aftersales_order_no: kase.aftersalesOrderNo || null,
    shein_order_no: info.orderNo || kase.orderNo || null,
    shein_order_id: info.orderId || null,
    shein_return_order_no: info.returnOrderNo || kase.returnOrderNo || null,
    shein_return_order_id: info.returnOrderId || null,
    shein_current_express_no: Array.from(currentNumbers.values()).map(x => x.raw).filter(Boolean).join(' / ') || null,
    match_status: matchStatus,
    match_source: matchSource,
    matched_tracking_no: matchedTrackingNo,
    discovered_tracking_numbers: Array.from(discoveredNumbers.values()),
    current_express_numbers: Array.from(currentNumbers.values()),
    route_summary: routeSummary,
    raw_detail: detail,
    raw_return_detail: returnDetail,
    raw_route: routeRaw,
    error_message: null,
  };
}

function errorRecord(candidate, kase, err) {
  return {
    verification_id: buildVerificationId(candidate, kase),
    store_key: kase.storeKey,
    et_return_order_id: candidate.return_order_id || null,
    et_shipment_number: candidate.et_shipment_number || normalizeTracking(candidate.et_shipment_number_raw) || null,
    et_shipment_number_raw: candidate.et_shipment_number_raw || null,
    standard_goods_sn: candidate.standard_goods_sn || null,
    shein_aftersales_order_no: kase.aftersalesOrderNo || null,
    shein_order_no: kase.orderNo || null,
    shein_order_id: null,
    shein_return_order_no: kase.returnOrderNo || null,
    shein_return_order_id: null,
    shein_current_express_no: kase.sheinExpressNo || null,
    match_status: 'error',
    match_source: null,
    matched_tracking_no: null,
    discovered_tracking_numbers: [],
    current_express_numbers: [],
    route_summary: [],
    raw_detail: null,
    raw_return_detail: null,
    raw_route: null,
    error_message: String(err?.message || err || 'unknown error'),
  };
}

async function upsertRows(args, rows) {
  if (!rows.length) return;
  const deduped = Array.from(new Map(rows.map(row => [row.verification_id, row])).values());
  const columns = [
    'verification_id',
    'store_key',
    'et_return_order_id',
    'et_shipment_number',
    'et_shipment_number_raw',
    'standard_goods_sn',
    'shein_aftersales_order_no',
    'shein_order_no',
    'shein_order_id',
    'shein_return_order_no',
    'shein_return_order_id',
    'shein_current_express_no',
    'match_status',
    'match_source',
    'matched_tracking_no',
    'discovered_tracking_numbers',
    'current_express_numbers',
    'route_summary',
    'raw_detail',
    'raw_return_detail',
    'raw_route',
    'error_message'
  ];
  const values = deduped.map(row => `(
${sqlQuote(row.verification_id)},
${sqlQuote(row.store_key)},
${sqlQuote(row.et_return_order_id)},
${sqlQuote(row.et_shipment_number)},
${sqlQuote(row.et_shipment_number_raw)},
${sqlQuote(row.standard_goods_sn)},
${sqlQuote(row.shein_aftersales_order_no)},
${sqlQuote(row.shein_order_no)},
${sqlQuote(row.shein_order_id)},
${sqlQuote(row.shein_return_order_no)},
${sqlQuote(row.shein_return_order_id)},
${sqlQuote(row.shein_current_express_no)},
${sqlQuote(row.match_status)},
${sqlQuote(row.match_source)},
${sqlQuote(row.matched_tracking_no)},
${sqlJson(row.discovered_tracking_numbers)},
${sqlJson(row.current_express_numbers)},
${sqlJson(row.route_summary)},
${sqlJson(row.raw_detail)},
${sqlJson(row.raw_return_detail)},
${sqlJson(row.raw_route)},
${sqlQuote(row.error_message)},
now(),
now()
)`).join(',\n');
  const sql = `
INSERT INTO ops.rtv_tracking_verification (
  ${columns.join(',\n  ')},
  verified_at,
  updated_at
)
VALUES
${values}
ON CONFLICT (verification_id) DO UPDATE SET
  store_key = EXCLUDED.store_key,
  et_return_order_id = EXCLUDED.et_return_order_id,
  et_shipment_number = EXCLUDED.et_shipment_number,
  et_shipment_number_raw = EXCLUDED.et_shipment_number_raw,
  standard_goods_sn = EXCLUDED.standard_goods_sn,
  shein_aftersales_order_no = EXCLUDED.shein_aftersales_order_no,
  shein_order_no = EXCLUDED.shein_order_no,
  shein_order_id = EXCLUDED.shein_order_id,
  shein_return_order_no = EXCLUDED.shein_return_order_no,
  shein_return_order_id = EXCLUDED.shein_return_order_id,
  shein_current_express_no = EXCLUDED.shein_current_express_no,
  match_status = EXCLUDED.match_status,
  match_source = EXCLUDED.match_source,
  matched_tracking_no = EXCLUDED.matched_tracking_no,
  discovered_tracking_numbers = EXCLUDED.discovered_tracking_numbers,
  current_express_numbers = EXCLUDED.current_express_numbers,
  route_summary = EXCLUDED.route_summary,
  raw_detail = EXCLUDED.raw_detail,
  raw_return_detail = EXCLUDED.raw_return_detail,
  raw_route = EXCLUDED.raw_route,
  error_message = EXCLUDED.error_message,
  verified_at = now(),
  updated_at = now();
`;
  await runPsql(args, sql);
}

async function closeContexts(contexts) {
  for (const ctx of contexts.values()) {
    try { ctx.ws?.close(); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeTimer = args.maxRuntimeMs > 0 ? setTimeout(() => {
    console.error(`verify_shein_rtv_tracking hard timed out after ${args.maxRuntimeMs + 120000}ms`);
    process.exit(124);
  }, args.maxRuntimeMs + 120000) : null;
  runtimeTimer?.unref?.();
  const candidates = await loadCandidates(args);
  const contexts = new Map();
  const rows = [];
  let matchedCandidates = 0;
  let scannedCases = 0;
  let stoppedByRuntime = false;
  const startedAt = Date.now();
  const runtimeExceeded = () => args.maxRuntimeMs > 0 && Date.now() - startedAt >= args.maxRuntimeMs;

  try {
    candidateLoop:
    for (const candidate of candidates) {
      if (runtimeExceeded()) {
        stoppedByRuntime = true;
        break;
      }
      const dynamicCases = await loadDynamicCasesForCandidate(args, candidate);
      const cases = dynamicCases.length ? dynamicCases : parseCandidateCases(candidate.candidate_cases);
      let matchedThisCandidate = false;
      for (const kase of cases) {
        if (runtimeExceeded()) {
          stoppedByRuntime = true;
          break candidateLoop;
        }
        scannedCases += 1;
        const store = storeMap.get(String(kase.storeKey || '').toUpperCase());
        if (!store) {
          rows.push(errorRecord(candidate, kase, new Error(`Store ${kase.storeKey} not configured`)));
          continue;
        }
        let ctx = contexts.get(store.storeKey);
        if (!ctx) {
          ctx = await ensureStoreContext(store, args);
          contexts.set(store.storeKey, ctx);
        }
        try {
          const row = await verifyCase(ctx, candidate, kase, args);
          rows.push(row);
          if (row.match_status === 'matched') {
            matchedThisCandidate = true;
            break;
          }
        } catch (err) {
          rows.push(errorRecord(candidate, kase, err));
        }
      }
      if (matchedThisCandidate) matchedCandidates += 1;
      if (rows.length >= 40) {
        await upsertRows(args, rows.splice(0, rows.length));
      }
    }
    if (rows.length) {
      await upsertRows(args, rows);
    }
  } finally {
    await closeContexts(contexts);
  }

  const verificationSummarySql = `
SELECT jsonb_build_object(
  'matched_rows', count(*) FILTER (WHERE match_status = 'matched'),
  'unmatched_rows', count(*) FILTER (WHERE match_status = 'unmatched'),
  'error_rows', count(*) FILTER (WHERE match_status = 'error'),
  'matched_et_returns', count(DISTINCT et_return_order_id) FILTER (WHERE match_status = 'matched')
)::text
FROM ops.rtv_tracking_verification;
`;
  const dbSummary = parseJsonLoose(await runPsql(args, verificationSummarySql)) || {};
  const result = {
    ok: true,
    scanned_candidates: candidates.length,
    scanned_cases: scannedCases,
    matched_candidates: matchedCandidates,
    stopped_by_runtime: stoppedByRuntime,
    elapsed_ms: Date.now() - startedAt,
    db_summary: dbSummary,
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (runtimeTimer) clearTimeout(runtimeTimer);
}

main().catch(err => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
