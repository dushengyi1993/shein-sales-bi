import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  classifyEvidence,
  evidenceDay,
  initialPool,
  missingMetricReviewRows,
  shiftDate
} from '../lib/link_retire_review_evidence.mjs';
import {
  COLLECTOR_HOST,
  SCHEMA_VERSION,
  collectLinkRetireReviewEvidence
} from './collect_link_retire_review_evidence.mjs';

const runDate = '2026-09-07';
const performanceDate = '2026-09-06';
const querySha256 = 'a'.repeat(64);
const pool = [{store_key:'CX', skc:'sv1', spu:'v1', standard_goods_sn:'P1', is_on_shelf:true, c7_eps_uv:100, c7_sale_cnt:0, c30_sale_cnt:null}];
const baseRow = {
  store_key:'CX',
  skc:'sv1',
  performance:{found:true, date:performanceDate, newTagPresent:true, newTag:'', sales7:0, exposure7:100},
  openapiCount:1,
  openapi:{found:true, spu:'v1', status:'已上架', firstShelf:'2026-01-01', lastShelf:'2026-01-01', fetchedAt:runDate, inventory:10},
  inventory:Array.from({length:15}, (_, index) => ({date:shiftDate(runDate, index - 15), usable:10})),
  statusHistory:Array.from({length:15}, (_, index) => ({date:shiftDate(runDate, index - 15), isOnShelf:true})),
  historyIssues:[],
  marketing:{covered:true, source:'scan.json', sourceAt:runDate, matches:[]}
};

function evidenceFor(row = baseRow) {
  return {
    schemaVersion:SCHEMA_VERSION,
    host:COLLECTOR_HOST,
    runDate,
    performanceDate,
    querySha256,
    generatedAt:'2026-09-07T05:00:00Z',
    sources:[],
    rows:[structuredClone(row)]
  };
}

function evaluate(mutateRow, mutateEvidence) {
  const row = structuredClone(baseRow);
  mutateRow?.(row);
  const evidence = evidenceFor(row);
  mutateEvidence?.(evidence);
  return classifyEvidence(pool, evidence, {runDate, performanceDate, querySha256})[0];
}

// Marketing is display evidence. A verified empty activity set remains eligible,
// while a missing same-day source remains pending.
assert.equal(evaluate().retire_candidate_bucket, 'candidate');
assert.equal(evaluate(row => { row.marketing.sourceAt='2026-09-06T16:30:00Z'; }).retire_candidate_bucket, 'candidate');
assert.equal(evaluate(row => { row.marketing.matches=[{current:true, sourceAt:runDate, start:'2026-09-01T00:00:00+08:00', end:'2026-09-30T23:59:59+08:00'}]; }).marketing_effective, true);
assert.equal(evaluate(row => { row.marketing.covered=false; row.marketing.sourceAt=null; }).retire_candidate_bucket, 'cannotJudge');
assert.match(evaluate(row => { row.marketing.covered=false; }).retire_candidate_reason, /marketing_live_incomplete/);

// Missing or unknown current state is never treated as an affirmative off-shelf
// exclusion. A fresh explicit off-shelf state is independently excludable.
assert.equal(evaluate(row => { row.openapi.status='未知'; }).retire_candidate_bucket, 'cannotJudge');
assert.match(evaluate(row => { row.openapi.status=null; }).retire_candidate_reason, /missing_or_unknown_current_status/);
assert.equal(evaluate(row => { row.openapi.status='已下架'; }).retire_candidate_reason, 'not_on_shelf_now');
assert.equal(evaluate(row => { row.openapi.status='待上架'; }).retire_candidate_bucket, 'cannotJudge');

