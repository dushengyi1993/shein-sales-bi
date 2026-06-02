import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeGoodsSnDetailed } from '../../lib/product_sku_normalizer.mjs';

const ROOT = process.cwd();
const cli = parseArgs(process.argv.slice(2));
const DATE_TAG = cli.date || '2026-06-01';
const VERSION = cli.version || 'v7';
const csvPath = path.resolve(ROOT, cli.csv || path.join('outputs', 'reports', `marketing-sku-approval-${DATE_TAG}-${VERSION}.csv`));
const costPath = path.resolve(ROOT, cli.cost || path.join('tmp', 'sku-approval-builder', `cloud-marketing-cost-map-${DATE_TAG}.json`));
const issuePath = path.resolve(ROOT, cli.issues || path.join('tmp', 'marketing-approval-correction', 'user-marked-issues-v4.json'));
const outPath = path.resolve(ROOT, cli.out || path.join('tmp', 'marketing-approval-correction', `verify-marketing-sku-approval-${DATE_TAG}-${VERSION}.json`));

const rows = parseCsv(await fs.readFile(csvPath, 'utf8').then(stripBom));
const issues = JSON.parse(await fs.readFile(issuePath, 'utf8'));
const costDoc = JSON.parse(await fs.readFile(costPath, 'utf8'));
const trueCostMap = costDoc.trueCostMap || {};
const costByCompact = new Map();
for (const [key, value] of Object.entries(trueCostMap)) {
  for (const candidate of [key, value?.standardGoodsSn, value?.standard].filter(Boolean)) {
    costByCompact.set(compact(candidate), value);
  }
}

const bySku = new Map(rows.map(row => [String(row['标准货号'] || '').trim(), row]));
const failures = [];
const warnings = [];
const issueChecks = [];

function addFailure(scope, message, details = {}) {
  failures.push({scope, message, details});
}

function addWarning(scope, message, details = {}) {
  warnings.push({scope, message, details});
}

function passIssue(issue, result, details = {}) {
  issueChecks.push({issue_id: issue.issue_id, sku: issue.standard_sku, result, details});
}

for (const issue of issues) {
  const oldSku = String(issue.standard_sku || '').trim();
  const note = String(issue.user_note || '');
  const normalized = normalizeGoodsSnDetailed(oldSku);
  const expectedSku = normalized.canonical || oldSku;
  const row = bySku.get(oldSku) || bySku.get(expectedSku);

  if (/归并到SK-13065/.test(note)) {
    const target = bySku.get('SK-13065吸尘器');
    if (bySku.has('SK-13065布衣清洗机')) {
      addFailure(issue.issue_id, '旧别名仍作为独立确认行出现', {oldSku});
      passIssue(issue, 'fail');
    } else if (!target) {
      addFailure(issue.issue_id, '归并目标 SKU 未出现在确认表', {target: 'SK-13065吸尘器'});
      passIssue(issue, 'fail');
    } else {
      passIssue(issue, 'pass', {canonical: 'SK-13065吸尘器', storage: target['仓储费SAR/件']});
    }
    continue;
  }

  if (!row) {
    addFailure(issue.issue_id, '用户标注 SKU 或其 canonical 未出现在确认表', {oldSku, expectedSku, note});
    passIssue(issue, 'fail');
    continue;
  }

  if (/这个货号是什么东西/.test(note)) {
    const status = String(row['系统结论'] || '');
    const handling = String(row['店铺差异我怎么处理'] || '');
    const confirmation = String(row['需要你确认'] || '');
    if (!/货号待归并|暂停/.test(status) || !/不自动处理/.test(handling) || !/先确认/.test(confirmation)) {
      addFailure(issue.issue_id, '待归并货号没有被暂停并要求先确认', {status, handling, confirmation});
      passIssue(issue, 'fail');
    } else {
      passIssue(issue, 'pass', {status, handling, confirmation});
    }
  }

  if (/仓储口径肯定有|应该也有仓储|不可能是0|任何一个品的仓储费都不可能是0/.test(note)) {
    const storage = asNumber(row['仓储费SAR/件']);
    if (!(storage > 0)) {
      addFailure(issue.issue_id, '标注为应有仓储的 SKU 仍未给出正数仓储费/件', {sku: row['标准货号'], storage: row['仓储费SAR/件']});
      passIssue(issue, 'fail');
    } else {
      passIssue(issue, 'pass', {storage});
    }
  }

  if (/仓储费.*这么高|仓储费一件有这么高/.test(note)) {
    const oldStorage = asNumber(issue.storage_fee_per_unit_sar);
    const newStorage = asNumber(row['仓储费SAR/件']);
    if (oldStorage !== null && newStorage !== null && !(newStorage < oldStorage * 0.5)) {
      addFailure(issue.issue_id, '被质疑过高的仓储费/件没有显著下降', {oldStorage, newStorage});
      passIssue(issue, 'fail');
    } else if (newStorage !== null && newStorage > 0) {
      passIssue(issue, 'pass', {oldStorage, newStorage});
    }
  }

  if (/利润率应该是30/.test(note)) {
    const price = asNumber(row['建议最终成交价SAR']);
    const productCost = asNumber(row['商品成本SAR（不含仓储）']);
    const shown = asPercent(row['不含仓储利润率']);
    const expected = price && productCost !== null ? (price - productCost) / price : null;
    if (expected === null || shown === null || Math.abs(expected - shown) > 0.002) {
      addFailure(issue.issue_id, '不含仓储利润率与建议最终成交价/商品成本不一致', {price, productCost, shown, expected});
      passIssue(issue, 'fail');
    } else {
      passIssue(issue, 'pass', {shown, expected});
    }
  }

  if (/15%券到底/.test(note)) {
    const combo = String(row['建议活动组合'] || '');
    if (isAmbiguousCouponText(combo)) {
      addFailure(issue.issue_id, '券策略仍保留 15% 是否允许的歧义文案', {combo});
      passIssue(issue, 'fail');
    } else {
      passIssue(issue, 'pass', {combo});
    }
  }
}

