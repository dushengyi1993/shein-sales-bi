export function extractShopNameFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = line.match(/半托管店铺\s*([A-Za-z0-9_-]{2,})/);
    if (inline) return inline[1].trim();
    if (!line.includes('半托管店铺')) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      const candidate = lines[j];
      if (!candidate || candidate === 'new') continue;
      if (/^(体验双列菜单|收藏|首页|订单|库存|商品|营销|营销活动报名)$/.test(candidate)) continue;
      if (/^[A-Za-z0-9_-]{2,}$/.test(candidate)) return candidate;
    }
  }
  return '';
}

export function normalizeShopName(value) {
  return String(value || '').trim();
}

export function validateStoreIdentity({
  store,
  truth = null,
  text = '',
  storageIdentity = null,
  href = '',
  context = '',
  requireActual = false,
} = {}) {
  const expectedShopName = normalizeShopName(store?.shopName);
  const actualShopName = extractShopNameFromText(text);
  const identity = normalizeIdentityCandidates(storageIdentity);
  const expectedAccountNo = normalizeShopName(truth?.accountNo || store?.accountNo);
  const expectedMerchantId = normalizeShopName(truth?.merchantId || store?.merchantId);
  const expectedLoginAlias = normalizeShopName(store?.loginAlias || truth?.loginAlias);
  const check = {
    ok: true,
    context,
    storeKey: String(store?.storeKey || '').toUpperCase(),
    profileKey: store?.profileKey || '',
    port: store?.port || '',
    expectedShopName,
    expectedAccountNo,
    expectedMerchantId,
    expectedLoginAlias,
    actualShopName,
    identity,
    href,
    reason: '',
  };
  if (expectedAccountNo || expectedMerchantId) {
    const accountValues = new Set([
      actualShopName,
      ...identity.accountNos,
      ...identity.userNames,
      ...identity.mainUserNames,
      ...identity.supplierUserNames,
    ].filter(Boolean).map(normalizeShopName));
    const merchantValues = new Set([
      ...identity.supplierIds,
      ...identity.externalIds,
    ].filter(Boolean).map(normalizeShopName));
    const supplierIdValues = new Set(identity.supplierIds.filter(Boolean).map(normalizeShopName));
    check.accountCandidates = [...accountValues];
    check.merchantCandidates = [...merchantValues];
    check.supplierIdCandidates = [...supplierIdValues];
    const accountConflicts = expectedAccountNo
      ? [...accountValues].filter(value => /^GS\d+$/i.test(value) && value !== expectedAccountNo)
      : [];
    const merchantConflicts = expectedMerchantId
      ? [...supplierIdValues].filter(value => /^\d+$/.test(value) && value !== expectedMerchantId)
      : [];
    check.accountConflicts = accountConflicts;
    check.merchantConflicts = merchantConflicts;
    const accountOk = !expectedAccountNo || accountValues.has(expectedAccountNo);
    const merchantOk = !expectedMerchantId || merchantValues.has(expectedMerchantId);
    check.accountOk = accountOk;
    check.merchantOk = merchantOk;
    if (accountConflicts.length || merchantConflicts.length) {
      check.ok = false;
      check.reason = 'conflicting_identity_candidates';
    } else if (!accountOk || !merchantOk) {
      check.ok = false;
      check.reason = !accountOk && !merchantOk
        ? 'account_and_merchant_mismatch'
        : !accountOk
          ? 'account_mismatch'
          : 'merchant_mismatch';
    }
    return check;
  }
  if (expectedShopName && !actualShopName && requireActual) {
    check.ok = false;
    check.reason = 'missing_actual_shop_name';
    return check;
  }
  if (expectedShopName && actualShopName && expectedShopName !== actualShopName) {
    check.ok = false;
    check.reason = 'shop_name_mismatch';
    return check;
  }
  return check;
}

export function validateStoreIdentitySnapshot({
  store,
  truth = null,
  snapshot = null,
  context = '',
  requireActual = false,
} = {}) {
  const text = [
    snapshot?.textHead || '',
    snapshot?.textTail || '',
    snapshot?.text || '',
  ].filter(Boolean).join('\n');
  return validateStoreIdentity({
    store,
    truth,
    text,
    storageIdentity: snapshot?.storageIdentity,
    href: snapshot?.href || '',
    context,
    requireActual,
  });
}

