#!/usr/bin/env node
/**
 * Generate a non-destructive cleanup candidate report for Lark Base tables and
 * native dashboards. This script never deletes cloud objects.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');

function parseArgs(argv) {
  const args = {currentMonth: '2026-04', recentMonths: 3, officialDashboardId: 'blkpt0h0aHgDAdRm'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--current-month') args.currentMonth = argv[++i];
    else if (a === '--recent-months') args.recentMonths = Number(argv[++i]);
    else if (a === '--official-dashboard-id') args.officialDashboardId = argv[++i];
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
function recentMonthList(currentMonth, count) {
  const out = [];
  let m = currentMonth;
  for (let i = 0; i < count; i++) {
    out.push(m);
    m = prevMonth(m);
  }
  return out;
}

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) throw new Error(`No JSON in output: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(Math.min(...starts)));
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
      if (code !== 0) reject(new Error(stderr || stdout || `lark-cli exited ${code}`));
      else resolve(parseFirstJson(stdout));
    });
  });
}

function classifyTable(table, recentMonths) {
  const name = table.name;
  const keepCore = new Set([
    '店铺配置', '系统参数', '抓取日志', '店铺日报事实',
    '产品日销量事实', '飞书日报记录',
  ]);
  const keepGenerated = new Set([
    '月度日销-2025汇总', '产品日销量-2025汇总',
    '月度日销-2026汇总', '产品日销量-2026汇总',
    '产品月销量-宽表', '产品周销量-宽表',
  ]);
  const keepRecent = new Set(recentMonths.flatMap(m => [`月度日销-${m}`, `产品日销量-${m}`]));

  if (keepCore.has(name)) return ['保留', '核心事实/配置/日志/日报底座'];
  if (name === '产品周销量' || name === '产品月销量') return ['待确认清理', '旧版产品周/月窄表，已由宽表展示替代；脚本切换后可删除'];
  if (keepRecent.has(name)) return ['保留', '最近三个月独立展示表，方便人工查看'];
  if (keepGenerated.has(name)) return ['保留', '合并/宽表展示，替代旧月度散表'];
  if (name.startsWith('看板数据-DSY-')) return ['保留', 'v6 原生 Dashboard 专用聚合数据源，不能删除'];
  if (/^(月度日销|产品日销量)-\d{4}-\d{2}$/.test(name)) return ['待确认清理', '已被年度汇总表覆盖的旧月度独立表；建议确认后删除或隐藏'];
  return ['待复核', '未匹配到固定规则，先不处理'];
}

function classifyDashboard(dashboard, officialDashboardId) {
  if (dashboard.dashboard_id === officialDashboardId || dashboard.name === 'DSY经营看板 v6-正式版') {
    return ['保留', '正式原生 Dashboard，已前端验证正常'];
  }
  return ['待确认清理', '旧版/诊断/验证用 Dashboard，部分会前端报错；建议确认后删除'];
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  const baseToken = state.baseToken;
  const recentMonths = recentMonthList(args.currentMonth, args.recentMonths);

  const tables = (await runLark(['base', '+table-list', '--as', 'user', '--base-token', baseToken, '--offset', '0', '--limit', '100'])).data.tables;
  const dashboards = (await runLark(['base', '+dashboard-list', '--as', 'user', '--base-token', baseToken])).data.items;

  const tableRows = tables.map(t => {
    const [decision, reason] = classifyTable(t, recentMonths);
    return {id: t.id, name: t.name, decision, reason};
  });
  const dashboardRows = dashboards.map(d => {
    const [decision, reason] = classifyDashboard(d, args.officialDashboardId);
    return {id: d.dashboard_id, name: d.name, decision, reason};
  });

  let md = `# 飞书 Base 表格/看板清理候选清单\n\n`;
  md += `生成时间：${new Date().toISOString()}\n\n`;
  md += `> 这只是候选清单，不会自动删除。删除或隐藏旧表/旧看板前需要用户确认。\n\n`;
  md += `## 数据表（${tables.length} 个）\n\n| 建议 | 名称 | ID | 原因 |\n|---|---|---|---|\n`;
  for (const row of tableRows) md += `| ${mdEscape(row.decision)} | ${mdEscape(row.name)} | ${mdEscape(row.id)} | ${mdEscape(row.reason)} |\n`;
  md += `\n## Dashboard（${dashboards.length} 个）\n\n| 建议 | 名称 | ID | 原因 |\n|---|---|---|---|\n`;
  for (const row of dashboardRows) md += `| ${mdEscape(row.decision)} | ${mdEscape(row.name)} | ${mdEscape(row.id)} | ${mdEscape(row.reason)} |\n`;
  md += `\n## 建议下一步\n\n`;
  md += `1. 保留 \`DSY经营看板 v6-正式版\`。\n`;
  md += `2. 旧 Dashboard（初版、v2、v3、v4、v5）建议用户确认后删除，避免侧边栏混乱。\n`;
  md += `3. 最近三个月（${recentMonths.join('、')}）保留独立月表；更早月表已可由年度汇总表替代，建议用户确认后删除或隐藏。\n`;
  md += `4. \`看板数据-DSY-*\` 是 v6 看板的数据源，虽然是辅助表，但不能删除。\n`;

  await fs.mkdir(REPORT_DIR, {recursive: true});
  const mdFile = path.join(REPORT_DIR, 'lark-base-cleanup-candidates.md');
  const jsonFile = path.join(REPORT_DIR, 'lark-base-cleanup-candidates.json');
  const result = {
    ok: true,
    currentMonth: args.currentMonth,
    recentMonths,
    tableCount: tables.length,
    dashboardCount: dashboards.length,
    cleanupTableCandidates: tableRows.filter(r => r.decision === '待确认清理').length,
    cleanupDashboardCandidates: dashboardRows.filter(r => r.decision === '待确认清理').length,
    tables: tableRows,
    dashboards: dashboardRows,
  };
  await fs.writeFile(mdFile, md, 'utf8');
  await fs.writeFile(jsonFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    tableCount: result.tableCount,
    dashboardCount: result.dashboardCount,
    cleanupTableCandidates: result.cleanupTableCandidates,
    cleanupDashboardCandidates: result.cleanupDashboardCandidates,
    report: path.relative(ROOT, mdFile),
  }, null, 2));
}

await main();
