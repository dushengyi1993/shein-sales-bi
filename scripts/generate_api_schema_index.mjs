#!/usr/bin/env node
/**
 * Generate a human-readable Markdown index of all semi-trust API details.
 */
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETAILS_DIR = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'api-details');
const INDEX_PATH = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'semi-trust-api-details.json');
const CATALOG_PATH = path.join(ROOT, 'outputs', 'shein-openapi-doc-catalog', 'official-capabilities.latest.json');
const OUT_MD = path.join(ROOT, 'docs', 'shein-openapi-api-schema-index.md');

function fieldTree(node, indent = 0) {
  if (!node) return '';
  const prefix = '  '.repeat(indent);
  let lines = [];
  const name = node.name || '(root)';
  const type = node.type || '';
  const req = node.required === true ? '必填' : (node.required === false ? '选填' : '');
  const desc = node.description ? ` — ${node.description}` : '';
  const meta = [type, req].filter(Boolean).join(', ');
  lines.push(`${prefix}- \`${name}\`${meta ? ` (${meta})` : ''}${desc}`);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      lines.push(fieldTree(child, indent + 1));
    }
  }
  return lines.filter(Boolean).join('\n');
}

function main() {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const catMap = new Map(catalog.capabilities.map(c => [c.docId, c]));
  const semi = index.interfaces.filter(i => i.modes.includes(5));

  // Group by category
  const byCat = {};
  for (const iface of semi) {
    const cap = catMap.get(iface.docId);
    const cat = cap?.category || 'unknown';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(iface);
  }

  const lines = [];
  lines.push('# SHEIN OpenAPI 半托管接口 Schema 索引');
  lines.push('');
  lines.push(`> 生成时间：\`${index.generatedAt}\`。来源：SHEIN 开放平台文档中心详情接口。共 ${semi.length} 个半托管接口（mode 包含 5）。本文件不包含密钥或授权值。`);
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 半托管接口总数：${semi.length}`);
  lines.push(`- 有请求示例：${semi.filter(i => i.hasRequestExample).length}`);
  lines.push(`- 有响应示例：${semi.filter(i => i.hasResponseExample).length}`);
  lines.push(`- 有请求体 schema：${semi.filter(i => i.hasRequestBody).length}`);
  lines.push('');
  lines.push('## 按分类分组');
  lines.push('');

  for (const [cat, items] of Object.entries(byCat).sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
    lines.push(`### ${cat}（${items.length}）`);
    lines.push('');
    lines.push('| docId | 名称 | 方法 | endpoint | 读/写 | 请求字段数 | 响应字段数 | 有示例 |');
    lines.push('|---:|---|---|---|---|---:|---:|---|');
    for (const i of items) {
      const cap = catMap.get(i.docId);
      const rw = cap?.read_or_write || '-';
      lines.push(`| ${i.docId} | ${i.title} | ${i.method} | \`${i.endpoint}\` | ${rw} | ${i.requestFieldCount} | ${i.responseFieldCount} | ${i.hasRequestExample || i.hasResponseExample ? '✓' : '✗'} |`);
    }
    lines.push('');
  }

  // Detailed schema for priority interfaces
  lines.push('## 优先开发接口 Schema 详情');
  lines.push('');
  const priorityDocIds = ['3001359', '3001360', '3001368', '3001634', '3001898', '3001544'];
  for (const docId of priorityDocIds) {
    const detailPath = path.join(DETAILS_DIR, `${docId}.json`);
    let detail;
    try { detail = JSON.parse(readFileSync(detailPath, 'utf8')); } catch { continue; }
    const cap = catMap.get(docId);
    lines.push(`### ${docId} — ${detail.meta.title}`);
    lines.push('');
    lines.push(`- **endpoint**: \`${detail.meta.endpoint}\``);
    lines.push(`- **method**: ${detail.meta.method}`);
    lines.push(`- **modes**: ${detail.meta.modeNames.join(', ')}`);
    lines.push(`- **QPS**: ${detail.meta.qps || '-'}`);
    lines.push(`- **描述**: ${detail.description.slice(0, 500)}`);
    lines.push('');
    if (detail.requestBody) {
      lines.push('**请求体**:');
      lines.push('');
      lines.push(fieldTree(detail.requestBody));
      lines.push('');
    }
    if (detail.responseBody) {
      lines.push('**响应体**:');
      lines.push('');
      lines.push(fieldTree(detail.responseBody));
      lines.push('');
    }
    if (detail.requestExample) {
      lines.push('**请求示例**:');
      lines.push('```');
      lines.push(detail.requestExample.slice(0, 1000));
      lines.push('```');
      lines.push('');
    }
    if (detail.responseExample) {
      lines.push('**响应示例**:');
      lines.push('```');
      lines.push(detail.responseExample.slice(0, 1000));
      lines.push('```');
      lines.push('');
    }
  }

  fs.writeFile(OUT_MD, lines.join('\n') + '\n', 'utf8').then(() => {
    console.log(`Written: ${path.relative(ROOT, OUT_MD)}`);
    console.log(`Semi-trust interfaces: ${semi.length}`);
  });
}

main();
