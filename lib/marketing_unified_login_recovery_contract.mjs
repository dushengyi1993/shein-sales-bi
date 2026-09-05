export const TERMINAL_LOGIN_BLOCKERS = Object.freeze([
  'saved_password_unavailable',
  'verification_code_required',
  'security_verification_required',
]);

export function isMarketingLoginRedirect(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return /(?:get_apollo_map|\/common\/get_apollo_map)/i.test(text)
    && /(?:20302|login redirect|登录重定向|GMPSSO)/i.test(text);
}

export function hasConcreteStoreIdentityConflict(identityRow = {}) {
  const check = identityRow?.identity || {};
  return (check.accountConflicts || []).length > 0
    || (check.merchantConflicts || []).length > 0
    || (Boolean(check.actualShopName)
      && Boolean(check.expectedShopName)
      && check.actualShopName !== check.expectedShopName);
}

export function classifyUnifiedLoginRecovery({relogin = null, identity = null, retry = null} = {}) {
  const blocker = String(relogin?.blocker || '').trim();
  if (TERMINAL_LOGIN_BLOCKERS.includes(blocker)) {
    return {ok: false, terminal: true, classification: 'login_terminal_blocker', blocker};
  }
  if (identity?.mismatch === true) {
    return {ok: false, terminal: true, classification: 'login_terminal_blocker', blocker: 'store_profile_identity_mismatch'};
  }
  if (identity && identity.ok !== true) {
    return {ok: false, terminal: false, classification: 'recoverable_pending', blocker: 'store_profile_identity_unavailable'};
  }
  if (retry?.full?.ok === true || retry?.ok === true) {
    return {ok: true, terminal: false, classification: 'recovered'};
  }
  return {
    ok: false,
    terminal: false,
    classification: 'recoverable_pending',
    blocker: blocker || (isMarketingLoginRedirect(retry?.full || retry) ? 'session_expired' : 'login_recovery_incomplete'),
  };
}

export function validateMarketingSessionReadiness({orderOk = false, sbnOk = false, marketingProbe = null} = {}) {
  const probeOk = Boolean(marketingProbe?.ok && !marketingProbe?.isLogin && !marketingProbe?.hasLoginText);
  if (!probeOk) {
    return {
      ready: false,
      reason: marketingProbe?.isLogin || isMarketingLoginRedirect(marketingProbe)
        ? 'marketing_subsystem_session_expired'
        : (marketingProbe?.hardBlockReason || 'marketing_subsystem_probe_failed'),
      orderPageOk: Boolean(orderOk),
      sbnPageOk: Boolean(sbnOk),
      marketingEndpointVerified: false,
    };
  }
  return {
    ready: true,
    orderPageOk: Boolean(orderOk),
    sbnPageOk: Boolean(sbnOk),
    marketingEndpointVerified: true,
  };
}

export function classifySessionFailure(errorOrPacket) {
  const text = typeof errorOrPacket === 'string'
    ? errorOrPacket
    : (errorOrPacket?.message || JSON.stringify(errorOrPacket || {}));
  if (/验证码|短信验证|手机验证|安全验证|滑块|拖动滑块|人机验证|captcha|geetest|verify/i.test(text)) {
    return { type: 'captcha_challenge', terminal: true, blocker: 'verification_code_required', description: '需人工完成滑块或短信/安全验证' };
  }
  if (/(?:saved_password_unavailable|account_required|password_required)/i.test(text)) {
    return { type: 'credential_missing', terminal: true, blocker: 'saved_password_unavailable', description: '受管Profile中无可用已保存密码，需人工登录' };
  }
  if (isMarketingLoginRedirect(errorOrPacket) || /(?:20302|session_expired)/i.test(text)) {
    return { type: 'session_expired', terminal: false, blocker: 'session_expired', description: '营销会话已过期，可通过受管Profile自动重新登录恢复' };
  }
  if (/(?:ECONNREFUSED|socket hang up|connection reset|CDP port|No page target)/i.test(text)) {
    return { type: 'network_disconnect', terminal: false, blocker: 'browser_connection_lost', description: '浏览器CDP连接断开，可重新拉起并复用同一受管Profile' };
  }
  return { type: 'unknown_session_issue', terminal: false, blocker: 'login_recovery_incomplete', description: '会话状态未就绪' };
}

export function createManagedStoreSessionLifecycle({
  storeKey = '',
  port = null,
  leaseTask = String(process.env.SHEIN_BI_BROWSER_LEASE_TASK || '').trim(),
  leaseRunId = String(process.env.SHEIN_BI_BROWSER_LEASE_RUN_ID || '').trim(),
  idleTimeoutMs = 600000,
} = {}) {
  const normalizedStore = String(storeKey || '').trim().toUpperCase();
  if (!normalizedStore) throw new Error('createManagedStoreSessionLifecycle requires storeKey');
  let activePort = port;
  let status = 'initialized';
  const stepHistory = [];
  let lastActiveAt = Date.now();
  let closed = false;
  return {
    storeKey: normalizedStore,
    leaseTask,
    leaseRunId,
    idleTimeoutMs,
    getPort: () => activePort,
    setPort: (p) => { activePort = p; },
    getStatus: () => status,
    getLastActiveAt: () => lastActiveAt,
    isClosed: () => closed,
    isIdleTimedOut: (now = Date.now()) => (now - lastActiveAt > idleTimeoutMs),
    assertProfileOwner: (claim = {}) => {
      const claimStore = String(claim.storeKey || '').trim().toUpperCase();
      if (claimStore && claimStore !== normalizedStore) {
        throw new Error('Profile owner mismatch: Session is for ' + normalizedStore + ' but caller is ' + claimStore);
      }
      if (leaseTask && claim.leaseTask && claim.leaseTask !== leaseTask) {
        throw new Error('Browser lease task mismatch: owned by ' + leaseTask + ' but claimed by ' + claim.leaseTask);
      }
      if (leaseRunId && claim.leaseRunId && claim.leaseRunId !== leaseRunId) {
        throw new Error('Browser lease run ID mismatch: owned by ' + leaseRunId + ' but claimed by ' + claim.leaseRunId);
      }
      return true;
    },
    recordStep: (stepName, details = {}) => {
      if (closed) throw new Error('Cannot execute step ' + stepName + ' on closed session for store ' + normalizedStore);
      lastActiveAt = Date.now();
      stepHistory.push({step: stepName, at: lastActiveAt, details});
      status = 'step_' + stepName;
      return {step: stepName, storeKey: normalizedStore, totalSteps: stepHistory.length};
    },
    shouldKeepOpenBetweenSteps: (currentStep, nextStep) => {
      if (closed) return false;
      const validTransitions = [
        ['login_recovery', 'preflight'],
        ['preflight', 'submit'],
        ['submit', 'readback'],
        ['submit', 'exact_readback'],
      ];
      return validTransitions.some(([from, to]) => from === currentStep && to === nextStep) || !nextStep;
    },
    assertStoreIsolation: (otherStoreKey) => {
      const other = String(otherStoreKey || '').trim().toUpperCase();
      if (other && other !== normalizedStore) {
        throw new Error('Store isolation violation: Attempted to use session for ' + normalizedStore + ' with store ' + other);
      }
      return true;
    },
    close: (reason = 'idle_timeout') => {
      closed = true;
      status = 'closed_' + reason;
      return {storeKey: normalizedStore, closed: true, reason, historyCount: stepHistory.length};
    },
    getSummary: () => ({
      storeKey: normalizedStore,
      status,
      closed,
      stepCount: stepHistory.length,
      history: [...stepHistory],
      lastActiveAt,
    }),
  };
}
