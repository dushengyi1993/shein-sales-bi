const DEFAULT_TARGET_BUDGET = 1000;

function normalizeStoreKey(value) {
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

function sourceIsUsableExecute(source) {
  return Boolean(source && source.exists !== false && source.status === 'ok');
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
  dryRunDoc = null,
  dryRunSource = null,
  storesConfigDoc = null,
  targetBudget = null,
} = {}) {
  const executeRows = Array.isArray(executeDoc?.stores) ? executeDoc.stores : [];
  const dryRunRows = Array.isArray(dryRunDoc?.stores) ? dryRunDoc.stores : [];
  const expectedStores = enabledStoreKeys(storesConfigDoc, executeRows.length ? executeRows : dryRunRows);
  const resolvedTarget = numberOrNull(targetBudget)
    ?? numberOrNull(executeDoc?.budget)
    ?? numberOrNull(dryRunDoc?.budget)
    ?? DEFAULT_TARGET_BUDGET;

  const executeUsable = sourceIsUsableExecute(executeSource) && executeDoc?.execute === true;
  const selectedRows = executeUsable ? executeRows : [];
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
        selectedSource: executeUsable ? 'execute' : 'none',
        hasDryRunObservation: Boolean(dryRunRow),
        dryRunObservedBudget: dryRunRow ? firstNumberEvidence(dryRunRow).value : null,
        requestedBudget: null,
        ok: null,
        writeOk: null,
        writeCodes: {},
        reason: executeUsable
          ? 'execute result did not include this enabled store'
          : 'no fresh execute readback evidence; dry-run observations are not treated as completed budget updates',
      });
      continue;
    }

    const budget = firstNumberEvidence(row);
    const write = writeStatus(row);
    let status = 'missing_evidence';
    let reason = 'missing before/after coupon_usage_upper_limit readback';
    if (budget.value !== null && budget.value >= resolvedTarget) {
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
      selectedSource: 'execute',
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

  let selectedSource = 'none';
  if (executeUsable) selectedSource = 'execute';
  else if (executeDoc && executeSource?.status === 'stale') selectedSource = 'execute_stale_not_accepted';
  else if (dryRunDoc) selectedSource = 'dry_run_only_not_completion_evidence';

  const status = belowTargetStores.length || missingEvidenceStores.length
    ? 'blocked'
    : (writeFailureButAtTargetStores.length ? 'ok_with_write_warnings' : 'ok');

  return {
    status,
    activityId: executeDoc?.activityId ?? dryRunDoc?.activityId ?? null,
    site: executeDoc?.site || dryRunDoc?.site || '',
    currency: executeDoc?.currency || dryRunDoc?.currency || 'SAR',
    targetBudget: resolvedTarget,
    selectedSource,
    evidenceSource: briefSource(executeSource),
    dryRunSource: briefSource(dryRunSource),
    executeCreatedAt: executeDoc?.createdAt || '',
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
    failures: Array.isArray(executeDoc?.failures) ? executeDoc.failures : [],
    rows,
  };
}
