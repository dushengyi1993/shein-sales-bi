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
