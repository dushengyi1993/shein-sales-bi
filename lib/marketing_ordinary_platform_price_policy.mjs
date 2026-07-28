const DEFAULT_TOLERANCE_SAR = 0.06;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace('%', '').replace(',', '').trim());
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function buildOrdinaryPlatformPriceAdjustmentAudit({
  rule,
  adjustedTarget,
  platformAdjusted,
  toleranceSar = DEFAULT_TOLERANCE_SAR,
} = {}) {
  if (!platformAdjusted) return null;
  const approvedTargetPrice = numberOrNull(
    rule?.finalTargetPrice
      ?? rule?.intendedFinalTargetPrice
      ?? rule?.targetPrice,
  );
  const activityTargetAfterPlatformAdjust = numberOrNull(adjustedTarget);
  const tolerance = Math.max(0, numberOrNull(toleranceSar) ?? DEFAULT_TOLERANCE_SAR);
  if (!(activityTargetAfterPlatformAdjust > 0)) return null;
  const deltaSar = approvedTargetPrice > 0
    ? round2(activityTargetAfterPlatformAdjust - approvedTargetPrice)
    : null;
  const belowApprovedTarget = approvedTargetPrice > 0
    && activityTargetAfterPlatformAdjust < approvedTargetPrice - tolerance;
  return {
    platformAdjustmentApplied: true,
    platformAdjustmentStatus: belowApprovedTarget
      ? 'below_target_due_to_platform_forced_discount'
      : 'platform_minimum_tier_applied',
    platformPricePolicy: 'submit_platform_minimum_tier_and_audit',
    approvedTargetPrice: approvedTargetPrice > 0 ? round2(approvedTargetPrice) : null,
    activityTargetAfterPlatformAdjust: round2(activityTargetAfterPlatformAdjust),
    deltaSar,
    toleranceSar: round2(tolerance),
    belowApprovedTarget,
    requiresReapproval: false,
  };
}

export function isOrdinaryPlatformTierRewriteAccepted({
  actualPrice,
  platformExpectedPrice,
  discountMatches = true,
  toleranceSar = DEFAULT_TOLERANCE_SAR,
} = {}) {
  const actual = numberOrNull(actualPrice);
  const expected = numberOrNull(platformExpectedPrice);
  const tolerance = Math.max(0, numberOrNull(toleranceSar) ?? DEFAULT_TOLERANCE_SAR);
  return Boolean(
    discountMatches
      && actual > 0
      && expected > 0
      && Math.abs(actual - expected) <= tolerance,
  );
}
