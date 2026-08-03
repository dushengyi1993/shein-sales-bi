import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  planActivityInventoryTransaction,
  runActivityInventoryTransaction,
} from './marketing_activity_inventory_transaction.mjs';
import {createMarketingActivityInventoryOpenApiAdapter} from './marketing_activity_inventory_openapi.mjs';

export function extractLimitedDiscountInventoryTargets({storeKey, rescue, preflightFull} = {}) {
  const rowsBySkc = new Map((rescue?.rows || []).map(row => [String(row?.skc || '').trim(), row]));
  const targets = [];
  const blockers = [];
  for (const invalid of preflightFull?.validation?.invalid || []) {
    if (invalid?.reason !== 'inventory below configured activity stock') continue;
    const skc = String(invalid?.skc || '').trim();
    const row = rowsBySkc.get(skc) || {};
    const minimumUsableInventory = firstPositiveInteger(
      invalid?.attendNum,
      row?.activityStock,
      rescue?.activityStock,
      invalid?.minStock,
    );
    if (!skc || !minimumUsableInventory) {
      blockers.push({
        storeKey,
        skc,
        reason: 'missing_live_limited_discount_minimum',
        invalid,
      });
      continue;
    }
    targets.push({
      storeKey,
      skc,
      canonical: String(row?.canonical || '').trim(),
      minimumUsableInventory,
      minimumSource: 'limited_discount_dry_run',
      minimumEvidence: {
        reason: invalid.reason,
        inventory: invalid.inventory ?? null,
        minStock: invalid.minStock ?? null,
        attendNum: invalid.attendNum ?? null,
        activityStock: row?.activityStock ?? rescue?.activityStock ?? null,
      },
    });
  }
  return {targets: uniqueTargets(targets), blockers};
}

export function extractOrdinaryActivityInventoryTargets(dryResults = []) {
  const targets = [];
  const blockers = [];
  for (const result of dryResults || []) {
    const plan = result?.selection?.activityInventoryTransactionPlan;
    if (!plan) continue;
    for (const blocker of plan.blockers || []) blockers.push({...blocker, activityId: result?.activity?.activityId || null});
    for (const row of plan.rows || []) {
      if (row?.requiresTemporaryRaise !== true) continue;
      const minimumUsableInventory = firstPositiveInteger(row.minimumUsableInventory);
      if (!minimumUsableInventory) {
        blockers.push({
          storeKey: result?.store || result?.storeKey || '',
          skc: row?.skc || '',
          reason: 'missing_live_ordinary_activity_minimum',
          evidence: row,
        });
        continue;
      }
      targets.push({
        storeKey: String(result?.store || result?.storeKey || row?.storeKey || '').trim().toUpperCase(),
        skc: String(row?.skc || '').trim(),
        canonical: String(row?.canonical || '').trim(),
        minimumUsableInventory,
        minimumSource: 'ordinary_activity_query_supplier_goods_list_v2',
        minimumEvidence: {
          activityId: result?.activity?.activityId || null,
          source: plan.source || '',
          sourceField: row?.minimumSourceField || '',
          currentUsableInventory: row?.currentUsableInventory ?? null,
        },
      });
    }
  }
  return {targets: uniqueTargets(targets), blockers};
}

export async function planInventoryAwareActivityExecution({
  root = process.cwd(),
  storeKey,
  targets,
  blockers = [],
  transactionHash,
  adapterFactory = createMarketingActivityInventoryOpenApiAdapter,
}) {
  if (blockers.length) {
    return {
      ok: false,
      ready: false,
      mode: 'dry-run',
      transactionHash,
      writeAttempted: false,
      blockers,
      rows: [],
    };
  }
  if (!targets.length) {
    return {
      ok: true,
      ready: true,
      mode: 'dry-run',
      transactionHash,
      writeAttempted: false,
      blockers: [],
      rows: [],
    };
  }
  const adapter = await adapterFactory({root, storeKey});
  const resolved = await adapter.resolveTargets(targets);
  return await planActivityInventoryTransaction({
    targets: resolved,
    transactionHash,
    readStock: adapter.readStock,
  });
}

