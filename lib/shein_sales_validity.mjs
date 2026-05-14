const CANCEL_STATUS_RE = /cancel|\u53d6\u6d88/i;

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function statusText(row) {
  return [
    row?.pageStatus,
    row?.pageStatusDesc,
    row?.goodsPerformanceStatusDesc,
    row?.orderStatusDesc,
    row?.performStatusDesc,
  ].filter(v => v !== null && v !== undefined && v !== '').join(' ');
}

export function salesExclusionReason(row) {
  const pageStatus = String(row?.pageStatus || '').trim().toUpperCase();
  if (pageStatus === 'CANCEL' || pageStatus.includes('CANCEL')) return 'cancelled_page_status';

  const goodsPerformanceStatus = Number(row?.goodsPerformanceStatus);
  if (Number.isFinite(goodsPerformanceStatus) && goodsPerformanceStatus === 6) return 'cancelled_before_pickup';

  const text = statusText(row);
  if (CANCEL_STATUS_RE.test(text)) return 'cancelled_status_text';

  return '';
}

export function isValidSalesGoodsRow(row) {
  return toNumber(row?.number ?? row?.quantity) > 0
    && toNumber(row?.currencyPrice ?? row?.salesSar) > 0
    && !salesExclusionReason(row);
}

export function salesQuantity(row) {
  return isValidSalesGoodsRow(row) ? toNumber(row?.number ?? row?.quantity) : 0;
}

export function salesAmountSar(row) {
  return isValidSalesGoodsRow(row) ? toNumber(row?.currencyPrice ?? row?.salesSar) : 0;
}

export function summarizeSalesGoodsRows(goodsRows = []) {
  const validRows = goodsRows.filter(isValidSalesGoodsRow);
  const excludedRows = goodsRows.filter(row => Number(row?.currencyPrice || 0) > 0 && !isValidSalesGoodsRow(row));
  const salesSar = validRows.reduce((sum, row) => sum + salesAmountSar(row), 0);
  return {
    validRows,
    excludedRows,
    salesSar,
    positiveAmountOrderCount: new Set(validRows.map(row => row.orderNo || row.orderId).filter(Boolean)).size,
    quantityAll: goodsRows.reduce((sum, row) => sum + toNumber(row?.number ?? row?.quantity), 0),
    quantityPositiveAmount: validRows.reduce((sum, row) => sum + salesQuantity(row), 0),
    salesGoodsLineCount: validRows.length,
    excludedGoodsLineCount: excludedRows.length,
    excludedSalesSar: excludedRows.reduce((sum, row) => sum + toNumber(row?.currencyPrice ?? row?.salesSar), 0),
    excludedQuantity: excludedRows.reduce((sum, row) => sum + toNumber(row?.number ?? row?.quantity), 0),
  };
}
