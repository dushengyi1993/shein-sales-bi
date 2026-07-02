#!/usr/bin/env node
/**
 * Guard that the generated BI portal shell is synchronized with the source
 * client assets for the ops workbench. The production portal serves
 * outputs/bi-portal/index.html, so a source-only frontend fix is not enough.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = await fs.readFile(path.join(ROOT, 'scripts/bi_app/client.js'), 'utf8');
const html = await fs.readFile(path.join(ROOT, 'outputs/bi-portal/index.html'), 'utf8');

const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
}

for (const required of [
  'sessionId=__none__',
  'opsTasksForSession',
  'pendingSession',
  'opsTaskProgressOnly',
  '如果要执行，就直接说“可以执行”“提交吧”“照做”',
  'data-ops-upload="1"',
  'function chooseOpsFiles',
  'ops-upload-file-input',
  'function opsSessionAssetsHtml',
  '会话资料',
  'function opsTaskAssetsHtml',
  '当前处理附件',
  'OPS_UPLOAD_LIMIT_TEXT',
]) {
  ok(client.includes(required), `source client missing required ops marker: ${required}`);
  ok(html.includes(required), `generated portal shell missing required ops marker: ${required}`);
}

for (const stale of [
  "opsApi('/api/link-ops-tasks?limit=80')",
  "Promise.all([opsApi('/api/openapi-capabilities'),opsApi('/api/link-ops-chats?limit=50'),opsApi('/api/link-ops-tasks?limit=80')])",
  '查看审计',
  'SHEIN_OPENAPI_SUBMIT',
  'payload hash',
  'dry-run',
  '飞书',
  '只读建议',
  '回到 BI 自动化运营页',
  'ops-upload-picker',
  'data-ops-upload-missing="1"',
  'function explainOpsUploadMissing',
  '先在聊天里说清楚要处理什么',
  '先创建处理',
]) {
  ok(!html.includes(stale), `generated portal shell still contains stale/operator-facing wording: ${stale}`);
}

if (failures.length) {
  console.error(JSON.stringify({ok: false, failures}, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ok: true, checked: 'bi ops portal shell sync'}, null, 2));
