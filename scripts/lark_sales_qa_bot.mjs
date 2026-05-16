#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = process.env.SHEIN_QA_BI_DATA || path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const STATE_DIR = process.env.SHEIN_QA_STATE_DIR || path.join(ROOT, 'state', 'lark_sales_qa_bot');
const STORE_KEYS = ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ', 'CX', 'YJ', 'XL', 'QY', 'QH', 'TZ'];

function parseArgs(argv) {
  const args = {answer: '', consume: false, dryRun: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answer') args.answer = argv[++i] || '';
    else if (a === '--consume') args.consume = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function readData() {
  return JSON.parse((await fs.readFile(DATA_PATH, 'utf8')).replace(/^\uFEFF/, ''));
}

function n(value) {
  const x = Number(value || 0);
  return Number.isFinite(x) ? x : 0;
}

function moneySar(value) {
  return `${n(value).toLocaleString('en-US', {maximumFractionDigits: 2})} SAR`;
}

function intNum(value) {
  return `${Math.round(n(value)).toLocaleString('en-US')}`;
}

function addDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pickDate(text, data) {
  const latest = data.dates?.salesDate || data.rankings?.salesSummary?.map(r => r.end_date).sort().at(-1) || '';
  const explicit = String(text).match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0];
  if (explicit) {
    const nums = explicit.match(/\d+/g).map(Number);
    return `${nums[0]}-${String(nums[1]).padStart(2, '0')}-${String(nums[2]).padStart(2, '0')}`;
  }
  if (/前天/.test(text)) return addDays(latest, -2);
  if (/昨天|昨日/.test(text)) return addDays(latest, -1);
  return latest;
}

function pickStore(text) {
  const upper = String(text || '').toUpperCase();
  for (const key of STORE_KEYS) {
    if (new RegExp(`(^|[^A-Z0-9])${key}([^A-Z0-9]|$)`).test(upper)) return key;
  }
  if (/DSY/i.test(upper)) return 'DSY';
  if (/LGM/i.test(upper)) return 'LGM';
  return '';
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function decodeTextContent(content) {
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  const raw = String(content || '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed.text;
  } catch {}
  return raw;
}

function normalizeEventPayload(input) {
  const root = input?.event || input || {};
  const message = root.message || root;
  return {
    ...root,
    ...message,
    event_id: input?.event_id || root.event_id || message.event_id || '',
    message_id: root.message_id || message.message_id || message.id || '',
    chat_type: root.chat_type || message.chat_type || '',
    message_type: root.message_type || message.message_type || '',
    sender_type: root.sender_type || root.sender?.sender_type || input?.sender?.sender_type || '',
    sender_id: root.sender_id || root.sender?.sender_id?.open_id || root.sender?.sender_id?.union_id || '',
    content: decodeTextContent(root.content ?? message.content),
  };
}

function findProduct(text, data) {
  const q = normalizeText(text).toLowerCase();
  if (!q) return '';
  const products = new Set();
  for (const row of data.rankings?.dailyProducts || []) {
    if (row.standard_goods_sn) products.add(String(row.standard_goods_sn));
  }
  const sorted = [...products].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (q.includes(p.toLowerCase())) return p;
  }
  const code = q.match(/[a-z]{1,5}[- ]?\d{2,6}[a-z]?/i)?.[0]?.replace(/\s+/g, '-').toUpperCase();
  if (code) {
    const hit = sorted.find(p => p.toUpperCase().includes(code));
    if (hit) return hit;
  }
  return '';
}

function rowSummary(row) {
  return `${moneySar(row?.gross_sales_sar ?? row?.sales_sar)}，订单 ${intNum(row?.gross_orders ?? row?.orders)}，销量 ${intNum(row?.gross_quantity ?? row?.quantity)}`;
}

function answerQuestion(text, data) {
  const q = normalizeText(text);
  const date = pickDate(q, data);
  const store = pickStore(q);
  const product = findProduct(q, data);
  const wantsRank = /排行|排名|top|前\d+|最高|最好/.test(q);
  const wantsProduct = product || /货号|产品|商品|SKU|SKC/i.test(q);
  const wantsStore = store || /店铺|哪个店|各店|门店/.test(q);
  const latestNote = `数据口径：${date}；BI 生成：${data.generatedAt || '-'}；销售源：${data.dates?.salesUpdatedAt || '-'}`;

  if (wantsRank && wantsProduct) {
    const rows = (data.rankings?.dailyProducts || [])
      .filter(r => r.date === date)
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 8);
    if (!rows.length) return `没查到 ${date} 的产品销售排行。\n${latestNote}`;
    return [
      `${date} 产品销售排行 TOP ${rows.length}`,
      ...rows.map((r, i) => `${i + 1}. ${r.standard_goods_sn || '-'}：${rowSummary(r)}`),
      latestNote,
    ].join('\n');
  }

  if (wantsRank || wantsStore) {
    const rows = (data.rankings?.dailyStores || [])
      .filter(r => r.date === date)
      .filter(r => !store || (store === 'DSY' ? r.group_key === 'DSY' : store === 'LGM' ? r.group_key === 'LGM' : r.store_key === store))
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar));
    if (!rows.length) return `没查到 ${date}${store ? ` ${store}` : ''} 的店铺销售数据。\n${latestNote}`;
    if (store && !['DSY', 'LGM'].includes(store)) {
      return `${date} ${store}：${rowSummary(rows[0])}\n${latestNote}`;
    }
    const top = rows.slice(0, 8);
    return [
      `${date}${store ? ` ${store}` : ''} 店铺销售排行 TOP ${top.length}`,
      ...top.map((r, i) => `${i + 1}. ${r.store_key}：${rowSummary(r)}`),
      latestNote,
    ].join('\n');
  }

  if (wantsProduct && product) {
    const rows = (data.rankings?.dailyProducts || []).filter(r => r.date === date && r.standard_goods_sn === product);
    if (!rows.length) return `没查到 ${date} ${product} 的销售数据。\n${latestNote}`;
    const row = rows.reduce((acc, r) => ({
      gross_sales_sar: n(acc.gross_sales_sar ?? acc.sales_sar) + n(r.gross_sales_sar ?? r.sales_sar),
      gross_orders: n(acc.gross_orders ?? acc.orders) + n(r.gross_orders ?? r.orders),
      gross_quantity: n(acc.gross_quantity ?? acc.quantity) + n(r.gross_quantity ?? r.quantity),
    }), {});
    const storeRows = (data.rankings?.dailyStoreProducts || [])
      .filter(r => r.date === date && r.standard_goods_sn === product)
      .sort((a, b) => n(b.gross_sales_sar ?? b.sales_sar) - n(a.gross_sales_sar ?? a.sales_sar))
      .slice(0, 5);
    return [
      `${date} ${product} 合计：${rowSummary(row)}`,
      storeRows.length ? `店铺贡献：${storeRows.map(r => `${r.store_key} ${moneySar(r.gross_sales_sar ?? r.sales_sar)}`).join('；')}` : '',
      latestNote,
    ].filter(Boolean).join('\n');
  }

  const summary = (data.rankings?.salesSummary || []).find(r => r.period_key === 'day' && r.end_date === date);
  if (summary) {
    return `${date} 总销售：${rowSummary(summary)}\n${latestNote}`;
  }
  return [
    `我现在能只读回答：今日/昨日销售额、订单、销量、店铺排行、产品/货号排行。`,
    `你可以问：“今天销售多少”、“昨天店铺排行”、“HL今天销售”、“BHRL-09激光脱毛仪今天卖了多少”。`,
    latestNote,
  ].join('\n');
}