export async function executeInventoryAwareActivity({
  root = process.cwd(),
  storeKey,
  targets,
  blockers = [],
  transactionHash,
  submit,
  readEnrollment,
  validateEnrollment,
  adapterFactory = createMarketingActivityInventoryOpenApiAdapter,
}) {
  if (blockers.length) {
    return {
      ok: false,
      safe: true,
      transactionHash,
      submitAttempted: false,
      writeAttempted: false,
      blockers,
      rows: [],
    };
  }
  if (!targets.length) {
    const submitResult = await submit({transactionHash, rows: []});
    const enrollmentReadback = await readEnrollment({
      phase: 'after_submit_without_inventory_transaction',
      transactionHash,
      submitResult,
    });
    const enrollment = validateEnrollment(enrollmentReadback, {
      phase: 'after_submit_without_inventory_transaction',
      submitResult,
    });
    return {
      ok: submitResult?.ok !== false && enrollment?.ok === true,
      safe: enrollment?.ok === true,
      transactionHash,
      submitAttempted: true,
      writeAttempted: false,
      rows: [],
      submit: {ok: submitResult?.ok !== false, result: submitResult},
      enrollmentReadback,
      enrollmentAfterRestore: enrollmentReadback,
      blockers: enrollment?.ok ? [] : [{reason: 'activity_enrollment_readback_failed', error: enrollment?.reason || ''}],
    };
  }
  const adapter = await adapterFactory({root, storeKey});
  const resolved = await adapter.resolveTargets(targets);
  return await runActivityInventoryTransaction({
    targets: resolved,
    transactionHash,
    acquireLock: adapter.acquireLock,
    readStock: adapter.readStock,
    writeStock: adapter.writeStock,
    submit,
    readEnrollment,
    validateEnrollment,
  });
}

export async function planLimitedDiscountInventoryTransaction({
  root = process.cwd(),
  storeKey,
  rescue,
  preflightFull,
  transactionHash,
  adapterFactory,
}) {
  const inventory = extractLimitedDiscountInventoryTargets({storeKey, rescue, preflightFull});
  const plan = await planInventoryAwareActivityExecution({
    root,
    storeKey,
    targets: inventory.targets,
    blockers: inventory.blockers,
    transactionHash,
    adapterFactory,
  });
  return {...plan, extractedTargets: inventory.targets};
}

export async function executeLimitedDiscountWithInventoryTransaction({
  root = process.cwd(),
  storeKey,
  rescue,
  preflightFull,
  transactionHash,
  runSubmit,
  runEnrollmentReadback,
  adapterFactory,
}) {
  if (typeof runSubmit !== 'function' || typeof runEnrollmentReadback !== 'function') {
    throw new Error('Limited-discount inventory transaction requires submit and enrollment readback callbacks');
  }
  const inventory = extractLimitedDiscountInventoryTargets({storeKey, rescue, preflightFull});
  const transaction = await executeInventoryAwareActivity({
    root,
    storeKey,
    targets: inventory.targets,
    blockers: inventory.blockers,
    transactionHash,
    adapterFactory,
    submit: async () => await runSubmit(),
    readEnrollment: async context => await runEnrollmentReadback(context),
    validateEnrollment: value => validateLimitedDiscountEnrollmentReadback(value, {
      rescue,
      requiredSkcs: inventory.targets.map(target => target.skc),
    }),
  });
  return {
    ...transaction,
    extractedTargets: inventory.targets,
    extractionBlockers: inventory.blockers,
    commandResult: transaction.submit?.result || null,
  };
}

