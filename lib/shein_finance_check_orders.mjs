import crypto from 'node:crypto';

export function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function dateWindows(start, end, maxDays = 7) {
  const first = new Date(`${start}T00:00:00+08:00`);
  const last = new Date(`${end}T00:00:00+08:00`);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || first > last) {
    throw new Error(`Invalid finance date range: ${start}..${end}`);
  }
  const out = [];
  let cursor = first;
  while (cursor <= last) {
    const windowEnd = new Date(Math.min(
      last.getTime(),
      cursor.getTime() + (Math.max(1, maxDays) - 1) * 86_400_000,
    ));
    out.push({start: dateOnly(cursor), end: dateOnly(windowEnd)});
    cursor = new Date(windowEnd.getTime() + 86_400_000);
  }
  return out;
}

function dateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((acc, part) => ({...acc, [part.type]: part.value}), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function financeListRows(response) {
  const info = response?.info ?? response?.data?.info ?? response?.data ?? {};
  for (const value of [info.list, info.rows, info.records, info.data]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function financeListTotal(response, fallback = 0) {
  const info = response?.info ?? response?.data?.info ?? response?.data ?? {};
  return numeric(info.count ?? info.total ?? info.totalCount) ?? fallback;
}

export function financeDetailInfo(response) {
  return response?.info ?? response?.data?.info ?? response?.data ?? response ?? {};
}

function text(value) {
  return String(value ?? '').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function mapFinanceCheckOrder({store, listRow = {}, detail = {}, fetchedAt, sourceWindow = {}}) {
  const storeKey = text(store?.storeKey).toUpperCase();
  const checkOrderNo = text(detail.checkOrderNo || listRow.checkOrderNo);
  if (!storeKey || !checkOrderNo) throw new Error('storeKey and checkOrderNo are required');
  const base = {
    store_key: storeKey,
    group_key: text(store?.groupKey),
    shop_name: text(store?.shopName || storeKey),
    check_order_no: checkOrderNo,
    bz_order_no: text(detail.bzOrderNo || listRow.bzOrderNo),
    report_order_no: text(detail.reportOrderNo || listRow.reportOrderNo),
    check_status: numeric(detail.checkStatus ?? listRow.checkStatus),
    second_order_type: numeric(detail.secondOrderType ?? listRow.secondOrderType),
    income_expenditure_type: numeric(detail.incomeExpenditureType ?? listRow.incomeExpenditureType),
    business_completed_time: text(detail.businessCompletedTime || listRow.businessCompletedTime) || null,
    completed_pay_time: text(detail.completedPayTime || listRow.completedPayTime) || null,
    estimate_pay_time: text(detail.estimatePayTime || listRow.estimatePayTime) || null,
    site: text(detail.site || listRow.site),
    currency_code: text(detail.currencyCode || listRow.currencyCode),
    estimate_income_money_total: numeric(detail.estimateIncomeMoneyTotal ?? listRow.estimateIncomeMoneyTotal),
    source_window_start: text(sourceWindow.start) || null,
    source_window_end: text(sourceWindow.end) || null,
    fetched_at: fetchedAt || new Date().toISOString(),
  };
  const raw = {list: listRow, detail};
  const order = {
    check_order_key: `${storeKey}__${checkOrderNo}`,
    ...base,
    payload_hash: sha256(JSON.stringify(raw)),
    raw_summary: raw,
  };
  const items = asArray(detail.itemList).map((item, index) => {
    const skuCode = text(item.skuCode || item.sku || item.skuSn);
    const identity = text(item.detailLineId || item.id || item.goodsId || item.entityId)
      || sha256(JSON.stringify({skuCode, index, item})).slice(0, 24);
    const returnExpense = numeric(item.returnExpense) ?? 0;
    const returnFreightSubsidy = numeric(item.returnFreightSubsidy) ?? 0;
    return {
      check_order_item_key: `${storeKey}__${checkOrderNo}__${identity}`,
      check_order_key: order.check_order_key,
      ...base,
      line_index: index,
      detail_line_id: text(item.detailLineId || item.id),
      sku_code: skuCode,
      goods_id: text(item.goodsId),
      entity_id: text(item.entityId),
      return_expense_sar: returnExpense,
      return_freight_subsidy_sar: returnFreightSubsidy,
      net_return_cost_sar: returnExpense - returnFreightSubsidy,
      stock_expense_sar: numeric(item.stockExpense),
      performance_cost_sar: numeric(item.performanceCost),
      service_fee_sar: numeric(item.serviceFee),
      income_amount_sar: numeric(item.incomeAmount),
      seller_currency_price: numeric(item.sellerCurrencyPrice),
      payload_hash: sha256(JSON.stringify(item)),
      raw_summary: item,
    };
  });
  return {order, items};
}

export function selectReturnCost({actualNetReturnCost, returnPerformanceActual = null, estimatedPackageCost = 13.88, isReturnPackage = false}) {
  const actual = numeric(actualNetReturnCost);
  if (actual !== null) return {amount: actual, source: 'finance_check_order_actual', settled: true};
  const returnActual = numeric(returnPerformanceActual);
  if (returnActual !== null && returnActual > 0) {
    return {amount: returnActual, source: 'return_order_performance_price_actual', settled: false};
  }
  if (isReturnPackage) return {amount: Number(estimatedPackageCost), source: 'package_estimate', settled: false};
  return {amount: 0, source: 'none', settled: false};
}
