#!/usr/bin/env node
/**
 * Full-history backfill for SHEIN product comments.
 *
 * It reads each store's earliest local sales date from the BI warehouse,
 * fetches product comments from SHEIN in safe date windows, fetches the
 * platform built-in Chinese translation with `translate: 1`, and upserts
 * both original text and Chinese translation into `fact.product_comment`.
 *
 * SHEIN rejects overly broad comment windows, so this script automatically
 * splits a failing window into smaller ranges. It is read-only against SHEIN.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const OUT_DIR = path.join(ROOT, 'outputs', 'shein_comments_history');
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
    start: '',
    end: bjDate(0),
    windowDays: 60,
    pageSize: 50,
    maxPages: 50,
    waitMs: 1000,
    dryRun: false,
    skipExistingArtifacts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--distro') args.distro = argv[++i];
    else if (a === '--container') args.container = argv[++i];
    else if (a === '--database') args.database = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--window-days') args.windowDays = Math.max(1, Number(argv[++i] || args.windowDays));
    else if (a === '--page-size') args.pageSize = Math.max(1, Number(argv[++i] || args.pageSize));
    else if (a === '--max-pages') args.maxPages = Math.max(1, Number(argv[++i] || args.maxPages));
    else if (a === '--wait-ms') args.waitMs = Math.max(0, Number(argv[++i] || args.waitMs));
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-existing-artifacts') args.skipExistingArtifacts = true;
  }
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ymdToDate(ymd) {
  return new Date(`${ymd}T00:00:00+08:00`);
}

function dateToYmd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(ymd, delta) {
  const d = ymdToDate(ymd);
  d.setDate(d.getDate() + delta);
  return dateToYmd(d);
}

function daysBetween(start, end) {
  return Math.round((ymdToDate(end) - ymdToDate(start)) / 86400_000);
}

function minYmd(a, b) {
  return a < b ? a : b;
}

function maxYmd(a, b) {
  return a > b ? a : b;
}

function num(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function dateOnly(v) {
  if (!v) return null;
  const s = String(v).replace(/\//g, '-');
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function ts(v) {
  if (!v) return null;
  const s = String(v).replace(/\//g, '-').trim();
  if (!s || s === '-') return null;
  return s.length === 16 ? `${s}:00` : s;
}

function joinUnique(values) {
  return [...new Set(values.map(x => String(x || '').trim()).filter(Boolean))].join(',');
}

function standardGoods(raw) {
  if (!raw) return '';
  const n = normalizeGoodsSnDetailed(String(raw));
  return n.canonical || n.standardGoodsSn || String(raw);
}

function compactJson(value, maxLen = 12000) {
  const text = JSON.stringify(value ?? null);
  return text.length <= maxLen ? text : JSON.stringify({truncated: true, preview: text.slice(0, maxLen)});
}

function csvEscape(v) {
  if (v === null || v === undefined || v === '') return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
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

function qIdent(ident) {
  return ident.split('.').map(x => `"${x.replace(/"/g, '""')}"`).join('.');
}

function selectedStores(args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  const keys = args.stores?.length ? new Set(args.stores) : null;
  return enabled.filter(s => !keys || keys.has(s.storeKey));
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

async function fetchStoreStarts(args) {
  const where = args.stores?.length ? `WHERE store_key IN (${args.stores.map(sqlLiteral).join(',')})` : '';
  const sql = `
SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
FROM (
  SELECT store_key, min(date)::text AS first_sales, max(date)::text AS last_sales
  FROM fact.store_daily_sales
  ${where}
  GROUP BY store_key
  ORDER BY store_key
) t;
`;
  const {stdout} = await runPsqlScript(args, sql);
  const text = stdout.trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return new Map();
  return new Map(JSON.parse(text.slice(start, end + 1)).map(row => [row.store_key, row]));
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

async function fetchPaged(send, startDate, endDate, translated, args) {
  const rows = [];
  let metaCount = null;
  for (let page = 1; page <= args.maxPages; page++) {
    const payload = {
      startCommentTime: `${startDate} 00:00:00`,
      commentEndTime: `${endDate} 23:59:59`,
      page,
      perPage: args.pageSize,
      ...(translated ? {translate: 1} : {}),
    };
    const json = await pageFetch(send, '/mgs-api-prefix/goods/comment/list', payload);
    const batch = json.info?.data || [];
    rows.push(...batch);
    metaCount = json.info?.meta?.count ?? json.info?.count ?? metaCount;
    if (Number.isFinite(Number(metaCount)) && rows.length >= Number(metaCount)) break;
    if (!batch.length || batch.length < args.pageSize) break;
  }
  return {rows, metaCount};
}

function tooBroadError(err) {
  return /mgs97906|数据量太多|缩小.*评论时间/i.test(String(err?.message || err));
}

async function fetchWindow(send, store, startDate, endDate, args, depth = 0) {
  try {
    const raw = await fetchPaged(send, startDate, endDate, false, args);
    const translated = await fetchPaged(send, startDate, endDate, true, args).catch(err => {
      if (tooBroadError(err)) throw err;
      return {rows: [], metaCount: null, translateError: String(err?.message || err)};
    });
    const translatedById = new Map((translated.rows || []).map(row => [String(row.commentId || ''), row]));
    const rows = raw.rows.map(row => {
      const translatedRow = translatedById.get(String(row.commentId || ''));
      const zh = translatedRow?.goodsCommentContent || '';
      const logisticZh = translatedRow?.logisticCommentContent || '';
      return {
        ...row,
        goodsCommentContentZh: zh,
        logisticCommentContentZh: logisticZh,
        translationProvider: zh || logisticZh ? PROVIDER : '',
        translatedAt: zh || logisticZh ? new Date().toISOString() : '',
      };
    });
    return [{
      storeKey: store.storeKey,
      startDate,
      endDate,
      rows,
      meta: {
        rawCount: raw.rows.length,
        rawMetaCount: raw.metaCount,
        translatedCount: rows.filter(row => row.goodsCommentContentZh).length,
        translatedMetaCount: translated.metaCount,
        translateError: translated.translateError || '',
      },
      splitDepth: depth,
    }];
  } catch (err) {
    if (tooBroadError(err) && startDate < endDate) {
      const span = daysBetween(startDate, endDate);
      const mid = addDays(startDate, Math.floor(span / 2));
      const nextStart = addDays(mid, 1);
      const left = await fetchWindow(send, store, startDate, mid, args, depth + 1);
      const right = await fetchWindow(send, store, nextStart, endDate, args, depth + 1);
      return [...left, ...right];
    }
    throw err;
  }
}

function makeWindows(startDate, endDate, windowDays) {
  const out = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const end = minYmd(addDays(cursor, windowDays - 1), endDate);
    out.push([cursor, end]);
    cursor = addDays(end, 1);
  }
  return out;
}

function toDbRow(store, c, sourceFile) {
  const raw = c.goodSn || '';
  const commentZh = c.goodsCommentContentZh || '';
  return {
    comment_key: `${store.storeKey}__${c.commentId || ''}`,
    store_key: store.storeKey,
    group_key: store.groupKey,
    shop_name: store.shopName,
    comment_id: c.commentId || '',
    comment_date: dateOnly(c.commentTime),
    comment_time: ts(c.commentTime),
    order_time: ts(c.orderTime),
    bill_no: c.billNo || '',
    supply_order_no: c.supplyOrderNo || '',
    standard_goods_sn: standardGoods(raw),
    raw_goods_sn: raw,
    spu: c.spu || '',
    skc: c.skc || '',
    sku: c.sku || '',
    goods_title: c.goodsTitle || '',
    goods_attribute: c.goodsAttribute || '',
    goods_comment_star: num(c.goodsCommentStar),
    goods_comment_star_name: c.goodsCommentStarName || '',
    goods_comment_content: c.goodsCommentContent || '',
    goods_comment_content_zh: commentZh,
    translation_provider: commentZh ? (c.translationProvider || PROVIDER) : '',
    translated_at: commentZh ? (c.translatedAt || new Date().toISOString()) : '',
    bad_comment_labels: joinUnique((c.badCommentLabelList || []).map(x => x.labelName || x.name || x)),
    logistic_comment_star: num(c.logisticCommentStar),
    is_quality: c.isQuality ?? '',
    is_quality_label: c.isQualityLabel ?? '',
    is_quality_complaint: c.isQualityComplaint ?? '',
    source_file: sourceFile,
    raw_summary: compactJson(c),
  };
}

async function upsertComments(args, rows) {
  const columns = [
    'comment_key','store_key','group_key','shop_name','comment_id','comment_date','comment_time','order_time',
    'bill_no','supply_order_no','standard_goods_sn','raw_goods_sn','spu','skc','sku','goods_title','goods_attribute',
    'goods_comment_star','goods_comment_star_name','goods_comment_content','goods_comment_content_zh','translation_provider',
    'translated_at','bad_comment_labels','logistic_comment_star','is_quality','is_quality_label','is_quality_complaint',
    'source_file','raw_summary',
  ];
  const deduped = new Map();
  for (const row of rows) {
    if (row.comment_key && row.comment_id) deduped.set(row.comment_key, row);
  }
  rows = [...deduped.values()];
  if (!rows.length) return {rows: 0};
  let script = 'BEGIN;\n';
  script += 'CREATE TEMP TABLE stage_full_history_comments (LIKE fact.product_comment INCLUDING DEFAULTS) ON COMMIT DROP;\n';
  script += `COPY stage_full_history_comments (${columns.map(qIdent).join(', ')}) FROM STDIN WITH (FORMAT csv, NULL '');\n`;
  for (const row of rows) script += csvLine(columns.map(c => row[c]));
  script += '\\.\n';
  const updateSet = columns
    .filter(c => c !== 'comment_key')
    .map(c => `${qIdent(c)} = EXCLUDED.${qIdent(c)}`)
    .concat('updated_at = now()')
    .join(',\n    ');
  script += `INSERT INTO fact.product_comment (${columns.map(qIdent).join(', ')})
SELECT ${columns.map(qIdent).join(', ')} FROM stage_full_history_comments
ON CONFLICT (comment_key) DO UPDATE SET
    ${updateSet};
COMMIT;
`;
  if (args.dryRun) return {rows: rows.length, dryRun: true};
  await runPsqlScript(args, script);
  return {rows: rows.length};
}

async function writeArtifact(store, segment) {
  const dir = path.join(OUT_DIR, store.storeKey);
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `${segment.startDate}_${segment.endDate}.json`);
  const data = {
    store: {
      storeKey: store.storeKey,
      groupKey: store.groupKey,
      shopName: store.shopName,
      profileKey: store.profileKey,
      port: store.port,
    },
    startDate: segment.startDate,
    endDate: segment.endDate,
    fetchTime: new Date().toISOString(),
    rows: segment.rows,
    meta: segment.meta,
  };
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const starts = await fetchStoreStarts(args);
  const stores = selectedStores(args);
  const summary = [];
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalTranslated = 0;
  await fs.mkdir(OUT_DIR, {recursive: true});
  for (const store of stores) {
    const startInfo = starts.get(store.storeKey);
    const startDate = args.start || startInfo?.first_sales;
    if (!startDate) {
      summary.push({storeKey: store.storeKey, skipped: true, reason: 'no_start_date'});
      continue;
    }
    const endDate = minYmd(args.end, startInfo?.last_sales || args.end);
    if (endDate < startDate) {
      summary.push({storeKey: store.storeKey, skipped: true, reason: 'empty_range', startDate, endDate});
      continue;
    }
    const windows = makeWindows(startDate, endDate, args.windowDays);
    const {ws, send} = await connectCdp(store.port);
    let storeFetched = 0;
    let storeUpserted = 0;
    let storeTranslated = 0;
    let segments = 0;
    try {
      await navigate(send, FEEDBACK_URL, args.waitMs);
      for (const [winStart, winEnd] of windows) {
        const expectedFile = path.join(OUT_DIR, store.storeKey, `${winStart}_${winEnd}.json`);
        if (args.skipExistingArtifacts) {
          try {
            await fs.access(expectedFile);
            continue;
          } catch {}
        }
        const fetchedSegments = await fetchWindow(send, store, winStart, winEnd, args);
        for (const segment of fetchedSegments) {
          const artifact = await writeArtifact(store, segment);
          const dbRows = segment.rows.map(row => toDbRow(store, row, path.relative(ROOT, artifact).replace(/\\/g, '/')));
          const upsert = await upsertComments(args, dbRows);
          segments += 1;
          storeFetched += segment.rows.length;
          storeUpserted += upsert.rows || 0;
          storeTranslated += segment.rows.filter(row => row.goodsCommentContentZh).length;
          console.log(`[${store.storeKey}] ${segment.startDate}..${segment.endDate} comments=${segment.rows.length} translated=${segment.meta.translatedCount} upsert=${upsert.rows || 0}`);
        }
      }
    } finally {
      try { ws.close(); } catch {}
    }
    totalFetched += storeFetched;
    totalUpserted += storeUpserted;
    totalTranslated += storeTranslated;
    summary.push({storeKey: store.storeKey, startDate, endDate, windows: windows.length, segments, fetched: storeFetched, translated: storeTranslated, upserted: storeUpserted});
  }
  const out = {
    ok: true,
    provider: PROVIDER,
    end: args.end,
    windowDays: args.windowDays,
    fetched: totalFetched,
    translated: totalTranslated,
    upserted: totalUpserted,
    stores: summary,
  };
  const report = path.join(OUT_DIR, `full-history-comments-summary-${Date.now()}.json`);
  await fs.writeFile(report, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify({...out, report: path.relative(ROOT, report)}, null, 2));
}

main().catch(err => {
  console.error(err?.stack || err);
  process.exit(1);
});