assert.equal(evaluate(row => { row.openapiCount=2; }).retire_candidate_bucket, 'cannotJudge');
assert.equal(evaluate(row => { row.inventory.splice(3,1); }).retire_candidate_bucket, 'cannotJudge');
assert.equal(evaluate(row => { row.statusHistory.splice(3,1); }).retire_candidate_bucket, 'cannotJudge');
assert.equal(evaluate(row => { row.performance.newTagPresent=false; }).retire_candidate_bucket, 'cannotJudge');
assert.equal(evaluate(row => { row.openapi.inventory=null; }).current_inventory, null);
assert.equal(evaluate(row => { row.openapi.inventory=null; }).retire_candidate_bucket, 'cannotJudge');
assert.equal(evaluate(row => { row.inventory[0].usable=0; }).retire_candidate_reason, 'recovery_or_relist_within_15d');
assert.equal(evaluate(row => { row.statusHistory[0].isOnShelf=false; }).retire_candidate_reason, 'recovery_or_relist_within_15d');
assert.equal(evaluate(row => { row.openapi.firstShelf='2026-08-24'; }).retire_candidate_bucket, 'excluded');
assert.equal(evaluate(row => { row.openapi.firstShelf='2026-08-23'; }).retire_candidate_bucket, 'candidate');
assert.equal(evaluate(row => { row.performance.newTag='新品'; }).retire_candidate_bucket, 'excluded');

// Invalid, future, and conflicting dates are pending evidence and cannot create
// a recovery/relist/recent-shelf exclusion.
assert.equal(evidenceDay('2026-09-06T16:30:00Z'), runDate);
assert.equal(evidenceDay('2026-09-07T00:30:00+08:00'), runDate);
assert.equal(evidenceDay('2026-09-07T00:30:00'), runDate);
assert.equal(evidenceDay('2026-02-30T00:30:00Z'), null);
assert.equal(evidenceDay('2026-09-07T25:30:00'), null);
assert.equal(evaluate(row => { row.openapi.fetchedAt='2026-09-07T12:30:00'; row.openapi.firstShelf='2026-01-01T08:30:00'; }).retire_candidate_bucket, 'candidate');
assert.equal(evidenceDay('2026-02-30'), null);
const futureFirst = evaluate(row => { row.openapi.firstShelf='2026-09-08'; });
assert.equal(futureFirst.retire_candidate_bucket, 'cannotJudge');
assert.equal(futureFirst.first_shelf_time, null);
assert.match(futureFirst.retire_candidate_reason, /future_first_shelf_time/);
const conflictingDay = '2026-09-02';
const duplicateConflict = evaluate(row => {
  row.statusHistory.push({date:conflictingDay, isOnShelf:false});
});
assert.equal(duplicateConflict.retire_candidate_bucket, 'cannotJudge');
assert.equal(duplicateConflict.relisted_at, null);
assert.match(duplicateConflict.retire_candidate_reason, /status_date_conflict/);
const recordedConflict = evaluate(row => {
  const index = row.statusHistory.findIndex(item => item.date === conflictingDay);
  row.statusHistory[index - 1].isOnShelf = false;
  row.historyIssues.push(`source_conflict:${conflictingDay}`);
});
assert.equal(recordedConflict.retire_candidate_bucket, 'cannotJudge');
assert.equal(recordedConflict.relisted_at, null);
assert.ok(recordedConflict.evidence_issues.includes(`source_conflict:${conflictingDay}`));
assert.equal(evaluate(row => { row.openapi.fetchedAt='2026-09-07T01:00:00'; }).retire_candidate_bucket, 'candidate');
assert.throws(() => evaluate(null, evidence => { evidence.schemaVersion='link-retire-evidence/v0'; }), /schema/);
assert.throws(() => evaluate(null, evidence => { evidence.generatedAt='2026-09-06T15:00:00Z'; }), /generatedAt/);

