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
    await page.goto(`https://zcnm3ts63aph.feishu.cn/base/${BASE_TOKEN}?table=${DASHBOARD_ID}`, {waitUntil: 'domcontentloaded'});
    await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
    await page.waitForTimeout(5000);
    const cardRect = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('.layout-item')].map(el => ({
        el,
        text: el.innerText || '',
        rect: el.getBoundingClientRect(),
      })).filter(x => x.text.includes('今日动销产品数') && x.text.includes('DSY'));
      const item = candidates[0];
      if (!item) return null;
      item.el.scrollIntoView({block: 'center', inline: 'center'});
      const r = item.el.getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height, text: item.text.slice(0, 100)};
    });
    if (!cardRect) throw new Error('card not found');
    await page.waitForTimeout(1000);
    const rect = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.layout-item')]
        .find(el => (el.innerText || '').includes('今日动销产品数') && (el.innerText || '').includes('DSY'));
      if (!item) return null;
      const r = item.getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height};
    });
    await page.mouse.move(rect.x + rect.w - 36, rect.y + 30);
    await page.waitForTimeout(500);
    await page.mouse.click(rect.x + rect.w - 31, rect.y + 30);
    await page.waitForTimeout(1000);
    const shot = path.join(REPORT_DIR, `dashboard-card-menu-${Date.now()}.png`);
    await page.screenshot({path: shot, fullPage: false});
    const info = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      });
      return visible.map(el => {
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (!text) return null;
        const r = el.getBoundingClientRect();
        if (r.x < 0 || r.y < 0 || r.x > innerWidth || r.y > innerHeight) return null;
        if (!/(配置|复制|删除|导出|查看|编辑|自定义|颜色|底板|字体|智能|图表|联动|明细)/.test(text)) return null;
        return {tag: el.tagName, text: text.slice(0, 200), cls: String(el.className || '').slice(0, 160), rect: {x:r.x,y:r.y,w:r.width,h:r.height}};
      }).filter(Boolean);
    });
    const out = path.join(REPORT_DIR, 'dashboard-card-menu-explore.json');
    await fs.writeFile(out, JSON.stringify({screenshot: path.relative(ROOT, shot), info}, null, 2), 'utf8');
    console.log(JSON.stringify({ok: true, screenshot: path.relative(ROOT, shot), out: path.relative(ROOT, out), info: info.slice(0, 50)}, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(err => { console.error(JSON.stringify({ok:false,error:err.message}, null, 2)); process.exit(1); });
