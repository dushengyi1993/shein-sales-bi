function rowDate(row) {
  return String(row?.date || row?.created_date || '').slice(0, 10);
}

export function normalizePrimarySalesGuard(value = {}) {
  const cutoverDate = String(value.cutoverDate || value.cutover_date || '').slice(0, 10);
  return {
    enabled: value.enabled === true,
    cutoverDate: /^\d{4}-\d{2}-\d{2}$/.test(cutoverDate) ? cutoverDate : '',
  };
}

export function partitionFormalSalesRows(rows = [], guard = {}) {
  const normalized = normalizePrimarySalesGuard(guard);
  if (!normalized.enabled || !normalized.cutoverDate) {
    return {kept: [...rows], skipped: []};
  }
  const kept = [];
  const skipped = [];
  for (const row of rows) {
    const date = rowDate(row);
    if (date && date >= normalized.cutoverDate) skipped.push(row);
    else kept.push(row);
  }
  return {kept, skipped};
}

export function guardFormalSalesFacts(sales = {}, guard = {}) {
  const keys = ['daily', 'orders', 'items', 'paymentFlags'];
  const guarded = {...sales};
  const skipped = {};
  for (const key of keys) {
    const partition = partitionFormalSalesRows(Array.isArray(sales[key]) ? sales[key] : [], guard);
    guarded[key] = partition.kept;
    skipped[key] = partition.skipped.length;
  }
  return {
    sales: guarded,
    skipped,
    skippedTotal: Object.values(skipped).reduce((sum, count) => sum + count, 0),
  };
}
