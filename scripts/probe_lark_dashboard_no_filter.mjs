#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseToken = 'SnnQbrAu6aLzMWsnEICcy0cKnJh';
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON: ${text}`);
  return JSON.parse(text.slice(start));
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
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout));
      else resolve(parsed);
    });
  });
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const f = path.join(PAYLOAD_DIR, `${Date.now()}-${name}.json`);
  await fs.writeFile(f, JSON.stringify(obj, null, 2), 'utf8');
  return path.relative(ROOT, f).replace(/\\/g, '/');
}

const created = await runLark([
  'base', '+dashboard-create',
  '--as', 'user',
  '--base-token', baseToken,
  '--name', 'DSY经营看板 v5-无筛选验证',
  '--theme-style', 'futuristic',
]);
const dashboardId = created.data?.dashboard?.dashboard_id || created.data?.dashboard_id;
const blocks = [
  {
    name: '总销售额无筛选',
    type: 'statistics',
    cfg: {table_name: '店铺日报事实', series: [{field_name: '销售额SAR', rollup: 'SUM'}]},
  },
  {
    name: '店铺排行无筛选',
    type: 'bar',
    cfg: {
      table_name: '店铺日报事实',
      series: [{field_name: '销售额SAR', rollup: 'SUM'}],
      group_by: [{field_name: '店铺代号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
    },
  },
  {
    name: '产品排行无筛选',
    type: 'bar',
    cfg: {
      table_name: '产品日销量事实',
      series: [{field_name: '销量', rollup: 'SUM'}],
      group_by: [{field_name: '货号', mode: 'integrated', sort: {type: 'value', order: 'desc'}}],
    },
  },
];

const results = [];
for (const block of blocks) {
  const file = await writePayload(block.name, block.cfg);
  const resp = await runLark([
    'base', '+dashboard-block-create',
    '--as', 'user',
    '--base-token', baseToken,
    '--dashboard-id', dashboardId,
    '--name', block.name,
    '--type', block.type,
    '--data-config', `@${file}`,
  ]);
  results.push(resp.data?.block || resp.block);
}
const arrange = await runLark(['base', '+dashboard-arrange', '--as', 'user', '--base-token', baseToken, '--dashboard-id', dashboardId]);

console.log(JSON.stringify({ok: true, dashboardId, results, arrange}, null, 2));
