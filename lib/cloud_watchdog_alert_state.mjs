import crypto from 'node:crypto';

const DAY_MS = 86_400_000;

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 20);
}

export function legacyIssueSetKey(issues = []) {
  return crypto.createHash('sha1').update(JSON.stringify(issues.map(String))).digest('hex').slice(0, 24);
}

function normalizedUnknown(text) {
  return text
    .replace(/\/srv\/\S+/g, '<path>')
    .replace(/\b(age|count|rows|items|pairs|failedPairs|threshold|exit|code|status)=\S+/gi, '$1=<value>')
    .replace(/\b\d+(?:\.\d+)?(?:h|%|MiB|GiB|min)\b/gi, '<value>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyWatchdogIssue(issue) {
  const raw = String(issue || '').trim();
  const service = /^服务异常：(\S+)/.exec(raw)?.[1] || /^常驻服务未运行：(\S+)/.exec(raw)?.[1] || '';
  const isPortalCritical = /shein-bi-(?:portal|webhook)\.service/.test(service);
  if (isPortalCritical
    || /^云端源码不一致：.*(?:commitMatch=false|missing=[1-9])/.test(raw)
    || /^(?:云端源码一致性检查失败|BI 数据文件不可读|BI 实时运行状态不可读|BI 实时更新通道未连接|BI 日期×店铺覆盖审计失败|订单闭环 DB 审计失败|systemd 批量快照不完整)/.test(raw)
    || (/^服务器硬盘即将写满/.test(raw))) {
    return {severity: 'critical', firstAlertAfterRuns: 1, remindEveryRuns: 6};
  }
  if (/^服务异常：shein-bi-et-low-inventory-(?:guard|recheck)\.service/.test(raw)) {
    return {severity: 'high', firstAlertAfterRuns: 4, remindEveryRuns: 12};
  }
  if (/^商品 OpenAPI 对账需处理：/.test(raw)
    || /^服务异常：shein-bi-cloud-(?:openapi-stock-refresh|today-sales-reconcile)\.service/.test(raw)) {
    return {severity: 'normal', firstAlertAfterRuns: 2, remindEveryRuns: 12};
  }
  if (/^日更补采异常：/.test(raw)) {
    return {severity: 'high', firstAlertAfterRuns: 3, remindEveryRuns: 12};
  }
  return {severity: 'high', firstAlertAfterRuns: 2, remindEveryRuns: 12};
}

export function deriveWatchdogIssueFamily(issue) {
  const raw = String(issue || '').trim();
  let match = /^(?:服务异常|常驻服务未运行)：(\S+)/.exec(raw);
  if (match) return `service:${match[1]}`;
  if (/^云端源码不一致：/.test(raw)) return 'source-integrity';
  if (/^云端源码一致性检查失败：/.test(raw)) return 'source-integrity-check';
  if (/^systemd 批量快照不完整：/.test(raw)) return 'systemd-snapshot';
  if (/^BI 数据文件不可读：/.test(raw)) return 'portal-data-unreadable';
  if (/^BI 实时运行状态不可读：/.test(raw)) return 'portal-runtime-unreadable';
  if (/^BI 实时更新通道未连接：/.test(raw)) return 'portal-live-updates-disconnected';
  if (/^BI 日期×店铺覆盖审计失败：/.test(raw)) return 'coverage-audit-failed';
  if (/^订单闭环 DB 审计失败：/.test(raw)) return 'order-closure-db-audit';
  if (/^商品 OpenAPI 对账需处理：/.test(raw)) return 'openapi-product-reconciliation';
  match = /^日更补采异常：date=([^\s]+).*?message=([^\n]+?)(?:\s+log=|$)/.exec(raw);
  if (match) {
    const stage = /profit mart/i.test(match[2]) ? 'profit' : normalizedUnknown(match[2]).slice(0, 80);
    return `daily-refresh:${match[1]}:${stage}`;
  }
  match = /^定时器未运行：(\S+)/.exec(raw);
  if (match) return `timer:${match[1]}`;
  match = /^BI 覆盖不足：(.+?) 覆盖不足/.exec(raw);
  if (match) return `coverage:${match[1]}`;
  if (/^BI 覆盖不足：/.test(raw)) return `coverage:${sha(normalizedUnknown(raw).replace(/\d{4}-\d{2}-\d{2}/g, '<date>'))}`;
  if (/^(?:BI 页面底稿过期|SHEIN 销售数据过期|SHEIN 业务域日更过期|SHEIN 链接表现日更过期|ET 货代仓过期)/.test(raw)) {
    return `stale:${raw.split('：')[0]}`;
  }
  if (/^服务器硬盘即将写满/.test(raw)) return 'root-disk:93';
  if (/^服务器硬盘快满了/.test(raw)) return 'root-disk:88';
  if (/^服务器硬盘空间偏紧/.test(raw)) return 'root-disk:80';
  match = /^营销无人值守守卫未完成：date=([^\s]+)/.exec(raw);
  if (match) return `marketing-guard:${match[1]}`;
  match = /^营销修复队列未闭环：date=([^\s]+)/.exec(raw);
  if (match) return `marketing-repair:${match[1]}`;
  match = /^链接\/业务域日更部分店铺失败：date=([^\s]+)/.exec(raw);
  if (match) return `link-business:${match[1]}`;
  if (/^SHEIN 店铺浏览器残留/.test(raw)) return 'orphan-store-browsers';
  if (/^订单状态复查/.test(raw)) return `order-recheck:${raw.split('：')[0]}`;
  if (/^订单闭环待复查：/.test(raw)) return 'order-closure-pending';
  return `issue:${sha(normalizedUnknown(raw))}`;
}

function makeIntent(kind, episode, nowIso) {
  const count = kind === 'alert' ? Number(episode.alertCount || 0) + 1 : 1;
  const id = `${kind}:${episode.family}:${episode.firstSeenAt}:${count}`;
  return {
    id: sha(id),
    kind,
    family: episode.family,
    raw: episode.lastRaw,
    createdAt: nowIso,
    status: 'pending',
    attemptCount: 0,
    idempotencyKey: `sync-watchdog-${kind}-${sha(id)}`,
  };
}

function emptyState(nowIso) {
  return {schemaVersion: 'cloud-watchdog-alert-state/v1', updatedAt: nowIso, runCount: 0, episodes: {}, outbox: {}, dispatches: {}};
}

export function migrateLegacyWatchdogState({legacyKey = '', previousIssues = [], now = new Date()} = {}) {
  const nowIso = new Date(now).toISOString();
  const state = emptyState(nowIso);
  if (!legacyKey || legacyKey === 'OK' || legacyIssueSetKey(previousIssues) !== legacyKey) return state;
  for (const raw of previousIssues.map(String).filter(Boolean)) {
    const family = deriveWatchdogIssueFamily(raw);
    const policy = classifyWatchdogIssue(raw);
    state.episodes[family] = {
      family, severity: policy.severity, status: 'alerted', firstSeenAt: nowIso, lastSeenAt: nowIso,
      consecutiveFailures: policy.firstAlertAfterRuns, alertCount: 1, lastAlertConsecutive: policy.firstAlertAfterRuns,
      alertSentCount: 1, firstAlertAt: nowIso, lastAlertAt: nowIso, recoveryNotifiedAt: null, lastRaw: raw,
    };
  }
  return state;
}

export function applyWatchdogAlertState({previousState, issues = [], now = new Date(), force = false} = {}) {
  const nowMs = new Date(now).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const valid = previousState?.schemaVersion === 'cloud-watchdog-alert-state/v1';
  const previous = valid ? structuredClone(previousState) : emptyState(nowIso);
  const next = {...previous, updatedAt: nowIso, runCount: Number(previous.runCount || 0) + 1};
  next.episodes ||= {};
  next.outbox ||= {};
  next.dispatches ||= {};
  const current = new Map();
  for (const raw of issues.map(String).filter(Boolean)) {
    const family = deriveWatchdogIssueFamily(raw);
    if (!current.has(family)) current.set(family, []);
    current.get(family).push(raw);
  }
  const toAlert = [];
  const toRecover = [];

  for (const [family, rows] of current) {
    const raw = rows.join('\n');
    const policy = classifyWatchdogIssue(raw);
    let episode = next.episodes[family];
    if (!episode || episode.status === 'resolved') {
      episode = {
        family, severity: policy.severity, status: 'pending', firstSeenAt: nowIso, lastSeenAt: nowIso,
        consecutiveFailures: 0, alertCount: 0, lastAlertConsecutive: 0, firstAlertAt: null,
        lastAlertAt: null, recoveryNotifiedAt: null, lastRaw: raw,
      };
    }
    episode.lastSeenAt = nowIso;
    episode.lastRaw = raw;
    episode.severity = policy.severity;
    episode.consecutiveFailures = Number(episode.consecutiveFailures || 0) + 1;
    for (const [id, intent] of Object.entries(next.outbox)) {
      if (intent.family === family && intent.kind === 'recovery' && intent.status === 'pending') delete next.outbox[id];
    }
    const firstDue = episode.status === 'pending'
      && (force || episode.consecutiveFailures >= policy.firstAlertAfterRuns);
    const reminderDue = episode.status === 'alerted'
      && (force || episode.consecutiveFailures - Number(episode.lastAlertConsecutive || 0) >= policy.remindEveryRuns);
    if (firstDue || reminderDue) {
      episode.status = 'alerted';
      episode.alertCount = Number(episode.alertCount || 0) + 1;
      episode.lastAlertConsecutive = episode.consecutiveFailures;
      episode.firstAlertAt ||= nowIso;
      episode.lastAlertAt = nowIso;
      const intent = makeIntent('alert', {...episode, alertCount: episode.alertCount - 1}, nowIso);
      if (!next.outbox[intent.id]) next.outbox[intent.id] = intent;
      toAlert.push(next.outbox[intent.id]);
    }
    next.episodes[family] = episode;
  }

  for (const [family, episode] of Object.entries(next.episodes)) {
    if (current.has(family) || episode.status === 'resolved') continue;
    const wasAlerted = episode.status === 'alerted';
    episode.status = 'resolved';
    episode.resolvedAt = nowIso;
    for (const [id, intent] of Object.entries(next.outbox)) {
      if (intent.family === family && intent.kind === 'alert' && intent.status === 'pending') delete next.outbox[id];
    }
    if (wasAlerted && Number(episode.alertSentCount || 0) > 0 && !episode.recoveryNotifiedAt) {
      const intent = makeIntent('recovery', episode, nowIso);
      if (!next.outbox[intent.id]) next.outbox[intent.id] = intent;
      toRecover.push(next.outbox[intent.id]);
    }
  }

  for (const [family, episode] of Object.entries(next.episodes)) {
    const resolvedMs = Date.parse(episode.resolvedAt || '');
    if (episode.status === 'resolved' && Number.isFinite(resolvedMs) && nowMs - resolvedMs > 30 * DAY_MS) delete next.episodes[family];
  }
  for (const [id, intent] of Object.entries(next.outbox)) {
    const createdMs = Date.parse(intent.createdAt || '');
    if (intent.status === 'sent' && Number.isFinite(createdMs) && nowMs - createdMs > 30 * DAY_MS) delete next.outbox[id];
  }

  return {
    nextState: next,
    toAlert,
    toRecover,
    pendingIssues: Object.values(next.episodes).filter(row => row.status === 'pending'),
    activeIssues: Object.values(next.episodes).filter(row => row.status === 'alerted'),
  };
}

export function pendingWatchdogOutbox(state, kind = '') {
  return Object.values(state?.outbox || {}).filter(row => row.status === 'pending' && (!kind || row.kind === kind));
}

export function prepareWatchdogDispatches(state, now = new Date()) {
  const next = structuredClone(state);
  next.dispatches ||= {};
  const at = new Date(now).toISOString();
  for (const kind of ['alert', 'recovery']) {
    const unassigned = Object.values(next.outbox || {})
      .filter(row => row.status === 'pending' && row.kind === kind && !row.dispatchId)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!unassigned.length) continue;
    const dispatchId = sha(`${kind}:${unassigned.map(row => row.id).join(',')}`);
    next.dispatches[dispatchId] = {
      id: dispatchId,
      kind,
      intentIds: unassigned.map(row => row.id),
      createdAt: at,
      status: 'pending',
      attemptCount: 0,
      idempotencyKey: `sync-watchdog-${kind}-batch-${dispatchId}`,
    };
    for (const row of unassigned) next.outbox[row.id].dispatchId = dispatchId;
  }
  for (const [id, dispatch] of Object.entries(next.dispatches)) {
    const activeIds = dispatch.intentIds.filter(intentId => {
      const intent = next.outbox?.[intentId];
      if (!intent || intent.status !== 'pending') return false;
      const episode = next.episodes?.[intent.family];
      return intent.kind === 'alert' ? episode?.status === 'alerted' : episode?.status === 'resolved';
    });
    dispatch.intentIds = activeIds;
    if (!activeIds.length && dispatch.status === 'pending') delete next.dispatches[id];
  }
  next.updatedAt = at;
  return next;
}