export function requireStoreIdentitySnapshot(options = {}) {
  const check = validateStoreIdentitySnapshot(options);
  if (!check.ok) {
    const error = new Error(formatStoreIdentityError(check));
    error.identityCheck = check;
    throw error;
  }
  return check;
}

export function formatStoreIdentityError(check) {
  const parts = [
    'store identity mismatch',
    `store=${check?.storeKey || ''}`,
    `profile=${check?.profileKey || ''}`,
    `expected=${check?.expectedAccountNo || check?.expectedShopName || '(unknown)'}`,
    `actual=${check?.actualShopName || '(not detected)'}`,
  ];
  if (check?.expectedMerchantId) parts.push(`merchant=${check.expectedMerchantId}`);
  if (check?.accountCandidates?.length) parts.push(`accountCandidates=${check.accountCandidates.slice(0, 8).join(',')}`);
  if (check?.merchantCandidates?.length) parts.push(`merchantCandidates=${check.merchantCandidates.slice(0, 8).join(',')}`);
  if (check?.accountConflicts?.length) parts.push(`accountConflicts=${check.accountConflicts.slice(0, 8).join(',')}`);
  if (check?.merchantConflicts?.length) parts.push(`merchantConflicts=${check.merchantConflicts.slice(0, 8).join(',')}`);
  if (check?.reason) parts.push(`reason=${check.reason}`);
  if (check?.context) parts.push(`context=${check.context}`);
  return parts.join(' ');
}

export function normalizeIdentityCandidates(identity = null) {
  const out = {
    accountNos: [],
    userNames: [],
    mainUserNames: [],
    supplierUserNames: [],
    supplierIds: [],
    externalIds: [],
    emplids: [],
    companyNames: [],
    rawSources: [],
  };
  if (!identity || typeof identity !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (key === 'rawSources') continue;
    out[key] = uniqueArray(Array.isArray(identity[key]) ? identity[key] : []);
  }
  out.rawSources = uniqueArray(Array.isArray(identity.rawSources) ? identity.rawSources : []);
  return out;
}

export function uniqueArray(values) {
  return [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))];
}

/**
 * Convert the many query-store-info response shapes seen across SHEIN OpenAPI
 * versions into the same candidate structure used by browser identity checks.
 * Keep this in one security boundary: executors must not drift into accepting
 * different account/merchant fields independently.
 */
