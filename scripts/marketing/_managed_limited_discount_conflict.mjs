const MANAGED_REQUERY_CODES = new Set([
  'mrs-simple_platform_limit_discounts-0006',
]);

const ACTIVE_ACTIVITY_STATES = new Set([2, 3]);

function uniqueSorted(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort();
}

function sameValues(left, right) {
  return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right));
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeGood(good) {
  return {
    skc: String(good?.skc || '').trim(),
    sku_supplier_no: String(good?.sku_supplier_no ?? ''),
    product_act_price: normalizeNumber(good?.product_act_price),
    max_product_act_price: normalizeNumber(good?.max_product_act_price),
    attend_num_sum: normalizeNumber(good?.attend_num_sum),
    stock_num: normalizeNumber(good?.stock_num),
    goods_state: String(good?.goods_state ?? ''),
    id: String(good?.id ?? ''),
  };
}

function normalizeGoods(goods) {
  return (goods || []).map(normalizeGood).sort((left, right) => left.skc.localeCompare(right.skc));
}

function goodsAreComplete(goods) {
  return goods.every(good => good.skc
    && ['product_act_price', 'attend_num_sum', 'stock_num'].every(field => Number.isFinite(good[field])));
}

function sameGoods(left, right) {
  return JSON.stringify(normalizeGoods(left)) === JSON.stringify(normalizeGoods(right));
}

function comparableTargetGoods(goods) {
  return normalizeGoods(goods).map(good => ({
    skc: good.skc,
    product_act_price: good.product_act_price,
    attend_num_sum: good.attend_num_sum,
    stock_num: good.stock_num,
  }));
}

function normalizedConflictEvidence(full, skc) {
  const value = String(skc || '').trim();
  if (!value) return [];
  const evidence = [];
  for (const activity of full?.before?.conflictActivities || []) {
    const activityId = Number(activity?.activity_id);
    const state = Number(activity?.state);
    const targetSkcs = uniqueSorted(activity?.targetSkcs);
    const targetGoods = (activity?.targetGoods || []).filter(good => String(good?.skc || '').trim() === value);
    if (!Number.isFinite(activityId) || activityId <= 0 || !ACTIVE_ACTIVITY_STATES.has(state)) continue;
    if (!targetSkcs.includes(value) || targetGoods.length !== 1) continue;
    evidence.push({
      activityId,
      state,
      skc: value,
      extraSkcs: uniqueSorted(activity?.extraSkcs),
      targetGood: targetGoods[0],
    });
  }
  return evidence;
}

function isInventoryRowHandled(row, planBySkc) {
  const skc = String(row?.skc || '').trim();
  const plan = planBySkc.get(skc);
  if (!plan) return false;
  if (row?.reason === 'inventory below configured activity stock') return true;
  if (plan?.requiresTemporaryRaise !== true) return false;
  return row?.reason === 'inventory below min_stock'
    || row?.error_code === 'mrs-simple_platform_limit_discounts-101018';
}

/**
 * Partition one live limited-discount preflight without assigning a business
 * meaning to platform code 0004. Only the explicit 0006 occupancy receipt may
 * be re-queried after the same SKC is proven to be an active member of a
 * concrete old activity. 0004 remains blocked because restoration capability
 * after a delete has not been established.
 */
