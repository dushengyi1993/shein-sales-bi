#!/usr/bin/env node
/**
 * Build and apply the new-listing 7-day limited-discount fallback plan.
 *
 * This is the write-side companion for build_marketing_daily_guard_report.mjs.
 * It is intentionally fail-closed: every store is dry-run first; only a clean
 * dry-run is executed. Mixed/unsafe existing limited-discount activities,
 * platform blocks, login/identity failures, or query_goods errors are recorded
 * and not forced.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');

function parseArgs(argv) {
  const args = {
    date: '',
    guard: '',
    priceOverrides: '',
    currentMarketingLiveScan: '',
    outDir: DEFAULT_OUT_DIR,
    stores: [],
    dryRunOnly: false,
    skipBuild: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = String(argv[++i] || '').trim();
    else if (arg.startsWith('--date=')) args.date = String(arg.slice('--date='.length)).trim();
    else if (arg === '--guard') args.guard = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--guard=')) args.guard = path.resolve(ROOT, arg.slice('--guard='.length));
    else if (arg === '--price-overrides') args.priceOverrides = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--price-overrides=')) args.priceOverrides = path.resolve(ROOT, arg.slice('--price-overrides='.length));
    else if (arg === '--current-marketing-live-scan') args.currentMarketingLiveScan = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--current-marketing-live-scan=')) args.currentMarketingLiveScan = path.resolve(ROOT, arg.slice('--current-marketing-live-scan='.length));
    else if (arg === '--out-dir') args.outDir = path.resolve(ROOT, argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(ROOT, arg.slice('--out-dir='.length));
    else if (arg === '--stores') args.stores = splitCsv(argv[++i]).map(s => s.toUpperCase());
    else if (arg.startsWith('--stores=')) args.stores = splitCsv(arg.slice('--stores='.length)).map(s => s.toUpperCase());
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else if (arg === '--skip-build') args.skipBuild = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.date) args.date = inferDateFromPath(args.guard) || formatLocalDate(new Date());
  if (!args.guard) args.guard = path.join(ROOT, 'outputs', 'reports', `marketing-daily-guard-${args.date}.json`);
  return args;
}

function splitCsv(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function inferDateFromPath(value) {
  const match = String(value || '').match(/20\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function pathExists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function runCommand(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 900000;
  const startedAt = new Date().toISOString();
  return await new Promise(resolve => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ok: false, exitCode: null, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr, error: error.message});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, exitCode: code, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr});
    });
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(source.slice(start));
    } catch {
      // stdout can contain nested JSON; keep scanning backwards.
    }
  }
  return null;
}

async function loadToolOutput(commandResult) {
  const parsed = parseLastJson(commandResult.stdout) || parseLastJson(commandResult.stderr);
  const outPath = parsed?.out ? path.resolve(ROOT, parsed.out) : '';
  const full = outPath && await pathExists(outPath) ? await readJson(outPath) : null;
  return {...commandResult, parsed, outPath, full};
}

function summarizeRaw(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout ? result.stdout.slice(-4000) : '',
    stderr: result.stderr ? result.stderr.slice(-4000) : '',
    error: result.error || '',
  };
}

function storeConfigByKey() {
  const doc = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  return new Map((doc.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => [String(store.storeKey || '').toUpperCase(), store]));
}

async function launchStore(storeKey) {
  return await runCommand(process.execPath, ['scripts/launch_store_browser.mjs', storeKey, '--headless'], {timeoutMs: 45000});
}

async function closeStore(storeKey) {
  return await runCommand(
    process.execPath,
    ['scripts/cleanup_shein_store_browsers.mjs', '--store', storeKey, '--cleanup-chrome-tmp', '--kill-after-sec', '5'],
    {timeoutMs: 90000},
  );
}

async function applyRescue({storeKey, port, rescuePath, execute}) {
  const result = await runCommand(process.execPath, [
    'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
    '--store-key',
    storeKey,
    '--port',
    String(port),
    '--rescue',
    rescuePath,
    execute ? '--execute' : '--dry-run',
  ], {timeoutMs: execute ? 1200000 : 900000});
  return await loadToolOutput(result);
}

async function buildPlan(args, guard) {
  const priceOverrides = args.priceOverrides || path.resolve(ROOT, guard?.targetPlanSelection?.priceOverrides || '');
  const liveScan = args.currentMarketingLiveScan
    || path.resolve(ROOT, guard?.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.liveLimitedDiscountSource || '');
  if (!priceOverrides || !fsSync.existsSync(priceOverrides)) throw new Error(`price-overrides file not found: ${priceOverrides || '(empty)'}`);
  const buildArgs = [
    'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
    '--date',
    args.date,
    '--price-overrides',
    priceOverrides,
  ];
  if (liveScan && fsSync.existsSync(liveScan)) buildArgs.push('--current-marketing-live-scan', liveScan);
  const build = await runCommand(process.execPath, buildArgs, {timeoutMs: 300000});
  const loaded = await loadToolOutput(build);
  if (!build.ok) throw new Error(`build_new_listing_limited_discount_plan failed: ${build.stderr || build.stdout || build.error || ''}`);
  const planPath = loaded.parsed?.reportJson ? path.resolve(ROOT, loaded.parsed.reportJson) : path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${args.date}.json`);
  return {command: buildArgs, result: summarizeRaw(build), planPath};
}

function classifyBlockedDryRun(full) {
  const reason = full?.reason || full?.parsed?.reason || '';
  const unsafe = Array.isArray(full?.unsafeExistingLimitedDiscounts) ? full.unsafeExistingLimitedDiscounts : [];
  const invalid = Array.isArray(full?.validation?.invalid) ? full.validation.invalid : [];
  const skipped = Array.isArray(full?.skippedUnreportable) ? full.skippedUnreportable : [];
  const platformCodes = [...new Set([
    ...invalid.map(row => row.error_code || row.code || '').filter(Boolean),
    ...skipped.flatMap(row => (row.reasons || []).map(r => r.error_code || r.code || '')).filter(Boolean),
  ])];
  if (unsafe.length) return {type: 'unsafe_existing_limited_discount', reason, unsafeExistingLimitedDiscounts: unsafe};
  if (platformCodes.length || invalid.length || skipped.length) return {type: 'platform_or_inventory_blocked', reason, platformCodes, invalid, skipped};
  return {type: 'dry_run_not_ok', reason};
}

async function processStore({file, storeMap, args}) {
  const storeKey = String(file.storeKey || '').toUpperCase();
  const store = storeMap.get(storeKey);
  const rescuePath = path.resolve(ROOT, file.path || '');
  const record = {
    storeKey,
    rescuePath: rel(rescuePath),
    targetCount: Number(file.count || 0),
    launched: null,
    dryRun: null,
    execute: null,
    close: null,
    ok: false,
    status: 'pending',
    createdActivityId: null,
    targetSkcs: [],
    blocked: null,
    error: '',
  };
  try {
    if (!store) throw new Error(`Unknown or disabled store: ${storeKey}`);
    const rescue = await readJson(rescuePath);
    record.targetSkcs = (rescue.rows || []).map(row => String(row.skc || '').trim()).filter(Boolean);
    record.launched = summarizeRaw(await launchStore(storeKey));
    if (!record.launched.ok) throw new Error(`launch_store_browser failed for ${storeKey}: ${record.launched.stderr || record.launched.stdout || record.launched.error}`);
    const dryRun = await applyRescue({storeKey, port: store.port, rescuePath, execute: false});
    record.dryRun = {
      ...summarizeRaw(dryRun),
      out: dryRun.outPath ? rel(dryRun.outPath) : '',
      parsed: dryRun.parsed || null,
      result: dryRun.full ? {
        ok: dryRun.full.ok,
        reason: dryRun.full.reason || '',
        targetCount: dryRun.full.targetCount,
        validation: dryRun.full.validation || null,
        unsafeExistingLimitedDiscounts: dryRun.full.unsafeExistingLimitedDiscounts || [],
      } : null,
    };
    if (!dryRun.full) {
      throw new Error(`dry-run did not produce a readable result for ${storeKey}: ${dryRun.stderr || dryRun.stdout || dryRun.error || ''}`);
    }
    if (!dryRun.full?.ok) {
      record.blocked = classifyBlockedDryRun(dryRun.full || dryRun.parsed || {});
      record.status = record.blocked.type;
      record.ok = true;
      return record;
    }
    if (args.dryRunOnly) {
      record.status = 'dry_run_ok';
      record.ok = true;
      return record;
    }
    const execute = await applyRescue({storeKey, port: store.port, rescuePath, execute: true});
    record.execute = {
      ...summarizeRaw(execute),
      out: execute.outPath ? rel(execute.outPath) : '',
      parsed: execute.parsed || null,
      result: execute.full ? {
        ok: execute.full.ok,
        reason: execute.full.reason || '',
        targetCount: execute.full.targetCount,
        targetCountForCreate: execute.full.targetCountForCreate,
        createdActivityId: execute.full.createdActivityId,
        endedActivities: execute.full.endedActivities || [],
        skippedUnreportable: execute.full.skippedUnreportable || [],
        after: execute.full.after ? {
          overlapSkcCount: execute.full.after.overlapSkcCount,
          duplicateOverlapSkcs: execute.full.after.duplicateOverlapSkcs || [],
          uncoveredAfter: execute.full.after.uncoveredAfter || [],
          unexpectedUncoveredAfter: execute.full.after.unexpectedUncoveredAfter || [],
        } : null,
      } : null,
    };
    if (!execute.full?.ok) throw new Error(`execute/readback failed for ${storeKey}: ${execute.full?.reason || execute.stderr || execute.stdout || execute.error || ''}`);
    record.createdActivityId = execute.full.createdActivityId || null;
    record.status = 'executed';
    record.ok = true;
    return record;
  } catch (error) {
    record.ok = false;
    record.status = 'failed';
    record.error = error.message;
    return record;
  } finally {
    record.close = summarizeRaw(await closeStore(storeKey));
  }
}

function summarizeTotals(results, plan) {
  const executed = results.filter(row => row.status === 'executed');
  const dryRunOk = results.filter(row => row.status === 'dry_run_ok');
  const blocked = results.filter(row => row.ok && row.blocked);
  const failed = results.filter(row => !row.ok);
  return {
    planActionable: Number(plan?.totals?.actionable || 0),
    planCreateLimitedDiscount: Number(plan?.totals?.createLimitedDiscount || 0),
    planReplaceExistingLimitedDiscount: Number(plan?.totals?.replaceExistingLimitedDiscount || 0),
    storesProcessed: results.length,
    storesExecuted: executed.length,
    storesDryRunOnlyOk: dryRunOk.length,
    storesBlocked: blocked.length,
    storesFailed: failed.length,
    executedTargetCount: executed.reduce((sum, row) => sum + Number(row.execute?.result?.targetCountForCreate ?? row.execute?.result?.targetCount ?? row.targetCount ?? 0), 0),
    blockedTargetCount: blocked.reduce((sum, row) => sum + Number(row.targetCount || 0), 0),
    failedTargetCount: failed.reduce((sum, row) => sum + Number(row.targetCount || 0), 0),
    createdActivities: executed.map(row => ({storeKey: row.storeKey, activityId: row.createdActivityId, targetCount: row.execute?.result?.targetCountForCreate ?? row.targetCount})),
    blockedByType: blocked.reduce((acc, row) => {
      const key = row.blocked?.type || 'blocked';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

function buildMarkdown(doc) {
  const lines = [];
  lines.push(`# 新上架 7 天限时折扣自动执行 ${doc.date}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 计划可处理 ${doc.totals.planActionable} 个链接；本次实际新建/重建 ${doc.totals.executedTargetCount} 个。`);
  lines.push(`- 平台/库存/混合旧活动阻断 ${doc.totals.blockedTargetCount} 个；异常失败 ${doc.totals.failedTargetCount} 个。`);
  lines.push(`- dry-run-only=${doc.dryRunOnly ? '是' : '否'}；所有店铺执行后均调用浏览器清理。`);
  lines.push('');
  lines.push('## 已执行');
  for (const item of doc.totals.createdActivities) {
    lines.push(`- ${item.storeKey}: 活动 ${item.activityId || '(未返回)'}，${item.targetCount} 个 SKC`);
  }
  if (!doc.totals.createdActivities.length) lines.push('- 无。');
  const blocked = doc.results.filter(row => row.blocked);
  if (blocked.length) {
    lines.push('');
    lines.push('## 阻断');
    for (const row of blocked) {
      lines.push(`- ${row.storeKey}: ${row.targetCount} 个，${row.blocked.type}，${row.blocked.reason || ''}`);
    }
  }
  const failed = doc.results.filter(row => !row.ok);
  if (failed.length) {
    lines.push('');
    lines.push('## 异常失败');
    for (const row of failed) lines.push(`- ${row.storeKey}: ${row.error}`);
  }
  lines.push('');
  lines.push('## 文件');
  lines.push(`- 执行 JSON：\`${doc.outputJson}\``);
  lines.push(`- 计划 JSON：\`${doc.planPath}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.outDir, {recursive: true});
await fs.mkdir(path.join(ROOT, 'outputs', 'reports'), {recursive: true});
if (!fsSync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
const guard = await readJson(args.guard);
let build = null;
if (!args.skipBuild) build = await buildPlan(args, guard);
const planPath = build?.planPath || path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${args.date}.json`);
if (!fsSync.existsSync(planPath)) throw new Error(`New-listing plan does not exist: ${planPath}`);
const plan = await readJson(planPath);
const storesFilter = new Set(args.stores || []);
const rescueFiles = (plan.rescueFiles || [])
  .filter(file => file?.path && Number(file.count || 0) > 0)
  .filter(file => !storesFilter.size || storesFilter.has(String(file.storeKey || '').toUpperCase()));
const storeMap = storeConfigByKey();
const results = [];
for (const file of rescueFiles) {
  results.push(await processStore({file, storeMap, args}));
}
const outputJson = path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${args.date}.json`);
const outputMd = path.join(ROOT, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${args.date}.md`);
const doc = {
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  date: args.date,
  dryRunOnly: args.dryRunOnly,
  guard: rel(args.guard),
  build,
  planPath: rel(planPath),
  planTotals: plan.totals || null,
  rescueFiles,
  totals: null,
  results,
  outputJson: rel(outputJson),
  outputMd: rel(outputMd),
};
doc.totals = summarizeTotals(results, plan);
await fs.writeFile(outputJson, JSON.stringify(doc, null, 2), 'utf8');
await fs.writeFile(outputMd, buildMarkdown(doc), 'utf8');
console.log(JSON.stringify({
  ok: doc.totals.storesFailed === 0,
  out: rel(outputJson),
  md: rel(outputMd),
  totals: doc.totals,
}, null, 2));
if (doc.totals.storesFailed > 0) process.exitCode = 2;