export function validateLimitedDiscountEnrollmentReadback(commandResult, {rescue, requiredSkcs = []} = {}) {
  const full = commandResult?.full || commandResult?.result?.full || commandResult;
  if (!full) return {ok: false, reason: 'missing limited-discount live readback'};
  const required = [...new Set((requiredSkcs || []).map(value => String(value || '').trim()).filter(Boolean))];
  const rescueRows = rescue?.rows || [];
  const rowsBySkc = new Map(rescueRows.map(row => [String(row?.skc || '').trim(), row]));
  const undefinedRequired = required.filter(skc => !rowsBySkc.has(skc));
  if (undefinedRequired.length) {
    return {ok: false, reason: `limited-discount required enrollment rows are absent from rescue: ${undefinedRequired.join(',')}`};
  }
  if (full?.ok === false && full?.alreadyCovered !== true && required.length === 0) {
    return {ok: false, reason: full.reason || full.error?.message || 'limited-discount readback returned ok=false'};
  }
  const expectedRows = required.length ? required.map(skc => rowsBySkc.get(skc)) : rescueRows;
  if (!expectedRows.length) return {ok: full?.ok === true, reason: full?.ok ? '' : 'rescue has no expected rows'};
  const expectedEnd = parseShanghai(rescue?.endTime);
  const activities = [
    ...(full?.before?.conflictActivities || []),
    ...(full?.after?.conflictActivities || []),
    ...(full?.createdActivity ? [full.createdActivity] : []),
  ];
  const exactRows = full?.after?.exactReadbackRows || [];
  const covered = new Set(exactRows.filter(row => row?.ok === true).map(row => String(row.skc || '').trim()));
  for (const activity of activities) {
    const state = Number(activity?.state ?? 2);
    if (![2, 3].includes(state)) continue;
    const end = parseShanghai(activity?.end_time || activity?.endTime);
    const goods = [
      ...(activity?.targetGoods || []),
      ...(activity?.goods || []),
    ];
    for (const good of goods) {
      const skc = String(good?.skc || '').trim();
      const row = expectedRows.find(item => String(item?.skc || '').trim() === skc);
      if (!row) continue;
      const expectedPrice = Number(row.limitedDiscountPrice ?? row.finalTargetPrice);
      const price = Number(good.product_act_price ?? good.limitedDiscountPrice);
      const stock = Number(good.attend_num_sum ?? good.activityStock ?? 0);
      const expectedStock = Number(row.activityStock ?? rescue?.activityStock ?? 10);
      const priceOk = Number.isFinite(price) && Math.abs(price - expectedPrice) <= 0.01;
      const stockOk = stock >= expectedStock;
      const endOk = !expectedEnd || Boolean(end && end >= expectedEnd);
      if (priceOk && stockOk && endOk) covered.add(skc);
    }
  }
  if (full?.alreadyCovered === true && expectedRows.length === 1) covered.add(String(expectedRows[0].skc || '').trim());
  const missing = expectedRows.map(row => String(row?.skc || '').trim()).filter(skc => !covered.has(skc));
  return {
    ok: missing.length === 0,
    reason: missing.length ? `limited-discount enrollment missing after readback: ${missing.join(',')}` : '',
    coveredSkcs: [...covered],
    missingSkcs: missing,
  };
}

export function validateOrdinaryActivityEnrollmentReadback(commandResult) {
  const full = commandResult?.doc || commandResult?.full || commandResult;
  if (!full) return {ok: false, reason: 'missing ordinary enrollment readback'};
  const summaries = Array.isArray(full?.stores)
    ? full.stores.flatMap(store => store?.results || [])
    : [full];
  const failures = summaries.filter(row => (
    row?.ok !== true
    || Number(row?.missingRows?.length ?? row?.missingRows ?? 0) > 0
    || Number(row?.priceMismatchRows?.length ?? row?.priceMismatchRows ?? 0) > 0
    || Number(row?.extraAvailableRows?.length ?? row?.extraAvailableRows ?? 0) > 0
    || Number(row?.activityListGapRows?.length ?? row?.activityListGapRows ?? 0) > 0
    || Number(row?.badPacketActivities?.length ?? row?.badPacketActivities ?? 0) > 0
  ));
  return {
    ok: failures.length === 0 && summaries.length > 0,
    reason: failures.length ? 'ordinary enrollment readback contains missing/mismatch/gap rows' : '',
    failures,
  };
}

export async function readRescue(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function activityExecutionTransactionHash(...values) {
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function uniqueTargets(targets) {
  const byKey = new Map();
  for (const target of targets) {
    const key = `${String(target.storeKey || '').toUpperCase()}::${String(target.skc || '').toLowerCase()}`;
    const previous = byKey.get(key);
    if (!previous || Number(target.minimumUsableInventory) > Number(previous.minimumUsableInventory)) {
      byKey.set(key, target);
    }
  }
  return [...byKey.values()];
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function parseShanghai(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = text.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}
