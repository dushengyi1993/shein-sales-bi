#!/usr/bin/env node
/**
 * SHEIN BI Ops CLI.
 *
 * A small client for Codex Desktop / local operators to drive the cloud BI
 * automation workbench through the same account, permission, and audit boundary
 * as the web UI. It never stores plaintext passwords; `login` stores only the
 * server session cookie in the user's profile or in `--session-file`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  BI_OPS_CLI_VERSION,
  DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR,
  ensurePartnerKnowledgeCurrent,
} from '../lib/partner_knowledge_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.SHEIN_BI_BASE_URL || 'https://sa.dushengyi.cc';
const DEFAULT_SESSION_FILE = process.env.SHEIN_BI_OPS_SESSION_FILE
  || path.join(os.homedir(), '.shein-bi', 'ops-session.json');
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const LOCAL_OPENAPI_TEST_OVERRIDE = process.env.SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR === '1';

function parseArgs(argv) {
  const args = {
    command: '',
    baseUrl: DEFAULT_BASE_URL,
    sessionFile: DEFAULT_SESSION_FILE,
    username: process.env.SHEIN_BI_USERNAME || '',
    password: process.env.SHEIN_BI_PASSWORD || '',
    taskId: '',
    jobId: '',
    chatSessionId: '',
    text: '',
    profile: '',
    askAgent: true,
    stores: [],
    sourceStores: [],
    writeStores: [],
    products: [],
    spuList: [],
    skcList: [],
    skuCodeList: [],
    supplierSkuList: [],
    operation: '',
    mode: 'dry-run',
    confirm: '',
    status: '',
    globalView: false,
    waitSeconds: 0,
    note: '',
    docEvidenceFile: '',
    storeProbeFile: '',
    readbackEvidenceFile: '',
    expect: '',
    limit: 40,
    json: true,
    passwordStdin: false,
    requireRealSubmit: false,
    imageFile: '',
    imageUrl: '',
    imageType: 0,
    imageDir: '',
    outputFile: '',
    openapiConfigFile: '',
    openapiStoreTruthFile: '',
    format: '',
    queryJson: '',
    queryFile: '',
    categoryId: '',
    pageNum: 1,
    pageSize: 10,
    languageList: [],
    version: '',
    payloadHash: '',
    orderNo: '',
    handleType: 1,
    expressCode: '',
    expressIdCode: '',
    expressChannelCode: '',
    goodsId: '',
    goodsIds: [],
    preRequestId: '',
    packageNo: [],
    deliveryNo: '',
    docId: '',
    endpoint: '',
    bodyJson: '',
    bodyFile: '',
    performanceDate: '',
    knowledgeCacheDir: process.env.SHEIN_BI_KNOWLEDGE_CACHE_DIR || DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-url') args.baseUrl = String(argv[++i] || '').trim();
    else if (a === '--session-file') args.sessionFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--username' || a === '-u') args.username = String(argv[++i] || '').trim();
    else if (a === '--password' || a === '-p') args.password = String(argv[++i] || '');
    else if (a === '--password-stdin') args.passwordStdin = true;
    else if (a === '--task-id' || a === '--id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--job-id') args.jobId = String(argv[++i] || '').trim();
    else if (a === '--chat-session' || a === '--chat-session-id') args.chatSessionId = String(argv[++i] || '').trim();
    else if (a === '--text' || a === '--command') args.text = String(argv[++i] || '').trim();
    else if (a === '--profile' || a === '--model-profile') args.profile = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--no-agent') args.askAgent = false;
    else if (a === '--store' || a === '--stores') args.stores.push(...splitList(argv[++i]));
    else if (a === '--source-store' || a === '--source-stores' || a === '--read-store' || a === '--read-stores') args.sourceStores.push(...splitList(argv[++i]));
    else if (a === '--target-store' || a === '--target-stores' || a === '--write-store' || a === '--write-stores') args.writeStores.push(...splitList(argv[++i]));
    else if (a === '--product' || a === '--products' || a === '--ref') args.products.push(...splitList(argv[++i]));
    else if (a === '--spu' || a === '--spu-name') args.spuList.push(...splitList(argv[++i]));
    else if (a === '--skc' || a === '--skc-name') args.skcList.push(...splitList(argv[++i]));
    else if (a === '--sku-code') args.skuCodeList.push(...splitList(argv[++i]));
    else if (a === '--supplier-sku') args.supplierSkuList.push(...splitList(argv[++i]));
    else if (a === '--operation' || a === '--action' || a === '--intent') args.operation = normalizeOperationName(argv[++i]);
    else if (a === '--mode') args.mode = String(argv[++i] || 'dry-run').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--status') args.status = String(argv[++i] || '').trim();
    else if (a === '--all' || a === '--scope-all') args.globalView = true;
    else if (a === '--wait-seconds') args.waitSeconds = Number(argv[++i] || 0);
    else if (a === '--note') args.note = String(argv[++i] || '').trim();
    else if (a === '--doc-evidence') args.docEvidenceFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-probe') args.storeProbeFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--readback-evidence') args.readbackEvidenceFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--expect') args.expect = String(argv[++i] || '').trim();
    else if (a === '--limit') args.limit = Number(argv[++i] || 40);
    else if (a === '--pretty') args.json = false;
    else if (a === '--require-real-submit' || a === '--require-execute') args.requireRealSubmit = true;
    else if (a === '--file' || a === '--image-file') args.imageFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--url' || a === '--image-url') args.imageUrl = String(argv[++i] || '').trim();
    else if (a === '--image-type' || a === '--type') args.imageType = Number(argv[++i] || 0);
    else if (a === '--image-dir' || a === '--dir') args.imageDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--out' || a === '--output') args.outputFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--format') args.format = String(argv[++i] || '').trim();
    else if (a === '--openapi-config') args.openapiConfigFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-truth' || a === '--openapi-store-truth') args.openapiStoreTruthFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--category' || a === '--category-id') args.categoryId = String(argv[++i] || '').trim();
    else if (a === '--page' || a === '--page-num') args.pageNum = Number(argv[++i] || 1);
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || 10);
    else if (a === '--language' || a === '--languages') args.languageList.push(...splitList(argv[++i]).map(x => x.toLowerCase()));
    else if (a === '--version') args.version = String(argv[++i] || '').trim();
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--order-no' || a === '--order') args.orderNo = String(argv[++i] || '').trim();
    else if (a === '--handle-type') args.handleType = Number(argv[++i] || 1);
    else if (a === '--express-code') args.expressCode = String(argv[++i] || '').trim();
    else if (a === '--express-id-code') args.expressIdCode = String(argv[++i] || '').trim();
    else if (a === '--express-channel-code') args.expressChannelCode = String(argv[++i] || '').trim();
    else if (a === '--goods-id') args.goodsId = String(argv[++i] || '').trim();
    else if (a === '--goods-ids') args.goodsIds.push(...splitList(argv[++i]));
    else if (a === '--pre-request-id') args.preRequestId = String(argv[++i] || '').trim();
    else if (a === '--package-no' || a === '--package-nos') args.packageNo.push(...splitList(argv[++i]));
    else if (a === '--delivery-no') args.deliveryNo = String(argv[++i] || '').trim();
    else if (a === '--doc-id' || a === '--docId') args.docId = String(argv[++i] || '').trim();
    else if (a === '--endpoint') args.endpoint = String(argv[++i] || '').trim();
    else if (a === '--body-json') args.bodyJson = String(argv[++i] || '');
    else if (a === '--body-file') args.bodyFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--performance-date' || a === '--perf-date') args.performanceDate = String(argv[++i] || '').trim();
    else if (a === '--knowledge-cache-dir') args.knowledgeCacheDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--query-json') args.queryJson = String(argv[++i] || '');
    else if (a === '--query-file') args.queryFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (!args.command) {
      args.command = a;
    } else {
      rest.push(a);
    }
  }
  if (!args.text && rest.length) args.text = rest.join(' ').trim();
  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.command ||= 'help';
  return args;
}

function normalizeOperationName(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = new Map([
    ['copy', 'copy_product_draft'],
    ['copy_product', 'copy_product_draft'],
    ['copy_draft', 'copy_product_draft'],
    ['create_link', 'copy_product_draft'],
    ['publish', 'copy_product_draft'],
    ['retire', 'retire_link'],
    ['retire_product', 'retire_link'],
    ['down', 'retire_link'],
    ['off_shelf', 'retire_link'],
    ['offline', 'retire_link'],
    ['activate', 'activate_link'],
    ['activate_product', 'activate_link'],
    ['up', 'activate_link'],
    ['on_shelf', 'activate_link'],
    ['online', 'activate_link'],
    ['relist', 'activate_link'],
    ['restore_listing', 'activate_link'],
    ['title', 'update_title'],
    ['image', 'update_images'],
    ['images', 'update_images'],
    ['photo', 'update_images'],
    ['photos', 'update_images'],
  ]);
  return aliases.get(lower) || lower;
}

function splitList(value) {
  return String(value || '')
    .split(/[,\s/]+/)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

function help() {
  return `SHEIN BI Ops CLI

Usage:
  node scripts/bi_ops_cli.mjs login --username <账号> --password <密码>
  node scripts/bi_ops_cli.mjs doctor
  node scripts/bi_ops_cli.mjs knowledge-status
  node scripts/bi_ops_cli.mjs version
  node scripts/bi_ops_cli.mjs doctor --operation copy_product_draft --target-stores HL
  node scripts/bi_ops_cli.mjs doctor --operation activate_link --stores DL --require-real-submit
  node scripts/bi_ops_cli.mjs doctor --operation retire_link --stores DL --require-real-submit
  node scripts/bi_ops_cli.mjs me
  node scripts/bi_ops_cli.mjs capabilities
  node scripts/bi_ops_cli.mjs maintenance-readiness --operation retire_link --expect blocked
  node scripts/bi_ops_cli.mjs maintenance-readiness --operation retire_link --doc-evidence <schema.json> --store-probe <probe.json> --readback-evidence <readback.json> --expect pilot_ready
  node scripts/bi_ops_cli.mjs plan-images --image-dir <图片文件夹> [--out roles.json]
  node scripts/bi_ops_cli.mjs retire-candidates --file <v3-times.csv> --performance-date 2026-07-04 [--out <dir>]
  node scripts/bi_ops_cli.mjs upload-pic --store FY --image-type 2 --file <image.jpg> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs transform-pic --store FY --image-type 2 --url <https://...> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs audit-status --store FY --spu <SPU> [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs search-product --store FY [--spu <SPU>|--product <货号>] [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs publish-standard --store FY [--category <id>] [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs shelf-quota --store FY [--mode dry-run|execute]
  node scripts/bi_ops_cli.mjs order-fulfillment --operation export-address --store FY --order-no <order>
  node scripts/bi_ops_cli.mjs openapi-call --doc-id <docId> --store FY --body-json '{}'
  node scripts/bi_ops_cli.mjs openapi-call --doc-id <GET docId> --store FY --query-json '{"id":"..."}'
  node scripts/bi_ops_cli.mjs openapi-catalog-plan --format summary [--out plan.json]
  node scripts/bi_ops_cli.mjs ask --text "今天全部店铺销售额是多少"
  node scripts/bi_ops_cli.mjs chats
  node scripts/bi_ops_cli.mjs chat --text "把 DX 的 PA4-6L 库存改成 30"
  node scripts/bi_ops_cli.mjs chat --chat-session <id> --text "先做系统检查，不要提交"
  node scripts/bi_ops_cli.mjs chat --text "把 DX 的 PA4-6L 库存改成 30" --wait-seconds 120
  node scripts/bi_ops_cli.mjs jobs [--status queued|running|succeeded|failed|uncertain_write]
  node scripts/bi_ops_cli.mjs job --job-id <id>
  node scripts/bi_ops_cli.mjs wait-job --job-id <id> [--wait-seconds 120]
  node scripts/bi_ops_cli.mjs tasks
  node scripts/bi_ops_cli.mjs create --text "把 520a 在 DL 生成下架预检" --stores DL --products 520a
  node scripts/bi_ops_cli.mjs create --text "复制 CX 的 SM-961 到 HL" --source-stores CX --target-stores HL --products SM-961
  node scripts/bi_ops_cli.mjs preflight --task-id <id>
  node scripts/bi_ops_cli.mjs execute --task-id <id> --confirm ${SUBMIT_CONFIRM_TEXT}
  node scripts/bi_ops_cli.mjs resolve --task-id <id> --status done --note "人工确认已闭环"
  node scripts/bi_ops_cli.mjs audit --task-id <id>
  node scripts/bi_ops_cli.mjs logout

Codex App example:
  请调用 node scripts/bi_ops_cli.mjs create --stores DL --products 520a --text "把 DL 的 520a 做下架预检"

Options:
  --base-url       默认 ${DEFAULT_BASE_URL}
  --session-file   默认 ${DEFAULT_SESSION_FILE}
  --knowledge-cache-dir  默认 ${DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR}
  --source-stores  跨店复制时只读来源店铺
  --target-stores  跨店复制时真实写入目标店铺；不填则沿用 --stores
  --chat-session   chat/tasks 用；继续指定的自动运营会话
  --profile        Owner 可选 fast / balanced / deep / owner；服务端仍会按风险升级且不会因此绕过权限
  --no-agent       chat 用；只走确定性意图/任务规则，不调用模型
  --wait-seconds   chat/wait-job 用；等待后台结构化规划完成的最长秒数
  --scope-all      Owner 的 jobs 全局只读视图；不会扩大写权限
  --operation      doctor 用；可填 copy_product_draft / activate_link / retire_link / update_title / update_images / update_inventory / update_supply_price / update_product_price / certificate_review
  --require-real-submit  doctor 用；要求所选店铺+动作已可真实提交，否则退出非 0
  --doc-evidence / --store-probe / --readback-evidence
                   maintenance-readiness 用；维护真实写的脱敏证据文件
  --expect         maintenance-readiness 用；blocked / schema_ready / pilot_ready
  --image-dir      plan-images 用；只扫描本地图包并输出角色规划，不上传、不提交
  --performance-date retire-candidates 用；按该表现日期计算首次上架 15 天保护窗
  --file / --url   图片工具用；本地文件或外链图片地址
  --image-type     图片工具用；1主图 / 2细节图 / 5方块图 / 6色块图 / 7详情图
  --openapi-config 底层 OpenAPI executor 测试用；日常 bi_ops_cli 不允许用它从本机直连真实 SHEIN
  --store-truth    底层 OpenAPI executor 测试用；默认 config/store_account_truth.json
  --category       publish-standard/search-product 用；末级分类 ID
  --page-size      search-product 用；最大 10

Safety:
  - 密码只用于 login 请求，不写入 session 文件。
  - doctor 只做本机/云端连通性和权限自检，不创建任务、不触发预检、不执行 SHEIN 写。
  - maintenance-readiness 只读检查脱敏证据，不连接 SHEIN，不打开真实写。
  - plan-images 只做本地图包角色规划，备用目录和“产品封面/AB测试”图不提交。
  - retire-candidates 只生成下架候选明细，不执行下架；固定排除有新品标签、首次上架 15 天内或缺首次上架时间的链接，并要求人工确认。
  - 本机因白名单/身份边界不能直连真实 SHEIN OpenAPI；bi_ops_cli 的真实 OpenAPI 调用必须走云端 BI 服务。
  - upload-pic / transform-pic 的 execute 委托云端 /api/openapi-image-asset/*；本地只做文件封装和权限会话传递。
  - audit-status / search-product / publish-standard / openapi-call 不允许通过 bi_ops_cli 从本机 execute；需要真实回读时到 shein-bi-tencent 云端执行或走云端任务审计。
  - order-fulfillment 是高风险订单履约工具；execute 必须额外提供确认文本和 dry-run payload hash。
  - openapi-call 是目录驱动 JSON 兜底工具；GET 用 --query-json/--query-file，POST 用 --body-json/--body-file；文件上传/WebHook 会被阻断，真实 execute 只能在云端边界内使用。
  - openapi-catalog-plan 只读取本地官方目录/schema，输出全量接口归位矩阵，不联网、不启用 WebHook receiver。
  - 所有任务创建/预检/执行/审计都走云端账号权限和审计。
  - ask/chat 通过同一 BI 账号、会话归属、模型限流和审计边界；profile 只影响理解深度，不改变写权限。
  - 每个云端业务命令开始前会用 ETag 检查负责人规则 manifest；有更新才原子下载，普通账号没有反向发布权限。
  - execute 仍需服务端确认任务已预检通过，并且确认文本精确匹配。
  - resolve 只用于已提交待回读/需人工处理任务的人工核销；服务端只允许全店管理账号执行。`;
}

async function readSession(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function writeSession(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
}

async function readStdinText() {
  let out = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function promptLine(prompt) {
  process.stdout.write(prompt);
  const text = await readStdinText();
  return text.split(/\r?\n/)[0] || '';
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return promptLine(prompt);
  }
  return await new Promise(resolve => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        if (value.length) value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    process.stdin.on('data', onData);
  });
}

function cookieFromSetCookie(headers) {
  const raw = headers.get('set-cookie') || '';
  return raw.split(';')[0].trim();
}

async function request(args, pathname, {method = 'GET', body, auth = true} = {}) {
  const headers = {'accept': 'application/json', 'user-agent': 'shein-bi-ops-cli/1.0'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const session = await readSession(args.sessionFile);
    if (session.cookie) headers.cookie = session.cookie;
  }
  const res = await fetch(`${args.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {raw: text};
  }
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = json;
    throw err;
  }
  return {json, res};
}

const KNOWLEDGE_CHECK_COMMANDS = new Set([
  'doctor', 'me', 'capabilities', 'ask', 'chats', 'jobs', 'job', 'wait-job', 'wait_job',
  'chat', 'tasks', 'create', 'preflight', 'execute', 'resolve', 'audit',
  'upload-pic', 'upload_pic', 'transform-pic', 'transform_pic',
]);

async function refreshPartnerKnowledge(args, {strict = false} = {}) {
  const session = await readSession(args.sessionFile);
  if (!session.cookie) {
    if (strict) throw new Error('尚未登录 BI，无法检查负责人规则版本');
    return {ok: false, skipped: true, warning: '尚未登录 BI'};
  }
  const result = await ensurePartnerKnowledgeCurrent({
    baseUrl: args.baseUrl,
    cookie: session.cookie,
    cacheDir: args.knowledgeCacheDir,
    cliVersion: BI_OPS_CLI_VERSION,
    strict,
  });
  if (result.updated) {
    process.stderr.write(`负责人规则已更新并校验：${String(result.manifest?.sourceCommit || result.manifest?.fingerprint || '').slice(0, 12)}\n`);
  }
  if (result.warning) {
    process.stderr.write(`负责人规则检查提示：${result.warning}\n`);
  }
  if (result.cliUpdateRecommended) {
    process.stderr.write(`CLI 有推荐更新：当前 ${BI_OPS_CLI_VERSION}，推荐 ${result.recommendedCliVersion}\n`);
  }
  return result;
}

function print(data, pretty = false) {
  if (!pretty) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data?.tasks)) {
    for (const task of data.tasks) {
      console.log(`${task.id}\t${task.status}\t${(task.targets?.stores || []).join('/')}\t${task.preview?.summary || task.command || ''}`);
    }
    return;
  }
  if (Array.isArray(data?.rows) && data?.counts) {
    const safe = data?.safety?.safeWriteOperations || {};
    const whitelist = data?.safety?.realSubmitWhitelist || {};
    console.log(`OpenAPI 总账：${data.counts.apiConnected ?? data.counts.authorized ?? 0}/${data.counts.total || data.rows.length} API 已接通，${data.counts.writePrecheckReady || 0} 店可系统检查，${data.counts.actorControlledSubmitReady ?? 0} 店当前账号可受控提交`);
    console.log(`真实写总闸门：${safe.enabled ? '开启' : '关闭'}；真实写试点白名单：${whitelist.enabled ? `开启(${whitelist.ruleCount || 0}条)` : '关闭'}；真实提交仍必须命中 人 + 店 + 动作 白名单`);
    for (const row of data.rows) {
      const actions = (Array.isArray(row.actionCapabilities) ? row.actionCapabilities : [])
        .map(action => {
          const state = action.realSubmitSupported ? '可真提交' : (action.precheckSupported ? '仅预检' : '任务池');
          const blockers = Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
            ? `；缺口=${action.realSubmitBlockers.join('/')}`
            : '';
          return `${action.label}:${state}${blockers}`;
        })
        .join(' | ');
      const wl = row.realSubmitWhitelist || {};
      const wlText = wl.enabled ? (wl.configured ? `白名单命中${wl.matchedRuleCount || 0}` : '白名单未命中') : '白名单关闭';
      console.log(`${row.storeKey}\t${row.status || '-'}\t${wlText}\t${actions}`);
    }
    return;
  }
  if (Array.isArray(data?.checks) && data?.generatedAt) {
    console.log(`BI Ops Doctor：${data.ok ? '通过' : '未通过'}  ${data.baseUrl || ''}`);
    if (data.user) {
      console.log(`当前账号：${data.user.username || '-'} · ${data.user.displayName || '-'} · ${data.user.role || '-'}`);
      console.log(`写权限：${Array.isArray(data.user.writeStores) ? data.user.writeStores.join(',') : '-'}`);
    }
    if (data.counts) {
      console.log(`OpenAPI：${data.counts.apiConnected ?? data.counts.authorized ?? 0}/${data.counts.total || 0} API 已接通，${data.counts.writePrecheckReady || 0} 可系统检查，${data.counts.actorControlledSubmitReady ?? 0} 当前账号可受控提交`);
    }
    const safe = data.safety?.safeWriteOperations || {};
    const whitelist = data.safety?.realSubmitWhitelist || {};
    console.log(`真实写：总闸门=${safe.enabled ? '开启' : '关闭'}，试点白名单=${whitelist.enabled ? `开启(${whitelist.ruleCount || 0}条)` : '关闭'}，静默写=${data.safety?.canSilentWrite ? '是' : '否'}`);
    if (data.requestedActionReadiness) {
      const readiness = data.requestedActionReadiness;
      console.log(`动作诊断：${readiness.operation} · ${readiness.requireRealSubmit ? '要求真实提交' : '要求可 dry-run'} · dry-run=${readiness.allCanDryRun ? '是' : '否'} · 真实提交=${readiness.allCanRealSubmitAfterPreflight ? '是' : '否'}`);
      for (const item of readiness.items || []) {
        const blockerText = Array.isArray(item.blockers) && item.blockers.length ? `；阻断=${item.blockers.join('/')}` : '';
        console.log(`  - ${item.storeKey}: 建任务=${item.canCreateTask ? '是' : '否'}，dry-run=${item.canDryRun ? '是' : '否'}，真实提交=${item.canRealSubmitAfterPreflight ? '是' : '否'}${blockerText}`);
      }
    }
    for (const check of data.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.label}${check.error ? `：${check.error}` : ''}`);
    }
    console.log(data.nextStep || '');
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function mimeForImageFile(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function fileToCloudUploadBody(file) {
  const abs = path.resolve(String(file || ''));
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  const bytes = await fs.readFile(abs);
  return {
    name: path.basename(abs),
    type: mimeForImageFile(abs),
    size: bytes.length,
    dataBase64: bytes.toString('base64'),
  };
}

function taskTargets(args) {
  const targets = {};
  if (args.stores.length) targets.stores = [...new Set(args.stores)];
  if (args.sourceStores.length) targets.sourceStores = [...new Set(args.sourceStores)];
  if (args.writeStores.length) targets.writeStores = [...new Set(args.writeStores)];
  if (args.products.length) targets.productRefs = [...new Set(args.products)];
  return targets;
}

function hasStoreAccess(user, field, storeKey) {
  const list = Array.isArray(user?.[field]) ? user[field].map(x => String(x || '').trim().toUpperCase()).filter(Boolean) : [];
  return list.includes('*') || list.includes(String(storeKey || '').trim().toUpperCase());
}

function requestedDoctorStores(args, capabilitiesJson) {
  const explicit = [...new Set([
    ...(args.writeStores || []),
    ...(args.stores || []),
  ].map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  if (explicit.length) return explicit;
  if (!args.operation) return [];
  return (Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [])
    .map(row => String(row.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
}

function buildActionReadiness(args, meJson, capabilitiesJson) {
  if (!args.operation) return null;
  const rows = Array.isArray(capabilitiesJson?.rows) ? capabilitiesJson.rows : [];
  const rowsByStore = new Map(rows.map(row => [String(row.storeKey || '').trim().toUpperCase(), row]));
  const user = meJson?.user || {};
  const sourceStores = [...new Set((args.sourceStores || []).map(x => String(x || '').trim().toUpperCase()).filter(Boolean))];
  const stores = requestedDoctorStores(args, capabilitiesJson);
  const items = stores.map(storeKey => {
    const row = rowsByStore.get(storeKey) || null;
    const actions = Array.isArray(row?.actionCapabilities) ? row.actionCapabilities : [];
    const action = actions.find(x => String(x.key || x.intent || '').trim() === args.operation) || null;
    const accountCanWrite = hasStoreAccess(user, 'writeStores', storeKey);
    const accountCanReadTargets = hasStoreAccess(user, 'readStores', storeKey);
    const unreadableSources = sourceStores.filter(src => !hasStoreAccess(user, 'readStores', src));
    const sourceReadable = unreadableSources.length === 0;
    const precheckSupported = Boolean(action?.precheckSupported);
    const realSubmitSupported = Boolean(action?.realSubmitSupported);
    const blockers = [];
    if (!row) blockers.push('能力总账里没有这个店铺');
    if (row && !action) blockers.push(`能力总账里没有动作 ${args.operation}`);
    if (!accountCanReadTargets) blockers.push('当前账号没有目标店铺读权限');
    if (!accountCanWrite) blockers.push('当前账号没有目标店铺写权限');
    if (!sourceReadable) blockers.push(`当前账号没有来源店铺读权限：${unreadableSources.join(',')}`);
    if (action && !precheckSupported) blockers.push('该动作当前不支持自动预检');
    if (action && precheckSupported && !realSubmitSupported) blockers.push(...(Array.isArray(action.realSubmitBlockers) && action.realSubmitBlockers.length
      ? action.realSubmitBlockers
      : ['该动作当前只支持 dry-run/预检，不支持真实提交']));
    const canCreateTask = accountCanWrite && accountCanReadTargets && sourceReadable;
    const canDryRun = canCreateTask && precheckSupported;
    const canRealSubmitAfterPreflight = canDryRun && realSubmitSupported;
    return {
      storeKey,
      operation: args.operation,
      accountCanWrite,
      accountCanReadTargets,
      sourceStores,
      sourceReadable,
      precheckSupported,
      realSubmitSupported,
      canCreateTask,
      canDryRun,
      canRealSubmitAfterPreflight,
      state: action?.state || '',
      reason: action?.reason || row?.note || '',
      nextStep: action?.nextStep || '',
      blockers: [...new Set(blockers)],
    };
  });
  const allCanRealSubmit = items.length > 0 && items.every(x => x.canRealSubmitAfterPreflight);
  const allCanDryRun = items.length > 0 && items.every(x => x.canDryRun);
  return {
    operation: args.operation,
    requestedStores: stores,
    requireRealSubmit: args.requireRealSubmit,
    allCanDryRun,
    allCanRealSubmitAfterPreflight: allCanRealSubmit,
    okForRequestedLevel: args.requireRealSubmit ? allCanRealSubmit : allCanDryRun,
    items,
  };
}

async function doctorCheck(label, fn, {critical = true} = {}) {
  try {
    const value = await fn();
    return {label, ok: true, critical, ...value};
  } catch (err) {
    return {
      label,
      ok: false,
      critical,
      error: err?.message || String(err),
      status: err?.status || null,
      response: err?.response ? {
        ok: err.response.ok,
        error: err.response.error || '',
        status: err.response.status || null,
      } : null,
    };
  }
}

async function runDoctor(args) {
  const checks = [];
  const nodeMajor = Number(String(process.versions.node || '').split('.')[0] || 0);
  const session = await readSession(args.sessionFile);
  let sessionText = '';
  try {
    sessionText = await fs.readFile(args.sessionFile, 'utf8');
  } catch {}

  checks.push({
    label: 'local-node',
    ok: nodeMajor >= 20,
    critical: true,
    node: process.version,
    message: nodeMajor >= 20 ? 'Node.js 版本符合建议要求。' : '建议安装 Node.js 20 或更高版本。',
  });
  checks.push({
    label: 'session-file',
    ok: Boolean(session.cookie),
    critical: true,
    sessionFile: args.sessionFile,
    exists: Boolean(sessionText),
    baseUrl: session.baseUrl || '',
    savedAt: session.savedAt || '',
    storesPlaintextPassword: /"password"\s*:|password=|owner-cli-pass|operator-cli-pass/i.test(sessionText),
  });
  if (checks.at(-1).storesPlaintextPassword) checks.at(-1).ok = false;

  let meJson = null;
  let capabilitiesJson = null;
  checks.push(await doctorCheck('auth-me', async () => {
    const {json} = await request(args, '/api/auth/me');
    meJson = json;
    const user = json.user || {};
    return {
      username: user.username || '',
      displayName: user.displayName || '',
      role: user.role || '',
      readStores: user.readStores || [],
      writeStores: user.writeStores || [],
    };
  }));
  checks.push(await doctorCheck('openapi-capabilities', async () => {
    const {json} = await request(args, '/api/openapi-capabilities');
    capabilitiesJson = json;
    return {
      totalStores: json.counts?.total || json.rows?.length || 0,
      authorizedStores: json.counts?.authorized || 0,
      readReadyStores: json.counts?.readReady || 0,
      writeConfirmableStores: json.counts?.writeConfirmable || 0,
      safeWriteEnabled: Boolean(json.safety?.safeWriteOperations?.enabled),
      realSubmitWhitelistEnabled: Boolean(json.safety?.realSubmitWhitelist?.enabled),
      canSilentWrite: Boolean(json.safety?.canSilentWrite),
    };
  }));
  checks.push(await doctorCheck('task-pool', async () => {
    const {json} = await request(args, '/api/link-ops-tasks?limit=1');
    return {
      reachable: true,
      taskCountVisible: Array.isArray(json.data?.tasks) ? json.data.tasks.length : 0,
    };
  }));

  const actionReadiness = buildActionReadiness(args, meJson, capabilitiesJson);
  if (actionReadiness) {
    checks.push({
      label: args.requireRealSubmit ? 'action-real-submit-readiness' : 'action-dry-run-readiness',
      ok: actionReadiness.okForRequestedLevel,
      critical: Boolean(args.requireRealSubmit),
      operation: actionReadiness.operation,
      requestedStores: actionReadiness.requestedStores,
      allCanDryRun: actionReadiness.allCanDryRun,
      allCanRealSubmitAfterPreflight: actionReadiness.allCanRealSubmitAfterPreflight,
    });
  }

  const ok = checks.every(check => check.ok || !check.critical);
  return {
    ok,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    sessionFile: args.sessionFile,
    user: meJson?.user || null,
    safety: capabilitiesJson?.safety ? {
      safeWriteOperations: capabilitiesJson.safety.safeWriteOperations,
      realSubmitWhitelist: capabilitiesJson.safety.realSubmitWhitelist,
      canSilentWrite: Boolean(capabilitiesJson.safety.canSilentWrite),
    } : null,
    counts: capabilitiesJson?.counts || null,
    requestedActionReadiness: actionReadiness,
    checks,
    nextStep: ok
      ? (actionReadiness
        ? (actionReadiness.okForRequestedLevel
          ? '所选账号/店铺/动作达到请求的可用级别；真实提交仍必须先 dry-run、进入待复核、输入确认文本并通过服务端回读。'
          : '本机 CLI 连通正常，但所选账号/店铺/动作没有达到请求的可用级别；查看 requestedActionReadiness.items[].blockers。')
        : '本机 CLI 到云端 BI 的账号、权限和只读接口自检通过。创建/预检/执行仍按服务端权限、确认文本和审计边界执行。')
      : '按 failed checks 处理：通常是未登录、session 过期、Node 版本过低或云端接口不可达。',
  };
}

function runLocalNodeScript(scriptRel, scriptArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptRel, ...scriptArgs], {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function assertLocalOpenApiExecutorAllowed(args, action, {allowDryRunForTests = true} = {}) {
  const mode = args.mode || 'dry-run';
  if (LOCAL_OPENAPI_TEST_OVERRIDE && (allowDryRunForTests || mode === 'dry-run')) return;
  if (mode === 'dry-run' && allowDryRunForTests && (args.openapiConfigFile || args.openapiStoreTruthFile)) {
    throw new Error(`${action} dry-run with --openapi-config is a bottom-level adapter smoke-test path. Set SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR=1 only for fake OpenAPI tests; do not use bi_ops_cli to prepare real SHEIN calls locally.`);
  }
  throw new Error(`${action} cannot run local SHEIN OpenAPI through bi_ops_cli. This machine is outside the SHEIN OpenAPI whitelist boundary; use the shein-bi-tencent cloud BI executor for real upload/submit/readback.`);
}

async function runMaintenanceReadiness(args) {
  const commandArgs = ['--operation', args.operation || 'retire_link'];
  if (args.docEvidenceFile) commandArgs.push('--doc-evidence', args.docEvidenceFile);
  if (args.storeProbeFile) commandArgs.push('--store-probe', args.storeProbeFile);
  if (args.readbackEvidenceFile) commandArgs.push('--readback-evidence', args.readbackEvidenceFile);
  if (args.expect) commandArgs.push('--expect', args.expect);
  if (!args.json) commandArgs.push('--pretty');
  const result = await runLocalNodeScript('scripts/check_bi_ops_maintenance_readiness.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runImageAssetExecutor(args, action) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error(`${action} requires --store <店铺>`);
  if (!args.imageType) throw new Error(`${action} requires --image-type <1|2|5|6|7>`);
  const mode = args.mode || 'dry-run';
  const shouldUseCloud = mode === 'execute' && !args.openapiConfigFile && !args.openapiStoreTruthFile;
  if (shouldUseCloud) {
    const body = {store, imageType: args.imageType};
    if (action === 'upload-pic') {
      if (!args.imageFile) throw new Error('upload-pic requires --file <image.jpg|png>');
      body.file = await fileToCloudUploadBody(args.imageFile);
    } else {
      if (!args.imageUrl) throw new Error('transform-pic requires --url <https://...>');
      body.url = args.imageUrl;
    }
    const {json} = await request(args, `/api/openapi-image-asset/${action}`, {
      method: 'POST',
      body,
    });
    print(json);
    return;
  }
  assertLocalOpenApiExecutorAllowed(args, action);
  const commandArgs = [action, '--store', store, '--image-type', String(args.imageType), '--mode', args.mode || 'dry-run'];
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (action === 'upload-pic') {
    if (!args.imageFile) throw new Error('upload-pic requires --file <image.jpg|png>');
    commandArgs.push('--file', args.imageFile);
  } else {
    if (!args.imageUrl) throw new Error('transform-pic requires --url <https://...>');
    commandArgs.push('--url', args.imageUrl);
  }
  const result = await runLocalNodeScript('scripts/openapi_image_asset_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runPlanImages(args) {
  if (!args.imageDir) throw new Error('plan-images requires --image-dir <图片文件夹>');
  const commandArgs = ['--dir', args.imageDir];
  if (args.outputFile) commandArgs.push('--out', args.outputFile);
  if (!args.json) commandArgs.push('--pretty');
  const result = await runLocalNodeScript('scripts/link_ops_plan_image_roles.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runRetireCandidates(args) {
  if (!args.imageFile) throw new Error('retire-candidates requires --file <enriched candidate csv>');
  const commandArgs = ['--input', args.imageFile];
  if (args.outputFile) commandArgs.push('--out-dir', args.outputFile);
  if (args.performanceDate) commandArgs.push('--performance-date', args.performanceDate);
  const result = await runLocalNodeScript('scripts/build_link_retire_candidates_from_csv.mjs', commandArgs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exitCode = result.code;
}

async function runReadonlyExecutor(args, action) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error(`${action} requires --store <店铺>`);
  assertLocalOpenApiExecutorAllowed(args, action);
  const commandArgs = [action, '--store', store, '--mode', args.mode || 'dry-run'];
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (args.categoryId) commandArgs.push('--category', args.categoryId);
  if (args.pageNum) commandArgs.push('--page', String(args.pageNum));
  if (args.pageSize) commandArgs.push('--page-size', String(args.pageSize));
  if (args.languageList.length) commandArgs.push('--language', args.languageList.join(','));
  if (args.version) commandArgs.push('--version', args.version);
  for (const spu of args.spuList || []) commandArgs.push('--spu', spu);
  for (const skc of args.skcList || []) commandArgs.push('--skc', skc);
  for (const skuCode of args.skuCodeList || []) commandArgs.push('--sku-code', skuCode);
  for (const supplierSku of args.supplierSkuList || []) commandArgs.push('--supplier-sku', supplierSku);
  for (const product of args.products || []) {
    if (action === 'search-product') commandArgs.push('--supplier-code', product);
    else commandArgs.push('--spu', product);
  }
  const result = await runLocalNodeScript('scripts/openapi_readonly_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runOrderFulfillmentExecutor(args) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error('order-fulfillment requires --store <店铺>');
  if (!args.operation) throw new Error('order-fulfillment requires --operation <export-address|import-express|place-express-order|print-express-info>');
  assertLocalOpenApiExecutorAllowed(args, 'order-fulfillment', {allowDryRunForTests: false});
  const commandArgs = [args.operation, '--store', store, '--mode', args.mode || 'dry-run'];
  if (args.confirm) commandArgs.push('--confirm', args.confirm);
  if (args.payloadHash) commandArgs.push('--payload-hash', args.payloadHash);
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  if (args.orderNo) commandArgs.push('--order-no', args.orderNo);
  if (args.handleType) commandArgs.push('--handle-type', String(args.handleType));
  if (args.expressCode) commandArgs.push('--express-code', args.expressCode);
  if (args.expressIdCode) commandArgs.push('--express-id-code', args.expressIdCode);
  if (args.expressChannelCode) commandArgs.push('--express-channel-code', args.expressChannelCode);
  if (args.goodsId) commandArgs.push('--goods-id', args.goodsId);
  if (args.goodsIds.length) commandArgs.push('--goods-ids', args.goodsIds.join(','));
  if (args.preRequestId) commandArgs.push('--pre-request-id', args.preRequestId);
  if (args.packageNo.length) commandArgs.push('--package-no', args.packageNo.join(','));
  if (args.deliveryNo) commandArgs.push('--delivery-no', args.deliveryNo);
  const result = await runLocalNodeScript('scripts/openapi_order_fulfillment_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function runCatalogPlan(args) {
  const commandArgs = ['plan'];
  if (args.format) commandArgs.push('--format', args.format);
  if (args.outputFile) commandArgs.push('--out', args.outputFile);
  const result = await runLocalNodeScript('scripts/openapi_catalog_executor.mjs', commandArgs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`openapi_catalog_executor plan failed with code ${result.code}`);
}

async function runCatalogExecutor(args) {
  const store = [...new Set([...(args.stores || []), ...(args.writeStores || [])])][0] || '';
  if (!store) throw new Error('openapi-call requires --store <店铺>');
  if (!args.docId && !args.endpoint) throw new Error('openapi-call requires --doc-id or --endpoint');
  assertLocalOpenApiExecutorAllowed(args, 'openapi-call');
  const commandArgs = ['--store', store, '--mode', args.mode || 'dry-run'];
  if (args.docId) commandArgs.push('--doc-id', args.docId);
  if (args.endpoint) commandArgs.push('--endpoint', args.endpoint);
  if (args.bodyFile) commandArgs.push('--body-file', args.bodyFile);
  else commandArgs.push('--body-json', args.bodyJson || '{}');
  if (args.queryFile) commandArgs.push('--query-file', args.queryFile);
  else if (args.queryJson) commandArgs.push('--query-json', args.queryJson);
  if (args.confirm) commandArgs.push('--confirm', args.confirm);
  if (args.payloadHash) commandArgs.push('--payload-hash', args.payloadHash);
  if (args.openapiConfigFile) commandArgs.push('--config', args.openapiConfigFile);
  if (args.openapiStoreTruthFile) commandArgs.push('--store-truth', args.openapiStoreTruthFile);
  const result = await runLocalNodeScript('scripts/openapi_catalog_executor.mjs', commandArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code || 0;
}

async function waitForLinkOpsJob(args, jobId) {
  const id = String(jobId || '').trim();
  if (!id) throw new Error('wait-job requires --job-id');
  const seconds = Number.isFinite(Number(args.waitSeconds)) && Number(args.waitSeconds) > 0
    ? Math.min(3_600, Number(args.waitSeconds))
    : 120;
  const deadline = Date.now() + seconds * 1_000;
  let last = null;
  while (Date.now() <= deadline) {
    const {json} = await request(args, `/api/link-ops-jobs/${encodeURIComponent(id)}`);
    last = json.data || json;
    if (['succeeded', 'failed', 'uncertain_write'].includes(String(last.status || ''))) return last;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const error = new Error(`Timed out waiting ${seconds}s for job ${id}`);
  error.response = last;
  throw error;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'version') {
    print({ok: true, version: BI_OPS_CLI_VERSION});
    return;
  }
  if (args.command === 'help') {
    console.log(help());
    return;
  }
  if (args.command === 'login') {
    if (!args.username && process.stdin.isTTY) args.username = (await promptLine('BI账号: ')).trim();
    if (args.passwordStdin) args.password = (await readStdinText()).trim();
    if (!args.password && process.stdin.isTTY) args.password = await promptHidden('BI密码: ');
    if (!args.username || !args.password) throw new Error('login requires --username and --password, SHEIN_BI_USERNAME/SHEIN_BI_PASSWORD, or interactive input');
    const {json, res} = await request(args, '/api/login', {
      method: 'POST',
      auth: false,
      body: {username: args.username, password: args.password},
    });
    const cookie = cookieFromSetCookie(res.headers);
    if (!cookie) throw new Error('Login succeeded but Set-Cookie was missing');
    await writeSession(args.sessionFile, {
      baseUrl: args.baseUrl,
      cookie,
      user: json.user,
      savedAt: new Date().toISOString(),
      note: 'Session cookie only; plaintext password is never stored.',
    });
    const knowledge = await refreshPartnerKnowledge(args).catch(error => ({ok: false, warning: String(error?.message || error)}));
    print({ok: true, user: json.user, sessionFile: args.sessionFile, knowledge: {
      updated: Boolean(knowledge?.updated),
      current: Boolean(knowledge?.ok && knowledge?.current !== false),
      sourceCommit: String(knowledge?.manifest?.sourceCommit || ''),
    }});
    return;
  }
  if (args.command === 'logout') {
    await request(args, '/api/logout', {method: 'POST'}).catch(() => null);
    await fs.rm(args.sessionFile, {force: true}).catch(() => {});
    print({ok: true, sessionFile: args.sessionFile, loggedOut: true});
    return;
  }
  if (args.command === 'knowledge-status' || args.command === 'knowledge_status') {
    const knowledge = await refreshPartnerKnowledge(args, {strict: true});
    print({ok: true, version: BI_OPS_CLI_VERSION, knowledge});
    return;
  }
  if (KNOWLEDGE_CHECK_COMMANDS.has(args.command)) {
    await refreshPartnerKnowledge(args, {strict: args.command === 'execute'});
  }
  if (args.command === 'doctor') {
    const report = await runDoctor(args);
    print(report, !args.json);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args.command === 'maintenance-readiness' || args.command === 'maintenance_readiness') {
    await runMaintenanceReadiness(args);
    return;
  }
  if (args.command === 'plan-images' || args.command === 'plan_images') {
    await runPlanImages(args);
    return;
  }
  if (args.command === 'retire-candidates' || args.command === 'retire_candidates') {
    await runRetireCandidates(args);
    return;
  }
  if (args.command === 'upload-pic' || args.command === 'upload_pic') {
    await runImageAssetExecutor(args, 'upload-pic');
    return;
  }
  if (args.command === 'transform-pic' || args.command === 'transform_pic') {
    await runImageAssetExecutor(args, 'transform-pic');
    return;
  }
  if (args.command === 'audit-status' || args.command === 'audit_status') {
    await runReadonlyExecutor(args, 'audit-status');
    return;
  }
  if (args.command === 'search-product' || args.command === 'search_product') {
    await runReadonlyExecutor(args, 'search-product');
    return;
  }
  if (args.command === 'publish-standard' || args.command === 'publish_standard') {
    await runReadonlyExecutor(args, 'publish-standard');
    return;
  }
  if (args.command === 'shelf-quota' || args.command === 'shelf_quota') {
    await runReadonlyExecutor(args, 'shelf-quota');
    return;
  }
  if (args.command === 'order-fulfillment' || args.command === 'order_fulfillment') {
    await runOrderFulfillmentExecutor(args);
    return;
  }
  if (args.command === 'openapi-catalog-plan' || args.command === 'openapi_catalog_plan') {
    await runCatalogPlan(args);
    return;
  }
  if (args.command === 'openapi-call' || args.command === 'openapi_call') {
    await runCatalogExecutor(args);
    return;
  }
  if (args.command === 'me') {
    const {json} = await request(args, '/api/auth/me');
    print(json);
    return;
  }
  if (args.command === 'capabilities') {
    const {json} = await request(args, '/api/openapi-capabilities');
    print(json, !args.json);
    return;
  }
  if (args.command === 'ask') {
    if (!args.text) throw new Error('ask requires --text');
    const {json} = await request(args, '/api/ops-agent/ask', {
      method: 'POST',
      body: {question: args.text, profile: args.profile || undefined, source: 'codex_desktop_cli'},
    });
    print(json);
    return;
  }
  if (args.command === 'chats') {
    const {json} = await request(args, `/api/link-ops-chats?limit=${encodeURIComponent(args.limit)}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'jobs') {
    const query = new URLSearchParams({limit: String(args.limit)});
    if (args.status) query.set('status', args.status);
    if (args.globalView) query.set('scope', 'all');
    const {json} = await request(args, `/api/link-ops-jobs?${query}`);
    print(json, !args.json);
    return;
  }
  if (args.command === 'job') {
    if (!args.jobId) throw new Error('job requires --job-id');
    const scope = args.globalView ? '?scope=all' : '';
    const {json} = await request(args, `/api/link-ops-jobs/${encodeURIComponent(args.jobId)}${scope}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'wait-job' || args.command === 'wait_job') {
    const job = await waitForLinkOpsJob(args, args.jobId);
    print({ok: job.status === 'succeeded', job}, !args.json);
    if (job.status !== 'succeeded') process.exitCode = 1;
    return;
  }
  if (args.command === 'chat') {
    if (!args.text) throw new Error('chat requires --text');
    const {json} = await request(args, '/api/link-ops-chats', {
      method: 'POST',
      body: {
        message: args.text,
        sessionId: args.chatSessionId || undefined,
        askAgent: args.askAgent,
        agentProfile: args.profile || undefined,
        source: 'codex_desktop_cli',
      },
    });
    const job = json.job || null;
    const completedJob = job && args.waitSeconds > 0 ? await waitForLinkOpsJob(args, job.id) : null;
    print({ok: true, session: json.session, autoTask: json.autoTask, job, completedJob, data: json.data, taskData: json.taskData});
    return;
  }
  if (args.command === 'tasks') {
    const scoped = args.chatSessionId ? `&sessionId=${encodeURIComponent(args.chatSessionId)}` : '';
    const {json} = await request(args, `/api/link-ops-tasks?limit=${encodeURIComponent(args.limit)}${scoped}`);
    print(json.data || json, !args.json);
    return;
  }
  if (args.command === 'create') {
    if (!args.text) throw new Error('create requires --text');
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'POST',
      body: {command: args.text, source: 'codex_desktop_cli', targets: taskTargets(args)},
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'preflight') {
    if (!args.taskId) throw new Error('preflight requires --task-id');
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'dry-run', source: 'codex_desktop_cli'},
    });
    print({ok: true, task: json.task, execution: json.execution});
    return;
  }
  if (args.command === 'execute') {
    if (!args.taskId) throw new Error('execute requires --task-id');
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) throw new Error(`execute requires --confirm ${SUBMIT_CONFIRM_TEXT}`);
    const {json} = await request(args, '/api/link-ops-execute', {
      method: 'POST',
      body: {id: args.taskId, mode: 'execute', confirm: args.confirm, source: 'codex_desktop_cli'},
    });
    print({ok: true, task: json.task, execution: json.execution});
    return;
  }
  if (args.command === 'resolve') {
    if (!args.taskId) throw new Error('resolve requires --task-id');
    const status = args.status || 'done';
    if (!['done', 'archived'].includes(status)) throw new Error('resolve --status must be done or archived');
    if (!args.note) throw new Error('resolve requires --note to explain the manual decision');
    const {json} = await request(args, '/api/link-ops-tasks', {
      method: 'PATCH',
      body: {id: args.taskId, status, note: args.note, event: 'manual_lifecycle_resolve_cli'},
    });
    print({ok: true, task: json.task, data: json.data});
    return;
  }
  if (args.command === 'audit') {
    if (!args.taskId) throw new Error('audit requires --task-id');
    const {json} = await request(args, `/api/link-ops-audit?taskId=${encodeURIComponent(args.taskId)}&limit=${encodeURIComponent(args.limit)}`);
    print(json);
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch(err => {
  const out = {
    ok: false,
    error: err?.message || String(err),
    status: err?.status || null,
    response: err?.response || null,
  };
  console.error(JSON.stringify(out, null, 2));
  process.exitCode = 1;
});