export function partitionManagedLimitedDiscountPreflight(full, {inventoryPlanRows = []} = {}) {
  const blockedBySkc = new Map();
  const managedRowsBySkc = new Map();
  const managedEvidenceBySkc = new Map();
  const inventoryRowsBySkc = new Map();
  const planBySkc = new Map((inventoryPlanRows || [])
    .map(row => [String(row?.skc || '').trim(), row])
    .filter(([skc]) => Boolean(skc)));

  const add = (map, skc, row) => {
    const value = String(skc || '').trim();
    if (!value) return;
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(row);
  };

  const scopedTargetSkcs = uniqueSorted([
    ...(full?.targetSkcs || []),
    ...(full?.before?.conflictActivities || []).flatMap(activity => activity?.targetSkcs || []),
    ...(full?.validation?.invalid || []).map(row => row?.skc),
  ]);
  const addGlobalBlocker = row => {
    const targets = scopedTargetSkcs.length ? scopedTargetSkcs : ['__GLOBAL__'];
    for (const skc of targets) add(blockedBySkc, skc, row);
  };

  for (const row of full?.validation?.invalid || []) {
    const skc = String(row?.skc || '').trim();
    if (!skc) {
      addGlobalBlocker({...row, reason: row?.reason || 'unscoped validation error'});
      continue;
    }
    const code = String(row?.error_code || '');
    const evidence = row?.reason === 'query_goods error_code' && MANAGED_REQUERY_CODES.has(code)
      ? normalizedConflictEvidence(full, skc)
      : [];
    if (evidence.length) {
      add(managedRowsBySkc, skc, row);
      managedEvidenceBySkc.set(skc, evidence);
    } else if (isInventoryRowHandled(row, planBySkc)) {
      add(inventoryRowsBySkc, skc, row);
    } else {
      add(blockedBySkc, skc, row);
    }
  }

  for (const skc of full?.validation?.missing || []) {
    add(blockedBySkc, skc, {skc: String(skc || '').trim(), reason: 'query_goods missing'});
  }
  for (const row of full?.skippedUnreportable || []) {
    const blocker = {...row, reason: row?.reason || 'skippedUnreportable'};
    if (String(row?.skc || '').trim()) add(blockedBySkc, row.skc, blocker);
    else addGlobalBlocker(blocker);
  }

  const activeConflictSkcs = uniqueSorted((full?.before?.conflictActivities || [])
    .filter(activity => Number.isFinite(Number(activity?.activity_id))
      && Number(activity.activity_id) > 0
      && ACTIVE_ACTIVITY_STATES.has(Number(activity?.state)))
    .flatMap(activity => activity?.targetSkcs || []));
  for (const skc of activeConflictSkcs) {
    if (managedRowsBySkc.has(skc)) continue;
    add(blockedBySkc, skc, {
      skc,
      reason: 'active limited-discount conflict lacks exact managed query_goods evidence',
    });
  }

  const blockedSkcs = uniqueSorted([...blockedBySkc.keys()]);
  const blockedSet = new Set(blockedSkcs);
  const managedConflictSkcs = uniqueSorted([...managedRowsBySkc.keys()].filter(skc => !blockedSet.has(skc)));
  const inventoryHandledSkcs = uniqueSorted([...inventoryRowsBySkc.keys()].filter(skc => !blockedSet.has(skc)));
  return {
    blockedSkcs,
    managedConflictSkcs,
    inventoryHandledSkcs,
    blockedBySkc: Object.fromEntries([...blockedBySkc].map(([skc, rows]) => [skc, rows])),
    managedRowsBySkc: Object.fromEntries([...managedRowsBySkc].map(([skc, rows]) => [skc, rows])),
    managedEvidenceBySkc: Object.fromEntries([...managedEvidenceBySkc]),
    inventoryRowsBySkc: Object.fromEntries([...inventoryRowsBySkc].map(([skc, rows]) => [skc, rows])),
  };
}

/**
 * Validate the selective-delete helper's complete membership readback. The
 * expected before set is locked by the earlier snapshot; every non-target SKC
 * must remain present after the mutation.
 */
