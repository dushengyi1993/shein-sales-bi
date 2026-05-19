#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {buildProductDraftFromSnapshots} from '../lib/link_ops_product_draft_mapper.mjs';
import {
  buildProductMasterCandidateFromDraft,
  summarizeProductMasterCandidate,
} from '../lib/shein_product_master.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'product-master-candidates');

function parseArgs(argv) {
  const args = {
    sourceStore: '',
    sourceSkc: '',
    date: 'latest',
    targetStore: 'HL',
    out: '',
    outDir: DEFAULT_OUT_DIR,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-store') args.sourceStore = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--source-skc') args.sourceSkc = String(argv[++i] || '').trim();
    else if (a === '--date') args.date = String(argv[++i] || '').trim() || 'latest';
    else if (a === '--target-store') args.targetStore = String(argv[++i] || '').trim().toUpperCase() || 'HL';
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/link_ops_build_product_master_candidate.mjs --source-store DL --source-skc sv260315124105439111444 [--date latest]

用途：
  从源店 WebAPI/链接快照生成“商品资料母库候选记录”。
  母库候选不保存图片；图片只在任务执行时作为临时素材复制、换链并清理。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.sourceStore) throw new Error('缺 --source-store。');
  if (!args.sourceSkc) throw new Error('缺 --source-skc。');
  return args;
}

function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const draftResult = await buildProductDraftFromSnapshots({
    sourceStore: args.sourceStore,
    sourceSkc: args.sourceSkc,
    date: args.date,
    targetStore: args.targetStore,
  });
  const candidate = buildProductMasterCandidateFromDraft(draftResult);
  const output = {
    ok: true,
    runId: `pmc_${stamp()}_${crypto.randomBytes(4).toString('hex')}`,
    sourceStore: args.sourceStore,
    sourceSkc: args.sourceSkc,
    sourceDate: draftResult.sourceDate,
    state: candidate.reviewStatus === 'ready_candidate' ? 'candidate_ready' : 'candidate_needs_review',
    summary: summarizeProductMasterCandidate(candidate),
    candidate,
  };
  const outPath = args.out || path.join(args.outDir, `${output.runId}.local.json`);
  await writeJson(outPath, output);
  output.savedTo = path.relative(ROOT, outPath).replace(/\\/g, '/');
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, state: 'error', error: err?.stack || err?.message || String(err)}, null, 2));
  process.exit(1);
});
