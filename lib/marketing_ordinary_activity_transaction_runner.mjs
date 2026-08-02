import {
  executeInventoryAwareActivity,
  extractOrdinaryActivityInventoryTargets,
  validateOrdinaryActivityEnrollmentReadback,
} from './marketing_activity_inventory_integration.mjs';

export async function executeOrdinaryActivityWithInventoryTransaction({
  root = process.cwd(),
  storeKey,
  dryResults,
  transactionHash,
  runSubmit,
  runVerify,
  adapterFactory,
}) {
  if (typeof runSubmit !== 'function' || typeof runVerify !== 'function') {
    throw new Error('Ordinary activity transaction requires runSubmit and runVerify callbacks');
  }
  const inventory = extractOrdinaryActivityInventoryTargets(dryResults);
  const transaction = await executeInventoryAwareActivity({
    root,
    storeKey,
    targets: inventory.targets,
    blockers: inventory.blockers,
    transactionHash,
    adapterFactory,
    submit: async () => {
      const result = await runSubmit();
      return {
        ok: result?.ok !== false && result?.code !== false && result?.code !== null
          ? Number(result?.code ?? result?.exitCode ?? 0) === 0
          : result?.ok === true,
        ...result,
      };
    },
    readEnrollment: async context => await runVerify(context),
    validateEnrollment: validateOrdinaryActivityEnrollmentReadback,
  });
  return {
    ...transaction,
    inventoryTargets: inventory.targets,
    inventoryPlanBlockers: inventory.blockers,
    submitResult: transaction.submit?.result || null,
  };
}
