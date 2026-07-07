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
    suggested_waste_goods_sn: '（废）SK-15013卷发钳和卷发棒',
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
assert.equal(parsed.counts.inputRows, 4);
assert.equal(parsed.counts.candidateRows, 1);
assert.equal(parsed.counts.excludedByFirstShelf15d, 2);
assert.equal(parsed.counts.excludedByNewGoodsTag, 1);
for (const check of parsed.targetSkcCheck) {
  assert.equal(check.presentInCandidates, false, check.skc);
  assert.equal(check.bucket, 'excludedByFirstShelf15d', check.skc);
}
const bundle = JSON.parse(await fs.readFile(parsed.outJson, 'utf8'));
assert.deepEqual(bundle.rows.map(r => r.skc), ['sv-old-safe']);

console.log(JSON.stringify({ok: true, outDir, counts: parsed.counts}, null, 2));
