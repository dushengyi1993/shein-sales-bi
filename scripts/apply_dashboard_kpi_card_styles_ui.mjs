#!/usr/bin/env node
/**
 * 给飞书 Dashboard 指标卡补充分组样式。
 *
 * 背景：
 * - 飞书公开 Dashboard block 接口只暴露 data_config，不暴露 statistics 卡片的
 *   底板/字体颜色。
 * - 颜色保存走飞书 Web 端“配置 > 自定义配置”链路；该脚本使用已登录的
 *   profiles/persistent-feishu-profile 自动操作，不改布局、不重排、不重建组件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const BASE_TOKEN = 'SnnQbrAu6aLzMWsnEICcy0cKnJh';
const DASHBOARD_ID = 'blkFn3qHrwdsrJyX';
const PROFILE_DIR = path.join(ROOT, 'profiles', 'persistent-feishu-profile');

const TARGETS = [
  {
    title: '今日动销产品数（DSY）',
    background: '#EAF2FF',
    font: '#1D4ED8',
  },
  {
    title: '今日动销产品数（LGM）',
    background: '#FFF3E8',
    font: '#C2410C',
  },
];

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

async function openDashboard(page) {
  await page.goto(`https://zcnm3ts63aph.feishu.cn/base/${BASE_TOKEN}?table=${DASHBOARD_ID}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText({timeout: 30_000});
  if (/扫码登录|账号登录|密码登录/.test(body) && !body.includes('SHEIN经营看板')) {
    throw new Error('飞书专用 profile 未登录，无法后台修改看板样式。');
  }
}

async function selectCardAndOpenConfig(page, title) {
  let current = null;
  for (let i = 0; i < 18; i++) {
    current = await page.evaluate(({title, i}) => {
      const scroller = document.querySelector('.dashboard-content-container')
        || document.querySelector('.bitable-block-dashboard__mount')
        || document.scrollingElement;
      const item = [...document.querySelectorAll('.layout-item')]
        .find(el => (el.innerText || '').includes(title));
      if (item) {
        item.scrollIntoView({block: 'center', inline: 'center'});
        const r = item.getBoundingClientRect();
        return {x: r.x, y: r.y, w: r.width, h: r.height};
      }
      if (scroller) scroller.scrollTop = i * 520;
      return null;
    }, {title, i});
    if (current) break;
    await page.waitForTimeout(500);
  }
  if (!current) throw new Error(`找不到指标卡：${title}`);
  await page.waitForTimeout(1000);
  current = await page.evaluate(title => {
    const item = [...document.querySelectorAll('.layout-item')]
      .find(el => (el.innerText || '').includes(title));
    const r = item.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height};
  }, title);

  await page.mouse.move(current.x + current.w - 36, current.y + 30);
  await page.waitForTimeout(300);
  await page.mouse.click(current.x + current.w - 31, current.y + 30);
  await page.waitForTimeout(500);
  await page.getByText('配置', {exact: true}).click();
  await page.waitForTimeout(1200);
  await page.getByText('自定义配置', {exact: true}).click();
  await page.waitForTimeout(800);
}

async function openColorPicker(page, label) {
  const ok = await page.evaluate(label => {
    const labels = [...document.querySelectorAll('p,div,span')]
      .filter(el => (el.innerText || '').trim() === label);
    const labelEl = labels[labels.length - 1];
    if (!labelEl) return false;
    const item = labelEl.closest('.dashboard-chart-block-setting-panel-tab-pane-item')
      || labelEl.parentElement;
    const selector = item?.querySelector('.ud__select__selector, [role=combobox]');
    if (!selector) return false;
    const r = selector.getBoundingClientRect();
    for (const type of ['mousedown', 'mouseup', 'click']) {
      selector.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      }));
    }
    return true;
  }, label);
  if (!ok) throw new Error(`找不到颜色下拉框：${label}`);
  await page.waitForTimeout(800);
}

async function setOpenPickerHex(page, hex) {
  const input = page.locator('.statistics-color-picker-menu input.ud__color-picker-input-inner').first();
  await input.waitFor({state: 'visible', timeout: 20_000});
  await input.click({clickCount: 3});
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(hex);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(700);
}

async function setCardStyle(page, target) {
  await selectCardAndOpenConfig(page, target.title);
  await openColorPicker(page, '背景颜色');
  await setOpenPickerHex(page, target.background);
  await openColorPicker(page, '文字颜色');
  await setOpenPickerHex(page, target.font);
  await page.mouse.click(1220, 130).catch(() => {});
  await page.waitForTimeout(3000);
}

function normalizeRgb(rgb) {
  const m = String(rgb || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

async function verifyStyles(page) {
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
  await page.waitForTimeout(5000);
  const results = [];
  for (const t of TARGETS) {
    let one = null;
    for (let i = 0; i < 18; i++) {
      one = await page.evaluate(({t, i}) => {
        const scroller = document.querySelector('.dashboard-content-container')
          || document.querySelector('.bitable-block-dashboard__mount')
          || document.scrollingElement;
        const item = [...document.querySelectorAll('.layout-item')]
          .find(el => (el.innerText || '').includes(t.title));
        if (!item) {
          if (scroller) scroller.scrollTop = i * 520;
          return null;
        }
        item.scrollIntoView({block: 'center', inline: 'center'});
        return true;
      }, {t, i});
      if (one) break;
      await page.waitForTimeout(350);
    }
    if (!one) {
      results.push({title: t.title, ok: false, error: 'not found'});
      continue;
    }
    await page.waitForTimeout(500);
    results.push(await page.evaluate(t => {
    function normalizeRgb(rgb) {
      const m = String(rgb || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return null;
      return `#${[m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
      const item = [...document.querySelectorAll('.layout-item')]
        .find(el => (el.innerText || '').includes(t.title));
      if (!item) return {title: t.title, ok: false, error: 'not found-after-scroll'};
      const titleCandidates = [...item.querySelectorAll('*')]
        .filter(el => (el.innerText || '').trim().includes(t.title))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (ar.width * ar.height) - (br.width * br.height);
        });
      const titleEl = titleCandidates[0];
      const valueCandidates = [...item.querySelectorAll('*')]
        .filter(el => /^[\s\d,.]+$/.test((el.innerText || '').trim()))
        .sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize));
      const valueEl = valueCandidates[0];
      const bg = normalizeRgb(getComputedStyle(item).backgroundColor);
      const titleColor = normalizeRgb(titleEl ? getComputedStyle(titleEl).color : '');
      const valueColor = normalizeRgb(valueEl ? getComputedStyle(valueEl).color : '');
      return {
        title: t.title,
        bg,
        titleColor,
        valueColor,
        expectedBg: t.background,
        expectedFont: t.font,
        ok: bg === t.background.toUpperCase()
          && (titleColor === t.font.toUpperCase() || valueColor === t.font.toUpperCase()),
      };
    }, t));
  }
  return results;
}

async function main() {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const {chromium} = loadPlaywright();
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: chromeExecutablePath(),
    viewport: {width: 1800, height: 1200},
    locale: 'zh-CN',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-features=Translate',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  try {
    const page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(90_000);
    await openDashboard(page);
    const results = [];
    for (const target of TARGETS) {
      await setCardStyle(page, target);
      results.push({title: target.title, applied: true});
    }
    const verify = await verifyStyles(page);
    const screenshot = path.join(REPORT_DIR, `dashboard-active-product-card-styled-${Date.now()}.png`);
    await page.screenshot({path: screenshot, fullPage: false});
    const out = {
      ok: verify.every(v => v.ok),
      results,
      verify,
      screenshot: path.relative(ROOT, screenshot),
      note: '只修改两张今日动销产品数 KPI 卡片颜色，不重排、不重建、不调整大小。',
    };
    const report = path.join(REPORT_DIR, 'dashboard-active-product-card-style-final.json');
    await fs.writeFile(report, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify({...out, report: path.relative(ROOT, report)}, null, 2));
    if (!out.ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err.message}, null, 2));
  process.exit(1);
});
