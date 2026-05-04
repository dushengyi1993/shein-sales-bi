#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const BASE_TOKEN = 'SnnQbrAu6aLzMWsnEICcy0cKnJh';
const DASHBOARD_ID = 'blkFn3qHrwdsrJyX';
const PROFILE_DIR = path.join(ROOT, 'profiles', 'persistent-feishu-profile');

function loadPlaywright() {
  try { return createRequire(import.meta.url)('playwright'); } catch {}
  const bundled = path.join(
    process.env.USERPROFILE || '',
    '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'node', 'node_modules', 'playwright', 'index.js',
  );
  return createRequire(pathToFileURL(bundled))(bundled);
}

function chromeExecutablePath() {
  for (const p of [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)) {
    try { if (createRequire(import.meta.url)('node:fs').existsSync(p)) return p; } catch {}
  }
  return undefined;
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
    const targetText = '今日动销产品数';
    const loc = page.locator(`text=${targetText}`).first();
    await loc.waitFor({state: 'visible'});
    await loc.scrollIntoViewIfNeeded();
    await loc.hover();
    await page.waitForTimeout(1000);
    const shot = path.join(REPORT_DIR, `dashboard-card-ui-hover-${Date.now()}.png`);
    await page.screenshot({path: shot, fullPage: false});
    const info = await page.evaluate(() => {
      function cssPath(el) {
        const parts = [];
        for (let n = el; n && n.nodeType === 1 && parts.length < 8; n = n.parentElement) {
          let s = n.tagName.toLowerCase();
          if (n.id) s += '#' + n.id;
          const cls = String(n.className || '').split(/\s+/).filter(Boolean).slice(0, 4);
          if (cls.length) s += '.' + cls.join('.');
          parts.unshift(s);
        }
        return parts.join(' > ');
      }
      const textNodes = [...document.querySelectorAll('body *')].filter(el => (el.innerText || '').includes('今日动销产品数'));
      const cards = textNodes.slice(0, 10).map(el => {
        const rect = el.getBoundingClientRect();
        let p = el;
        const ancestors = [];
        for (let i = 0; p && i < 8; i++, p = p.parentElement) {
          const r = p.getBoundingClientRect();
          ancestors.push({
            path: cssPath(p),
            className: String(p.className || ''),
            text: (p.innerText || '').slice(0, 120),
            rect: {x: r.x, y: r.y, w: r.width, h: r.height},
            bg: getComputedStyle(p).backgroundColor,
            color: getComputedStyle(p).color,
          });
        }
        return {path: cssPath(el), text: (el.innerText || '').slice(0, 200), rect: {x: rect.x, y: rect.y, w: rect.width, h: rect.height}, ancestors};
      });
      const buttons = [...document.querySelectorAll('button,[role=button],.ud__button,[class*=button],[class*=menu],[class*=more]')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        })
        .slice(0, 120)
        .map(el => {
          const r = el.getBoundingClientRect();
          return {path: cssPath(el), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 80), rect: {x:r.x,y:r.y,w:r.width,h:r.height}, cls:String(el.className||'').slice(0,120)};
        });
      return {url: location.href, cards, buttons};
    });
    const out = path.join(REPORT_DIR, 'dashboard-card-ui-explore.json');
    await fs.writeFile(out, JSON.stringify({screenshot: path.relative(ROOT, shot), ...info}, null, 2), 'utf8');
    console.log(JSON.stringify({ok: true, screenshot: path.relative(ROOT, shot), out: path.relative(ROOT, out)}, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err.message}, null, 2));
  process.exit(1);
});
