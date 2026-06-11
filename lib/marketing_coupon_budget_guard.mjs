const DEFAULT_TARGET_BUDGET = 1000;
const EXPECTED_ACTIVITY_ID = 34810;
const EXPECTED_SITE = 'shein-sa';
const EXPECTED_CURRENCY = 'SAR';

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSite(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumberEvidence(row) {
  const candidates = [
    ['after.usageSite.coupon_usage_upper_limit', row?.after?.usageSite?.coupon_usage_upper_limit],
    ['after.budgetInfoSite.coupon_usage_upper_limit', row?.after?.budgetInfoSite?.coupon_usage_upper_limit],
    ['before.usageSite.coupon_usage_upper_limit', row?.before?.usageSite?.coupon_usage_upper_limit],
    ['before.budgetInfoSite.coupon_usage_upper_limit', row?.before?.budgetInfoSite?.coupon_usage_upper_limit],
  ];
  for (const [source, raw] of candidates) {
    const value = numberOrNull(raw);
    if (value !== null) {
      const parts = source.split('.');
      const holder = parts[0] === 'after' ? row?.after : row?.before;
      const site = parts[1] === 'usageSite' ? holder?.usageSite : holder?.budgetInfoSite;
      return {
        value,
        source,
        stage: parts[0],
        usedAmount: numberOrNull(site?.coupon_used_amount),
        siteBudgetState: numberOrNull(site?.site_budget_state),
      };
    }
  }
  return {
    value: null,
    source: '',
    stage: '',
    usedAmount: null,
    siteBudgetState: null,
  };
}

function writeStatus(row) {
  const activityLimitCode = String(row?.write?.activityLimit?.code ?? '').trim();
  const siteBudgetCode = String(row?.write?.siteBudget?.code ?? '').trim();
  const codes = {};
  if (activityLimitCode) codes.activityLimit = activityLimitCode;
  if (siteBudgetCode) codes.siteBudget = siteBudgetCode;
  const hasWrite = Boolean(row?.write);
  const writeOk = !hasWrite || Object.values(codes).every(code => code === '0');
  return {
    hasWrite,
    writeOk,
    codes,
    messages: {
      activityLimit: row?.write?.activityLimit?.msg || '',
      siteBudget: row?.write?.siteBudget?.msg || '',
    },
  };
}

function enabledStoreKeys(storesConfigDoc, fallbackRows) {
  const fromConfig = (storesConfigDoc?.stores || [])
    .filter(s => s && s.enabled !== false)
    .map(s => normalizeStoreKey(s.storeKey))
    .filter(Boolean);
  if (fromConfig.length) return [...new Set(fromConfig)].sort();
  return [...new Set((fallbackRows || [])
    .map(r => normalizeStoreKey(r?.storeKey || r?.store))
    .filter(Boolean))].sort();
}

function requireBudgetAtOrAbove(doc, field, target, issues, {required = false} = {}) {
  const hasField = doc && Object.prototype.hasOwnProperty.call(doc, field);
  if (!hasField && !required) return;
  const value = numberOrNull(doc?.[field]);
  if (value === null) {
    issues.push(`${field} missing or non-numeric`);
  } else if (value < target) {
    issues.push(`${field} below target: ${value}<${target}`);
  }
}

function pushSharedScopeIssues(issues, doc, target, label = 'document') {
  if (!doc || typeof doc !== 'object') {
    issues.push(`${label} missing`);
    return;
  }
  if (Number(doc.activityId) !== EXPECTED_ACTIVITY_ID) {
    issues.push(`${label} activityId must be ${EXPECTED_ACTIVITY_ID}`);
  }
  if (normalizeSite(doc.site) !== EXPECTED_SITE) {
    issues.push(`${label} site must be ${EXPECTED_SITE}`);
  }
  if (normalizeCurrency(doc.currency) !== EXPECTED_CURRENCY) {
    issues.push(`${label} currency must be ${EXPECTED_CURRENCY}`);
  }
}

function rowBudgetFieldIssues(row, target, issues, {required = false, label = 'row'} = {}) {
  const hasRequested = row && Object.prototype.hasOwnProperty.call(row, 'requestedBudget');
  if (!hasRequested && !required) return;
  const value = numberOrNull(row?.requestedBudget);
  if (value === null) issues.push(`${label} requestedBudget missing or non-numeric`);
  else if (value < target) issues.push(`${label} requestedBudget below target: ${value}<${target}`);
}

function pushRowScopeIssues(issues, row, kind, target, index) {
  const label = `stores[${index}]`;
  pushSharedScopeIssues(issues, row, target, label);
  rowBudgetFieldIssues(row, target, issues, {
    required: kind === 'readback',
    label,
  });

  if (kind === 'readback') {
    if (row?.readOnly !== true) issues.push(`${label} readOnly must be true`);
    if (row?.execute !== false) issues.push(`${label} execute must be false`);
    if (row?.writeAttempted !== false) issues.push(`${label} writeAttempted must be false`);
    if (numberOrNull(row?.writeEndpointCalls) !== 0) issues.push(`${label} writeEndpointCalls must be 0`);
    if (row?.write !== undefined && row?.write !== null) issues.push(`${label} must not contain write result`);
  }
}

function documentScopeIssues(doc, kind, targetBudget) {
  const target = numberOrNull(targetBudget) ?? DEFAULT_TARGET_BUDGET;
  const issues = [];
  pushSharedScopeIssues(issues, doc, target);
  if (!doc || typeof doc !== 'object') return issues;

  if (kind === 'execute') {
    if (doc.execute !== true) issues.push('execute must be true');
    if (doc.readOnly === true) issues.push('readOnly must not be true for execute evidence');
    if (doc.mode !== undefined && doc.mode !== 'execute') issues.push('mode must be execute when present');
    requireBudgetAtOrAbove(doc, 'budget', target, issues, {required: true});
    requireBudgetAtOrAbove(doc, 'targetBudget', target, issues, {required: false});
  } else if (kind === 'readback') {
    if (doc.mode !== 'readback') issues.push('mode must be readback');
    if (doc.readOnly !== true) issues.push('readOnly must be true');
    if (doc.execute !== false) issues.push('execute must be false');
    if (doc.writeAttempted !== false) issues.push('writeAttempted must be false');
    if (numberOrNull(doc.writeEndpointCalls) !== 0) issues.push('writeEndpointCalls must be 0');
    requireBudgetAtOrAbove(doc, 'budget', target, issues, {required: true});
    requireBudgetAtOrAbove(doc, 'targetBudget', target, issues, {required: true});
  }

  if (!Array.isArray(doc.stores)) {
    issues.push('stores must be an array');
  } else {
    doc.stores.forEach((row, index) => pushRowScopeIssues(issues, row, kind, target, index));
  }
  return issues;
}

function sourceIsUsableExecute(source, doc, targetBudget) {
  return Boolean(
    source
    && source.exists !== false
    && source.status === 'ok'
    && documentScopeIssues(doc, 'execute', targetBudget).length === 0
  );
}

function sourceIsUsableReadback(source, doc, targetBudget) {
  return Boolean(
    source
    && source.exists !== false
    && source.status === 'ok'
    && documentScopeIssues(doc, 'readback', targetBudget).length === 0
  );
}

function firstEvidenceRejectionReason({executeScopeIssues, readbackScopeIssues, executeSource, readbackSource}) {
  if (executeSource?.status === 'ok' && executeScopeIssues.length) {
    return `execute budget evidence rejected: ${executeScopeIssues[0]}`;
  }
  if (readbackSource?.status === 'ok' && readbackScopeIssues.length) {
    return `read-only current budget evidence rejected: ${readbackScopeIssues[0]}`;
  }
  return 'no fresh execute or read-only current budget evidence; dry-run observations are not treated as completed budget updates';
}

function briefSource(source) {
  return {
    path: source?.path || '',
    status: source?.status || 'missing',
    artifactAgeHours: source?.artifactAgeHours ?? null,
    dataAgeHours: source?.dataAgeHours ?? null,
  };
}

export function summarizeCouponBudgetStatus({
  executeDoc = null,
  executeSource = null,
  readbackDoc = null,
  readbackSource = null,
  dryRunDoc = null,
  dryRunSource = null,
  storesConfigDoc = null,
  targetBudget = null,
} = {}) {
  const executeRows = Array.isArray(executeDoc?.stores) ? executeDoc.stores : [];
  const readbackRows = Array.isArray(readbackDoc?.stores) ? readbackDoc.stores : [];
  const dryRunRows = Array.isArray(dryRunDoc?.stores) ? dryRunDoc.stores : [];
  const expectedStores = enabledStoreKeys(storesConfigDoc, executeRows.length ? executeRows : (readbackRows.length ? readbackRows : dryRunRows));
  const requiredTargetBudget = numberOrNull(targetBudget) ?? DEFAULT_TARGET_BUDGET;
  const resolvedTarget = numberOrNull(targetBudget)
    ?? numberOrNull(executeDoc?.budget)
    ?? numberOrNull(readbackDoc?.targetBudget)
    ?? numberOrNull(readbackDoc?.budget)
    ?? numberOrNull(dryRunDoc?.budget)
    ?? DEFAULT_TARGET_BUDGET;

  const executeScopeIssues = documentScopeIssues(executeDoc, 'execute', requiredTargetBudget);
  const readbackScopeIssues = documentScopeIssues(readbackDoc, 'readback', requiredTargetBudget);
  const rejectedEvidenceReason = firstEvidenceRejectionReason({
    executeScopeIssues,
    readbackScopeIssues,
    executeSource,
    readbackSource,
  });
  const executeUsable = sourceIsUsableExecute(executeSource, executeDoc, requiredTargetBudget);
  const readbackUsable = !executeUsable && sourceIsUsableReadback(readbackSource, readbackDoc, requiredTargetBudget);
  const selectedSource = executeUsable ? 'execute' : (readbackUsable ? 'readback_current' : 'none');
  const selectedRows = executeUsable ? executeRows : (readbackUsable ? readbackRows : []);
  const selectedByStore = new Map(selectedRows.map(r => [normalizeStoreKey(r?.storeKey || r?.store), r]));
  const dryRunByStore = new Map(dryRunRows.map(r => [normalizeStoreKey(r?.storeKey || r?.store), r]));
  const rows = [];

  for (const storeKey of expectedStores) {
    const row = selectedByStore.get(storeKey);
    if (!row) {
      const dryRunRow = dryRunByStore.get(storeKey);
      rows.push({
        storeKey,
        status: 'missing_evidence',
        currentBudget: null,
        usedAmount: null,
        siteBudgetState: null,
        evidenceSource: '',
        evidenceStage: '',
        selectedSource,
        hasDryRunObservation: Boolean(dryRunRow),
        dryRunObservedBudget: dryRunRow ? firstNumberEvidence(dryRunRow).value : null,
        requestedBudget: null,
        ok: null,
        writeOk: null,
        writeCodes: {},
        reason: executeUsable
          ? 'execute result did not include this enabled store'
          : (readbackUsable
            ? 'readback result did not include this enabled store'
            : rejectedEvidenceReason),
      });
      continue;
    }

    const budget = firstNumberEvidence(row);
    const write = writeStatus(row);
    const readbackRejected = readbackUsable && (row?.readback?.ok !== true || row?.ok !== true);
    let status = 'missing_evidence';
    let reason = 'missing before/after coupon_usage_upper_limit readback';
    if (readbackRejected) {
      reason = row?.reason || 'read-only current budget readback did not pass strict validation';
    } else if (budget.value !== null && budget.value >= resolvedTarget) {
      status = row.ok === false || write.writeOk === false ? 'write_failed_but_at_target' : 'at_target';
      reason = status === 'write_failed_but_at_target'
        ? 'write failed or store result not ok, but readback budget is already at target'
        : 'readback budget is at target';
    } else if (budget.value !== null) {
      status = 'below_target';
      reason = 'readback budget is below target';
    }
    rows.push({
      storeKey,
      status,
      currentBudget: budget.value,
      usedAmount: budget.usedAmount,
      siteBudgetState: budget.siteBudgetState,
      evidenceSource: budget.source,
      evidenceStage: budget.stage,
      selectedSource,
      hasDryRunObservation: dryRunByStore.has(storeKey),
      dryRunObservedBudget: dryRunByStore.has(storeKey) ? firstNumberEvidence(dryRunByStore.get(storeKey)).value : null,
      requestedBudget: numberOrNull(row?.requestedBudget),
      ok: row?.ok ?? null,
      writeOk: write.writeOk,
      writeCodes: write.codes,
      writeMessages: write.messages,
      reason: row?.reason || reason,
    });
  }

  const verifiedAtTargetStores = rows
    .filter(r => r.status === 'at_target' || r.status === 'write_failed_but_at_target')
    .map(r => r.storeKey);
  const belowTargetStores = rows
    .filter(r => r.status === 'below_target')
    .map(r => ({
      storeKey: r.storeKey,
      currentBudget: r.currentBudget,
      targetBudget: resolvedTarget,
      evidenceSource: r.evidenceSource,
    }));
  const missingEvidenceStores = rows
    .filter(r => r.status === 'missing_evidence')
    .map(r => ({
      storeKey: r.storeKey,
      reason: r.reason,
      hasDryRunObservation: r.hasDryRunObservation,
      dryRunObservedBudget: r.dryRunObservedBudget,
    }));
  const writeFailureButAtTargetStores = rows
    .filter(r => r.status === 'write_failed_but_at_target')
    .map(r => ({
      storeKey: r.storeKey,
      currentBudget: r.currentBudget,
      evidenceSource: r.evidenceSource,
      writeCodes: r.writeCodes,
      reason: r.reason,
    }));

  let summarySelectedSource = selectedSource;
  if (executeUsable) summarySelectedSource = 'execute';
  else if (readbackUsable) summarySelectedSource = 'readback_current';
  else if (executeDoc && executeSource?.status === 'stale') summarySelectedSource = 'execute_stale_not_accepted';
  else if (readbackDoc && readbackSource?.status === 'stale') summarySelectedSource = 'readback_stale_not_accepted';
  else if (executeDoc && executeSource?.status === 'ok' && executeScopeIssues.length) summarySelectedSource = 'execute_invalid_scope_not_accepted';
  else if (readbackDoc && readbackSource?.status === 'ok' && readbackScopeIssues.length) summarySelectedSource = 'readback_invalid_scope_not_accepted';
  else if (dryRunDoc) summarySelectedSource = 'dry_run_only_not_completion_evidence';

  const status = belowTargetStores.length || missingEvidenceStores.length
    ? 'blocked'
    : (writeFailureButAtTargetStores.length ? 'ok_with_write_warnings' : 'ok');

  return {
    status,
    activityId: executeDoc?.activityId ?? readbackDoc?.activityId ?? dryRunDoc?.activityId ?? null,
    site: executeDoc?.site || readbackDoc?.site || dryRunDoc?.site || '',
    currency: executeDoc?.currency || readbackDoc?.currency || dryRunDoc?.currency || 'SAR',
    targetBudget: resolvedTarget,
    selectedSource: summarySelectedSource,
    evidenceSource: briefSource(executeSource),
    readbackSource: briefSource(readbackSource),
    dryRunSource: briefSource(dryRunSource),
    executeCreatedAt: executeDoc?.createdAt || '',
    readbackCreatedAt: readbackDoc?.createdAt || '',
    dryRunCreatedAt: dryRunDoc?.createdAt || '',
    expectedStoreCount: expectedStores.length,
    verifiedAtTargetCount: verifiedAtTargetStores.length,
    belowTargetCount: belowTargetStores.length,
    missingEvidenceCount: missingEvidenceStores.length,
    writeFailureButAtTargetCount: writeFailureButAtTargetStores.length,
    verifiedAtTargetStores,
    belowTargetStores,
    missingEvidenceStores,
    writeFailureButAtTargetStores,
    failures: Array.isArray(executeDoc?.failures)
      ? executeDoc.failures
      : (Array.isArray(readbackDoc?.failures) ? readbackDoc.failures : []),
    evidenceValidation: {
      executeIssues: executeScopeIssues,
      readbackIssues: readbackScopeIssues,
    },
    rows,
  };
}
