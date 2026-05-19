#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {
  buildProductDraftFromSnapshots,
  inferSourceProductFromTask,
  summarizeDraftForExecutor,
} from '../lib/link_ops_product_draft_mapper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'link-ops-product-drafts');

function parseArgs(argv) {
  const args = {
    sourceStore: '',
    sourceSkc: '',
    date: 'latest',
    targetStore: 'HL',
    stockQty: 100,
    out: '',
    outDir: DEFAULT_OUT_DIR,
    taskFile: DEFAULT_TASK_FILE,
    taskId: '',
    taskJson: '',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-store') args.sourceStore = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--source-skc') args.sourceSkc = String(argv[++i] || '').trim();
    else if (a === '--date') args.date = String(argv[++i] || '').trim() || 'latest';
    else if (a === '--target-store') args.targetStore = String(argv[++i] || '').trim().toUpperCase() || 'HL';
    else if (a === '--stock-qty') args.stockQty = Number(argv[++i] || 100);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--task-file') args.taskFile = path.resolve(argv[++i]);
    else if (a === '--task-id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--task-json') args.taskJson = path.resolve(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/link_ops_build_product_draft_from_webapi.mjs --source-store DL --source-skc sv260315124105439111444 [--date latest]
  node scripts/link_ops_build_product_draft_from_webapi.mjs --task-json task.json

用途：
  从源店链接/WebAPI 快照生成 canonical product draft 与 HL OpenAPI publishOrEdit payload 草稿。
  该脚本不会写 SHEIN 后台；缺少属性、尺寸、成本、仓库等字段时会列出 blockers。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function isoStamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function normalizeTaskStore(data) {
  if (Array.isArray(data?.tasks)) return data;
  if (data?.id) return {version: 1, updatedAt: null, tasks: [data]};
  throw new Error('Task JSON must be a task object or {tasks: [...]} store');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadTask(args) {
  const source = args.taskJson ? args.taskJson : args.taskFile;
  const store = normalizeTaskStore(await readJson(source));
  if (!args.taskId && store.tasks.length === 1) return store.tasks[0];
  const task = store.tasks.find(t => String(t?.id || '') === args.taskId);
  if (!task) throw new Error(`Task not found: ${args.taskId || '(missing --task-id)'}`);
  return task;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let sourceStore = args.sourceStore;
  let sourceSkc = args.sourceSkc;
  if ((!sourceStore || !sourceSkc) && (args.taskJson || args.taskId)) {
    const task = await loadTask(args);
    const inferred = inferSourceProductFromTask(task, {targetStore: args.targetStore});
    sourceStore ||= inferred.sourceStore;
    sourceSkc ||= inferred.sourceSkc;
  }
  if (!sourceStore) throw new Error('缺 --source-store，或任务里没有可推断的源店。');
  if (!sourceSkc) throw new Error('缺 --source-skc，或任务里没有可推断的源 SKC。');

  const result = await buildProductDraftFromSnapshots({
    sourceStore,
    sourceSkc,
    date: args.date,
    targetStore: args.targetStore,
    stockQty: args.stockQty,
  });
  const output = {
    ok: true,
    runId: `lpd_${isoStamp()}_${crypto.randomBytes(4).toString('hex')}`,
    state: result.readyForOpenApiSubmit ? 'ready_for_openapi_submit' : 'draft_generated_with_blockers',
    summary: summarizeDraftForExecutor(result),
    ...result,
  };
  const outPath = args.out || path.join(args.outDir, `${output.runId}.local.json`);
  await writeJson(outPath, output);
  output.savedTo = path.relative(ROOT, outPath).replace(/\\/g, '/');
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    ok: false,
    state: 'error',
    error: err?.stack || err?.message || String(err),
  }, null, 2));
  process.exit(1);
});
