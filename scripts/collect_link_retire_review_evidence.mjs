#!/usr/bin/env node
// Read-only remote collector. Receives an exact key/date request on stdin;
// emits only allowlisted evidence, never credentials or raw platform payloads.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const SCHEMA_VERSION = 'link-retire-evidence/v1';
export const COLLECTOR_HOST = 'shein-bi-tencent';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const safe = value => { if (!/^[A-Za-z0-9_-]+$/.test(value || '')) throw new Error('invalid key/date'); return value; };
const keyOf = row => `${row.store_key}::${row.skc}`;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const uniquePush = (list, value) => { if (!list.includes(value)) list.push(value); };
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);
const isValidDate = value => DATE_RE.test(value || '') && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;

function exactKeyCoverage(rows, keys) {
  if (!Array.isArray(rows) || !Array.isArray(keys)) return false;
  const expected = keys.map(keyOf);
  const actual = rows.map(keyOf);
  if (expected.length !== actual.length || new Set(expected).size !== expected.length || new Set(actual).size !== actual.length) return false;
  const expectedSet = new Set(expected);
  return actual.every(key => expectedSet.has(key));
}

export function validatePriorEvidence(priorEvidence, {runDate, performanceDate, querySha256, keys}) {
  if (!priorEvidence || typeof priorEvidence !== 'object' || priorEvidence.schemaVersion !== SCHEMA_VERSION) throw new Error('prior evidence schema mismatch');
  if (priorEvidence.runDate !== runDate || priorEvidence.performanceDate !== performanceDate || priorEvidence.querySha256 !== querySha256) throw new Error('prior evidence binding mismatch');
  if (!exactKeyCoverage(priorEvidence.rows, keys)) throw new Error('prior evidence key coverage mismatch');
  if (!Array.isArray(priorEvidence.sources) || typeof priorEvidence.databaseSource !== 'string') throw new Error('prior evidence provenance incomplete');
  for (const row of priorEvidence.rows) {
    if (!Array.isArray(row.inventory) || !Array.isArray(row.statusHistory) || !Array.isArray(row.historyIssues)) throw new Error(`prior evidence row incomplete: ${keyOf(row)}`);
  }
  return priorEvidence;
}

export function validateCollectorRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('invalid request');
  const {runDate, performanceDate, querySha256, keys} = request;
  safe(runDate); safe(performanceDate);
  if (!isValidDate(runDate) || !isValidDate(performanceDate) || performanceDate > runDate || !SHA256_RE.test(querySha256 || '')) throw new Error('invalid request');
  if (!Array.isArray(keys)) throw new Error('invalid keys');
  for (const key of keys) { safe(key?.store_key); safe(key?.skc); }
  if (new Set(keys.map(keyOf)).size !== keys.length) throw new Error('invalid keys');
  // This validation intentionally precedes runtime policy imports, file reads,
  // and database access in supplement mode.
  if (request.priorEvidence) validatePriorEvidence(request.priorEvidence, {runDate, performanceDate, querySha256, keys});
  return {runDate, performanceDate, querySha256, keys, priorEvidence:request.priorEvidence};
}

function sqlValues(keys) {
  return keys.length ? keys.map(key => `('${safe(key.store_key)}','${safe(key.skc)}')`).join(',') : '(NULL::text,NULL::text)';
}