function shouldAnswerEvent(event) {
  const content = normalizeText(event?.content || '');
  if (!content) return false;
  if (String(event?.message_type || '') !== 'text') return false;
  if (/app|bot/i.test(String(event?.sender_type || ''))) return false;
  if (event?.chat_type === 'p2p') return true;
  return /销售|销量|订单|利润|退货|退款|排行|排名|货号|产品|商品|店铺|数据|BI|bi|今天|昨天|昨日/.test(content);
}

function runLark(args) {
  return new Promise(resolve => {
    const child = spawn('lark-cli', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err?.stack || err)}));
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
}

async function alreadyHandled(eventId) {
  if (!eventId) return false;
  const file = path.join(STATE_DIR, 'events', `${eventId}.json`);
  try { await fs.access(file); return true; } catch { return false; }
}

async function markHandled(eventId, payload) {
  if (!eventId) return;
  const dir = path.join(STATE_DIR, 'events');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, `${eventId}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

async function handleEvent(event, options = {}) {
  const eventId = event.event_id || event.message_id || crypto.createHash('sha1').update(JSON.stringify(event)).digest('hex');
  if (!shouldAnswerEvent(event)) return {ok: true, skipped: true, reason: 'not_sales_question'};
  if (await alreadyHandled(eventId)) return {ok: true, skipped: true, reason: 'duplicate'};
  const data = await readData();
  const answer = answerQuestion(event.content || '', data);
  const sendArgs = [
    'im', '+messages-reply',
    '--as', 'bot',
    '--message-id', event.message_id || event.id,
    '--text', answer,
    '--idempotency-key', `sales-qa-${eventId}`.slice(0, 80),
  ];
  let sent = {ok: true, dryRun: true};
  if (!options.dryRun) sent = await runLark(sendArgs);
  await markHandled(eventId, {
    handledAt: new Date().toISOString(),
    eventId,
    messageId: event.message_id || event.id || '',
    chatType: event.chat_type || '',
    questionPreview: String(event.content || '').slice(0, 200),
    answer,
    sendOk: sent.ok,
    sendCode: sent.code ?? null,
    stderrTail: String(sent.stderr || '').slice(-500),
  });
  return {ok: sent.ok, eventId, answer, sendCode: sent.code ?? null, stderrTail: String(sent.stderr || '').slice(-500)};
}

async function consume(options = {}) {
  await fs.mkdir(STATE_DIR, {recursive: true});
  const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of rl) {
    const raw = String(line || '').trim();
    if (!raw) continue;
    try {
      const event = normalizeEventPayload(JSON.parse(raw));
      const result = await handleEvent(event, options);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error(JSON.stringify({ok: false, error: String(err?.stack || err).slice(0, 2000)}));
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.answer) {
  const data = await readData();
  console.log(answerQuestion(args.answer, data));
} else if (args.consume) {
  await consume({dryRun: args.dryRun});
} else {
  console.log('Usage: node scripts/lark_sales_qa_bot.mjs --answer "今天销售多少" | --consume');
}