// Missing required metrics stay strict-null and become complete review rows.
const metricQuery = {data:{dates:{linkDate:performanceDate}, storeLinks:[
  {store_key:'CX', skc:'missing-exposure', spu:'a', standard_goods_sn:'A', is_on_shelf:true, shelf_status_name:'已上架', c7_eps_uv:null, c7_sale_cnt:0, c30_sale_cnt:null},
  {store_key:'CX', skc:'missing-sales', spu:'b', standard_goods_sn:'B', is_on_shelf:true, shelf_status_name:'已上架', c7_eps_uv:100, c7_sale_cnt:'', c30_sale_cnt:0},
  {store_key:'CX', skc:'both-missing', spu:'c', standard_goods_sn:'C', is_on_shelf:true, shelf_status_name:'已上架', c7_eps_uv:'', c7_sale_cnt:null},
  {store_key:'CX', skc:'known-high-exposure', is_on_shelf:true, c7_eps_uv:301, c7_sale_cnt:null},
  {store_key:'CX', skc:'known-sales', is_on_shelf:true, c7_eps_uv:null, c7_sale_cnt:1},
  {store_key:'CX', skc:'off-shelf', is_on_shelf:false, c7_eps_uv:null, c7_sale_cnt:0},
  {store_key:'CX', skc:'complete', is_on_shelf:true, c7_eps_uv:300, c7_sale_cnt:0}
]}};
const missingRows = missingMetricReviewRows(metricQuery);
assert.deepEqual(missingRows.map(row => row.skc), ['missing-exposure','missing-sales','both-missing']);
assert.equal(missingRows[0].c7_exposure, null);
assert.equal(missingRows[1].c7_sale_cnt, null);
assert.deepEqual(missingRows[2].evidence_issues, ['missing_c7_exposure','missing_c7_sales']);
assert.ok(missingRows.every(row => row.retire_candidate_bucket === 'cannotJudge' && row.current_inventory === null));
assert.deepEqual(initialPool(metricQuery, performanceDate).map(row => row.skc), ['complete']);

// Supplement mode validates all bindings before any external access, performs no
// SQL, keeps prior DB history, clears only resolved unavailable issues, and
// records file conflicts even where a DB row exists.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'link-retire-evidence-'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, JSON.stringify(value));
};
const resolveRuntime = file => path.isAbsolute(file) ? file : path.join(fixtureRoot, file);
const start = shiftDate(runDate, -15);
const history = Array.from({length:15}, (_, index) => ({date:shiftDate(start, index), isOnShelf:true, source:'fact.link_master_snapshot'}));
const hashDate = shiftDate(start, 1);
const contractDate = shiftDate(start, 3);
const sourceConflictDate = shiftDate(start, 5);
const resolvedDate = shiftDate(start, 7);
const preservedConflictDate = shiftDate(start, 9);
const priorRow = structuredClone(baseRow);
priorRow.statusHistory = history;
priorRow.historyIssues = [`unavailable:${resolvedDate}`, `source_conflict:${preservedConflictDate}`];
const priorEvidence = {
  schemaVersion:SCHEMA_VERSION,
  host:COLLECTOR_HOST,
  runDate,
  performanceDate,
  querySha256,
  generatedAt:'2026-09-07T04:00:00Z',
  sources:[],
  databaseSource:'retained database evidence',
  rows:[priorRow]
};
const request = {runDate, performanceDate, querySha256, keys:[{store_key:'CX', skc:'sv1'}], priorEvidence};