function baseSql({values, start, runDate, performanceDate}) {
  return `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='90s';
WITH keys(store_key,skc) AS (VALUES ${values}),
perf AS (SELECT p.* FROM fact.link_performance_daily p JOIN keys k USING(store_key,skc) WHERE p.date=DATE '${performanceDate}'),
inv AS (SELECT k.store_key,k.skc,v.snapshot_date,
 CASE WHEN count(*) FILTER(WHERE coalesce(v.usable_inventory,v.inventory_quantity) IS NULL)>0 THEN NULL ELSE sum(coalesce(v.usable_inventory,v.inventory_quantity)) END AS usable
 FROM keys k JOIN fact.visible_inventory_snapshot v ON v.store_key=k.store_key
 AND k.skc=ANY(regexp_split_to_array(coalesce(v.skc_list,''),'[^A-Za-z0-9_-]+'))
 WHERE v.snapshot_date BETWEEN DATE '${start}' AND DATE '${runDate}' GROUP BY k.store_key,k.skc,v.snapshot_date)
SELECT coalesce(jsonb_agg(jsonb_build_object('store_key',k.store_key,'skc',k.skc,
 'performance',(SELECT jsonb_build_object('found',true,'date',p.date,'newTagPresent',p.raw_summary ? 'newGoodsTag','newTag',p.raw_summary->>'newGoodsTag','sales7',p.c7_sale_cnt,'exposure7',p.raw_summary->>'c7EpsUv') FROM perf p WHERE p.store_key=k.store_key AND p.skc=k.skc ORDER BY p.updated_at DESC LIMIT 1),
 'openapiCount',(SELECT count(*) FROM fact.openapi_product_link o WHERE o.store_key=k.store_key AND o.skc=k.skc),
 'openapi',(SELECT jsonb_build_object('found',true,'spu',o.spu,'status',o.shelf_status_name,'firstShelf',o.first_shelf_time,'lastShelf',o.last_shelf_time,'fetchedAt',o.fetched_at AT TIME ZONE 'Asia/Shanghai','inventory',o.shein_usable_inventory) FROM fact.openapi_product_link o WHERE o.store_key=k.store_key AND o.skc=k.skc ORDER BY o.fetched_at DESC LIMIT 1),
 'inventory',coalesce((SELECT jsonb_agg(jsonb_build_object('date',v.snapshot_date,'usable',v.usable) ORDER BY v.snapshot_date) FROM inv v WHERE v.store_key=k.store_key AND v.skc=k.skc),'[]'::jsonb)
) ORDER BY k.store_key,k.skc),'[]'::jsonb) FROM keys k WHERE k.store_key IS NOT NULL; COMMIT;`;
}

function historySql({values, start, performanceDate}) {
  return `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout='60s';
WITH keys(store_key,skc) AS (VALUES ${values})
SELECT coalesce(jsonb_agg(jsonb_build_object('store_key',l.store_key,'skc',l.skc,'date',l.snapshot_date,'isOnShelf',l.is_on_shelf,'sourceFile',l.source_file) ORDER BY l.store_key,l.skc,l.snapshot_date),'[]'::jsonb)
FROM fact.link_master_snapshot l JOIN keys k USING(store_key,skc) WHERE l.snapshot_date BETWEEN DATE '${start}' AND DATE '${performanceDate}'; COMMIT;`;
}

