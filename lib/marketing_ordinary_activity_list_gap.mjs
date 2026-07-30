export function ordinaryActivityListGap(allowGoodsNum, applyGoodsNum) {
  const allowed = Number(allowGoodsNum);
  const applied = Number(applyGoodsNum);
  if (!Number.isFinite(allowed) || !Number.isFinite(applied)) return 0;
  return Math.max(0, allowed - applied);
}
