#!/usr/bin/env node
/**
 * Static smoke for BI ops workbench chat-only UX.
 * This intentionally does not call production APIs or SHEIN; it guards the
 * browser-side affordances that make slow preflight/submit actions visible.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = await fs.readFile(path.join(ROOT, 'scripts/bi_app/client.js'), 'utf8');
const css = await fs.readFile(path.join(ROOT, 'scripts/bi_app/styles.css'), 'utf8');
const portalServer = await fs.readFile(path.join(ROOT, 'scripts/serve_bi_portal.mjs'), 'utf8');
const failures = [];
function ok(cond, msg) { if (!cond) failures.push(msg); }

ok(!client.includes("function opsConfirmAccepted"), 'fixed confirm helper should not exist in chat-only frontend');
ok(!client.includes("SHEIN_OPENAPI_SUBMIT"), 'backend safety token leaked into frontend');
ok(!client.includes('placeholder="输入“确认”"'), 'fixed final-confirm input is still visible');
ok(!client.includes('placeholder="输入 SHEIN_OPENAPI_SUBMIT 后最终提交"'), 'old English confirm placeholder is still visible');
ok(!client.includes('提交前在对话里的最后确认框输入“确认”即可'), 'fixed final-confirm validation error is still visible');

for (const fn of ['opsBusyFor', 'opsSetBusy', 'opsBusyBanner', 'opsTaskTime', 'opsTaskSessionId', 'opsTasksForSession', 'opsActiveTaskForSession']) {
  ok(client.includes(`function ${fn}`), `missing runtime helper ${fn}`);
}
for (const msg of ['正在处理当前对话…', '收到，我正在处理。数据、资料缺口、权限边界和下一步都会直接发在这里。', '正在上传', '系统会先说明选中的对象、资料缺口和下一步']) {
  ok(client.includes(msg), `missing busy feedback message: ${msg}`);
}
ok(client.includes('pendingSession') && client.includes('pending_user_') && client.includes('pending_assistant_'), 'chat send has no optimistic pending session, messages can disappear until refresh');
ok(client.includes('opsHumanCheckRows') && client.includes('opsHumanProblemText'), 'human-readable task check helpers missing');
ok(client.includes('opsExecPublishPreValidFailed') && client.includes('opsExecStateLabel'), 'publish pre-valid failure helpers missing');
ok(client.includes('平台没通过，需要补充') && client.includes('未创建新链接'), 'publish pre-valid failure is not explained clearly');
ok(client.includes('店铺能力') && client.includes('可操作') && client.includes('opsTaskProgressOnly'), 'operator-facing capability/progress wording is not simplified');
ok(client.includes('如果要执行，就直接说“可以执行”“提交吧”“照做”'), 'chat-only natural confirmation hint missing');
ok(client.includes('把 DX 某条 SKC 库存改成 100') && client.includes('下架缺货链接'), 'chat prompt still looks copy-only instead of generic ops');
ok(client.includes('ops-upload-picker') && client.includes('type="file"') && client.includes('accept="${H(OPS_UPLOAD_ACCEPT)}"'), 'upload control is not a native file input picker');
ok(!client.includes('input.click()'), 'upload still depends on programmatic file input click');
ok(client.includes('data-ops-upload-missing="1"') && client.includes('function explainOpsUploadMissing'), 'upload without current task has no visible human feedback');
ok(client.includes('function opsTaskAssetsHtml') && client.includes('已上传文件'), 'uploaded files are not rendered in current task panel');
ok(client.includes('OPS_UPLOAD_LIMIT_TEXT') && client.includes('XLSX') && client.includes('20MB') && client.includes('120MB'), 'upload limits/formats are not visible in frontend');
for (const phrase of ['飞书', 'V1', '任务池', '确认成任务', '可预检 ', '完成 dry-run', '只能问数、生成任务或 dry-run', '查看审计', '正在读取这条任务的审计记录', '系统会先建任务并预检', '最后确认', '确认提交', 'data-ops-final-execute', 'data-ops-execute', 'data-ops-audit', 'data-ops-resolve', 'executeOpsTask', 'loadOpsAudit', 'resolveOpsTask', '任务 ', '当前任务', '生成任务草稿', 'askOnly', 'noAutoTask', 'opsDryrun', '只问数', '只回答']) {
  ok(!client.includes(phrase), `operator-facing technical wording leaked: ${phrase}`);
}
for (const phrase of ['飞书', '回到 BI 自动化运营页', '当前飞书通道', 'ops_write_readonly_advice', 'body.noAutoTask', 'readonly-codex-gateway', '形成强确认', '系统已锁住任务', '我已经调用过 SHEIN 写接口', '系统已经把内部检查结果收口到聊天里', '请按聊天里的缺口继续']) {
  ok(!portalServer.includes(phrase), `BI ops server should not carry cross-entry wording: ${phrase}`);
}
ok(portalServer.includes('stripLinkOpsInternalLeakLines'), 'server no longer strips only the leaking internal lines');
ok(portalServer.includes('fallbackLinkOpsClientText'), 'server lacks a user-facing fallback when a whole answer is internal noise');
ok(client.includes('[一二三四五六七八九十]+、') || client.includes('一二三四五六七八九十'), 'Markdown parser does not recognize Chinese ordered lists');
ok(client.includes('blockquote') && client.includes('opsMarkdownTable'), 'Markdown parser lacks blockquote/table support');

for (const cls of ['.ops-busy-banner', '.ops-evidence-item', '.ops-upload-label.disabled', '.ops-upload-picker .ops-upload-input', '.ops-assets', '.ops-asset-pill', '.ops-md-table-wrap', '.ops-task-control.conversational', '.ops-task-card.progress-only', '.ops-session.pending']) {
  ok(css.includes(cls), `missing CSS selector ${cls}`);
}
ok(/\.ops-task-evidence\{[^}]*grid-template-columns:repeat\(auto-fit,minmax/.test(css), 'task evidence is not grid-based');
ok(/\.ops-task-card \.ops-task-evidence span[^}]*max-width:100%!important/.test(css), 'generic task-card span clamp still applies to evidence chips');
ok(css.includes('overflow-x:hidden!important'), 'right rail horizontal overflow guard missing');
ok(css.includes('blockquote') && css.includes('.ops-markdown table'), 'Markdown visual styles missing');
ok(css.includes('.ops-msg.user .ops-markdown{color:#fffaf0}'), 'user chat bubble Markdown text color override missing');
ok(css.includes('.ops-msg.user .ops-markdown strong{color:#fff}'), 'user chat bubble strong text override missing');

if (failures.length) {
  console.error(JSON.stringify({ok: false, failures}, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ok: true, checked: 'bi ops confirm feedback frontend static smoke'}, null, 2));
