#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-candidates-smoke-'));
const input = path.join(tmp, 'input.csv');
const outDir = path.join(tmp, 'out');
const columns = [
  'store',
  'standard_goods_sn',
  'skc',
  'c7_exposure',
  'c7_sale_cnt',
  'new_tag_value',
  'current_status',
  'link_created_time',
  'first_shelf_time',
  'inventory_recovery_date',
  'recovery_evidence_complete',
  'suggested_waste_goods_sn',
  'perf_date',
];
const rows = [
  {
    store: 'FY',
    standard_goods_sn: 'SK-5110电磁炉',
    skc: 'sv-old-safe',
    c7_exposure: 1,
    c7_sale_cnt: 0,
    new_tag_value: '',
    current_status: '已上架',
    link_created_time: '2026-01-08 22:47:06',
    first_shelf_time: '2026-01-11 13:22:45',
    inventory_recovery_date: '2026-05-01',
    suggested_waste_goods_sn: '（废）SK-5110电磁炉',
    perf_date: '2026-07-04',
  },
  {
    store: 'HL',
    standard_goods_sn: 'SK-YM-7032绞肉机',
    skc: 'sv260628145147517093202',
    c7_exposure: 0,
    c7_sale_cnt: 0,
    new_tag_value: '',
    current_status: '已上架',
    link_created_time: '2026-06-28 14:57:56',
    first_shelf_time: '2026-07-04 20:31:21',
    inventory_recovery_date: '',
    suggested_waste_goods_sn: '（废）SK-YM-7032绞肉机',
    perf_date: '2026-07-04',
  },
  {
    store: 'XL',
    standard_goods_sn: 'KF-JN-02便携咖啡机',
    skc: 'sv260620170564657240918',
    c7_exposure: 0,
    c7_sale_cnt: 0,
    new_tag_value: '',
    current_status: '已上架',
    link_created_time: '2026-06-20 17:09:08',
    first_shelf_time: '2026-07-04 13:47:07',
    inventory_recovery_date: '',
    suggested_waste_goods_sn: '（废）KF-JN-02便携咖啡机',
    perf_date: '2026-07-04',
  },
  {
    store: 'DL',
    standard_goods_sn: 'SK-15013卷发钳和卷发棒',
    skc: 'sv-new-tag',
    c7_exposure: 8,
    c7_sale_cnt: 0,
    new_tag_value: '4',
    current_status: '已上架',
    link_created_time: '2026-06-20 17:09:08',
    first_shelf_time: '2026-05-01 13:47:07',
    inventory_recovery_date: '',
    suggested_waste_goods_sn: '（废）SK-15013卷发钳和卷发棒',
    perf_date: '2026-07-04',
  },
  {
    store: 'DX',
    standard_goods_sn: 'SK-3378杆式吸尘器',
    skc: 'sv-replenished-yesterday',
    c7_exposure: 5,
    c7_sale_cnt: 0,
    new_tag_value: '',
    current_status: '已上架',
    link_created_time: '2025-08-28 12:00:00',
    first_shelf_time: '2025-12-03 22:37:56',
    inventory_recovery_date: '2026-07-03',
    suggested_waste_goods_sn: '（废）SK-3378杆式吸尘器',
    perf_date: '2026-07-04',
  },
  {
    store: 'QY',
    standard_goods_sn: 'OLD-UNKNOWN',
    skc: 'sv-missing-recovery-evidence',
    c7_exposure: 0,
    c7_sale_cnt: 0,
    new_tag_value: '',
    current_status: '已上架',
    link_created_time: '2025-01-01 00:00:00',
    first_shelf_time: '2025-01-02 00:00:00',
    inventory_recovery_date: '',
    recovery_evidence_complete: '',
    suggested_waste_goods_sn: '（废）OLD-UNKNOWN',
    perf_date: '2026-07-04',
  },
];
await fs.writeFile(input, [
  columns.join(','),
  ...rows.map(row => columns.map(c => csvEscape(row[c])).join(',')),
].join('\n'), 'utf8');

const result = await run(['scripts/build_link_retire_candidates_from_csv.mjs', '--input', input, '--out-dir', outDir, '--performance-date', '2026-07-04']);
assert.equal(result.code, 0, result.stderr);
const parsed = JSON.parse(result.stdout);
assert.equal(parsed.ok, true);
assert.equal(parsed.counts.inputRows, 6);
assert.equal(parsed.counts.candidateRows, 1);
assert.equal(parsed.counts.excludedByFirstShelf15d, 2);
assert.equal(parsed.counts.excludedByNewGoodsTag, 1);
assert.equal(parsed.counts.excludedByRecentRecovery15d, 1);
assert.equal(parsed.counts.cannotJudgeRows, 1);
for (const check of parsed.targetSkcCheck) {
  assert.equal(check.presentInCandidates, false, check.skc);
  assert.equal(check.bucket, 'excludedByFirstShelf15d', check.skc);
}
const bundle = JSON.parse(await fs.readFile(parsed.outJson, 'utf8'));
assert.deepEqual(bundle.rows.map(r => r.skc), ['sv-old-safe']);

