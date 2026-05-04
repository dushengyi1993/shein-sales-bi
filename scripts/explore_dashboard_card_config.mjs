#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const PROFILE_DIR = path.join(ROOT, 'profiles', 'persistent-feishu-profile');
const BASE_TOKEN = 'SnnQbrAu6aLzMWsnEICcy0cKnJh';
const DASHBOARD_ID = 'blkFn3qHrwdsrJyX';

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch {}
  const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.js');
  return createRequire(pathToFileURL(bundled))(bundled);
}
function chromeExecutablePath() {
  for (const p of [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean)) {
    try { if (createRequire(import.meta.url)('node:fs').existsSync(p)) return p; } catch {}
  }
}
async function openConfig(page, titleText) {
  await page.goto(`https://zcnm3ts63aph.feishu.cn/base/${BASE_TOKEN}?table=${DASHBOARD_ID}`, {waitUntil: 'domcontentloaded'});
  await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
  await page.waitForTimeout(5000);
  const rect = await page.evaluate(titleText => {
    const item = [...document.querySelectorAll('.layout-item')]
      .find(el => (el.innerText || '').includes(titleText));
    if (!item) return null;
    item.scrollIntoView({block: 'center', inline: 'center'});
    const r = item.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  }, titleText);
  if (!rect) throw new Error(`card not found: ${titleText}`);
  await page.waitForTimeout(1000);
  const rect2 = await page.evaluate(titleText => {
    const item = [...document.querySelectorAll('.layout-item')]
      .find(el => (el.innerText || '').includes(titleText));
    const r = item.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  }, titleText);
  await page.mouse.move(rect2.x + rect2.w - 36, rect2.y + 30);
  await page.waitForTimeout(300);
  await page.mouse.click(rect2.x + rect2.w - 31, rect2.y + 30);
  await page.waitForTimeout(500);
  await page.getByText('配置', {exact: true}).click();
  await page.waitForTimeout(3000);
}
async function main() {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const {chromium} = loadPlaywright();
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: chromeExecutablePath(),
    viewport: {width: 1800, height: 1200},
    locale: 'zh-CN',
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-features=Translate', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(90_000);
    await openConfig(page, '今日动销产品数（DSY）');
    await page.getByText('自定义配置', {exact: true}).click();
    await page.waitForTimeout(1500);
    const shot = path.join(REPORT_DIR, `dashboard-card-config-${Date.now()}.png`);
    await page.screenshot({path: shot, fullPage: false});
    const info = await page.evaluate(() => {
      function pathOf(el) {
        const a=[]; for(let n=el;n&&n.nodeType===1&&a.length<7;n=n.parentElement){let s=n.tagName.toLowerCase(); const cls=String(n.className||'').split(/\s+/).filter(Boolean).slice(0,3); if(cls.length)s+='.'+cls.join('.'); a.unshift(s);} return a.join(' > ');
      }
      return [...document.querySelectorAll('body *')].map(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden') return null;
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (!text) return null;
        if (!/(自定义|底板|背景|字体|颜色|标题|指标|数值|样式|主题|配置|数据源|图表类型|保存|完成|取消|展示|基础)/.test(text)) return null;
        return {tag: el.tagName, text: text.slice(0, 500), cls: String(el.className || '').slice(0, 180), path: pathOf(el), rect: {x:r.x,y:r.y,w:r.width,h:r.height}, bg:s.backgroundColor, color:s.color};
      }).filter(Boolean);
    });
    const out = path.join(REPORT_DIR, 'dashboard-card-config-explore.json');
    await fs.writeFile(out, JSON.stringify({screenshot: path.relative(ROOT, shot), info}, null, 2), 'utf8');
    console.log(JSON.stringify({ok: true, screenshot: path.relative(ROOT, shot), out: path.relative(ROOT, out), info: info.slice(-80)}, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(err => { console.error(JSON.stringify({ok:false,error:err.message}, null, 2)); process.exit(1); });