try {
  const originalRelative = path.join('outputs','shein_links','CX',`${hashDate}.json`);
  const snapshotRelative = path.join('snapshots',`${hashDate}.json`);
  const snapshotBytes = Buffer.from(JSON.stringify({ok:true, date:hashDate, store:{storeKey:'CX'}, linkRows:[{skc:'sv1', isOnShelf:true}]}));
  fs.mkdirSync(path.dirname(resolveRuntime(snapshotRelative)), {recursive:true});
  fs.writeFileSync(resolveRuntime(snapshotRelative), snapshotBytes);
  writeJson(resolveRuntime(path.join('state','pipeline-markers',shiftDate(hashDate,1),'daily-operating-refresh.json')), {
    ok:true,
    businessDate:hashDate,
    evidence:[{dependencies:[{path:originalRelative, snapshotPath:snapshotRelative, sha256:'0'.repeat(64), bytes:snapshotBytes.length + 1}]}]
  });
  writeJson(resolveRuntime(path.join('outputs','shein_links','CX',`${contractDate}.json`)), {ok:true, date:'2026-01-01', store:{storeKey:'CX'}, linkRows:[]});
  writeJson(resolveRuntime(path.join('outputs','shein_links','CX',`${sourceConflictDate}.json`)), {ok:true, date:sourceConflictDate, store:{storeKey:'CX'}, linkRows:[{skc:'sv1', isOnShelf:false}]});
  writeJson(resolveRuntime(path.join('outputs','shein_links','CX',`${resolvedDate}.json`)), {ok:true, date:resolvedDate, store:{storeKey:'CX'}, linkRows:[{skc:'sv1', isOnShelf:true}]});
  const scanFile = path.join(fixtureRoot, 'marketing-scan.json');
  writeJson(scanFile, {updatedAt:'2026-09-07T01:00:00Z', stores:[{store:'CX', ok:true, warnings:[]}], rows:[]});
  writeJson(resolveRuntime(path.join('state','cloud_ops_alerts','marketing-live-guard-last.json')), {scanFile});

  let sqlCalls = 0;
  const collected = await collectLinkRetireReviewEvidence(request, {
    root:fixtureRoot,
    resolveRuntime,
    now:'2026-09-07T06:00:00Z',
    runSql:() => { sqlCalls += 1; throw new Error('SQL must not run in supplement mode'); }
  });
  assert.equal(sqlCalls, 0);
  assert.equal(collected.schemaVersion, SCHEMA_VERSION);
  assert.equal(collected.host, COLLECTOR_HOST);
  assert.equal(collected.databaseSource, priorEvidence.databaseSource);
  const issues = collected.rows[0].historyIssues;
  assert.ok(issues.includes(`history_hash_mismatch:${hashDate}`));
  assert.ok(issues.includes(`history_bytes_mismatch:${hashDate}`));
  assert.ok(issues.includes(`history_contract_mismatch:${contractDate}`));
  assert.ok(issues.includes(`source_conflict:${sourceConflictDate}`));
  assert.ok(issues.includes(`source_conflict:${preservedConflictDate}`));
  assert.ok(!issues.includes(`unavailable:${hashDate}`), 'DB-complete hash mismatch is a conflict, not a missing day');
  assert.ok(!issues.includes(`unavailable:${resolvedDate}`), 'verified retained DB/file evidence clears only unavailable');

  let externalTouches = 0;
  await assert.rejects(
    collectLinkRetireReviewEvidence({...request, priorEvidence:{...priorEvidence, schemaVersion:'bad'}}, {
      resolveRuntime:() => { externalTouches += 1; return fixtureRoot; },
      runSql:() => { externalTouches += 1; return []; }
    }),
    /prior evidence schema/
  );
  await assert.rejects(
    collectLinkRetireReviewEvidence({...request, priorEvidence:{...priorEvidence, performanceDate:'2026-09-05'}}, {
      resolveRuntime:() => { externalTouches += 1; return fixtureRoot; },
      runSql:() => { externalTouches += 1; return []; }
    }),
    /prior evidence binding/
  );
  await assert.rejects(
    collectLinkRetireReviewEvidence({...request, priorEvidence:{...priorEvidence, rows:[]}}, {
      resolveRuntime:() => { externalTouches += 1; return fixtureRoot; },
      runSql:() => { externalTouches += 1; return []; }
    }),
    /prior evidence key coverage/
  );
  assert.equal(externalTouches, 0);

  const collectorSource = fs.readFileSync(new URL('./collect_link_retire_review_evidence.mjs', import.meta.url));
  const dataImport = `await import("data:text/javascript;base64,${collectorSource.toString('base64')}")`;
  const dataUrlRun = spawnSync(process.execPath, ['--input-type=module','-e',dataImport], {
    input:JSON.stringify({...request, priorEvidence:{...priorEvidence, schemaVersion:'bad'}}),
    encoding:'utf8',
    maxBuffer:4 * 1024 * 1024
  });
  assert.notEqual(dataUrlRun.status, 0);
  assert.match(dataUrlRun.stderr, /prior evidence schema mismatch/);
} finally {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  assert.ok(resolvedFixtureRoot.startsWith(path.resolve(os.tmpdir())), 'temporary fixture must remain under the OS temp directory');
  fs.rmSync(resolvedFixtureRoot, {recursive:true, force:true});
}

const legacy = spawnSync(process.execPath, ['scripts/build_link_retire_candidates_from_csv.mjs','--input','unused.json','--send'], {encoding:'utf8'});
assert.notEqual(legacy.status, 0);
assert.match(legacy.stderr, /bound XLSX --send contract/);

console.log('PASS link retire evidence: strict metrics/dates/status, display-only marketing, no-SQL supplement, immutable history conflicts');
