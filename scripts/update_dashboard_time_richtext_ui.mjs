#!/usr/bin/env node
/**
 * 更新飞书 Dashboard 顶部“数据时间说明”富文本块。
 *
 * 重要背景：
 * - 飞书公开 OpenAPI 更新已存在的 Dashboard text/RICH_TEXT 块时，会把 Markdown
 *   二次序列化成带引号和字面量 \n 的普通字符串。
 * - 该脚本不再调用公开 block update 接口，而是用已登录的飞书网页会话，通过
 *   富文本编辑器本身完成保存。
 * - 只替换文本内容，不调用 dashboard arrange，不重建组件，不修改布局和大小。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const DEFAULT_BASE_TOKEN = 'SnnQbrAu6aLzMWsnEICcy0cKnJh';
const DEFAULT_PROFILE_DIR = path.join(ROOT, 'profiles', 'persistent-feishu-profile');
const DEFAULT_DASHBOARDS = {
  main: {
    name: 'SHEIN经营看板 v3-主看板',
    dashboardId: 'blkFn3qHrwdsrJyX',
    sourcePrefix: 'MAIN',
    scopeTableId: 'tblerbgAxnpdnXpy',
  },
  prev: {
    name: 'SHEIN经营看板 v3-上月',
    dashboardId: 'blkWeyZhphgRZYim',
    sourcePrefix: 'PREV',
    scopeTableId: 'tblqPSHy7Rb4MXte',
  },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function beijingNowString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function currentBeijingMonth() {
  return beijingNowString().slice(0, 7);
}

function previousMonth(month) {
  const [year, monthNo] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, monthNo - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function parseArgs(argv) {
  const args = {
    dashboard: 'main',
    dashboardId: null,
    dashboardName: null,
    sourcePrefix: null,
    scopeTableId: null,
    month: null,
    baseToken: DEFAULT_BASE_TOKEN,
    dataFetchTime: null,
    refreshTime: null,
    profileDir: DEFAULT_PROFILE_DIR,
    visible: false,
    timeoutMs: 120_000,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dashboard') args.dashboard = argv[++i];
    else if (a === '--dashboard-id') args.dashboardId = argv[++i];
    else if (a === '--dashboard-name' || a === '--name') args.dashboardName = argv[++i];
    else if (a === '--source-prefix') args.sourcePrefix = argv[++i]?.toUpperCase();
    else if (a === '--scope-table-id') args.scopeTableId = argv[++i];
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--base-token') args.baseToken = argv[++i];
    else if (a === '--data-fetch-time') args.dataFetchTime = argv[++i];
    else if (a === '--refresh-time') args.refreshTime = argv[++i];
    else if (a === '--profile-dir') args.profileDir = path.resolve(argv[++i]);
    else if (a === '--visible') args.visible = true;
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
  }
  if (!DEFAULT_DASHBOARDS[args.dashboard]) {
    throw new Error(`未知 dashboard：${args.dashboard}，只支持 main 或 prev`);
  }
  return args;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function run(command, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || stdout || `${command} exited ${code}`));
      else resolve(stdout);
    });
  });
}

function parseFirstJson(text) {
  const raw = String(text || '').trim().replace(/^\uFEFF/, '');
  const starts = [raw.indexOf('{'), raw.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) throw new Error(`输出里没有 JSON：${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(Math.min(...starts)));
}

async function listRecords(baseToken, tableId) {
  const stdout = await run('lark-cli', [
    'base', '+record-list', '--as', 'user',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--field-id', '范围',
    '--field-id', '数据抓取时间',
    '--field-id', '更新时间',
    '--limit', '100',
    '--format', 'json',
  ], 90_000);
  return parseFirstJson(stdout).data;
}

async function resolveContext(args) {
  const defaults = DEFAULT_DASHBOARDS[args.dashboard];
  const state = await readJson(STATE_PATH, {});
  const month = args.month || (args.dashboard === 'prev'
    ? previousMonth(currentBeijingMonth())
    : currentBeijingMonth());
  const dashboardName = args.dashboardName || defaults.name;
  const dashboardState = state.dashboards?.[dashboardName] || {};
  const sourcePrefix = args.sourcePrefix || dashboardState.group || defaults.sourcePrefix;
  const dashboardId = args.dashboardId || dashboardState.dashboard_id || defaults.dashboardId;
  const scopeTableId = args.scopeTableId
    || dashboardState.source_tables?.scope?.table_id
    || state.tables?.[`看板数据-${sourcePrefix}-范围汇总`]?.table_id
    || defaults.scopeTableId;

  let dataFetchTime = args.dataFetchTime;
  let refreshTime = args.refreshTime;
  if ((!dataFetchTime || !refreshTime) && scopeTableId) {
    const table = await listRecords(args.baseToken, scopeTableId);
    const fields = table.fields || [];
    const rows = table.data || [];
    const idxScope = fields.indexOf('范围');
    const row = rows.find(r => r[idxScope] === '全部') || rows[0];
    if (row) {
      const idxFetch = fields.indexOf('数据抓取时间');
      const idxUpdate = fields.indexOf('更新时间');
      if (!dataFetchTime) dataFetchTime = row[idxFetch] || row[idxUpdate];
      if (!refreshTime) refreshTime = row[idxUpdate] || beijingNowString();
    }
  }
  if (!refreshTime) refreshTime = beijingNowString();
  if (!dataFetchTime) dataFetchTime = refreshTime;
  return {dashboardName, dashboardId, sourcePrefix, month, scopeTableId, dataFetchTime, refreshTime};
}

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {}
  const bundled = path.join(
    process.env.USERPROFILE || '',
    '.cache', 'codex-runtimes', 'codex-primary-runtime',
    'dependencies', 'node', 'node_modules', 'playwright', 'index.js',
  );
  try {
    return createRequire(pathToFileURL(bundled))(bundled);
  } catch (err) {
    throw new Error(`找不到 Playwright，请先安装/加载工作区依赖。原始错误：${err.message}`);
  }
}

function chromeExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find(p => {
    try { return createRequire(import.meta.url)('node:fs').existsSync(p); } catch { return false; }
  });
}

function desiredText(context) {
  return [
    `SHEIN 经营看板｜${context.month}`,
    '',
    `数据抓取时间：${context.dataFetchTime}（北京时间）`,
    `看板刷新时间：${context.refreshTime}（北京时间）`,
  ].join('\n');
}

async function updateViaBrowser(args, context) {
  const {chromium} = loadPlaywright();
  await fs.mkdir(args.profileDir, {recursive: true});
  await fs.mkdir(REPORT_DIR, {recursive: true});

  const browser = await chromium.launchPersistentContext(args.profileDir, {
    headless: !args.visible,
    executablePath: chromeExecutablePath(),
    viewport: {width: 1600, height: 1000},
    locale: 'zh-CN',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-features=Translate',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const targetText = desiredText(context);
  const url = `https://zcnm3ts63aph.feishu.cn/base/${args.baseToken}?table=${context.dashboardId}`;
  try {
    const page = browser.pages()[0] || await browser.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    await page.goto(url, {waitUntil: 'domcontentloaded', timeout: args.timeoutMs});
    await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
    await page.waitForTimeout(3000);

    const loginState = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        url: location.href,
        needLogin: /扫码登录|账号登录|登录|密码/.test(text) && !/SHEIN经营看板|SHEIN 经营看板/.test(text),
        sample: text.slice(0, 200),
      };
    });
    if (loginState.needLogin) {
      if (!args.visible) {
        throw new Error(`飞书专用浏览器 profile 尚未登录。请先运行本脚本加 --visible，扫码/登录一次。当前页面：${loginState.url}`);
      }
      console.error('飞书专用 profile 尚未登录；请在打开的窗口完成扫码/登录，进入看板后脚本会继续。');
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return /SHEIN经营看板|SHEIN 经营看板|数据抓取时间|看板刷新时间/.test(text);
      }, {timeout: args.timeoutMs});
      await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
      await page.waitForTimeout(3000);
    }

    const editor = page.locator(
      'div[contenteditable="true"], [data-slate-editor="true"], .rich-text-block-editor-kit-container',
    ).filter({
      hasText: /数据抓取时间|看板刷新时间|SHEIN 经营看板|SHEIN经营看板|# SHEIN/,
    }).first();

    await editor.waitFor({state: 'visible', timeout: args.timeoutMs});
    await editor.scrollIntoViewIfNeeded();
    await editor.dblclick();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.insertText(targetText);
    await page.keyboard.press('Escape');
    await page.mouse.click(20, 20).catch(() => {});
    await page.waitForTimeout(3000);

    await page.reload({waitUntil: 'domcontentloaded', timeout: args.timeoutMs});
    await page.waitForLoadState('networkidle', {timeout: 30_000}).catch(() => {});
    await page.waitForTimeout(3000);

    const verify = await page.evaluate(expected => {
      const body = document.body.innerText || '';
      const lines = expected.split('\n').filter(Boolean);
      const editorText = [...document.querySelectorAll(
        'div[contenteditable="true"], [data-slate-editor="true"], .rich-text-block-editor-kit-container',
      )].map(el => el.innerText || '').find(t => t.includes('数据抓取时间') || t.includes('SHEIN')) || '';
      return {
        ok: lines.every(line => body.includes(line)) && !body.includes('"# SHEIN') && !body.includes('\\n'),
        bodyHasLiteralSlashN: body.includes('\\n'),
        bodyHasQuotedTitle: body.includes('"# SHEIN'),
        editorText,
      };
    }, targetText);
    if (!verify.ok) {
      throw new Error(`富文本更新时间后校验失败：${JSON.stringify(verify)}`);
    }

    const screenshot = path.join(
      REPORT_DIR,
      `dashboard-richtext-${args.dashboard}-${context.month}-${Date.now()}.png`,
    );
    await page.screenshot({path: screenshot, fullPage: false});
    return {ok: true, url, text: targetText, screenshot: path.relative(ROOT, screenshot), verify};
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = await resolveContext(args);
  const text = desiredText(context);
  if (args.dryRun) {
    console.log(JSON.stringify({ok: true, dryRun: true, context, text}, null, 2));
    return;
  }
  const result = await updateViaBrowser(args, context);
  console.log(JSON.stringify({ok: true, context, result}, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err.message}, null, 2));
  process.exit(1);
});
