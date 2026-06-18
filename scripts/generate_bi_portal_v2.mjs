#!/usr/bin/env node
/**
 * Generate SHEIN BI V2 production shell.
 *
 * The cloud BI runtime owns current data through /api/bi/section/*. This script
 * owns the HTML shell layout: V2 is the default portal index, while the legacy
 * V1 shell is preserved under outputs/bi-portal/v1/index.html for temporary
 * fallback until it is formally archived.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(ROOT, 'scripts', 'bi_v2');

function parseArgs(argv) {
  const args = {
    outFile: path.join(ROOT, 'outputs', 'bi-portal', 'index.html'),
    compatV2File: path.join(ROOT, 'outputs', 'bi-portal', 'v2', 'index.html'),
    legacySource: path.join(ROOT, 'outputs', 'bi-portal', 'index.html'),
    legacyTarget: path.join(ROOT, 'outputs', 'bi-portal', 'v1', 'index.html'),
    preserveLegacy: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out-file') args.outFile = path.resolve(argv[++i]);
    else if (a === '--compat-v2-file') args.compatV2File = path.resolve(argv[++i]);
    else if (a === '--legacy-source') args.legacySource = path.resolve(argv[++i]);
    else if (a === '--legacy-target') args.legacyTarget = path.resolve(argv[++i]);
    else if (a === '--no-preserve-legacy') args.preserveLegacy = false;
  }
  return args;
}

function looksLikeV2Shell(html) {
  return /<title>\s*SHEIN BI V2|V2 正式入口|BI V2 preview|SHEIN BI V2 · 运营工作台/i.test(String(html || ''));
}

async function preserveLegacyShell(args) {
  if (!args.preserveLegacy || !args.legacySource || !args.legacyTarget) {
    return {preserved: false, reason: 'disabled'};
  }
  let html = '';
  try {
    html = await fs.readFile(args.legacySource, 'utf8');
  } catch {
    return {preserved: false, reason: 'missing-source'};
  }
  if (looksLikeV2Shell(html)) {
    return {preserved: false, reason: 'source-is-v2'};
  }
  await fs.mkdir(path.dirname(args.legacyTarget), {recursive: true});
  await fs.writeFile(args.legacyTarget, html, 'utf8');
  return {preserved: true, source: args.legacySource, target: args.legacyTarget};
}

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
<title>SHEIN BI · 运营工作台</title>
<style>${css}</style>
</head>
<body>
<aside class="sidebar">
  <div class="brand"><div class="mark">BI</div><h1>SHEIN 运营工作台</h1><p>正式入口 · cloud runtime first</p></div>
  <nav class="nav" id="nav"></nav>
  <div class="side-note"><b id="crumb">正在连接…</b><span>V2 正式入口；V1 临时备份在 /v1/。</span><div id="sideStatus" class="side-status" aria-live="polite"></div></div>
</aside>
<main class="main">
  <div class="command"><div class="bar home-filter-bar">
    <div class="field search-field"><label for="q">搜索</label><input id="q" aria-label="搜索" placeholder="标准货号 / SKC / 商品名 / 订单号" autocomplete="off" /></div>
    <div class="field scope-field"><label for="scope">店铺</label><select id="scope" aria-label="店铺或负责人范围"></select></div>
    <div id="rangeDock" class="range-dock" aria-label="日期范围筛选"></div>
    <div class="quick command-actions"><button id="clearFilters">清空</button></div>
  </div></div>
  <div id="view"></div>
  <div class="foot">BI V2 · data source of truth: cloud runtime / section API · V1 backup: /v1/</div>
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

const args = parseArgs(process.argv.slice(2));
const legacy = await preserveLegacyShell(args);
const html = renderHtml({storeConfig, css, clientJs});
const wrote = [];
for (const target of [args.outFile, args.compatV2File]) {
  if (!target) continue;
  if (wrote.includes(target)) continue;
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, html, 'utf8');
  wrote.push(target);
}
console.log(JSON.stringify({ok: true, wrote, legacy}, null, 2));
