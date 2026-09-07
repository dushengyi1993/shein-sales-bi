import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {classifyEvidence,shiftDate} from '../lib/link_retire_review_evidence.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(SCRIPT_DIR, '..');
const BUILDER = path.join(SCRIPT_DIR, 'build_link_retire_review_workbook.mjs');
const TEST_ROOT = path.join(REPO_DIR, 'outputs', 'v7-retire-workbook-dev');

function parseArgs(argv) {
  let artifactToolEntry = process.env.ARTIFACT_TOOL_ENTRY || '';
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--artifact-tool-entry' || raw === '--artifactToolEntry') {
      artifactToolEntry = argv[++index] || '';
      continue;
    }
    if (raw.startsWith('--artifact-tool-entry=')) {
      artifactToolEntry = raw.slice('--artifact-tool-entry='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${raw}`);
  }
  if (!artifactToolEntry) {
    throw new Error('Pass --artifact-tool-entry <path-to-artifact_tool.mjs> or set ARTIFACT_TOOL_ENTRY');
  }
  return artifactToolEntry;
}

function artifactToolCandidates(configuredPath) {
  const resolved = path.resolve(configuredPath);
  const candidates = [resolved];
  let isDirectory = false;
  try {
    isDirectory = fssync.statSync(resolved).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (isDirectory) {
    candidates.push(
      path.join(resolved, 'dist', 'artifact_tool.mjs'),
      path.join(resolved, 'artifact_tool.mjs'),
      path.join(resolved, '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs'),
      path.join(resolved, 'node_modules', '@oai', 'artifact-tool', 'dist', 'artifact_tool.mjs'),
    );
  }
  return [...new Set(candidates)];
}

async function loadArtifactTool(configuredPath) {
  const entry = artifactToolCandidates(configuredPath).find(candidate => fssync.existsSync(candidate));
  if (!entry) throw new Error(`@oai/artifact-tool entry not found under: ${path.resolve(configuredPath)}`);
  return import(pathToFileURL(entry).href);
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_DIR, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function assertBlank(value, message) {
  assert.ok(value === null || value === undefined || value === '', message);
}

function findHeaderRow(values, headerKey = 'source_row_index') {
  const rowIndex = values.findIndex(row => row.includes(headerKey));
  assert.ok(rowIndex >= 0, `table header with ${headerKey} must exist`);
  return rowIndex;
}

function rowObjects(values, headerKey = 'source_row_index') {
  const labels={'来源行号':'source_row_index','SKC':'skc','店铺标识':'store','近7天曝光':'c7_exposure','缺失库存日期列表':'missing_inventory_dates','缺失状态日期列表':'missing_status_dates','证据问题列表':'evidence_issues','输入候选分组':'retire_candidate_bucket','输入候选原因':'retire_candidate_reason','当前库存':'current_inventory'};
  values=values.map(row=>row.map(v=>labels[v] || v));
  const headerIndex = findHeaderRow(values, headerKey);
  const headers = values[headerIndex];
  const rows = values.slice(headerIndex + 1).filter(row => row.some(value => value !== null && value !== undefined && value !== ''));
  return {
    headers,
    rows: rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]]))),
  };
}

function getByKey(rows, key, expected) {
  const row = rows.find(entry => entry[key] === expected);
  assert.ok(row, `row ${key}=${expected} must exist`);
  return row;
}

function syntheticDocument() {
  return {
    summary: {
      runDate: '2026-09-07',
      performanceDate: '2026-09-06',
      querySha256: 'synthetic-query-sha256',
      evidenceSha256: 'synthetic-evidence-sha256',
      fingerprint: 'synthetic-fingerprint-v7',
      protectionReferenceDate: '2026-09-07',
      counts: {
        inputRows: 3,
        basePool: 2,
        candidates: 1,
        pending: 1,
        excluded: 1,
      },
      source: {
        kind: 'synthetic fixture',
        sections: ['linksData', 'inventory', 'statusHistory'],
      },
    },
    evaluated: [
      {
        store: 'JSH',
        skc: 'SKC-CANDIDATE',
        standard_goods_sn: 'SK-001',
        current_status: '已上架',
        c7_exposure: 100,
        c7_sale_cnt: 0,
        c30_sale_cnt: 0,
        new_goods_tag: '',
        first_shelf_time: '2026-07-01T08:30:00',
        inventory_recovery_date: null,
        relisted_at: null,
        last_shelf_time: '2026-07-01',
        current_inventory: 10,
        marketing_effective: false,
        retire_candidate_bucket: 'candidate',
        retire_candidate_reason: 'synthetic candidate row',
        missing_inventory_dates: [],
        missing_status_dates: [],
        evidence_issues: [],
        nested_evidence: { source: 'fixture', values: [1, 2, 3] },
      },
      {
        store: 'DL',
        skc: 'SKC-PENDING',
        standard_goods_sn: 'SK-002',
        current_status: 'unknown',
        c7_exposure: null,
        c7_sale_cnt: null,
        c30_sale_cnt: 1,
        new_goods_tag: null,
        first_shelf_time: null,
        inventory_recovery_date: null,
        relisted_at: '2026-09-05',
        last_shelf_time: null,
        current_inventory: 0,
        marketing_effective: true,
        retire_candidate_bucket: 'cannotJudge',
        retire_candidate_reason: 'missing source dates',
        missing_inventory_dates: ['2026-09-01'],
        missing_status_dates: ['2026-09-02', '2026-09-03'],
        evidence_issues: ['missing_inventory_dates', 'missing_status_dates'],
        nested_evidence: { source: 'fixture', missing: true },
      },
      {
        store: 'TZZ',
        skc: 'SKC-EXCLUDED',
        standard_goods_sn: 'SK-003',
        current_status: 'off_shelf',
        c7_exposure: 4,
        c7_sale_cnt: 0,
        c30_sale_cnt: 0,
        new_goods_tag: 'new',
        first_shelf_time: '2026-08-28',
        inventory_recovery_date: null,
        relisted_at: null,
        last_shelf_time: '2026-08-28',
        current_inventory: 0,
        marketing_effective: false,
        retire_candidate_bucket: 'excludedByPolicy',
        retire_candidate_reason: 'recent first shelf',
        missing_inventory_dates: [],
        missing_status_dates: [],
        evidence_issues: [],
        nested_evidence: { source: 'fixture', policy: 'new_listing_protection' },
      },
    ],
  };
}

async function main() {
  const artifactToolEntry = parseArgs(process.argv.slice(2));
  const runDir = path.join(TEST_ROOT, `run-${Date.now()}-${process.pid}`);
  const inputPath = path.join(runDir, 'analysis.json');
  const outputPath = path.join(runDir, 'review.xlsx');
  const qaDir = path.join(runDir, 'qa');
  const document = syntheticDocument();
  // Exercise the actual producer before the builder; candidates need complete
  // evidence, while missing values are tested on the pending sheet below.
  const runDate=document.summary.runDate,performanceDate=document.summary.performanceDate,querySha256='a'.repeat(64);
  const pool=[{store_key:'JSH',skc:'SKC-CANDIDATE',spu:'SPU1',standard_goods_sn:'SK-001',c7_eps_uv:100,c7_sale_cnt:0}];
  const evidence={schemaVersion:'link-retire-evidence/v1',host:'shein-bi-tencent',runDate,performanceDate,querySha256,generatedAt:'2026-09-07T05:00:00Z',sources:[],rows:[{
    store_key:'JSH',skc:'SKC-CANDIDATE',performance:{found:true,date:performanceDate,newTagPresent:true,newTag:'',sales7:0,exposure7:100},openapiCount:1,
    openapi:{found:true,spu:'SPU1',status:'已上架',firstShelf:'2026-07-01',lastShelf:'2026-07-01',fetchedAt:runDate,inventory:10},
    inventory:Array.from({length:15},(_,i)=>({date:shiftDate(runDate,i-15),usable:10})),
    statusHistory:Array.from({length:15},(_,i)=>({date:shiftDate(runDate,i-15),isOnShelf:true})),
    marketing:{covered:true,sourceAt:runDate,matches:[]},historyIssues:[],
  }]};
  document.evaluated[0]=classifyEvidence(pool,evidence,{runDate,performanceDate,querySha256})[0];
  assert.equal(document.evaluated[0].retire_candidate_bucket,'candidate');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(inputPath, JSON.stringify(document, null, 2), 'utf8');

  const built = await runNode([
    BUILDER,
    '--input', inputPath,
    '--output', outputPath,
    '--qa-dir', qaDir,
    '--artifact-tool-entry', artifactToolEntry,
  ]);
  assert.equal(built.code, 0, `builder failed:\nstdout=${built.stdout}\nstderr=${built.stderr}`);
  assert.match(built.stdout, /"ok": true/);

  const manifestPath = `${outputPath}.manifest.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.analysisSha256, await sha256File(inputPath));
  assert.equal(manifest.workbookSha256, await sha256File(outputPath));
  assert.equal(manifest.fingerprint, document.summary.fingerprint);
  assert.equal(manifest.protectionReferenceDate, document.summary.runDate);
  assert.deepEqual(manifest.counts, document.summary.counts);

  const { FileBlob, SpreadsheetFile } = await loadArtifactTool(artifactToolEntry);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const summary = rowObjects(workbook.worksheets.getItem('来源摘要').getUsedRange().values, 'summary_key');
  const candidate = rowObjects(workbook.worksheets.getItem('审核清单').getUsedRange().values);
  const pending = rowObjects(workbook.worksheets.getItem('待确认').getUsedRange().values);
  const excluded = rowObjects(workbook.worksheets.getItem('排除复核').getUsedRange().values);
  const source = rowObjects(workbook.worksheets.getItem('来源数据').getUsedRange().values);

  assert.ok(candidate.headers.includes('审核决定'));
  assert.ok(!pending.headers.includes('审核决定'));
  assert.ok(!excluded.headers.includes('审核决定'));
  assert.equal(candidate.rows.length, 1);
  assert.equal(pending.rows.length, 1);
  assert.equal(excluded.rows.length, 1);
  assert.equal(source.rows.length, 3);

  const candidateRow = getByKey(candidate.rows, 'skc', 'SKC-CANDIDATE');
  assert.equal(candidateRow['审核决定'], '待确认');
  assert.equal(candidateRow.store, 'JSH');
  assert.equal(candidateRow.c7_exposure, 100);
  assert.equal(candidateRow.missing_inventory_dates, '[]');
  assert.equal(candidateRow.missing_status_dates, '[]');
  assert.equal(candidateRow.evidence_issues, '[]');

  const pendingRow = getByKey(pending.rows, 'skc', 'SKC-PENDING');
  assertBlank(pendingRow.c7_exposure, 'missing c7_exposure must remain blank');
  assert.equal(pendingRow.retire_candidate_bucket, 'cannotJudge');
  assert.match(pendingRow.missing_inventory_dates, /2026-09-01/);
  assert.match(pendingRow.missing_status_dates, /2026-09-03/);
  assert.equal(pendingRow.current_inventory, 0, 'real zero inventory must be preserved');

  const excludedRow = getByKey(excluded.rows, 'skc', 'SKC-EXCLUDED');
  assert.equal(excludedRow.retire_candidate_bucket, 'excludedByPolicy');
  assert.equal(excludedRow.retire_candidate_reason, 'recent first shelf');

  const sourceIndexes = source.rows.map(row => row.source_row_index);
  assert.deepEqual(sourceIndexes, [1, 2, 3]);
  const protectionRow = getByKey(summary.rows, 'summary_key', 'protectionReferenceDate');
  const runDateRow = getByKey(summary.rows, 'summary_key', 'runDate');
  assert.equal(protectionRow.summary_value, runDateRow.summary_value);
  const countRows = summary.rows.filter(row => ['inputRows', 'basePool', 'candidates', 'pending', 'excluded'].includes(row.summary_count_key));
  assert.equal(countRows.length, 5);
  assert.equal(getByKey(countRows, 'summary_count_key', 'candidates').summary_count_value, 1);

  const qaFiles = [
    'summary.png',
    'candidate-review.png',
    'cannot-judge.png',
    'excluded-review.png',
    'source-data.png',
    'summary.ndjson',
    'candidate-review.ndjson',
    'cannot-judge.ndjson',
    'excluded-review.ndjson',
    'source-data.ndjson',
    'formula-errors.ndjson',
    'qa-manifest.json',
  ];
  for (const fileName of qaFiles) {
    const filePath = path.join(qaDir, fileName);
    const stat = await fs.stat(filePath);
    assert.ok(stat.size > 0, `${fileName} must be non-empty`);
  }
  for (const fileName of ['summary.png', 'candidate-review.png', 'cannot-judge.png', 'excluded-review.png', 'source-data.png']) {
    const bytes = await fs.readFile(path.join(qaDir, fileName));
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${fileName} must be PNG`);
  }
  const formulaErrors = (await fs.readFile(path.join(qaDir, 'formula-errors.ndjson'), 'utf8')).trim();
  assert.ok(formulaErrors === '' || /Cell search matched 0 entries\./u.test(formulaErrors));
  const qaManifest = JSON.parse(await fs.readFile(path.join(qaDir, 'qa-manifest.json'), 'utf8'));
  assert.equal(qaManifest.formulaErrorScan, 'empty');

  const invalidArgs = await runNode([BUILDER, '--input', inputPath]);
  assert.notEqual(invalidArgs.code, 0);
  assert.match(`${invalidArgs.stdout}\n${invalidArgs.stderr}`, /Missing required argument: --output/);

  const result = {
    ok: true,
    runDir,
    outputPath,
    manifestPath,
    qaDir,
    rows: { candidate: candidate.rows.length, cannotJudge: pending.rows.length, other: excluded.rows.length, source: source.rows.length },
    checks: [
      'synthetic candidate/cannotJudge/other buckets preserved',
      'candidate-only audit decision validation surface',
      'missing values remain blank and real zero remains zero',
      'missing date/evidence arrays rendered as JSON strings',
      'XLSX import and PNG render QA',
      'analysis/workbook SHA256 manifest',
      'required CLI argument failure',
    ],
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`[test_link_retire_review_workbook] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
