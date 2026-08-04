#!/usr/bin/env node
/**
 * Generate the current SHEIN BI production shell.
 *
 * The cloud BI runtime owns current data through /api/bi/section/*. This script
 * owns the HTML shell layout. This is the only live BI portal; older shells
 * are recoverable only from archived GitHub releases.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileAtomic} from '../lib/atomic_file_publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetDir = path.join(ROOT, 'scripts', 'bi_app');
const BRAND_ASSET_VERSION = '20260803.1';

function parseArgs(argv) {
  const args = {
    outFile: path.join(ROOT, 'outputs', 'bi-portal', 'index.html'),
    compatV2File: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out-file') args.outFile = path.resolve(argv[++i]);
    else if (a === '--compat-v2-file') args.compatV2File = path.resolve(argv[++i]);
  }
  return args;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function buildProductAliasSearch(aliasConfig) {
  const out = {};
  for (const entry of aliasConfig?.aliases || []) {
    const canonical = String(entry?.canonical || '').trim();
    if (!canonical) continue;
    const aliases = (entry.aliases || [])
      .map(alias => typeof alias === 'string' ? alias : alias?.value)
      .filter(Boolean);
    const text = [canonical, ...aliases]
      .map(x => String(x || '').normalize('NFKC').trim())
      .filter(Boolean)
      .join(' ');
    if (text) out[canonical] = text;
  }
  return out;
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
<meta name="description" content="SHEIN 销售、利润、库存、流量与运营自动化工作台" />
<meta name="theme-color" content="#171612" />
<meta name="color-scheme" content="light" />
<title>SHEIN BI · 运营工作台</title>
<link rel="icon" href="/favicon.svg?v=${BRAND_ASSET_VERSION}" type="image/svg+xml" />
<style>${css}</style>
</head>
<body>
<a class="skip-link" href="#content">跳到主要内容</a>
<aside class="sidebar">
  <div class="brand" aria-label="SHEIN BI">
    <div class="mark" aria-hidden="true"><img src="/favicon.svg?v=${BRAND_ASSET_VERSION}" alt="" /></div>
    <div>
      <h1>SHEIN BI</h1>
      <p>沙特半托运营工作台</p>
    </div>
  </div>
  <nav class="nav" id="nav" aria-label="主导航"></nav>
  <div id="accountBox" class="account-box" aria-live="polite"></div>
  <div class="side-note"><b id="crumb">正在连接…</b><span>正式入口 · cloud runtime first</span><div id="sideStatus" class="side-status" aria-live="polite"></div></div>
</aside>
<main class="main" id="content" tabindex="-1">
  <section class="command" aria-label="全局筛选"><div class="bar home-filter-bar">
    <div class="field search-field"><label for="q">搜索</label><input id="q" aria-label="搜索" placeholder="标准货号 / SKC / 商品名 / 订单号" autocomplete="off" /></div>
    <div class="field scope-field"><label for="scope">店铺</label><select id="scope" aria-label="店铺或负责人范围"></select></div>
    <div id="rangeDock" class="range-dock" aria-label="日期范围筛选"></div>
    <div class="quick command-actions"><button type="button" id="clearFilters">清空</button></div>
  </div></section>
  <div id="view" aria-busy="true"></div>
  <footer class="foot">BI 主系统 · data source of truth: cloud runtime / section API</footer>
</main>
<script>window.__SHEIN_STORE_CONFIG__=${safeInlineJson(storeConfig)};</script>
<script>${safeInlineScript(clientJs)}</script>
</body>
</html>`;
}

const [storeConfigRaw, productAliases, css, clientJs, faviconSvg] = await Promise.all([
  readJson(path.join(ROOT, 'config', 'stores.json'), {stores: [], ownerGroups: [], groups: {}}),
  readJson(path.join(ROOT, 'config', 'product_aliases.json'), {aliases: []}),
  fs.readFile(path.join(assetDir, 'styles.css'), 'utf8'),
  fs.readFile(path.join(assetDir, 'client.js'), 'utf8'),
  fs.readFile(path.join(assetDir, 'favicon.svg'), 'utf8'),
]);
const storeConfig = {
  ...storeConfigRaw,
  productAliasSearch: buildProductAliasSearch(productAliases),
};

const args = parseArgs(process.argv.slice(2));
const html = renderHtml({storeConfig, css, clientJs});
const wrote = [];
const wroteAssets = [];
for (const target of [args.outFile, args.compatV2File]) {
  if (!target) continue;
  if (wrote.includes(target)) continue;
  await writeFileAtomic(target, html, {encoding: 'utf8'});
  const faviconTarget = path.join(path.dirname(target), 'favicon.svg');
  if (!wroteAssets.includes(faviconTarget)) {
    await writeFileAtomic(faviconTarget, faviconSvg, {encoding: 'utf8'});
    wroteAssets.push(faviconTarget);
  }
  wrote.push(target);
}
console.log(JSON.stringify({ok: true, wrote, wroteAssets}, null, 2));