export function validateSelectiveLimitedDiscountRemoval({
  full,
  plannedSkcs,
  expectedPreserveSkcs,
  expectedBeforeSkcs,
  expectedBeforeGoods,
  requireAfter = false,
} = {}) {
  const errors = [];
  const planned = uniqueSorted(plannedSkcs);
  const preserved = uniqueSorted(expectedPreserveSkcs);
  const expectedBefore = uniqueSorted(expectedBeforeSkcs?.length ? expectedBeforeSkcs : [...planned, ...preserved]);
  const results = Array.isArray(full?.results) ? full.results : [];
  if (results.length !== 1) errors.push('remove_result_count');
  const result = results[0] || {};
  if (planned.some(skc => preserved.includes(skc))) errors.push('target_preserve_overlap');
  const before = result?.before;
  if (!before) errors.push('before_missing');
  if (!sameValues(before?.skcs, expectedBefore)) errors.push('before_membership_mismatch');
  if (!sameValues(before?.removeSkcsPresent, planned)) errors.push('before_targets_mismatch');
  if ((before?.missingToRemove || []).length) errors.push('before_target_missing');
  if (!sameValues(before?.preserveSkcs, preserved)) errors.push('before_preserve_mismatch');
  const beforeGoodsSkcs = (before?.goods || []).map(good => good?.skc);
  if (!sameValues(beforeGoodsSkcs, expectedBefore) || beforeGoodsSkcs.length !== expectedBefore.length) {
    errors.push('before_goods_membership_mismatch');
  }
  const normalizedBeforeGoods = normalizeGoods(before?.goods);
  if (!goodsAreComplete(normalizedBeforeGoods)) errors.push('before_goods_attributes_incomplete');
  if (expectedBeforeGoods && !sameGoods(before?.goods, expectedBeforeGoods)) {
    errors.push('before_goods_attributes_changed');
  }

  const after = result?.after;
  let missingPreservedSkcs = [];
  let changedPreservedSkcs = [];
  if (requireAfter) {
    if (!after) {
      errors.push('after_missing');
      missingPreservedSkcs = preserved;
    } else {
      missingPreservedSkcs = preserved.filter(skc => !uniqueSorted(after.skcs).includes(skc));
      if (!sameValues(after?.skcs, preserved)) errors.push('after_membership_mismatch');
      if ((after?.stillPresent || []).length) errors.push('after_target_still_present');
      if ((after?.missingPreserved || []).length || missingPreservedSkcs.length) errors.push('after_preserved_missing');
      if ((after?.unexpectedAdded || []).length) errors.push('after_unexpected_added');
      const afterGoodsSkcs = (after?.goods || []).map(good => good?.skc);
      if (!sameValues(afterGoodsSkcs, preserved) || afterGoodsSkcs.length !== preserved.length) {
        errors.push('after_goods_membership_mismatch');
      }
      const normalizedAfterGoods = normalizeGoods(after?.goods);
      if (!goodsAreComplete(normalizedAfterGoods)) errors.push('after_goods_attributes_incomplete');
      const expectedPreservedGoods = normalizeGoods(expectedBeforeGoods || before?.goods)
        .filter(good => preserved.includes(good.skc));
      changedPreservedSkcs = preserved.filter(skc => {
        const actual = normalizedAfterGoods.filter(good => good.skc === skc);
        const expected = expectedPreservedGoods.filter(good => good.skc === skc);
        return !sameGoods(actual, expected);
      });
      if (changedPreservedSkcs.length) errors.push('after_preserved_goods_attributes_changed');
      const afterContractErrors = Array.isArray(after?.contractValidation?.errors)
        ? after.contractValidation.errors.map(error => String(error || '').trim()).filter(Boolean)
        : [];
      const activityContractChanged = after?.contractValidation?.ok === false
        && afterContractErrors.some(error => /^after_activity_(missing|id_changed|state_changed|start_time_changed|end_time_changed)$/.test(error));
      if (activityContractChanged) {
        changedPreservedSkcs = uniqueSorted([...changedPreservedSkcs, ...preserved]);
        errors.push('after_preserved_activity_contract_changed');
      }
    }
  }

  if (full?.ok !== true || result?.ok !== true) errors.push('remove_helper_not_ok');
  return {
    ok: errors.length === 0,
    errors: uniqueSorted(errors),
    plannedSkcs: planned,
    preservedSkcs: preserved,
    expectedBeforeSkcs: expectedBefore,
    beforeGoodsSnapshot: normalizedBeforeGoods,
    missingPreservedSkcs: uniqueSorted(missingPreservedSkcs),
    changedPreservedSkcs: uniqueSorted(changedPreservedSkcs),
  };
}

