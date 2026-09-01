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
