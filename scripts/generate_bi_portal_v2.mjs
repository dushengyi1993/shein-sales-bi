#!/usr/bin/env node
/**
 * Generate SHEIN BI V2 preview shell.
 *
 * Writes only outputs/bi-portal/v2/index.html. The generated page loads
 * business data from the cloud BI runtime / section API; repository artifacts
 * are only a compatibility bootstrap and must not be used as current data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'outputs', 'bi-portal', 'v2');
const outFile = path.join(outDir, 'index.html');
const assetDir = path.join(ROOT, 'scripts', 'bi_v2');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeInlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\u003c');
}

function safeInlineScript(value) {
  return String(value || '').replace(/<\/script/gi, '<\\/script');
}

function renderHtml({storeConfig, css, clientJs}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>SHEIN BI V2 · 运营工作台</title>
<style>${css}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand"><div class="mark">BI</div><h1>SHEIN 运营工作台</h1><p>V2 preview · cloud runtime first</p></div>
  <nav class="nav" id="nav"></nav>
  <div class="side-note"><b id="crumb">正在连接…</b><span>正式入口不变；V2 仅作平行验收。</span></div>
</aside>
<main class="main">
  <div class="command"><div class="bar">
    <div class="field"><label for="q">搜索</label><input id="q" aria-label="搜索" placeholder="标准货号 / SKC / 商品名 / 订单号" autocomplete="off" /></div>
    <div class="field"><label for="scope">范围</label><select id="scope" aria-label="范围"></select></div>
    <div class="field"><label for="start">开始</label><input id="start" aria-label="开始日期" type="date" /></div>
    <div class="field"><label for="end">结束</label><input id="end" aria-label="结束日期" type="date" /></div>
    <div class="quick"><button data-preset="7">近7天</button><button data-preset="30">近30天</button><button data-preset="365">近一年</button><button id="clearFilters">清空</button></div>
  </div></div>
  <div id="view"></div>
  <div class="foot">BI V2 preview · data source of truth: cloud runtime / section API</div>
</main>
<script>window.__SHEIN_STORE_CONFIG__=${safeInlineJson(storeConfig)};</script>
<script>${safeInlineScript(clientJs)}</script>
</body>
</html>`;
}

const [storeConfig, css, clientJs] = await Promise.all([
  readJson(path.join(ROOT, 'config', 'stores.json'), {stores: [], ownerGroups: [], groups: {}}),
  fs.readFile(path.join(assetDir, 'styles.css'), 'utf8'),
  fs.readFile(path.join(assetDir, 'client.js'), 'utf8'),
]);

await fs.mkdir(outDir, {recursive: true});
await fs.writeFile(outFile, renderHtml({storeConfig, css, clientJs}), 'utf8');
console.log(`[generate_bi_portal_v2] wrote ${outFile}`);