for (const row of rows) {
  const sku = String(row['标准货号'] || '').trim();
  const status = String(row['系统结论'] || '');
  const combo = String(row['建议活动组合'] || '');
  const storage = asNumber(row['仓储费SAR/件']);
  const productCost = asNumber(row['商品成本SAR（不含仓储）']);
  const fullCost = asNumber(row['含仓储成本SAR']);
  const price = asNumber(row['建议最终成交价SAR']);
  const productMargin = asPercent(row['不含仓储利润率']);
  const fullMargin = asPercent(row['含仓储利润率']);
  const normalized = normalizeGoodsSnDetailed(sku);
  const trueCost = costByCompact.get(compact(sku));

  if (normalized.needsReview && !/货号待归并|暂停/.test(status)) {
    addFailure('full-table', 'needsReview 货号没有被暂停', {sku, status, reason: normalized.reviewReason});
  }

  if (!/缺云端成本|货号待归并/.test(status)) {
    if (!(storage > 0)) {
      addFailure('full-table', '可处理 SKU 的仓储费/件不是正数', {sku, status, storage: row['仓储费SAR/件']});
    }
    if (isAmbiguousCouponText(combo)) {
      addFailure('full-table', '建议活动组合存在 15% 券歧义', {sku, combo});
    }
  }

  if (productMargin !== null && fullMargin !== null && fullMargin - productMargin > 0.0005) {
    addFailure('full-table', '含仓储利润率高于不含仓储利润率', {sku, productMargin, fullMargin});
  }

  if (price && productCost !== null && productMargin !== null) {
    const expected = (price - productCost) / price;
    if (Math.abs(expected - productMargin) > 0.002) {
      addFailure('full-table', '不含仓储利润率与建议最终成交价/商品成本不一致', {sku, price, productCost, shown: productMargin, expected});
    }
  }

  if (price && fullCost !== null && fullMargin !== null) {
    const expected = (price - fullCost) / price;
    if (Math.abs(expected - fullMargin) > 0.002) {
      addFailure('full-table', '含仓储利润率与建议最终成交价/含仓储成本不一致', {sku, price, fullCost, shown: fullMargin, expected});
    }
  }

  const mappedStorageUnit = asNumber(trueCost?.storageUnitCostSar) ?? asNumber(trueCost?.storageUnitCostSar30d);
  if (mappedStorageUnit > 0 && !(storage > 0)) {
    addFailure('full-table', '成本映射有 ET 仓储但确认表未显示正数仓储费/件', {sku, mappedStorage: mappedStorageUnit, shownStorage: row['仓储费SAR/件']});
  }
}

for (const alias of ['SK-13065布衣清洗机', 'SK-3065', 'SK-675']) {
  if (bySku.has(alias)) {
    addFailure('full-table', '旧别名/短货号仍作为独立确认行出现', {alias});
  }
}

const report = {
  ok: failures.length === 0,
  csvPath: path.relative(ROOT, csvPath),
  costPath: path.relative(ROOT, costPath),
  issuePath: path.relative(ROOT, issuePath),
  rowCount: rows.length,
  issueCount: issues.length,
  issueChecks,
  failures,
  warnings,
};

await fs.mkdir(path.dirname(outPath), {recursive: true});
await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ok: report.ok, rowCount: report.rowCount, issueCount: report.issueCount, failureCount: failures.length, warningCount: warnings.length, outPath}, null, 2));
if (!report.ok) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows
    .filter(r => r.some(v => String(v || '').trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%SAR,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function asPercent(value) {
  const n = asNumber(value);
  if (n === null) return null;
  return n / 100;
}

function compact(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isAmbiguousCouponText(value) {
  const text = String(value || '');
  return /不叠券/.test(text) && /禁止30\/50%券/.test(text) && !/15\/30\/50%券都禁止/.test(text);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}
