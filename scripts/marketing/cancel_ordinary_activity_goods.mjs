#!/usr/bin/env node
/**
 * Safely cancel ordinary SHEIN marketing activity goods for a tightly scoped row.
 *
 * This is intentionally narrower than the one-off M12 retract helper:
 * - one store only;
 * - one ordinary activity only;
 * - one or more explicit SKCs, with execute allowed only when each SKC has exactly
 *   one live enrolled/under-review row;
 * - dry-run by default; `--execute` is required to call the cancel endpoint;
 * - store identity is verified before any read/write call.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8')).stores || [];
const STORE_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    store: '',
    activityId: 0,
    skcs: [],
    execute: false,
    noLaunch: false,
    noClose: false,
    pageSize: 500,
    outputPrefix: 'ordinary-activity-cancel',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--store' || a === '--stores') out.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--activity' || a === '--activity-id') out.activityId = Number(argv[++i] || 0);
    else if (a === '--skc' || a === '--skcs') out.skcs.push(...splitList(argv[++i]).map(x => x.toLowerCase()));
    else if (a === '--execute') out.execute = true;
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--page-size') out.pageSize = Number(argv[++i] || out.pageSize);
    else if (a === '--output-prefix') out.outputPrefix = String(argv[++i] || out.outputPrefix).trim() || out.outputPrefix;
  }
  out.skcs = [...new Set(out.skcs.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
  if (!out.store) throw new Error('Missing --store, e.g. --store QH');
  if (!out.activityId) throw new Error('Missing --activity, e.g. --activity 45488');
  if (!out.skcs.length) throw new Error('Missing --skc, e.g. --skc sv260602123257162993050');
  if (!Number.isFinite(out.pageSize) || out.pageSize < 50) out.pageSize = 500;
  return out;
}

const args = parseArgs(process.argv.slice(2));

function normSkc(value) {
  return String(value || '').trim().toLowerCase();
}

function listFrom(info) {
  if (Array.isArray(info?.data)) return info.data;
  if (Array.isArray(info?.list)) return info.list;
  if (Array.isArray(info?.records)) return info.records;
  if (Array.isArray(info?.partake_goods_list)) return info.partake_goods_list;
  if (Array.isArray(info?.activity_detail_list)) return info.activity_detail_list;
  if (Array.isArray(info)) return info;
  return [];
}

function priceOf(row) {
  const sku = Array.isArray(row?.activity_sku_list) ? row.activity_sku_list[0] : null;
  const candidates = [
    row?.activity_price,
    row?.product_act_price,
    row?.attend_price,
    row?.attend_cost,
    row?.price,
    row?.activity_price_str,
    row?.enroll_display_str,
    sku?.activity_price,
    sku?.product_act_price,
    sku?.attend_price,
  ];
  for (const value of candidates) {
    const n = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function compactRow(row) {
  return {
    id: Number(row?.id ?? row?.partake_good_id ?? row?.partake_goods_id ?? row?.activity_goods_id ?? row?.partake_rule_good_id ?? NaN),
    skc: String(row?.skc || '').trim(),
    supplierNo: row?.supplier_no || row?.supplierNo || row?.sku_supplier_no || '',
    auditStatus: row?.audit_status ?? '',
    auditStatusDesc: row?.audit_status_desc ?? '',
    goodsAuditStatus: row?.goods_audit_status ?? '',
    goodsAuditStatusDesc: row?.goods_audit_status_desc ?? '',
    status: row?.status ?? '',
    activityPrice: priceOf(row),
    insertZoneTime: row?.insert_zone_time || '',
    insertTime: row?.insert_time ?? null,
    rawKeys: Object.keys(row || {}).sort().slice(0, 80),
  };
}

function isActiveEnrollment(row) {
  const auditStatus = String(row?.audit_status ?? '').trim();
  const goodsAuditStatus = String(row?.goods_audit_status ?? '').trim();
  const desc = String(row?.audit_status_desc || row?.goods_audit_status_desc || '').trim();
  return auditStatus === '0'
    || auditStatus === '1'
    || goodsAuditStatus === '0'
    || goodsAuditStatus === '1'
    || desc.includes('审核中')
    || desc.includes('审核通过');
}

function localDateTime(d) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const item = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(item.timer);
      msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
    });
    await this.call('Runtime.enable');
    await this.call('Page.enable').catch(() => {});
  }
  call(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 90_000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  async eval(body, arg = undefined) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
    const res = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(desc);
    }
    return res.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchVisible(store) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    '--visible',
    '--url',
    LIST_URL,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 25_000});
  if (r.status !== 0) throw new Error(`launch ${store.storeKey} failed: ${r.stderr || r.stdout}`);
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser(store) {
  if (!args.noLaunch && !args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(1500);
    launchVisible(store);
    await sleep(6500);
  } else if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store);
    await sleep(6500);
  }
}

async function connectStorePage(store) {
  await ensureBrowser(store);
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com'))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`${store.storeKey} port ${store.port} no page target`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function readLoginState(cdp) {
  return await cdp.eval(`
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      isLogin: location.href.includes('/login/')
        || text.includes('请输入账号')
        || text.includes('请输入密码')
        || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      tail: text.slice(-800),
    };
  `);
}

async function clickLoginOnce(cdp) {
  const target = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button],a')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录')
      || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20)
      || buttons.find(x => !x.disabled && x.text === '登录')
      || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!btn) return {found: false, href: location.href, buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20), tail: (document.body?.innerText || '').slice(-800)};
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found: true, text: btn.text, href: location.href, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  `);
  if (!target.found) return {clicked: false, ...target};
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y, button: 'none'});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
  return {clicked: true, ...target};
}

async function recoverLoginIfNeeded(cdp) {
  const before = await readLoginState(cdp);
  if (!before.isLogin) return {needed: false, before};
  const attempts = [];
  let after = before;
  for (let i = 1; i <= 4; i += 1) {
    const clicked = await clickLoginOnce(cdp);
    attempts.push({attempt: i, ...clicked});
    await sleep(String(clicked.text || '').includes('继续登录') ? 2200 : 5000);
    after = await readLoginState(cdp);
    if (!after.isLogin) break;
    if (i === 2) {
      await cdp.eval('location.reload(); return {href: location.href};');
      await sleep(2500);
    }
  }
  return {needed: true, before, attempts, after, ok: !after.isLogin};
}

async function gotoMarketingList(cdp) {
  await cdp.eval('location.href = __arg.url; return {href: location.href};', {url: LIST_URL});
  await sleep(2500);
  return await recoverLoginIfNeeded(cdp);
}

async function assertIdentity(cdp, store, context) {
  const snapshot = await cdp.eval(storeIdentityEvalBody());
  return requireStoreIdentitySnapshot({
    store,
    truth: STORE_TRUTH.stores?.[store.storeKey],
    snapshot,
    context,
  });
}

async function queryActivityRows(cdp, activityId, skcs, activeOnly) {
  return await cdp.eval(`
    const baseHeaders = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    async function post(apiPath, body, route) {
      const headers = {...baseHeaders, 'x-bbl-route': route};
      const res = await fetch('/mrs-api-prefix' + apiPath, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 200), info: json?.info ?? json, text: text.slice(0, 800)};
    }
    function listFrom(info) {
      if (Array.isArray(info?.data)) return info.data;
      if (Array.isArray(info?.list)) return info.list;
      if (Array.isArray(info?.records)) return info.records;
      if (Array.isArray(info?.partake_goods_list)) return info.partake_goods_list;
      if (Array.isArray(info)) return info;
      return [];
    }
    const route = '/mbrs/marketing/sign-up/config/' + __arg.activityId;
    const packets = [];
    const rows = [];
    for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
      const body = {
        activity_id_list: [__arg.activityId],
        query_coupon: false,
        skc_list: __arg.skcs,
      };
      if (__arg.activeOnly) body.audit_status = [0, 1];
      const q = await post(
        '/mbrs/activity/get_partake_activity_goods_list?page_num=' + pageNum + '&page_size=' + __arg.pageSize,
        body,
        route,
      );
      const list = listFrom(q.info?.data ?? q.info);
      const total = Number(q.info?.meta?.total ?? q.info?.meta?.count ?? q.info?.total ?? list.length ?? 0);
      packets.push({pageNum, http: q.http, code: q.code, msg: q.msg, total, count: list.length, text: q.text});
      rows.push(...list);
      if (String(q.code) !== '0' || !list.length || rows.length >= total || list.length < __arg.pageSize) break;
    }
    return {href: location.href, packets, rows};
  `, {activityId, skcs, activeOnly, pageSize: args.pageSize});
}

async function cancelGoods(cdp, activityId, goodsList) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
      'x-bbl-route': '/mbrs/marketing/list',
    };
    const endpoint = '/mrs-api-prefix/mbrs/activity/batch_cancel_partake_goods';
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({activity_id: __arg.activityId, goods_list: __arg.goodsList}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const info = json?.info || {};
    const successCnt = Number(info.success_cnt ?? 0);
    const failCnt = Number(info.fail_cnt ?? 0);
    return {
      ok: res.status === 200 && String(json?.code) === '0' && successCnt === __arg.goodsList.length && failCnt === 0,
      endpoint,
      http: res.status,
      code: json?.code ?? '',
      msg: json?.msg || text.slice(0, 300),
      info,
      successCnt,
      failCnt,
      rawTextSample: text.slice(0, 1000),
    };
  `, {activityId, goodsList});
}

async function main() {
  await fs.mkdir(OUT_DIR, {recursive: true});
  const store = STORES.find(s => String(s.storeKey || '').toUpperCase() === args.store);
  if (!store) throw new Error(`Unknown store: ${args.store}`);

  const out = {
    createdAt: new Date().toISOString(),
    asiaShanghai: localDateTime(new Date()),
    mode: args.execute ? 'execute' : 'dry-run',
    storeKey: args.store,
    activityId: args.activityId,
    targetSkcs: args.skcs,
    ok: false,
    identity: null,
    loginRecovery: null,
    before: null,
    cancelTargets: [],
    skipped: [],
    cancel: null,
    after: null,
    remainingActiveRows: [],
    reason: '',
  };

  let cdp = null;
  try {
    cdp = await connectStorePage(store);
    out.loginRecovery = await gotoMarketingList(cdp);
    if (out.loginRecovery.after?.isLogin) throw new Error('still on login page after recovery');
    out.identity = await assertIdentity(cdp, store, `ordinary activity cancel ${args.store} ${args.activityId}`);

    const beforeActive = await queryActivityRows(cdp, args.activityId, args.skcs, true);
    const beforeAll = await queryActivityRows(cdp, args.activityId, args.skcs, false);
    out.before = {
      activePackets: beforeActive.packets,
      allPackets: beforeAll.packets,
      activeRows: beforeActive.rows.map(compactRow),
      allRows: beforeAll.rows.map(compactRow),
    };

    for (const skc of args.skcs) {
      const activeRows = beforeActive.rows.filter(r => normSkc(r?.skc) === skc && isActiveEnrollment(r));
      if (activeRows.length !== 1) {
        out.skipped.push({
          skc,
          reason: activeRows.length === 0 ? 'no_single_active_enrollment_to_cancel' : 'multiple_active_enrollments_refuse_to_cancel',
          activeRows: activeRows.map(compactRow),
          allRows: beforeAll.rows.filter(r => normSkc(r?.skc) === skc).map(compactRow),
        });
        continue;
      }
      const row = compactRow(activeRows[0]);
      if (!Number.isFinite(row.id)) {
        out.skipped.push({skc, reason: 'active_row_missing_id', activeRows: [row]});
        continue;
      }
      out.cancelTargets.push({
        id: row.id,
        skc: row.skc,
        supplierNo: row.supplierNo,
        activityPrice: row.activityPrice,
        auditStatus: row.auditStatus,
        auditStatusDesc: row.auditStatusDesc,
        goodsAuditStatus: row.goodsAuditStatus,
        insertZoneTime: row.insertZoneTime,
      });
    }

    if (out.cancelTargets.length !== args.skcs.length || out.skipped.length) {
      out.reason = 'target resolution is not exactly one active row per requested SKC';
    } else if (args.execute) {
      out.cancel = await cancelGoods(cdp, args.activityId, out.cancelTargets.map(x => ({id: x.id, skc: x.skc})));
      await sleep(3500);
    }

    const afterActive = await queryActivityRows(cdp, args.activityId, args.skcs, true);
    out.after = {
      activePackets: afterActive.packets,
      activeRows: afterActive.rows.map(compactRow),
    };
    out.remainingActiveRows = afterActive.rows.filter(r => args.skcs.includes(normSkc(r?.skc)) && isActiveEnrollment(r)).map(compactRow);
    if (!out.reason && args.execute && !out.cancel?.ok) out.reason = 'cancel endpoint failed';
    if (!out.reason && args.execute && out.remainingActiveRows.length) out.reason = 'active rows remain after cancel';
    out.ok = !out.reason && (!args.execute || (out.cancel?.ok && out.remainingActiveRows.length === 0));
  } catch (err) {
    out.reason = String(err?.message || err);
    out.error = String(err?.stack || err?.message || err);
  } finally {
    cdp?.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${args.outputPrefix}-${args.store}-${args.activityId}-${args.execute ? 'execute' : 'dry-run'}-${stamp}`;
  const jsonPath = path.join(OUT_DIR, `${base}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  const lines = [];
  lines.push(`# 普通营销活动单行撤回${args.execute ? '执行' : '预检'}报告`);
  lines.push('');
  lines.push(`- 时间：${out.asiaShanghai} Asia/Shanghai`);
  lines.push(`- 模式：${out.mode}`);
  lines.push(`- 店铺：${out.storeKey}`);
  lines.push(`- 活动：${out.activityId}`);
  lines.push(`- 目标 SKC：${out.targetSkcs.join(', ')}`);
  lines.push(`- 命中可撤记录：${out.cancelTargets.length}`);
  lines.push(`- 跳过/异常：${out.skipped.length}`);
  lines.push(`- 撤回后仍在审核中/已报：${out.remainingActiveRows.length}`);
  lines.push(`- 结论：${out.ok ? 'OK' : '需处理'}${out.reason ? `（${out.reason}）` : ''}`);
  lines.push('');
  if (out.cancelTargets.length) {
    lines.push('## 将撤/已撤记录');
    for (const row of out.cancelTargets) {
      lines.push(`- ${row.skc} id=${row.id} 活动价=${row.activityPrice ?? '-'} 状态=${row.auditStatusDesc || row.auditStatus || row.goodsAuditStatus}`);
    }
    lines.push('');
  }
  if (out.skipped.length) {
    lines.push('## 异常');
    for (const row of out.skipped) lines.push(`- ${row.skc}: ${row.reason}`);
    lines.push('');
  }
  await fs.writeFile(mdPath, lines.join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({
    ok: out.ok,
    mode: out.mode,
    storeKey: out.storeKey,
    activityId: out.activityId,
    targetSkcs: out.targetSkcs,
    cancelTargets: out.cancelTargets,
    skipped: out.skipped.map(x => ({skc: x.skc, reason: x.reason})),
    remainingActiveRows: out.remainingActiveRows,
    reason: out.reason,
    jsonPath: path.relative(ROOT, jsonPath),
    mdPath: path.relative(ROOT, mdPath),
  }, null, 2));
  if (!out.ok && args.execute) process.exitCode = 2;
}

await main();