const queryInput = path.join(tmp, 'query.json');
const jsonOutDir = path.join(tmp, 'json-out');
await fs.writeFile(queryInput, JSON.stringify({
  ok: true,
  mode: 'direct-bi-data',
  aiInvoked: false,
  data: {storeLinks: rows},
}), 'utf8');
const jsonResult = await run([
  'scripts/build_link_retire_candidates_from_csv.mjs',
  '--input', queryInput,
  '--out-dir', jsonOutDir,
  '--performance-date', '2026-07-04',
]);
assert.equal(jsonResult.code, 0, jsonResult.stderr);
const jsonParsed = JSON.parse(jsonResult.stdout);
assert.equal(jsonParsed.ok, true);
assert.equal(jsonParsed.counts.inputRows, 6);
assert.equal(jsonParsed.counts.candidateRows, 1);
const jsonSummary = JSON.parse(await fs.readFile(jsonParsed.outSummary, 'utf8'));
assert.equal(jsonSummary.inputFormat, 'json');
const jsonBundle = JSON.parse(await fs.readFile(jsonParsed.outJson, 'utf8'));
assert.deepEqual(jsonBundle.rows.map(r => r.skc), ['sv-old-safe']);

// Real managed-query linksData shape: store_key/c7_eps_uv/is_on_shelf/
// shelf_status_name rows without enriched newGoodsTag or recovery columns.
// The server `retire_candidate` flag is the only new-tag evidence; recovery
// history is not part of the section, so rows lacking it stay 待确认.
const queryRealInput = path.join(tmp, 'query-real.json');
const realRows = [
  {
    store_key: 'FY', standard_goods_sn: 'SK-5110电磁炉', spu: 'SPU-5110', skc: 'sv-real-candidate',
    link_date: '2026-07-04', first_shelf_time: '2026-01-11 13:22:45',
    c7_eps_uv: 1, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    retire_candidate: true, inventory_recovery_date: '2026-05-01',
  },
  {
    store_key: 'HL', standard_goods_sn: 'SK-YM-7032绞肉机', spu: 'SPU-7032', skc: 'sv-real-new',
    link_date: '2026-07-04', first_shelf_time: '2026-07-04 20:31:21',
    c7_eps_uv: 0, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    retire_candidate: true,
  },
  {
    store_key: 'XL', standard_goods_sn: 'KF-JN-02便携咖啡机', spu: 'SPU-JN02', skc: 'sv-real-no-recovery',
    link_date: '2026-07-04', first_shelf_time: '2026-01-01 00:00:00',
    c7_eps_uv: 2, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    retire_candidate: true,
  },
  {
    store_key: 'DL', standard_goods_sn: 'SK-15013卷发钳和卷发棒', spu: 'SPU-15013', skc: 'sv-real-tag',
    link_date: '2026-07-04', first_shelf_time: '2026-05-01 13:47:07',
    c7_eps_uv: 8, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    new_goods_tag: '4', retire_candidate: false,
  },
  {
    store_key: 'DX', standard_goods_sn: 'SK-3378杆式吸尘器', spu: 'SPU-3378', skc: 'sv-real-no-tag-evidence',
    link_date: '2026-07-04', first_shelf_time: '2025-12-03 22:37:56',
    c7_eps_uv: 5, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    retire_candidate: false,
  },
  {
    store_key: 'QY', standard_goods_sn: 'OLD-UNKNOWN', spu: 'SPU-OLD', skc: 'sv-real-high-exposure',
    link_date: '2026-07-04', first_shelf_time: '2025-01-02 00:00:00',
    c7_eps_uv: 500, c7_sale_cnt: 0, is_on_shelf: true, shelf_status_name: '已上架',
    retire_candidate: false,
  },
];
await fs.writeFile(queryRealInput, JSON.stringify({
  ok: true,
  mode: 'direct-bi-data',
  aiInvoked: false,
  data: {storeLinks: realRows},
}), 'utf8');
const realJsonOutDir = path.join(tmp, 'real-json-out');
const realJsonResult = await run([
  'scripts/build_link_retire_candidates_from_csv.mjs',
  '--input', queryRealInput,
  '--out-dir', realJsonOutDir,
]);
assert.equal(realJsonResult.code, 0, realJsonResult.stderr);
const realJsonParsed = JSON.parse(realJsonResult.stdout);
assert.equal(realJsonParsed.ok, true);
assert.equal(realJsonParsed.counts.inputRows, 6);
assert.equal(realJsonParsed.counts.candidateRows, 1);
assert.equal(realJsonParsed.counts.excludedByFirstShelf15d, 1);
assert.equal(realJsonParsed.counts.excludedByNewGoodsTag, 1);
assert.equal(realJsonParsed.counts.cannotJudgeRows, 2);
const realJsonSummary = JSON.parse(await fs.readFile(realJsonParsed.outSummary, 'utf8'));
assert.equal(realJsonSummary.inputFormat, 'json');
assert.equal(realJsonSummary.performanceDate, '2026-07-04', 'link_date must serve as the business-date fallback');
assert.match(realJsonSummary.evidenceScope.newGoodsTag, /retire_candidate/);
assert.match(realJsonSummary.evidenceScope.recoveryEvidence, /待确认/);
const realJsonBundle = JSON.parse(await fs.readFile(realJsonParsed.outJson, 'utf8'));
assert.deepEqual(realJsonBundle.rows.map(r => r.skc), ['sv-real-candidate']);
const candidateRow = realJsonBundle.rows[0];
assert.equal(candidateRow.store, 'FY', 'store_key must map to the executor column store');
assert.equal(candidateRow.spu, 'SPU-5110');
assert.equal(candidateRow.current_status, '已上架', 'shelf_status_name must map to current_status');
assert.equal(candidateRow.c7_exposure, 1, 'c7_eps_uv must map to c7_exposure');
assert.equal(candidateRow.c7_sale_cnt, 0);
assert.equal(candidateRow.new_tag_value, '', 'server-verified empty newGoodsTag must not leak a fake tag value');
assert.equal(candidateRow.first_shelf_time, '2026-01-11 13:22:45');

console.log(JSON.stringify({ok: true, outDir, jsonOutDir, realJsonOutDir, counts: parsed.counts}, null, 2));
