function splitStores(value) {
  return [...new Set(String(value || '')
    .split(/[,\s，、]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean))];
}

function reportRequiresOtp(report, storeKeys) {
  const wanted = new Set(storeKeys);
  const rows = Array.isArray(report?.results)
    ? report.results
    : Array.isArray(report?.stores)
      ? report.stores
      : [];
  return rows.some(row => {
    const storeKey = String(row?.storeKey || '').trim().toUpperCase();
    if (!wanted.has(storeKey)) return false;
    return /手机号码验证|短信验证码|OTP码|验证码已发送/i.test(JSON.stringify(row));
  });
}

/**
 * One expired store login can make the session manager fail, the same store's
 * link/business refresh fail, and the daily wrapper report "partial". Those
 * are one operational incident, not three independent problems.
 */
export function collapseWatchdogRootCauseIssues({issues = [], sessionReport = null} = {}) {
  const source = Array.isArray(issues) ? issues.map(String) : [];
  const sessionService = source.find(issue => /^服务异常：shein-bi-cloud-session-manager\.service\b/.test(issue));
  const linkIssue = source.find(issue => /^链接\/业务域日更部分店铺失败：/.test(issue));
  if (!sessionService || !linkIssue) return {issues: source, collapsed: false};

  const linkMatch = /date=([^\s]+)\s+failed=([^\s]+)/.exec(linkIssue);
  const linkDate = linkMatch?.[1] || '-';
  const linkStores = splitStores(linkMatch?.[2]);
  const sessionStores = splitStores(sessionReport?.summary?.failedStores || sessionReport?.failedStores);
  if (!linkStores.length || !sessionStores.length || linkStores.some(store => !sessionStores.includes(store))) {
    return {issues: source, collapsed: false};
  }

  const otpRequired = reportRequiresOtp(sessionReport, linkStores);
  const dailyDerived = source.filter(issue =>
    /^日更补采异常：/.test(issue)
    && /\bmessage=link-business (?:partial|failed|metrics not ready)\b/.test(issue));
  const removed = new Set([sessionService, linkIssue, ...dailyDerived]);
  const storeLabel = linkStores.join('、');
  const rootCause = otpRequired
    ? `店铺登录需要人工验证：${storeLabel} 登录已进入短信验证码页面，导致 ${linkDate} 的链接与流量数据未更新；其他店铺已完成。`
    : `店铺登录状态异常：${storeLabel} 登录恢复失败，导致 ${linkDate} 的链接与流量数据未更新；其他店铺已完成。`;
  return {
    issues: [rootCause, ...source.filter(issue => !removed.has(issue))],
    collapsed: true,
    rootCause,
    removedCount: removed.size,
    stores: linkStores,
    otpRequired,
  };
}

function notificationPriority(issue) {
  if (/^(?:常驻服务未运行|服务异常|BI 实时|BI 数据文件不可读|订单闭环 DB 审计失败|根分区)/.test(issue)) return 0;
  if (/^(?:定时器未运行|BI 覆盖不足|链接\/业务域日更部分店铺失败|日更补采异常|云端源码)/.test(issue)) return 1;
  if (/^商品 OpenAPI 对账需处理：/.test(issue)) return 3;
  return 2;
}

function summarizeProductIssues(productIssues) {
  if (!productIssues.length) return '';
  const stores = [...new Set(productIssues
    .map(issue => /：([A-Z0-9]+) 店/.exec(issue)?.[1] || '')
    .filter(Boolean))];
  const allDetailMissing = productIssues.every(issue => /OpenAPI 商品详情缺失 \d+ 条/.test(issue));
  const detailCount = allDetailMissing
    ? productIssues.reduce((total, issue) => total + Number(/OpenAPI 商品详情缺失 (\d+) 条/.exec(issue)?.[1] || 0), 0)
    : 0;
  const storeLabel = stores.length ? `（${stores.join('、')}）` : '';
  if (allDetailMissing && detailCount > 0) {
    return `商品数据详情需补采：${stores.length || productIssues.length} 家店共 ${detailCount} 条${storeLabel}。系统会优先补采，完整链接清单保存在本次维护日志。`;
  }
  return `商品数据对账需处理：${stores.length || productIssues.length} 家店${storeLabel}。系统会优先复查，完整原因和链接清单保存在本次维护日志。`;
}

/**
 * Keep the full issue list in the JSON report, but make the Feishu summary
 * useful: real service/data failures come first and repetitive per-store
 * product rows become one human-readable item instead of hiding later issues.
 */
export function prepareWatchdogNotificationIssues({issues = [], limit = 12} = {}) {
  const source = Array.isArray(issues) ? issues.map(String).filter(Boolean) : [];
  const productIssues = source.filter(issue => /^商品 OpenAPI 对账需处理：/.test(issue));
  const nonProductIssues = source.filter(issue => !/^商品 OpenAPI 对账需处理：/.test(issue));
  const candidates = nonProductIssues
    .map((issue, index) => ({issue, index, priority: notificationPriority(issue)}))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(row => row.issue);
  const productSummary = summarizeProductIssues(productIssues);
  if (productSummary) candidates.push(productSummary);

  const safeLimit = Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 12);
  if (candidates.length <= safeLimit) {
    return {
      issues: candidates,
      omittedCount: 0,
      productCollapsedCount: Math.max(0, productIssues.length - (productSummary ? 1 : 0)),
    };
  }
  const visibleCount = Math.max(0, safeLimit - 1);
  const omittedCount = candidates.length - visibleCount;
  return {
    issues: [
      ...candidates.slice(0, visibleCount),
      `另有 ${omittedCount} 项低优先级维护信息已记入日志；核心故障不会再被清单截断遮住。`,
    ],
    omittedCount,
    productCollapsedCount: Math.max(0, productIssues.length - (productSummary ? 1 : 0)),
  };
}
