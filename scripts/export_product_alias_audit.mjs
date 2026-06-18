#!/usr/bin/env node
/**
 * Export current canonical product aliases and candidate alias splits for review.
 * Read-only: consumes config/product_aliases.json, config/product_catalog.json and optional BI linksData section JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    outDir: path.join(ROOT, 'outputs', 'reports'),
    sectionJson: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--section-json') args.sectionJson = path.resolve(argv[++i]);
  }
  return args;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, headers) {
  return [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n') + '\n';
}
function unique(values) {
  return [...new Set(values.map(x => String(x ?? '').trim()).filter(Boolean))];
}
function normModel(s) {
  return String(s || '').toUpperCase().replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/--+/g, '-').replace(/^-|-$/g, '');
}
function zhPart(s) {
  return String(s || '').replace(/[A-Za-z0-9\-_:：+\/()（）\s]/g, '').replace(/(电动|便携式|便携|半自动|自动|台式|手持|式|和|与|的)/g, '').trim();
}
function similarityReason(a,b) {
  const ma = normModel(a), mb = normModel(b);
  const za = zhPart(a), zb = zhPart(b);
  if (ma && mb && ma === mb && za && zb && (za.includes(zb) || zb.includes(za))) return `同型号 ${ma}，中文品类高度重叠`;
  if (ma && mb && (ma.startsWith(mb) || mb.startsWith(ma)) && Math.min(ma.length, mb.length) >= 4 && za && zb && (za.includes(zb) || zb.includes(za))) return `型号前缀相同 ${ma}/${mb}，中文品类重叠`;
  return '';
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function latestSectionJson() {
  const candidates = [
    path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json'),
    path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
  ];
  for (const file of candidates) {
    const j = await readJson(file, null);
    if (j) return {file, json:j};
  }
  return {file:'', json:null};
}
function sectionRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.storeLinks)) return payload.storeLinks;
  if (payload.data && Array.isArray(payload.data.storeLinks)) return payload.data.storeLinks;
  if (payload.linksData && Array.isArray(payload.linksData.storeLinks)) return payload.linksData.storeLinks;
  return [];
}
function rawGoodsSnFromRow(row) {
  return row.raw_goods_sn || row.rawGoodsSn || row.raw_standard_goods_sn || row.rawStandardGoodsSn || row.standard_goods_sn || row.standardGoodsSn || '';
}
function titleContextFromRow(row) {
  return {
    goodsTitle: row.sale_name || row.saleName || row.product_name_cn || row.productNameCn || row.product_display_name || row.productDisplayName || '',
    title: row.sale_name || row.saleName || row.product_name_cn || row.productNameCn || row.product_display_name || row.productDisplayName || '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const aliasConfig = await readJson(path.join(ROOT, 'config', 'product_aliases.json'), {aliases: [], ignoredAliases: []});
  const catalog = await readJson(path.join(ROOT, 'config', 'product_catalog.json'), {standards: []});
  const standards = unique([...(catalog.standards || []), ...(catalog.extraConfirmedStandards || [])]);
  const aliasRows = [];
  for (const entry of aliasConfig.aliases || []) {
    const aliases = unique(entry.aliases || []);
    aliasRows.push({
      '标准货号': entry.canonical || '',
      '别名数量': aliases.length,
      '别名列表': aliases.join(' / '),
      '是否在标准清单': standards.includes(entry.canonical) ? '是' : '否',
    });
  }
  aliasRows.sort((a,b) => String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));

  const ignoredRows = [];
  for (const entry of aliasConfig.ignoredAliases || []) {
    ignoredRows.push({
      '忽略项': unique(entry.aliases || []).join(' / '),
      '原因': entry.reason || '',
      '来源': entry.source || '',
    });
  }

  let source = args.sectionJson ? {file: args.sectionJson, json: await readJson(args.sectionJson, null)} : await latestSectionJson();
  const rows = sectionRows(source.json);
  const rawByCanonical = new Map();
  for (const row of rows) {
    const raw = rawGoodsSnFromRow(row);
    const normalized = normalizeGoodsSnDetailed(raw, titleContextFromRow(row));
    if (!raw || normalized.ignored) continue;
    const canonical = normalized.canonical || row.standard_goods_sn || row.standardGoodsSn || row.product_display_name || row.productDisplayName || '';
    if (!canonical) continue;
    if (!rawByCanonical.has(canonical)) rawByCanonical.set(canonical, new Map());
    const m = rawByCanonical.get(canonical);
    m.set(raw, (m.get(raw) || 0) + 1);
  }
  const observedRows = [...rawByCanonical.entries()].map(([canonical, m]) => ({
    '标准货号': canonical,
    '当前云端原始写法数量': m.size,
    '当前云端原始写法': [...m.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).map(([k,v]) => `${k}(${v})`).join(' / '),
  })).sort((a,b)=>String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));

  const candidates = [];
  const canonicalNames = unique([...standards, ...aliasRows.map(r => r['标准货号']), ...rawByCanonical.keys()]);
  for (let i = 0; i < canonicalNames.length; i += 1) {
    for (let j = i + 1; j < canonicalNames.length; j += 1) {
      const a = canonicalNames[i], b = canonicalNames[j];
      const reason = similarityReason(a, b);
      if (!reason) continue;
      candidates.push({
        '候选A': a,
        '候选B': b,
        '原因': reason,
        '建议': '需人工确认后再归并',
      });
    }
  }
  candidates.sort((a,b)=>String(a['候选A']).localeCompare(String(b['候选A']), 'zh-Hans-CN') || String(a['候选B']).localeCompare(String(b['候选B']), 'zh-Hans-CN'));

  await fs.mkdir(args.outDir, {recursive:true});
  const stamp = new Date().toISOString().replace(/[-:]/g,'').slice(0,15);
  const aliasCsv = path.join(args.outDir, `product-alias-audit-${stamp}.csv`);
  const observedCsv = path.join(args.outDir, `product-observed-aliases-${stamp}.csv`);
  const candidateCsv = path.join(args.outDir, `product-alias-candidates-${stamp}.csv`);
  const ignoredCsv = path.join(args.outDir, `product-ignored-aliases-${stamp}.csv`);
  await fs.writeFile(aliasCsv, toCsv(aliasRows, ['标准货号','别名数量','别名列表','是否在标准清单']), 'utf8');
  await fs.writeFile(observedCsv, toCsv(observedRows, ['标准货号','当前云端原始写法数量','当前云端原始写法']), 'utf8');
  await fs.writeFile(candidateCsv, toCsv(candidates, ['候选A','候选B','原因','建议']), 'utf8');
  await fs.writeFile(ignoredCsv, toCsv(ignoredRows, ['忽略项','原因','来源']), 'utf8');
  const summary = {
    ok: true,
    generatedAt: new Date().toISOString(),
    sourceSection: source.file ? path.relative(ROOT, source.file).replace(/\\/g,'/') : '',
    standards: standards.length,
    canonicalAliasGroups: aliasRows.length,
    observedCanonicalGroups: observedRows.length,
    candidatePairs: candidates.length,
    ignoredGroups: ignoredRows.length,
    files: {aliasCsv, observedCsv, candidateCsv, ignoredCsv},
  };
  const summaryFile = path.join(args.outDir, `product-alias-audit-${stamp}.json`);
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({...summary, files:Object.fromEntries(Object.entries(summary.files).map(([k,v])=>[k,path.relative(ROOT,v).replace(/\\/g,'/')]))}, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
