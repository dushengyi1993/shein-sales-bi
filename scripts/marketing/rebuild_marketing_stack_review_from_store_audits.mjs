#!/usr/bin/env node
/**
 * Rebuild marketing stack review artifacts from per-store audit JSON files.
 *
 * This is useful when the scan must be performed in separate batches or when a
 * later retry for a failed store overwrote the date-level report. It only reads
 * local audit files and writes report artifacts; it does not open browsers or
 * call SHEIN APIs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const BI = JSON.parse(await fs.readFile(path.join(ROOT, 'outputs', 'bi-portal', 'data.json'), 'utf8'));
const COST_DOC = JSON.parse(await fs.readFile(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), 'utf8'));
const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));

async function main() {
const args = parseArgs(process.argv.slice(2));
const dateTag = args.date || formatDate(new Date());
const storeOrder = args.stores.length ? args.stores : storesConfig.stores.filter(s => s.enabled).map(s => s.storeKey);
const selectedStores = storesConfig.stores.filter(s => storeOrder.includes(s.storeKey));
const storeDocs = await loadStoreDocs(args.sourceDirs, storeOrder);
const detailRows = [];
const couponRows = [];
const storeStatuses = [];

for (const storeKey of storeOrder) {
  const doc = storeDocs.get(storeKey);
  if (!doc) {
    storeStatuses.push({storeKey, ok: false, rowCount: 0, couponCount: 0, issue: 'missing_store_audit'});
    continue;
  }
  const rows = doc.rows || [];
  const coupons = doc.couponSummaries || [];
  detailRows.push(...rows.map(stripRaw));
  couponRows.push(...coupons.map(stripRaw));
  const diag = (doc.activityFetchDiagnostics || []).map(x => [x.code, x.msg].filter(Boolean).join(' ')).filter(Boolean).join('；');
  storeStatuses.push({
    storeKey,
    ok: Boolean(doc.ok && rows.length > 0),
    rowCount: rows.length,
    couponCount: coupons.length,
    issue: rows.length ? '' : (diag || doc.error || 'no_rows'),
  });
}

const limitRows = buildLimitDiscountRows(BI);
const summaryRows = summarizeBySku(detailRows);
const base = path.join(OUT_DIR, `marketing-stack-review-${dateTag}`);
const files = {
  detailCsv: `${base}-detail.csv`,
  bySkuCsv: `${base}-by-sku.csv`,
  couponCsv: `${base}-coupon.csv`,
  limitDiscountCsv: `${base}-limit-discount-risk.csv`,
  md: `${base}.md`,
  json: `${base}.json`,
};

await fs.mkdir(OUT_DIR, {recursive: true});
await writeCsv(files.detailCsv, detailRows, DETAIL_HEADERS);
await writeCsv(files.bySkuCsv, summaryRows, SUMMARY_HEADERS);
await writeCsv(files.couponCsv, couponRows, COUPON_HEADERS);
await writeCsv(files.limitDiscountCsv, limitRows, LIMIT_HEADERS);
await fs.writeFile(files.json, JSON.stringify({
  createdAt: new Date().toISOString(),
  rebuiltFrom: args.sourceDirs.map(d => path.relative(ROOT, d)),
  source: {
    biGeneratedAt: BI.generatedAt || '',
    biLinkDate: BI.dates?.linkDate || '',
    biLinkUpdatedAt: BI.dates?.linkUpdatedAt || BI.dates?.linkWarehouseUpdatedAt || '',
    costSource: COST_DOC.source || '',
  },
  selectedStores: selectedStores.map(s => ({storeKey: s.storeKey, groupKey: s.groupKey, shopName: s.shopName})),
  storeStatuses,
  missingStores: storeStatuses.filter(s => !s.ok).map(s => s.storeKey),
  notes: [
    '本文件由分批只读扫描审计重建；未报名、未提交、未取消或调价限时折扣。',
    '缺失店铺的失败原因记录在 storeStatuses；未覆盖店铺不能视为已完成。',
  ],
  summaryRows,
  detailRows,
  couponRows,
  limitRows,
}, null, 2), 'utf8');
await fs.writeFile(files.md, renderMarkdown({dateTag, storeStatuses, summaryRows, detailRows, couponRows, limitRows, files}), 'utf8');

console.log(JSON.stringify({
  dateTag,
  stores: storeOrder.length,
  completedStores: storeStatuses.filter(s => s.ok).length,
  missingStores: storeStatuses.filter(s => !s.ok).map(s => ({storeKey: s.storeKey, issue: s.issue})),
  detailRows: detailRows.length,
  summaryRows: summaryRows.length,
  couponRows: couponRows.length,
  limitRows: limitRows.length,
  files,
}, null, 2));
}

function parseArgs(argv) {
  const out = {sourceDirs: [], stores: [], date: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source-dirs') out.sourceDirs = String(argv[++i] || '').split(',').map(s => path.resolve(ROOT, s.trim())).filter(Boolean);
    else if (a === '--stores') out.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--date') out.date = String(argv[++i] || '').trim();
  }
  if (!out.sourceDirs.length) throw new Error('Missing --source-dirs');
  return out;
}

async function loadStoreDocs(dirs, stores) {
  const docs = new Map();
  for (const dir of dirs) {
    for (const storeKey of stores) {
      const file = path.join(dir, `store-${storeKey}.json`);
      try {
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        docs.set(storeKey, doc);
      } catch {}
    }
  }
  return docs;
}

function stripRaw(row) {
  const out = {...row};
  delete out._raw;
  return out;
}

function buildLimitDiscountRows(bi) {
  const rows = [];
  const seen = new Set();
  for (const r of [...(bi.storeLinks || []), ...(bi.links || [])]) {
    const names = splitActivityNames(r.performance_activity_names || r.activity_names || r.activityNames || '').filter(x => /限时折扣/.test(x));
    if (!names.length) continue;
    const store = r.store_key || r.storeKey || '';
    const skc = r.skc || '';
    const standard = r.standard_goods_sn || r.standardGoodsSn || '';
    const key = `${store}__${skc}__${names.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      '店铺': store,
      'SKC': skc,
      '标准货号': standard,
      '限时折扣名称': names.join(' / '),
      '限时折扣价SAR': '',
      '来源': 'outputs/bi-portal/data.json performance_activity_names',
      '数据日期': r.link_date || bi.dates?.linkDate || '',
      '风险提示': '只读审核已发现限时折扣标签，但当前脚本未读取到限时折扣价；报名/用券前必须人工复核或专项扫描。',
      '修改意见/备注': '',
    });
  }
  return rows.sort((a, b) => String(a['店铺']).localeCompare(String(b['店铺'])) || String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));
}

function summarizeBySku(rows) {
  const bySku = new Map();
  for (const r of rows) {
    const key = r['标准货号'] || r['供方货号'] || r.SKC;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(r);
  }
  const out = [];
  for (const [sku, group] of bySku) {
    const stores = uniq(group.map(r => r['店铺'])).sort();
    const activities = uniq(group.map(r => r['活动ID'])).sort((a, b) => Number(a) - Number(b));
    const risks = uniq(group.flatMap(r => String(r['风险提示'] || '').split('；').filter(Boolean)));
    const margins = group.map(r => parsePct(r['含仓储费利润率'])).filter(v => v !== null);
    out.push({
      '标准货号': sku,
      '代表供方货号': mostCommon(group.map(r => r['供方货号'])),
      '适用店铺数': stores.length,
      '适用店铺': stores.join(','),
      '涉及活动数': activities.length,
      '活动ID': activities.join(','),
      '明细行数': group.length,
      '当前售价SAR范围': range(group.map(r => r['当前售价SAR']), 2),
      '商品完整成本SAR范围': range(group.map(r => r['商品完整成本SAR']), 2),
      '含仓储费成本SAR范围': range(group.map(r => r['含仓储费成本SAR']), 2),
      '建议普通活动价SAR范围': range(group.map(r => r['本次建议普通活动价SAR']), 2),
      '叠加后最终成交价SAR范围': range(group.map(r => r['叠加后最终成交价SAR']), 2),
      '最低含仓储费利润率': margins.length ? pct(Math.min(...margins)) : '',
      '限时折扣风险行数': group.filter(r => r['限时折扣名称']).length,
      '优惠券叠加风险行数': group.filter(r => r['优惠券活动ID/名称']).length,
      '高风险提示': risks.slice(0, 8).join('；') + (risks.length > 8 ? '；...' : ''),
      '修改意见/备注': '',
    });
  }
  return out.sort((a, b) => String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));
}

function renderMarkdown({dateTag, storeStatuses, summaryRows, detailRows, couponRows, limitRows, files}) {
  const completed = storeStatuses.filter(s => s.ok);
  const missing = storeStatuses.filter(s => !s.ok);
  const risky = detailRows.filter(r => r['风险提示']).length;
  const lowMargin = detailRows.filter(r => {
    const m = parsePct(r['含仓储费利润率']);
    return m !== null && m < 0.20;
  }).length;
  const missingCost = detailRows.filter(r => /成本缺失|仓储费缺失/.test(r['风险提示'] || '')).length;
  const previewHeaders = ['店铺','活动ID','标准货号','当前售价SAR','本次建议普通活动价SAR','优惠券券档/风险折扣','叠加后最终成交价SAR','含仓储费利润率','风险提示','修改意见/备注'];
  const topRiskRows = detailRows.filter(r => r['风险提示']).slice(0, 80);
  return [
    `# 19 店营销活动叠加安全审核（${dateTag}）`,
    '',
    '- 状态：只读扫描输出；未报名、未提交、未取消或调价限时折扣。',
    `- 当前覆盖：${completed.length}/${storeStatuses.length} 店`,
    `- 已覆盖店铺：${completed.map(s => s.storeKey).join(', ') || '-'}`,
    `- 未覆盖店铺：${missing.map(s => `${s.storeKey}（${s.issue}）`).join('；') || '无'}`,
    `- 明细行：${detailRows.length}`,
    `- 标准货号行：${summaryRows.length}`,
    `- 优惠券规则行：${couponRows.length}`,
    `- 限时折扣风险标签行：${limitRows.length}`,
    `- 有风险提示明细行：${risky}`,
    `- 含仓储费利润率低于 20% 行：${lowMargin}`,
    `- 缺成本/仓储费口径行：${missingCost}`,
    `- BI 数据时间：${BI.generatedAt || ''}`,
    `- 链接活动标签日期：${BI.dates?.linkDate || ''}`,
    `- 成本来源：${COST_DOC.source || ''}`,
    '',
    '## 文件',
    '',
    `- 明细审核表：\`${path.relative(ROOT, files.detailCsv)}\``,
    `- 按标准货号汇总：\`${path.relative(ROOT, files.bySkuCsv)}\``,
    `- 优惠券规则：\`${path.relative(ROOT, files.couponCsv)}\``,
    `- 限时折扣风险表：\`${path.relative(ROOT, files.limitDiscountCsv)}\``,
    `- JSON 全量：\`${path.relative(ROOT, files.json)}\``,
    '',
    '## 审核口径',
    '',
    '- 最低促销基准价先按当前可读到的 `当前售价` 与 `本次建议普通活动价` 取低值。',
    '- 若 BI 链路已发现同 SKC 存在 `限时折扣`，但本阶段未读到限时折扣价格，明细会标为高风险，不按安全通过。',
    '- 若同窗口存在优惠券活动，按券规则中可读到的最高商家承担折扣做风险测算；用户可在备注栏指定不用券或只用 15% 档。',
    '- 安全判断默认看 `含仓储费利润率`；仓储费缺失会标记风险，不能当 0 处理。',
    '',
    '## 风险明细预览',
    '',
    `| ${previewHeaders.join(' | ')} |`,
    `| ${previewHeaders.map(() => '---').join(' | ')} |`,
    ...topRiskRows.map(r => `| ${previewHeaders.map(h => mdCell(r[h])).join(' | ')} |`),
    topRiskRows.length < risky ? `\n> 仅预览前 ${topRiskRows.length} 行风险；完整内容见 CSV/JSON。` : '',
    '',
  ].join('\n');
}

const DETAIL_HEADERS = [
  '店铺','分组','活动类型','活动ID','活动名称','报名截止','普通活动开始','普通活动结束','时间窗口是否重叠',
  'SKC','SKU','供方货号','标准货号','商品标题/中文名',
  '原始价SAR','当前售价SAR','价格字段来源','平台最低降幅%',
  '商品完整成本SAR','仓储费摊销SAR/件','含仓储费成本SAR','仓储口径',
  '本次建议普通活动价SAR','本次建议普通活动折扣%','普通营销活动价/折扣',
  '优惠券活动ID/名称','优惠券券档/风险折扣','优惠券券后价SAR',
  '限时折扣名称','限时折扣价SAR',
  '最低价来源','最低促销基准价SAR','叠加后最终成交价SAR','商品利润率','含仓储费利润率','风险提示','修改意见/备注',
];

const SUMMARY_HEADERS = [
  '标准货号','代表供方货号','适用店铺数','适用店铺','涉及活动数','活动ID','明细行数',
  '当前售价SAR范围','商品完整成本SAR范围','含仓储费成本SAR范围','建议普通活动价SAR范围','叠加后最终成交价SAR范围',
  '最低含仓储费利润率','限时折扣风险行数','优惠券叠加风险行数','高风险提示','修改意见/备注',
];

const COUPON_HEADERS = [
  '店铺','分组','优惠券活动ID','优惠券活动名称','报名截止','活动开始','活动结束','后台券档','商家承担%','平台承担%',
  '风险测算最高券折扣%','站点','当前站点预算SAR','已用预算SAR','优惠券状态','可报名数量','已报名数量','规则来源','备注/风险',
];

const LIMIT_HEADERS = ['店铺','SKC','标准货号','限时折扣名称','限时折扣价SAR','来源','数据日期','风险提示','修改意见/备注'];

async function writeCsv(file, rows, headers) {
  const text = [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
  await fs.writeFile(file, '\uFEFF' + text, 'utf8');
}

function splitActivityNames(text) {
  return String(text || '').split(/\s*\/\s*|\s*；\s*|\s*;\s*/).map(s => s.trim()).filter(Boolean);
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function numValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%', '').replace(',', '').trim());
  return Number.isFinite(n) ? n : null;
}
function parsePct(s) {
  const n = numValue(s);
  return n === null ? null : n / 100;
}
function pct(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : `${round2(Number(v) * 100)}%`;
}
function round2(n) {
  if (!Number.isFinite(Number(n))) return null;
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function range(values, digits = 2) {
  const nums = values.map(numValue).filter(v => v !== null);
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const fmt = v => Number(v).toFixed(digits).replace(/\.?0+$/, '');
  return min === max ? fmt(min) : `${fmt(min)}-${fmt(max)}`;
}
function uniq(values) {
  return [...new Set(values.filter(v => v !== null && v !== undefined && String(v) !== ''))];
}
function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, '<br>').slice(0, 500);
}
function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

await main();