export function openApiIdentityToStorageIdentity(value, {maxDepth = 8} = {}) {
  const target = {
    accountNos: new Set(),
    userNames: new Set(),
    mainUserNames: new Set(),
    supplierUserNames: new Set(),
    supplierIds: new Set(),
    externalIds: new Set(),
    emplids: new Set(),
    companyNames: new Set(),
    rawSources: new Set(),
  };
  const add = (name, candidate, transform = x => x) => {
    const text = String(candidate ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (text) target[name].add(transform(text));
  };
  const walk = (node, source = 'openapi', depth = 0) => {
    if (!node || depth > maxDepth) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${source}[${index}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    add('rawSources', source);
    for (const [key, raw] of Object.entries(node)) {
      if (raw && typeof raw === 'object') {
        walk(raw, `${source}.${key}`, depth + 1);
        continue;
      }
      const k = String(key || '').toLowerCase();
      const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/^GS\d+$/i.test(text) || /(accountno|account_no|storeaccount|gsaccount|supplieraccount)/i.test(k)) add('accountNos', text, x => x.toUpperCase());
      if (/(username|user_name|(^|_)name$|shopname|shop_name)/i.test(k)) add('userNames', text);
      if (/mainusername|main_user_name/i.test(k)) add('mainUserNames', text);
      if (/supplierusername|supplier_user_name/i.test(k)) add('supplierUserNames', text);
      if (/(supplierid|supplier_id|merchantid|merchant_id|mallcode|mall_code)/i.test(k)) add('supplierIds', text);
      if (/(externalid|external_id)/i.test(k)) add('externalIds', text);
      if (/(emplid|emp_id|empid)/i.test(k)) add('emplids', text);
      if (/(companyname|company_name|suppliername|supplier_name|storetitle|store_title|shoptitle|shop_title)/i.test(k)) add('companyNames', text);
    }
  };
  walk(value);
  return Object.fromEntries(Object.entries(target).map(([key, set]) => [key, [...set]]));
}

/**
 * SHEIN may return only a merchant id and omit the GS account. That fallback is
 * acceptable only when the expected merchant is present and there is no
 * concrete/conflicting GS or merchant candidate.
 */
export function storeIdentityMatchesMerchantOnly(identityCheck) {
  if (!identityCheck || identityCheck.ok) return Boolean(identityCheck?.ok);
  const expected = String(identityCheck.expectedMerchantId || '').trim();
  if (!expected) return false;
  const merchantCandidates = uniqueArray([
    ...(identityCheck.merchantCandidates || []),
    ...(identityCheck.identity?.supplierIds || []),
    ...(identityCheck.identity?.externalIds || []),
    ...(identityCheck.storageIdentity?.supplierIds || []),
    ...(identityCheck.storageIdentity?.externalIds || []),
  ]);
  const accountCandidates = uniqueArray([
    ...(identityCheck.accountCandidates || []),
    ...(identityCheck.identity?.accountNos || []),
    ...(identityCheck.storageIdentity?.accountNos || []),
  ]);
  const accountConflicts = uniqueArray(identityCheck.accountConflicts || []);
  const merchantConflicts = uniqueArray(identityCheck.merchantConflicts || []);
  const merchantOk = identityCheck.merchantOk === true || merchantCandidates.includes(expected);
  const hasConcreteAccount = accountCandidates.some(candidate => /^GS\d+$/i.test(candidate));
  return merchantOk && !accountConflicts.length && !merchantConflicts.length && !hasConcreteAccount;
}

export const STORE_IDENTITY_BROWSER_SNIPPET = `
function __sheinStoreIdentityAdd(set, value) {
  if (value === null || value === undefined || value === '') return;
  set.add(String(value).trim());
}
function __sheinStoreIdentityParseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}
function __sheinStoreIdentityCollectFromObject(obj, out, source, depth) {
  if (!obj || depth > 5) return;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => __sheinStoreIdentityCollectFromObject(item, out, source + '[' + index + ']', depth + 1));
    return;
  }
  if (typeof obj !== 'object') return;
  __sheinStoreIdentityAdd(out.rawSources, source);
  __sheinStoreIdentityAdd(out.userNames, obj.userName || obj.username || obj.name || obj.enName);
  __sheinStoreIdentityAdd(out.mainUserNames, obj.mainUserName);
  __sheinStoreIdentityAdd(out.supplierUserNames, obj.supplierUserName);
  __sheinStoreIdentityAdd(out.supplierIds, obj.supplierId || obj.supplier_id || obj.merchantId || obj.merchant_id);
  __sheinStoreIdentityAdd(out.externalIds, obj.externalId || obj.external_id);
  __sheinStoreIdentityAdd(out.emplids, obj.emplid || obj.empId);
  __sheinStoreIdentityAdd(out.companyNames, obj.company_name || obj.companyName || (obj.commonData && obj.commonData.company_name));
  for (const v of [obj.userName, obj.username, obj.name, obj.enName, obj.mainUserName, obj.supplierUserName, obj.accountNo, obj.account_no]) {
    if (/^GS\\d+$/i.test(String(v || '').trim())) __sheinStoreIdentityAdd(out.accountNos, String(v).trim().toUpperCase());
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object') continue;
    if (/(user|supplier|merchant|commonData|login|account|auth|seller|company)/i.test(key)) {
      __sheinStoreIdentityCollectFromObject(value, out, source + '.' + key, depth + 1);
    }
  }
}
function readSheinStoreIdentitySnapshot() {
  const out = {
    accountNos: new Set(),
    userNames: new Set(),
    mainUserNames: new Set(),
    supplierUserNames: new Set(),
    supplierIds: new Set(),
    externalIds: new Set(),
    emplids: new Set(),
    companyNames: new Set(),
    rawSources: new Set(),
  };
  for (const storageName of ['localStorage', 'sessionStorage']) {
    const storage = window[storageName];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!/(user|supplier|merchant|login|account|auth|seller|company|MBRS_USER_INFO|page-spy)/i.test(key || '')) continue;
      const parsed = __sheinStoreIdentityParseMaybeJson(storage.getItem(key));
      __sheinStoreIdentityCollectFromObject(parsed, out, storageName + ':' + key, 0);
    }
  }
  const text = document.body?.innerText || '';
  return {
    href: location.href,
    title: document.title,
    isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
    textHead: text.slice(0, 2200),
    textTail: text.slice(-1200),
    storageIdentity: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]])),
  };
}
`;

export function storeIdentityEvalBody() {
  return `${STORE_IDENTITY_BROWSER_SNIPPET}
return readSheinStoreIdentitySnapshot();`;
}