export function validateLimitedDiscountActivitySnapshot({current, expected} = {}) {
  const errors = [];
  if (!current) errors.push('activity_missing');
  if (!expected) errors.push('expected_activity_missing');
  if (errors.length) return {ok: false, errors};
  if (Number(current.activityId) !== Number(expected.activityId)) errors.push('activity_id_changed');
  if (Number(current.state) !== Number(expected.state)) errors.push('activity_state_changed');
  if (String(current.startTime || '') !== String(expected.startTime || '')) errors.push('activity_start_time_changed');
  if (String(current.endTime || '') !== String(expected.endTime || '')) errors.push('activity_end_time_changed');
  if (!sameValues(current.targetSkcs, expected.targetSkcs)) errors.push('activity_target_membership_changed');
  if (!sameValues(current.extraSkcs, expected.extraSkcs)) errors.push('activity_preserve_membership_changed');
  const currentGoods = comparableTargetGoods(current.targetGoods);
  const expectedGoods = comparableTargetGoods(expected.targetGoods);
  if (!goodsAreComplete(currentGoods) || !goodsAreComplete(expectedGoods)) errors.push('activity_target_attributes_incomplete');
  if (JSON.stringify(currentGoods) !== JSON.stringify(expectedGoods)) errors.push('activity_target_attributes_changed');
  return {ok: errors.length === 0, errors: uniqueSorted(errors)};
}

// Keep this function self-contained: remove_skc_from_limited_discount.mjs
// serializes it into the browser execution that performs the final read and
// delete, so the checked bytes and the mutation share one helper invocation.
export function validateRemovalMutationContract({expected, currentActivity, currentGoods, phase = 'before'} = {}) {
  const errors = [];
  const unique = values => [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort();
  const number = value => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const normalizeGood = good => ({
    skc: String(good?.skc || '').trim(),
    sku_supplier_no: String(good?.sku_supplier_no ?? ''),
    product_act_price: number(good?.product_act_price),
    max_product_act_price: number(good?.max_product_act_price),
    attend_num_sum: number(good?.attend_num_sum),
    stock_num: number(good?.stock_num),
    goods_state: String(good?.goods_state ?? ''),
    id: String(good?.id ?? ''),
  });
  const normalizeGoods = goods => (goods || []).map(normalizeGood).sort((left, right) => left.skc.localeCompare(right.skc));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!expected || typeof expected !== 'object') errors.push('expected_contract_missing');
  const planned = unique(expected?.plannedSkcs);
  const preserved = unique(expected?.preserveSkcs);
  const expectedGoods = normalizeGoods(expected?.beforeGoods);
  const requiredSkcs = phase === 'after' ? preserved : unique([...planned, ...preserved]);
  const expectedPhaseGoods = expectedGoods.filter(good => requiredSkcs.includes(good.skc));
  const actualGoods = normalizeGoods(currentGoods);
  if (!planned.length) errors.push('planned_skcs_missing');
  if (planned.some(skc => preserved.includes(skc))) errors.push('target_preserve_overlap');
  if (!same(unique(actualGoods.map(good => good.skc)), requiredSkcs)) errors.push(`${phase}_membership_changed`);
  if (actualGoods.length !== requiredSkcs.length) errors.push(`${phase}_goods_count_changed`);
  if (!same(actualGoods, expectedPhaseGoods)) errors.push(`${phase}_goods_attributes_changed`);
  if (phase === 'before' || preserved.length) {
    if (!currentActivity) errors.push(`${phase}_activity_missing`);
    if (Number(currentActivity?.activity_id) !== Number(expected?.activityId)) errors.push(`${phase}_activity_id_changed`);
    if (Number(currentActivity?.state) !== Number(expected?.state)) errors.push(`${phase}_activity_state_changed`);
    if (String(currentActivity?.start_time || '') !== String(expected?.startTime || '')) errors.push(`${phase}_activity_start_time_changed`);
    if (String(currentActivity?.end_time || '') !== String(expected?.endTime || '')) errors.push(`${phase}_activity_end_time_changed`);
  }
  const changedSkcs = requiredSkcs.filter(skc => {
    const actual = actualGoods.filter(good => good.skc === skc);
    const locked = expectedPhaseGoods.filter(good => good.skc === skc);
    return !same(actual, locked);
  });
  return {ok: errors.length === 0, errors: unique(errors), changedSkcs};
}
