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
  assert.match(source, /24h 事件/);
  assert.match(source, /待处理/);
  assert.match(source, /平台动态加载失败/);
}

assert.match(client, /return\{id:webhookText\(r\?\.id\),receivedAt:webhookText\(r\?\.receivedAt\),processedAt:webhookText\(r\?\.processedAt\),storeKey:webhookText\(r\?\.storeKey\)/);
assert.match(client, /function platformPage\(\)\{loadWebhook\(\)/);
assert.match(client, /WEBHOOK\.promise=\(async\(\)=>[\s\S]*?if\(S\.tab==='platform'\)render\(\);return WEBHOOK\.promise/);
assert.doesNotMatch(client, /WEBHOOK\.error='';if\(S\.tab==='platform'\)render\(\);WEBHOOK\.promise=/, 'loading render must happen only after promise assignment to avoid recursive render');
assert.match(css, /\.webhook-event\{display:grid/);
assert.match(css, /@media\(max-width:720px\)\{\.webhook-kpis/);

console.log('bi_webhook_frontend: navigation, API, normalized event projection, states, and mobile timeline contracts passed');