export function pendingWatchdogDispatches(state) {
  return Object.values(state?.dispatches || {}).filter(row => row.status === 'pending' && row.intentIds?.length);
}

export function markWatchdogDispatchSent(state, dispatchId, sentAt = new Date()) {
  let next = structuredClone(state);
  const dispatch = next.dispatches?.[dispatchId];
  if (!dispatch) return next;
  next = markWatchdogOutboxSent(next, dispatch.intentIds, sentAt);
  next.dispatches[dispatchId].status = 'sent';
  next.dispatches[dispatchId].sentAt = new Date(sentAt).toISOString();
  next.dispatches[dispatchId].attemptCount = Number(next.dispatches[dispatchId].attemptCount || 0) + 1;
  return next;
}

export function markWatchdogDispatchAttempt(state, dispatchId, attemptedAt = new Date()) {
  const next = structuredClone(state);
  const dispatch = next.dispatches?.[dispatchId];
  if (!dispatch) return next;
  dispatch.lastAttemptAt = new Date(attemptedAt).toISOString();
  dispatch.attemptCount = Number(dispatch.attemptCount || 0) + 1;
  next.updatedAt = dispatch.lastAttemptAt;
  return next;
}

export function markWatchdogOutboxSent(state, ids = [], sentAt = new Date()) {
  const next = structuredClone(state);
  const at = new Date(sentAt).toISOString();
  for (const id of ids) {
    const intent = next.outbox?.[id];
    if (!intent) continue;
    intent.status = 'sent';
    intent.sentAt = at;
    intent.attemptCount = Number(intent.attemptCount || 0) + 1;
    if (intent.kind === 'recovery' && next.episodes?.[intent.family]) next.episodes[intent.family].recoveryNotifiedAt = at;
    if (intent.kind === 'alert' && next.episodes?.[intent.family]) {
      next.episodes[intent.family].alertSentCount = Number(next.episodes[intent.family].alertSentCount || 0) + 1;
    }
  }
  next.updatedAt = at;
  return next;
}

export function markWatchdogOutboxAttempt(state, ids = [], attemptedAt = new Date()) {
  const next = structuredClone(state);
  const at = new Date(attemptedAt).toISOString();
  for (const id of ids) {
    const intent = next.outbox?.[id];
    if (!intent) continue;
    intent.lastAttemptAt = at;
    intent.attemptCount = Number(intent.attemptCount || 0) + 1;
  }
  next.updatedAt = at;
  return next;
}