function defaultRunSql(sql, {label, maxBuffer}) {
  const result = spawnSync('sudo', ['docker','exec','-i','shein-warehouse-db','psql','-X','-q','-U','shein','-d','shein_bi','-v','ON_ERROR_STOP=1','-t','-A'], {input:sql, encoding:'utf8', maxBuffer});
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr).slice(0,1600)}`);
  return JSON.parse(result.stdout.trim());
}

function issueRows(rows, store, date, issue) {
  for (const row of rows) if (row.store_key === store) uniquePush(row.historyIssues, `${issue}:${date}`);
}

function hasStatusDay(row, date) {
  return row.statusHistory.some(item => item.date === date && typeof item.isOnShelf === 'boolean');
}

function markUnavailableWhereNeeded(rows, store, date) {
  for (const row of rows) if (row.store_key === store && !hasStatusDay(row, date)) uniquePush(row.historyIssues, `unavailable:${date}`);
}

function clearUnavailable(row, date) {
  row.historyIssues = row.historyIssues.filter(issue => issue !== `unavailable:${date}`);
}

function mergeDatabaseHistory(rows, historyRows, byKey) {
  for (const history of historyRows) {
    const row = byKey.get(keyOf(history));
    if (!row) throw new Error(`database history contains unexpected key: ${keyOf(history)}`);
    if (row.statusHistory.some(item => item.date === history.date)) {
      uniquePush(row.historyIssues, `duplicate_database:${history.date}`);
      continue;
    }
    row.statusHistory.push({date:history.date, isOnShelf:history.isOnShelf, source:'fact.link_master_snapshot', sourceFile:history.sourceFile});
  }
}

function mergeVerifiedHistoryDocument({doc, rows, byKey, store, date}) {
  if (doc.ok !== true || doc.date !== date || doc.store?.storeKey !== store || !Array.isArray(doc.linkRows)) {
    issueRows(rows, store, date, 'history_contract_mismatch');
    markUnavailableWhereNeeded(rows, store, date);
    return;
  }
  const targetRows = rows.filter(row => row.store_key === store);
  const matching = new Map();
  for (const sourceRow of doc.linkRows) {
    const targetKey = `${store}::${sourceRow?.skc}`;
    if (!byKey.has(targetKey)) continue;
    if (!matching.has(targetKey)) matching.set(targetKey, []);
    matching.get(targetKey).push(sourceRow);
  }
  for (const row of targetRows) {
    const sourceRows = matching.get(keyOf(row)) || [];
    if (sourceRows.length > 1) {
      uniquePush(row.historyIssues, `duplicate:${date}`);
      continue;
    }
    if (sourceRows.length === 0) {
      if (hasStatusDay(row, date)) clearUnavailable(row, date);
      else uniquePush(row.historyIssues, `unavailable:${date}`);
      continue;
    }
    const sourceRow = sourceRows[0];
    if (typeof sourceRow.isOnShelf !== 'boolean') {
      uniquePush(row.historyIssues, `history_contract_mismatch:${date}`);
      continue;
    }
    const existing = row.statusHistory.filter(item => item.date === date);
    if (existing.length > 1) {
      uniquePush(row.historyIssues, `duplicate_existing:${date}`);
      continue;
    }
    if (existing.length === 1 && existing[0].isOnShelf !== sourceRow.isOnShelf) {
      uniquePush(row.historyIssues, `source_conflict:${date}`);
      continue;
    }
    if (existing.length === 0) row.statusHistory.push({date, isOnShelf:sourceRow.isOnShelf, source:'morning_source_file'});
    clearUnavailable(row, date);
  }
}

export async function collectLinkRetireReviewEvidence(inputRequest, options = {}) {
  const request = validateCollectorRequest(inputRequest);
  const {runDate, performanceDate, querySha256, keys, priorEvidence} = request;
  const start = shiftDate(runDate, -15);
  const values = sqlValues(keys);
  const runSql = options.runSql || defaultRunSql;
  let rows;
  let databaseSource;
  let sources;

  if (priorEvidence) {
    rows = structuredClone(priorEvidence.rows);
    databaseSource = priorEvidence.databaseSource;
    sources = structuredClone(priorEvidence.sources);
  } else {
    rows = runSql(baseSql({values, start, runDate, performanceDate}), {label:'read-only database collection', maxBuffer:32 * 1024 * 1024});
    if (!exactKeyCoverage(rows, keys)) throw new Error('database row key coverage mismatch');
    for (const row of rows) { row.statusHistory = []; row.historyIssues = []; }
    databaseSource = 'shein-warehouse-db/shein_bi: fact.link_performance_daily,fact.openapi_product_link,fact.visible_inventory_snapshot,fact.link_master_snapshot (READ ONLY transactions)';
    sources = [];
  }

  // No runtime path import or file access occurs until a prior evidence payload
  // has passed all binding and complete-key checks above.
  const root = options.root || process.cwd();
  let resolveRuntime = options.resolveRuntime;
  if (!resolveRuntime) {
    const {runtimeArtifactLocation} = await import(pathToFileURL(path.join(root, 'lib/cloud_runtime_path_policy.mjs')).href);
    resolveRuntime = file => runtimeArtifactLocation({root, file}).path;
  }
  const readFile = options.readFileSync || fs.readFileSync;
  function readEvidence(file) {
    const bytes = readFile(file);
    const source = {path:file, sha256:digest(bytes), bytes:bytes.length};
    sources.push(source);
    let doc;
    try { doc = JSON.parse(bytes); }
    catch (error) { error.evidenceContract = true; throw error; }
    return {doc, source};
  }

  const byKey = new Map(rows.map(row => [keyOf(row), row]));
  if (!priorEvidence) {
    const databaseHistory = runSql(historySql({values, start, performanceDate}), {label:'direct link-master history read', maxBuffer:16 * 1024 * 1024});
    if (!Array.isArray(databaseHistory)) throw new Error('invalid database history result');
    mergeDatabaseHistory(rows, databaseHistory, byKey);
  }
  // A complete retained database observation is enough to resolve a previous
  // missing-file issue. Other conflicts remain immutable.
  for (const row of rows) {
    for (const status of row.statusHistory) if (typeof status.isOnShelf === 'boolean') clearUnavailable(row, status.date);
  }

  const historySnapshots = new Map();
  for (let date = start; date < runDate; date = shiftDate(date, 1)) {
    const next = shiftDate(date, 1);
    try {
      const {doc:marker} = readEvidence(resolveRuntime(path.join('state','pipeline-markers',next,'daily-operating-refresh.json')));
      if (marker.ok !== true || marker.businessDate !== date) continue;
      for (const parent of marker.evidence || []) for (const dependency of parent.dependencies || []) {
        if (dependency.snapshotPath && dependency.path) historySnapshots.set(resolveRuntime(dependency.path), dependency);
      }
    } catch {
      // A marker is only a locator. The canonical original path is still tried.
    }
  }

  for (const store of [...new Set(keys.map(key => key.store_key))]) {
    const directory = resolveRuntime(path.join('outputs','shein_links',store));
    for (let date = start; date <= runDate; date = shiftDate(date, 1)) {
      const original = path.join(directory, `${date}.json`);
      const saved = historySnapshots.get(original);
      const sourceFile = saved ? resolveRuntime(saved.snapshotPath) : original;
      let loaded;
      try {
        loaded = readEvidence(sourceFile);
      } catch (error) {
        if (error?.code === 'ENOENT') markUnavailableWhereNeeded(rows, store, date);
        else {
          issueRows(rows, store, date, error?.evidenceContract ? 'history_contract_mismatch' : 'history_read_error');
          markUnavailableWhereNeeded(rows, store, date);
        }
        continue;
      }
      if (saved) {
        let mismatched = false;
        if (!SHA256_RE.test(saved.sha256 || '') || loaded.source.sha256 !== saved.sha256) {
          issueRows(rows, store, date, 'history_hash_mismatch');
          mismatched = true;
        }
        if (!Number.isSafeInteger(saved.bytes) || loaded.source.bytes !== saved.bytes) {
          issueRows(rows, store, date, 'history_bytes_mismatch');
          mismatched = true;
        }
        if (mismatched) {
          markUnavailableWhereNeeded(rows, store, date);
          continue;
        }
      }
      mergeVerifiedHistoryDocument({doc:loaded.doc, rows, byKey, store, date});
    }
  }

  let scan = null;
  let scanFile = null;
  let marketingError = null;
  try {
    const {doc:guard} = readEvidence(resolveRuntime('state/cloud_ops_alerts/marketing-live-guard-last.json'));
    scanFile = path.resolve(root, guard.scanFile);
    scan = readEvidence(scanFile).doc;
  } catch {
    marketingError = 'marketing_source_unavailable';
  }
  for (const row of rows) {
    const store = (scan?.stores || []).find(item => item.store === row.store_key);
    const matches = (scan?.rows || []).filter(item => item.store_key === row.store_key && item.skc === row.skc);
    row.marketing = {
      covered:store?.ok === true && !(store.warnings?.length),
      source:scanFile,
      sourceAt:scan?.updatedAt || scan?.createdAt || null,
      matches:matches.flatMap(match => [
        {current:match.marketing_limited_discount_is_current === true, start:match.marketing_limited_discount_start, end:match.marketing_limited_discount_end, sourceAt:match.marketing_price_source_at, type:'limited_discount'},
        {current:match.marketing_ordinary_price_is_current === true, start:match.marketing_activity_start, end:match.marketing_activity_end, sourceAt:match.marketing_price_source_at, type:'ordinary'}
      ])
    };
  }

  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('invalid collector time');
  return {schemaVersion:SCHEMA_VERSION, host:COLLECTOR_HOST, runDate, performanceDate, querySha256, generatedAt:now.toISOString(), sources, databaseSource, marketingError, rows};
}

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const evidence = await collectLinkRetireReviewEvidence(request);
  console.log(JSON.stringify(evidence));
}

const invokedDirectly = import.meta.url.startsWith('data:') || (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url);
if (invokedDirectly) {
  try { await main(); }
  catch (error) { console.error(error?.stack || error); process.exitCode = 1; }
}
