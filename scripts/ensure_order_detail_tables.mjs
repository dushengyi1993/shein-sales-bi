#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'state', 'lark_base.json');
const PAYLOAD_DIR = path.join(ROOT, 'outputs', 'lark_payloads');

function parseFirstJson(stdout) {
  const text = String(stdout || '').trim();
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (start < 0) throw new Error('No JSON in lark-cli output');
  return JSON.parse(text.slice(start));
}

async function writePayload(name, obj) {
  await fs.mkdir(PAYLOAD_DIR, {recursive: true});
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-');
  const file = path.join(PAYLOAD_DIR, `${Date.now()}-${safe}.json`);
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

async function runLark(args, payloadName = null, payload = null) {
  const finalArgs = [...args];
  if (payload) {
    const payloadFile = await writePayload(payloadName || 'payload', payload);
    finalArgs.push('--json', `@${path.relative(ROOT, payloadFile).replace(/\\/g, '/')}`);
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('lark-cli', finalArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      let parsed = null;
      try { parsed = parseFirstJson(stdout); } catch {}
      if (code !== 0) reject(new Error(parsed?.error?.message || stderr || stdout || `lark-cli ${code}`));
      else resolve({stdout, stderr, parsed});
    });
    child.on('error', reject);
  });
}

function textField(name) { return {type: 'text', name}; }
function selectField(name, options) {
  return {type: 'select', name, multiple: false, options: options.map(([name, hue]) => ({name, hue, lightness: 'Light'}))};
}
function numberField(name, precision = 2) {
  return {type: 'number', name, style: {type: 'plain', precision, percentage: false, thousands_separator: true}};
}
function checkboxField(name) { return {type: 'checkbox', name}; }

const TABLES = {
  '订单明细事实': [
    textField('唯一键'), textField('订单号'), textField('订单ID'),
    selectField('分组', [['DSY', 'Blue'], ['LGM', 'Purple']]),
    textField('店铺代号'), textField('店铺名称'), textField('日期'),
    textField('订单创建时间'), textField('客户下单时间'), textField('站点'),
    textField('订单状态'), textField('履约状态'),
    numberField('订单销售额SAR'), numberField('订单销售额RMB'),
    numberField('商品行数', 0), numberField('销量', 0),
    checkboxField('是否有效销售'), textField('抓取时间'), textField('备注'),
  ],
  '订单商品SKC明细事实': [
    textField('唯一键'), textField('订单号'), textField('订单ID'),
    selectField('分组', [['DSY', 'Blue'], ['LGM', 'Purple']]),
    textField('店铺代号'), textField('店铺名称'), textField('日期'),
    textField('订单创建时间'), textField('货号'), textField('原始货号'),
    textField('SKC'), textField('SKU Code'), textField('SKU Sn'),
    textField('商品ID'), textField('Entity ID'), textField('规格'), textField('商品名称'),
    numberField('销量', 0), textField('币种'),
    numberField('销售额SAR'), numberField('销售额RMB'), checkboxField('是否有效销售'),
    textField('商品状态'), textField('履约状态'), textField('售后单号'), textField('退货单号'),
    textField('抓取时间'), textField('备注'),
  ],
  'SKC链接映射': [
    textField('唯一键'),
    selectField('分组', [['DSY', 'Blue'], ['LGM', 'Purple']]),
    textField('店铺代号'), textField('店铺名称'), textField('货号'), textField('SKC'),
    textField('SKU Code'), textField('SKU Sn'), textField('商品ID'), textField('Entity ID'),
    textField('规格'), textField('商品名称'),
    numberField('累计销量', 0), numberField('累计销售额SAR'), numberField('累计销售额RMB'),
    textField('首次订单日期'), textField('最近订单日期'), textField('更新时间'), textField('备注'),
  ],
};

async function listTables(baseToken) {
  const resp = await runLark([
    'base', '+table-list', '--as', 'user', '--base-token', baseToken, '--offset', '0', '--limit', '100',
  ]);
  return resp.parsed?.data?.tables || [];
}

async function ensureTable(state, baseToken, name, fields) {
  const known = state.tables?.[name]?.table_id;
  if (known) return {name, tableId: known, created: false};
  const existing = (await listTables(baseToken)).find(t => t.name === name);
  if (existing?.id) {
    state.tables ||= {};
    state.tables[name] = {table_id: existing.id, raw: {discovered: true}};
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    return {name, tableId: existing.id, created: false};
  }
  const resp = await runLark([
    'base', '+table-create', '--as', 'user', '--base-token', baseToken, '--name', name, '--fields', JSON.stringify(fields),
  ]);
  const tableId = resp.parsed?.data?.table?.id || resp.parsed?.data?.table?.table_id || resp.parsed?.table?.id;
  if (!tableId) throw new Error(`Cannot create table ${name}`);
  state.tables ||= {};
  state.tables[name] = {table_id: tableId, raw: resp.parsed};
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  return {name, tableId, created: true};
}

const state = JSON.parse((await fs.readFile(STATE_PATH, 'utf8')).replace(/^\uFEFF/, ''));
const baseToken = state.baseToken;
const results = [];
for (const [name, fields] of Object.entries(TABLES)) {
  results.push(await ensureTable(state, baseToken, name, fields));
}
console.log(JSON.stringify({ok: true, results}, null, 2));
