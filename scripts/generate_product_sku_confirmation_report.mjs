#!/usr/bin/env node
/**
 * Generate a concise user-facing SKU confirmation report from
 * report_product_sku_candidates.mjs output.
 *
 * Usage:
 *   node scripts/generate_product_sku_confirmation_report.mjs --start 2025-09-01 --end 2026-04-26 --group DSY
 *   node scripts/generate_product_sku_confirmation_report.mjs --label 2025-09-01_to_2026-04-26
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const CATALOG_PATH = path.join(ROOT, 'config', 'product_catalog.json');

function parseArgs(argv) {
  const args = {group: 'DSY'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
  }
  if (args.month) args.label = args.month;
  if (!args.label && args.start && args.end) args.label = `${args.start}_to_${args.end}`;
  if (!args.label) throw new Error('Use --label, --month, or --start/--end');
  return args;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function aggregateByCanonical(rows) {
  const byCanonical = new Map();
  for (const r of rows) {
    if (!byCanonical.has(r.canonical)) {
      byCanonical.set(r.canonical, {
        canonical: r.canonical,
        qty: 0,
        salesSar: 0,
        stores: new Set(),
        firstDate: r.firstDate,
        lastDate: r.lastDate,
        cleaned: new Set(),
        matchedAliases: new Set(),
        examples: [],
        needsReview: false,
        reviewReasons: new Set(),
      });
    }
    const c = byCanonical.get(r.canonical);
    c.qty += Number(r.qty || 0);
    c.salesSar = round2(c.salesSar + Number(r.salesSar || 0));
    String(r.stores || '').split('|').filter(Boolean).forEach(s => c.stores.add(s));
    if (!c.firstDate || r.firstDate < c.firstDate) c.firstDate = r.firstDate;
    if (!c.lastDate || r.lastDate > c.lastDate) c.lastDate = r.lastDate;
    c.cleaned.add(r.cleaned);
    if (r.matchedAlias) c.matchedAliases.add(r.matchedAlias);
    c.needsReview ||= Boolean(r.needsReview);
    if (r.reviewReason) c.reviewReasons.add(r.reviewReason);
    for (const ex of r.examples || []) {
      if (c.examples.length < 3) c.examples.push(ex);
    }
  }
  return [...byCanonical.values()].map(c => ({
    canonical: c.canonical,
    qty: c.qty,
    salesSar: round2(c.salesSar),
    stores: [...c.stores].sort().join('|'),
    firstDate: c.firstDate,
    lastDate: c.lastDate,
    sourceValues: [...c.cleaned].sort().join(' | '),
    matchedAliases: [...c.matchedAliases].sort().join(' | '),
    needsReview: c.needsReview,
    reviewReasons: [...c.reviewReasons].join('|'),
    exampleRawGoodsSn: c.examples[0]?.rawGoodsSn || '',
    exampleTitle: c.examples[0]?.goodsTitle || '',
  }));
}

function buildAttention(report, canonicalRows) {
  const attention = [];
  for (const r of report.reviewRows || []) {
    attention.push({
      level: '待确认',
      item: r.cleaned || r.canonical || r.rawGoodsSn || '未知货号',
      detail: `销量 ${r.qty || 0}，销售额 ${round2(r.salesSar || 0)} SAR；原因：${r.reviewReason || '未匹配标准货号或别名'}`,
    });
  }
  // 如果关键项没有按用户最新口径落地，才提示；正常情况下不应出现。
  if (!canonicalRows.some(r => r.canonical === '2001胶囊咖啡机')) {
    attention.push({level: '异常', item: '2001胶囊咖啡机', detail: '用户已确认它是新标准货号，但本次扫描未归并到该标准货号。'});
  }
  if (canonicalRows.some(r => r.canonical === 'SK-3065蒸汽熨烫机')) {
    attention.push({level: '异常', item: 'SK-3065蒸汽熨烫机', detail: '用户已确认 3065/SK-3065 应并入 SK-GT-3065蒸汽熨烫机，但本次扫描仍存在旧 canonical。'});
  }
  return attention;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await readJson(path.join(REPORT_DIR, `product-sku-candidates-${args.label}.json`));
  const catalog = await readJson(CATALOG_PATH);
  const rows = report.rows || [];
  const canonicalRows = aggregateByCanonical(rows);

  const csvHeader = [
    'needsReview', 'reviewReasons', 'canonical', 'sourceValues', 'matchedAliases',
    'qty', 'salesSar', 'stores', 'firstDate', 'lastDate', 'exampleRawGoodsSn', 'exampleTitle',
  ];
  const sortedForCsv = [...canonicalRows].sort((a, b) =>
    Number(b.needsReview) - Number(a.needsReview) ||
    b.salesSar - a.salesSar ||
    a.canonical.localeCompare(b.canonical, 'zh-CN'));
  const mapCsv = [csvHeader.join(',')];
  for (const r of sortedForCsv) mapCsv.push(csvHeader.map(k => csvEscape(r[k])).join(','));

  const normalizedMapCsv = path.join(REPORT_DIR, `product-sku-normalized-map-${args.label}.csv`);
  await fs.writeFile(normalizedMapCsv, mapCsv.join('\n'), 'utf8');

  const attention = buildAttention(report, canonicalRows);
  const confirmedMappings = [
    ['1710', 'WK-1710-4手持搅拌器'],
    ['6810', 'SK-6810半自动意式咖啡机'],
    ['175', 'SK-JB-175离心式榨汁机'],
    ['便携式咖啡机', 'KF-JN-02便携咖啡机'],
    ['03012', 'SK-03012台式榨汁机'],
    ['185', 'SK-185台式榨汁机'],
    ['3065 / SK-3065蒸汽熨烫机 / SK-3065熨烫机 / MZ3065熨烫机', 'SK-GT-3065蒸汽熨烫机'],
    ['2001胶囊咖啡机 / 2001', '2001胶囊咖啡机（新标准货号）'],
  ];
  const top = [...canonicalRows]
    .sort((a, b) => b.salesSar - a.salesSar || a.canonical.localeCompare(b.canonical, 'zh-CN'))
    .slice(0, 15);

  const matchedCount = rows.length - (report.reviewRows || []).length;
  const validationPath = path.join(REPORT_DIR, 'history-product-vs-store-validation.json');
  let validationOk = null;
  try {
    const validation = await readJson(validationPath);
    validationOk = Boolean(validation.ok);
  } catch {}

  const md = [];
  md.push(`# ${args.group} 产品货号确认报告（${args.label}）`);
  md.push('');
  md.push(`生成时间：${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}（北京时间）`);
  md.push('');
  md.push('## 结论');
  md.push('');
  md.push(`- 已加载标准货号：${(catalog.standards || []).length} 个；额外临时确认货号：${(catalog.extraConfirmedStandards || []).length} 个。`);
  md.push(`- 全量扫描 ${args.group} 历史订单后，原始/清洗货号组合：${rows.length} 个；已通过别名或标准清单归并：${matchedCount} 个。`);
  md.push(`- 待确认项：${(report.reviewRows || []).length} 个。`);
  if (validationOk !== null) {
    md.push(`- 产品销售额与店铺日销逐月核对：${validationOk ? '通过，全部 0 差异' : '未通过，请查看校验文件'}（详见 \`outputs/reports/history-product-vs-store-validation.json\`）。`);
  }
  md.push('');
  md.push('## 已确认并落地的关键归并规则');
  md.push('');
  md.push('| 原货号/简称 | 当前归并到 |');
  md.push('|---|---|');
  for (const [a, b] of confirmedMappings) md.push(`| ${a} | ${b} |`);
  md.push('');
  md.push('## 仍需确认的项');
  md.push('');
  if (!attention.length) md.push('- 暂无。');
  for (const a of attention) md.push(`- **${a.level}：${a.item}**：${a.detail}`);
  md.push('');
  md.push('## 已归并后的产品汇总 Top 15（按销售额）');
  md.push('');
  md.push('| 产品货号 | 销量 | 销售额 SAR | 店铺 | 日期范围 |');
  md.push('|---|---:|---:|---|---|');
  for (const r of top) {
    md.push(`| ${r.canonical} | ${r.qty} | ${r.salesSar.toFixed(2)} | ${r.stores} | ${r.firstDate} ~ ${r.lastDate} |`);
  }
  md.push('');
  md.push('## 明细文件');
  md.push('');
  md.push(`- 全量归并明细 CSV：\`${path.relative(ROOT, normalizedMapCsv)}\``);
  md.push(`- SKU 扫描 JSON：\`outputs/reports/product-sku-candidates-${args.label}.json\``);
  md.push(`- 待确认 CSV：\`outputs/reports/product-sku-candidates-${args.label}.csv\``);
  md.push('');
  md.push('说明：全量归并明细里列出每个最终货号对应的历史原始货号、销量、销售额和示例标题；如果发现某一行不对，告诉我“把 A 改归到 B”，我会重刷受影响月份。');

  const markdown = path.join(REPORT_DIR, `product-sku-confirmation-${args.label}.md`);
  const json = path.join(REPORT_DIR, `product-sku-confirmation-${args.label}.json`);
  await fs.writeFile(markdown, md.join('\n'), 'utf8');
  await fs.writeFile(json, JSON.stringify({
    generatedAt: new Date().toISOString(),
    label: args.label,
    group: args.group,
    standardCount: (catalog.standards || []).length,
    extraConfirmedStandards: catalog.extraConfirmedStandards || [],
    totalRawRows: rows.length,
    reviewCount: (report.reviewRows || []).length,
    attention,
    normalizedMapCsv: path.relative(ROOT, normalizedMapCsv),
    markdown: path.relative(ROOT, markdown),
    topProducts: top,
  }, null, 2), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    label: args.label,
    reviewCount: (report.reviewRows || []).length,
    attentionCount: attention.length,
    markdown: path.relative(ROOT, markdown),
    normalizedMapCsv: path.relative(ROOT, normalizedMapCsv),
  }, null, 2));
}

await main();
