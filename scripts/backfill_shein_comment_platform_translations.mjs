#!/usr/bin/env node
/**
 * Backfill SHEIN product-comment translations with the platform built-in
 * translation (`/mgs-api-prefix/goods/comment/list` + `translate: 1`).
 *
 * This script is read-only against SHEIN and only updates the warehouse
 * translation fields. It does not store cookies, request headers or tokens.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const ORIGIN = 'https://sso.geiwohuo.com';
const FEEDBACK_URL = `${ORIGIN}/#/mgs/store-management/product-feedback`;
const PROVIDER = 'shein-platform';

const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

function parseArgs(argv) {
  const args = {
    distro: 'Ubuntu-24.04',
    container: 'shein-warehouse-db',
    database: 'shein_bi',
    user: 'shein',
    stores: null,
    limit: 5000,
    force: false,
    waitMs: 1200,
    pageSize: 50,
    maxPages: 20,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--limit') args.limit = Number(argv[++i] || 0) || args.limit;
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i] || args.waitMs);
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || args.pageSize);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i] || args.maxPages);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

function sqlLiteral(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function dateOnly(v) {
  const m = String(v || '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}

function addDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function selectedStoreMap(args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  const keys = args.stores?.length ? new Set(args.stores) : null;
  return new Map(enabled.filter(s => !keys || keys.has(s.storeKey)).map(s => [s.storeKey, s]));
}

async function runPsqlScript(args, script) {
  const child = spawn('wsl', [
    '-d', args.distro,
    '--',
    'bash',
    '-lc',
    `sudo docker exec -i ${args.container} psql -U ${args.user} -d ${args.database} -v ON_ERROR_STOP=1`,
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.stdin.write(script);
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  if (code !== 0) {
    throw new Error(`psql failed (${code})\nSTDOUT:\n${stdout.slice(-4000)}\nSTDERR:\n${stderr.slice(-4000)}`);
  }
  return {stdout, stderr};
}

async function fetchTargetRows(args) {
  const where = [
    "coalesce(goods_comment_content,'') <> ''",
    args.force ? 'true' : `(translation_provider IS DISTINCT FROM ${sqlLiteral(PROVIDER)})`,
  ];
  if (args.stores?.length) where.push(`store_key IN (${args.stores.map(sqlLiteral).join(',')})`);
  const sql = `
SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
FROM (
  SELECT comment_key, store_key, comment_id, comment_date
  FROM fact.product_comment
  WHERE ${where.join(' AND ')}
  ORDER BY comment_date NULLS LAST, store_key, comment_id
  LIMIT ${Math.max(1, Number(args.limit || 5000))}
) t;
`;
  const {stdout} = await runPsqlScript(args, sql);
  const text = stdout.trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  return JSON.parse(text.slice(start, end + 1));
}

async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(5000)})).json();
  const page = targets.find(p => p.type === 'page' && /geiwohuo|shein/i.test(p.url)) || targets.find(p => p.type === 'page');
  if (!page) throw new Error(`No Chrome page target on port ${port}.`);
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

async function navigate(send, url, waitMs) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
}

async function pageFetch(send, endpoint, payload) {
  const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const payload = ${JSON.stringify(payload)};
    return fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin-Path': location.hash ? location.hash.replace(/^#/, '') : location.pathname,
        'Origin-Url': location.href,
      },
      body: JSON.stringify(payload),
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json};
    });
  })()`;
  const value = await evaluate(send, expression);
  if (!value?.json) throw new Error(`Non-JSON response from ${endpoint}: ${String(value?.text || '').slice(0, 300)}`);
  const code = String(value.json.code ?? value.json.status ?? '');
  if (code && code !== '0') throw new Error(`${endpoint} failed: code=${value.json.code} msg=${value.json.msg || value.json.message || ''}`);
  return value.json;
}

async function fetchTranslatedRows(send, startDate, endDate, args) {
  const rows = [];
  for (let page = 1; page <= args.maxPages; page++) {
    const payload = {
      startCommentTime: `${startDate} 00:00:00`,
      commentEndTime: `${endDate} 23:59:59`,
      page,
      perPage: args.pageSize,
      translate: 1,
    };
    const json = await pageFetch(send, '/mgs-api-prefix/goods/comment/list', payload);
    const batch = json.info?.data || [];
    rows.push(...batch);
    const total = Number(json.info?.meta?.count ?? json.info?.count ?? 0);
    if ((total && rows.length >= total) || !batch.length || batch.length < args.pageSize) break;
  }
  return rows;
}

async function updateRows(args, rows) {
  if (!rows.length) return {updated: 0};
  const now = new Date().toISOString();
  let script = 'BEGIN;\n';
  script += 'CREATE TEMP TABLE stage_comment_platform_translation(comment_key text PRIMARY KEY, goods_comment_content_zh text, translation_provider text, translated_at timestamptz) ON COMMIT DROP;\n';
  script += "COPY stage_comment_platform_translation(comment_key, goods_comment_content_zh, translation_provider, translated_at) FROM STDIN WITH (FORMAT csv, NULL '');\n";
  for (const row of rows) script += csvLine([row.comment_key, row.goods_comment_content_zh, PROVIDER, now]);
  script += '\\.\n';
  script += `
UPDATE fact.product_comment c
SET goods_comment_content_zh = s.goods_comment_content_zh,
    translation_provider = s.translation_provider,
    translated_at = s.translated_at
FROM stage_comment_platform_translation s
WHERE c.comment_key = s.comment_key;
COMMIT;
`;
  if (args.dryRun) return {updated: rows.length, dryRun: true};
  await runPsqlScript(args, script);
  return {updated: rows.length};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = await fetchTargetRows(args);
  const stores = selectedStoreMap(args);
  const byStore = new Map();
  for (const row of targets) {
    if (!stores.has(row.store_key)) continue;
    const date = dateOnly(row.comment_date);
    if (!date) continue;
    if (!byStore.has(row.store_key)) byStore.set(row.store_key, []);
    byStore.get(row.store_key).push({...row, comment_date: date});
  }
  const updates = [];
  const summary = [];
  for (const [storeKey, rows] of byStore) {
    const store = stores.get(storeKey);
    const minDate = rows.reduce((a, r) => a < r.comment_date ? a : r.comment_date, rows[0].comment_date);
    const maxDate = rows.reduce((a, r) => a > r.comment_date ? a : r.comment_date, rows[0].comment_date);
    const {ws, send} = await connectCdp(store.port);
    try {
      await navigate(send, FEEDBACK_URL, args.waitMs);
      const wanted = new Map(rows.map(r => [String(r.comment_id), r]));
      const translated = [];
      let cursor = minDate;
      while (cursor <= maxDate) {
        const batch = await fetchTranslatedRows(send, cursor, cursor, args);
        translated.push(...batch);
        cursor = addDays(cursor, 1);
      }
      for (const row of translated) {
        const target = wanted.get(String(row.commentId || ''));
        const zh = row.goodsCommentContent || '';
        if (target && zh) updates.push({comment_key: target.comment_key, goods_comment_content_zh: zh});
      }
      summary.push({storeKey, selected: rows.length, matched: updates.filter(u => rows.some(r => r.comment_key === u.comment_key)).length, range: `${minDate}..${maxDate}`});
    } finally {
      try { ws.close(); } catch {}
    }
  }
  const result = await updateRows(args, updates);
  console.log(JSON.stringify({ok: true, provider: PROVIDER, selected: targets.length, updated: result.updated, stores: summary, dryRun: args.dryRun}, null, 2));
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
