#!/usr/bin/env node
/**
 * Legacy script: create or update the older SHEIN dashboard in Lark Base.
 *
 * 说明：旧看板如果因为字段/表配置变更打不开，不直接删除；默认新建
 * 新看板，用当前真实表名/字段名重新配置组件。
 *
 * 2026-04-27 重要修复：
 * 飞书前端 Dashboard 对 API 创建的 select 字段筛选/分组存在兼容问题：
 * API 返回成功，但前端取图表数据时报
 *   fieldValue is null, condition value is *expression.L
 * 并显示“配置数据发生变更，请重新配置”。
 * 因此本脚本仅保留为历史排障兼容入口。正式看板请使用
 * setup_lark_dashboard_native.mjs，它读取“看板数据-DSY-*”聚合表。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');

function parseArgs(argv) {
  const args = {
    group: 'DSY',
    dashboardName: 'DSY经营看板 v4-修复版',
    themeStyle: 'futuristic',
    arrange: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--month') args.month = argv[++i];
    else if (a === '--name') args.dashboardName = argv[++i];
    else if (a === '--theme-style') args.themeStyle = argv[++i];
    else if (a === '--no-arrange') args.arrange = false;
  }
  if (args.month && !/^\d{4}-\d{2}$/.test(args.month)) throw new Error('Invalid --month, expected YYYY-MM');
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function beijingMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}`;
}

function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function localDateMs(date) {
  return new Date(`${date}T00:00:00+08:00`).getTime();
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error(`No JSON in lark-cli output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(start));
}

async function writeDataConfig(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

async function runLark(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli exited ${code}`));
      else resolve({stdout, stderr, parsed});
    });
  });
}

async function listDashboards(baseToken) {
  const resp = await runLark(['base', '+dashboard-list', '--as', 'user', '--base-token', baseToken, '--format', 'json']);
  return resp.parsed?.data?.items || resp.parsed?.items || [];
}

async function createDashboard(baseToken, name, themeStyle) {
  const resp = await runLark(['base', '+dashboard-create', '--as', 'user', '--base-token', baseToken, '--name', name, '--theme-style', themeStyle]);
  return resp.parsed?.data || resp.parsed;
}

async function listBlocks(baseToken, dashboardId) {
  const resp = await runLark(['base', '+dashboard-block-list', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId, '--page-size', '100', '--format', 'json']);
  return resp.parsed?.data?.items || resp.parsed?.items || [];
}

async function createBlock(baseToken, dashboardId, block) {
  const configFile = await writeDataConfig(`dashboard-${block.name}`, block.dataConfig);
  const resp = await runLark([
    'base', '+dashboard-block-create', '--as', 'user', '--base-token', baseToken,
    '--dashboard-id', dashboardId, '--name', block.name, '--type', block.type,
    '--data-config', `@${path.relative(ROOT, configFile).replace(/\\/g, '/')}`,
  ]);
  return resp.parsed?.data || resp.parsed;
}

async function arrangeDashboard(baseToken, dashboardId) {
  const resp = await runLark(['base', '+dashboard-arrange', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId]);
  return resp.parsed?.data || resp.parsed;
}

function monthFilter(_group, month) {
  const endMonth = nextMonth(month);
  return {
    conjunction: 'and',
    conditions: [
      {field_name: '日期', operator: 'isGreaterEqual', value: localDateMs(`${month}-01`)},
      {field_name: '日期', operator: 'isLess', value: localDateMs(`${endMonth}-01`)},
    ],
  };
}

function buildBlocks({group, month, baseUrl}) {
  const factFilter = monthFilter(group, month);
  const productFilter = monthFilter(group, month);
  return [
    {
      name: '看板说明',
      type: 'text',
      dataConfig: {text: [
        `# SHEIN ${group} 经营看板`,
        `当前看板月份：**${month}**`,
        '',
        '- 销售额口径：按订单创建时间归属北京时间自然日。',
        '- 产品口径：按归一化货号统计，销量取商品行 number。',
        '- 旧看板保留不删除；本看板为按当前字段重新配置的 v2。',
        `- Base：${baseUrl}`,
      ].join('\n')},
    },
    {
      name: `${month} 销售额 SAR`,
      type: 'statistics',
      dataConfig: {table_name: '店铺日报事实', series: [{field_name: '销售额SAR', rollup: 'SUM'}], filter: factFilter},
    },
    {
      name: `${month} 销售额 RMB`,
      type: 'statistics',
      dataConfig: {table_name: '店铺日报事实', series: [{field_name: '销售额RMB', rollup: 'SUM'}], filter: factFilter},
    },
    {
      name: `${month} 有效订单`,
      type: 'statistics',
      dataConfig: {table_name: '店铺日报事实', series: [{field_name: '有效订单数', rollup: 'SUM'}], filter: factFilter},
    },
    {
      name: `${month} 日销售趋势`,
      type: 'line',
      dataConfig: {
        table_name: '店铺日报事实',
        series: [{field_name: '销售额SAR', rollup: 'SUM'}],
        group_by: [{field_name: '日期', mode: 'integrated', sort: {type: 'group', order: 'asc'}}],
        filter: factFilter,
      },
    },
    {
      name: `${month} 店铺销售排行`,
      type: 'bar',
      dataConfig: {
        table_name: '店铺日报事实',
        series: [{field_name: '销售额SAR', rollup: 'SUM'}],
        group_by: [{field_name: '店铺代号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
        filter: factFilter,
      },
    },
    {
      name: `${month} 产品销量排行`,
      type: 'bar',
      dataConfig: {
        table_name: '产品日销量事实',
        series: [{field_name: '销量', rollup: 'SUM'}],
        group_by: [{field_name: '货号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
        filter: productFilter,
      },
    },
    {
      name: `${month} 产品销售额排行`,
      type: 'bar',
      dataConfig: {
        table_name: '产品日销量事实',
        series: [{field_name: '销售额SAR', rollup: 'SUM'}],
        group_by: [{field_name: '货号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
        filter: productFilter,
      },
    },
    {
      name: `${month} 产品日销量趋势`,
      type: 'column',
      dataConfig: {
        table_name: '产品日销量事实',
        series: [{field_name: '销量', rollup: 'SUM'}],
        group_by: [{field_name: '日期', mode: 'integrated', sort: {type: 'group', order: 'asc'}}],
        filter: productFilter,
      },
    },
    {
      name: `${month} 店铺订单排行`,
      type: 'column',
      dataConfig: {
        table_name: '店铺日报事实',
        series: [{field_name: '有效订单数', rollup: 'SUM'}],
        group_by: [{field_name: '店铺代号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
        filter: factFilter,
      },
    },
  ];
}

async function writeReport(payload) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const file = path.join(REPORT_DIR, `dashboard-setup-${payload.month}-${payload.dashboardName.replace(/[^\p{L}\p{N}._-]+/gu, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

const args = parseArgs(process.argv.slice(2));
const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
const baseToken = state.baseToken;
if (!baseToken) throw new Error('Missing baseToken in state/lark_base.json');
const month = args.month || beijingMonth();
const baseUrl = state.baseCreateResponse?.data?.base?.url || `https://zcnm3ts63aph.feishu.cn/base/${baseToken}`;

let dashboard = (await listDashboards(baseToken)).find(d => d.name === args.dashboardName);
let dashboardCreated = false;
if (!dashboard) {
  const created = await createDashboard(baseToken, args.dashboardName, args.themeStyle);
  dashboard = {dashboard_id: created.dashboard_id || created.dashboard?.dashboard_id, name: args.dashboardName, raw: created};
  dashboardCreated = true;
}
const dashboardId = dashboard.dashboard_id || dashboard.id;
if (!dashboardId) throw new Error(`Cannot resolve dashboard id from ${JSON.stringify(dashboard)}`);

const existingBlocks = await listBlocks(baseToken, dashboardId);
const existingByName = new Map(existingBlocks.map(b => [b.name, b]));
const desiredBlocks = buildBlocks({group: args.group, month, baseUrl});
const blockResults = [];
for (const block of desiredBlocks) {
  const existing = existingByName.get(block.name);
  if (existing) {
    blockResults.push({name: block.name, type: block.type, action: 'skipped_existing', blockId: existing.block_id || existing.id});
    continue;
  }
  const created = await createBlock(baseToken, dashboardId, block);
  blockResults.push({
    name: block.name,
    type: block.type,
    action: 'created',
    blockId: created.block?.block_id || created.block_id || created.id || null,
    raw: created,
  });
}

let arrangeResult = null;
if (args.arrange) arrangeResult = await arrangeDashboard(baseToken, dashboardId);

state.dashboards = state.dashboards || {};
state.dashboards[args.dashboardName] = {
  dashboard_id: dashboardId,
  month,
  group: args.group,
  updated_at: new Date().toISOString(),
  blocks: blockResults.map(b => ({name: b.name, type: b.type, action: b.action, block_id: b.blockId})),
};
await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');

const report = {
  ok: true,
  dashboardName: args.dashboardName,
  dashboardId,
  dashboardCreated,
  group: args.group,
  month,
  blockCount: blockResults.length,
  createdBlocks: blockResults.filter(b => b.action === 'created').length,
  skippedExistingBlocks: blockResults.filter(b => b.action === 'skipped_existing').length,
  blocks: blockResults,
  arranged: Boolean(arrangeResult),
  arrangeResult,
  baseUrl,
};
const reportFile = await writeReport(report);

console.log(JSON.stringify({
  ok: true,
  dashboardName: args.dashboardName,
  dashboardId,
  dashboardCreated,
  group: args.group,
  month,
  blockCount: report.blockCount,
  createdBlocks: report.createdBlocks,
  skippedExistingBlocks: report.skippedExistingBlocks,
  arranged: report.arranged,
  reportFile: path.relative(ROOT, reportFile),
  baseUrl,
}, null, 2));
