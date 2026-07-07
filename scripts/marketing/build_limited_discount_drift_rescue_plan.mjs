#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_GUARD = path.join(ROOT, 'outputs/reports/marketing-daily-guard-2026-07-05.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-fallback/target-price-drift-2026-07-05');
const DEFAULT_END_TIME = '2026-07-21 23:59:59';
const DEFAULT_ACTIVITY_NAME_PREFIX = '限时折扣目标价漂移修复';

function parseArgs(argv) {
  const args = {guard: DEFAULT_GUARD, outDir: DEFAULT_OUT_DIR, endTime: '', activityNamePrefix: DEFAULT_ACTIVITY_NAME_PREFIX, maxRows: 0};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (a.startsWith('--guard=')) args.guard = path.resolve(a.slice('--guard='.length));
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (a.startsWith('--out-dir=')) args.outDir = path.resolve(a.slice('--out-dir='.length));
    else if (a === '--end-time') args.endTime = String(argv[++i] || '');
    else if (a.startsWith('--end-time=')) args.endTime = String(a.slice('--end-time='.length));
    else if (a === '--activity-name-prefix') args.activityNamePrefix = String(argv[++i] || '');
    else if (a.startsWith('--activity-name-prefix=')) args.activityNamePrefix = String(a.slice('--activity-name-prefix='.length));
    else if (a === '--max-rows') args.maxRows = Number(argv[++i] || 0);
    else if (a.startsWith('--max-rows=')) args.maxRows = Number(a.slice('--max-rows='.length));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.guard) throw new Error('Missing --guard');
  if (!args.outDir) throw new Error('Missing --out-dir');
  return args;
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function ymdFromText(value) {
  const match = String(value || '').match(/20\d{6}/);
  return match ? match[0] : '';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function groupKey(row) {
  return [
    row.storeKey,
    row.limitedDiscountName || '',
    row.limitedDiscountEnd || '',
  ].join('::');
}

function normalizeRow(row) {
  const finalTargetPrice = num(row.finalTargetPrice);
  const limitedDiscountPrice = finalTargetPrice;
  return {
    storeKey: row.storeKey,
    skc: row.skc,
    canonical: row.canonical || '',
    supplierNo: row.canonical || row.supplierNo || '',
    currentPrice: null,
    finalTargetPrice,
    targetPrice: finalTargetPrice,
    needsLimitedDiscount: true,
    limitedDiscountPrice,
    previousLimitedPrice: num(row.limitedDiscountPrice),
    previousDeltaSar: num(row.deltaSar),
    sourceRule: 'limited_discount_target_price_drift_current_window_target',
    targetPriceSource: row.targetPriceSource || '',
    priceSourceActivityId: row.activityId || '',
    sourceLimitedDiscountName: row.limitedDiscountName || '',
    sourceLimitedDiscountStart: row.limitedDiscountStart || '',
    sourceLimitedDiscountEnd: row.limitedDiscountEnd || '',
    note: 'live 限时折扣价低于当前窗口 finalTargetPrice；修正价直接兜到当前链接+窗口目标价，不使用机械15%。',
  };
}

async function writeJson(file, obj) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export function buildLimitedDiscountDriftRescuePlan(guard, options = {}) {
  const rows = (guard.limitedDiscountTargetPriceDrift?.belowRows || [])
    .filter(row => row && row.storeKey && row.skc)
    .filter(row => num(row.finalTargetPrice) !== null)
    .filter(row => num(row.limitedDiscountPrice) !== null)
    .filter(row => num(row.limitedDiscountPrice) < num(row.finalTargetPrice) - 0.01);
  const selectedRows = Number(options.maxRows || 0) > 0 ? rows.slice(0, Number(options.maxRows)) : rows;
  const groups = new Map();
  for (const row of selectedRows) {
    const key = groupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        storeKey: row.storeKey,
        limitedDiscountName: row.limitedDiscountName || '',
        limitedDiscountNameDate: ymdFromText(row.limitedDiscountName),
        limitedDiscountEnd: row.limitedDiscountEnd || '',
        activityId: row.activityId || '',
        rows: [],
      });
    }
    groups.get(key).rows.push(normalizeRow(row));
  }
  const byStore = {};
  const rescueFiles = [];
  for (const group of groups.values()) {
    byStore[group.storeKey] = (byStore[group.storeKey] || 0) + group.rows.length;
  }
  return {
    createdAt: new Date().toISOString(),
    reportDate: guard.reportDate || '',
    sourceGuard: options.guardPath || '',
    sourceLiveScan: guard.limitedDiscountTargetPriceDrift?.source || '',
    sourcePriceOverrides: guard.limitedDiscountTargetPriceDrift?.planSourcePath || '',
    rule: '修正 live 限时折扣价低于当前窗口 finalTargetPrice 的行；单一目标活动可用 apply_hl_limited_discount_rescue dry-run/execute，混合活动由脚本 fail-closed 后再 split-preserve。',
    totals: {
      belowTarget: rows.length,
      selected: selectedRows.length,
      groups: groups.size,
      stores: Object.keys(byStore).length,
    },
    byStore,
    groups: [...groups.values()].sort((a, b) => a.storeKey.localeCompare(b.storeKey) || String(a.limitedDiscountName).localeCompare(String(b.limitedDiscountName))),
    rescueFiles,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const guard = JSON.parse(await fs.readFile(args.guard, 'utf8'));
  const endTime = args.endTime || DEFAULT_END_TIME;
  const plan = buildLimitedDiscountDriftRescuePlan(guard, {guardPath: rel(args.guard), maxRows: args.maxRows});
  await fs.mkdir(args.outDir, {recursive: true});
  for (const group of plan.groups) {
    const safeName = String(group.limitedDiscountNameDate || 'unknown');
    const file = path.join(args.outDir, `limited-drift-rescue-${group.storeKey}-${safeName}-${plan.reportDate || 'unknown'}.json`);
    const rescue = {
      createdAt: plan.createdAt,
      storeKey: group.storeKey,
      purpose: `limited_discount_target_price_drift_rescue_${plan.reportDate || ''}`,
      sourceGuard: plan.sourceGuard,
      sourceLiveScan: plan.sourceLiveScan,
      sourcePriceOverrides: plan.sourcePriceOverrides,
      sourceLimitedDiscountName: group.limitedDiscountName,
      sourceLimitedDiscountEnd: group.limitedDiscountEnd,
      endTime,
      activityNamePrefix: args.activityNamePrefix,
      rows: group.rows,
    };
    await writeJson(file, rescue);
    plan.rescueFiles.push({
      storeKey: group.storeKey,
      path: rel(file),
      count: group.rows.length,
      sourceLimitedDiscountName: group.limitedDiscountName,
      sourceLimitedDiscountEnd: group.limitedDiscountEnd,
    });
  }
  const jsonPath = path.join(args.outDir, `limited-discount-target-drift-rescue-plan-${plan.reportDate || 'unknown'}.json`);
  await writeJson(jsonPath, plan);
  const mdPath = path.join(args.outDir, `limited-discount-target-drift-rescue-plan-${plan.reportDate || 'unknown'}.md`);
  const lines = [
    `# ${plan.reportDate || ''} 限时折扣目标价漂移修正计划`,
    '',
    `- belowTarget: ${plan.totals.belowTarget}`,
    `- selected: ${plan.totals.selected}`,
    `- groups: ${plan.totals.groups}`,
    `- stores: ${plan.totals.stores}`,
    '',
    '## rescue files',
    ...plan.rescueFiles.map(file => `- ${file.storeKey} ${file.sourceLimitedDiscountName}: ${file.count} 行，${file.path}`),
    '',
    '执行边界：先 dry-run；单一目标活动安全通过后才 execute；混合/计划外/人工特殊价由 apply 脚本 fail-closed 后再走 split-preserve。',
  ];
  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify({ok: true, json: rel(jsonPath), md: rel(mdPath), rescueFiles: plan.rescueFiles.length, rows: plan.totals.selected}, null, 2));
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('build_limited_discount_drift_rescue_plan.mjs')) {
  await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
