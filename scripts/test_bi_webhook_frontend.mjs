#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = fs.readFileSync(path.join(ROOT, 'scripts/bi_app/client.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'scripts/bi_app/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'outputs/bi-portal/index.html'), 'utf8');

for (const source of [client, html]) {
  assert.match(source, /\['platform','平台动态','hook'\]/);
  assert.match(source, /\/api\/shein\/webhook\/summary/);
  assert.match(source, /\/api\/shein\/webhook\/events\?/);
  assert.match(source, /function webhookRow/);
  assert.match(source, /webhookSeverity/);
  assert.match(source, /webhookStore/);
  assert.match(source, /webhookType/);
  assert.match(source, /webhookStatus/);
  assert.match(source, /近24小时重点动态/);
  assert.match(source, /近24小时需处理/);
  assert.match(source, /普通订单和退货同步、审核通过、正常上架等只留后台审计/);
  assert.match(source, /当前没有需要关注的平台动态/);
  assert.match(source, /普通成功回执不会出现/);
  assert.match(source, /系统处理结果/);
  assert.match(source, /平台动态加载失败/);
}

assert.match(client, /return\{id:webhookText\(r\?\.id\),receivedAt:webhookText\(r\?\.receivedAt\),processedAt:webhookText\(r\?\.processedAt\),storeKey:webhookText\(r\?\.storeKey\)/);
assert.match(client, /function platformPage\(\)\{loadWebhook\(\)/);
assert.match(client, /WEBHOOK\.promise=\(async\(\)=>[\s\S]*?if\(S\.tab==='platform'\)render\(\);return WEBHOOK\.promise/);
assert.doesNotMatch(client, /WEBHOOK\.error='';if\(S\.tab==='platform'\)render\(\);WEBHOOK\.promise=/, 'loading render must happen only after promise assignment to avoid recursive render');
assert.match(client, /const WEBHOOK_EVENT_LABELS=Object\.freeze/);
assert.match(client, /function webhookCopyText\(v,max=4000\)/);
assert.match(client, /phase==='done'&&stored/);
assert.match(client, /P0:'需要立即处理',P1:'建议关注',P3:'普通通知'/);
assert.match(client, /succeeded:'已处理'/);
const eventCard = client.match(/function webhookEventCard\(r\)\{([\s\S]*?)\}\nfunction platformPage/)?.[1] || '';
assert.ok(eventCard, 'webhookEventCard must exist');
assert.doesNotMatch(eventCard, /eventCode|actionState|r\.title|r\.summary|webhookBadge\(r\.severity|webhookBadge\(r\.status/, 'operator timeline must not render audit-only codes or stored technical copy');
assert.match(eventCard, /webhookTitle\(r\)/);
assert.match(eventCard, /webhookSummary\(r\)/);
assert.doesNotMatch(client, /P0（24h）|集中查看平台 webhook|事件时间线|刷新事件/);
assert.match(css, /\.webhook-event\{display:grid/);
assert.match(css, /\.webhook-event-body p\{[^}]*white-space:pre-line/);
assert.match(css, /@media\(max-width:720px\)\{\.webhook-kpis/);

console.log('bi_webhook_frontend: business-language timeline, hidden audit metadata, filters, states, and mobile contracts passed');
