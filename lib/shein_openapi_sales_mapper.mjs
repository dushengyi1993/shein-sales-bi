import {isValidSalesGoodsRow, salesExclusionReason} from './shein_sales_validity.mjs';

const ORDER_STATUS_DESC = new Map([
  [1, '待处理'],
  [4, '已发货'],
  [5, '已签收'],
  [6, '用户已退款'],
  [7, '待揽收'],
]);

const PERFORMANCE_STATUS_DESC = new Map([
  [1, '待处理'],
  [4, '尾程已发货'],
  [5, '已签收'],
  [6, '揽收前已取消'],
  [7, '待揽收'],
]);

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function statusNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function statusDescription(value, descriptions) {
  return descriptions.get(statusNumber(value)) || '';
}

function storeEntries(config) {
  if (Array.isArray(config)) return config;
  return asArray(config?.stores);
}

export function resolveOpenApiStoreMetadata(storeKey, secretStore = {}, publicStoreConfig = {}) {
  const normalized = String(storeKey || secretStore?.storeKey || '').trim().toUpperCase();
  const publicStore = storeEntries(publicStoreConfig).find((entry) => {
    const key = entry?.key ?? entry?.storeKey;
    return String(key || '').trim().toUpperCase() === normalized;
  }) || {};
  return {
    storeKey: normalized,
    groupKey: String(publicStore.groupKey || secretStore.groupKey || '').trim(),
    shopName: String(publicStore.shopName || secretStore.shopName || normalized).trim(),
  };
}

export function openApiOrderBusinessTime(order = {}) {
  return order.orderAllocateTime || order.addTime || order.orderTime || '';
}

export function isOpenApiCancelledBeforePickup(order, item) {
  const orderStatus = statusNumber(order?.orderStatus);
  const goodsStatus = statusNumber(item?.newGoodsStatus);
  const performanceTag = statusNumber(item?.performanceTag);
  return goodsStatus === 6 && (performanceTag === 2 || orderStatus === 6);
}

export function toOpenApiOrderRows(orderDetails) {
  return asArray(orderDetails).map((order) => {
    const businessTime = openApiOrderBusinessTime(order);
    return {
      orderId: '',
      orderNo: String(order.orderNo || ''),
      billno: String(order.orderNo || ''),
      orderStatus: order.orderStatus ?? '',
      orderStatusDesc: statusDescription(order.orderStatus, ORDER_STATUS_DESC),
      performStatus: order.orderStatus ?? '',
      performStatusDesc: statusDescription(order.orderStatus, PERFORMANCE_STATUS_DESC),
      allocateTime: String(businessTime).slice(0, 16),
      allocateTimeFull: businessTime,
      orderCreateTime: businessTime,
      site: order.salesSite || '',
      orderType: order.orderType ?? '',
    };
  });
}

export function toOpenApiGoodsRows(orderDetails) {
  const rows = [];
  for (const order of asArray(orderDetails)) {
    const businessTime = openApiOrderBusinessTime(order);
    for (const item of asArray(order.orderGoodsInfoList)) {
      const estimatedIncome = round2(item.estimatedIncome || 0);
      const cancelledBeforePickup = isOpenApiCancelledBeforePickup(order, item);
      const performanceStatus = cancelledBeforePickup
        ? 6
        : (item.newGoodsStatus ?? order.orderStatus ?? '');
      const candidate = {
        number: 1,
        currencyPrice: estimatedIncome,
        pageStatus: cancelledBeforePickup ? 'CANCEL' : '',
        pageStatusDesc: cancelledBeforePickup ? '已取消' : '',
        goodsPerformanceStatus: performanceStatus,
        goodsPerformanceStatusDesc: statusDescription(performanceStatus, PERFORMANCE_STATUS_DESC),
        orderStatusDesc: statusDescription(order.orderStatus, ORDER_STATUS_DESC),
        performStatusDesc: statusDescription(order.orderStatus, PERFORMANCE_STATUS_DESC),
      };
      const validSale = isValidSalesGoodsRow(candidate);
      const exclusionReason = cancelledBeforePickup
        ? 'cancelled_before_pickup'
        : salesExclusionReason(candidate);
      rows.push({
        orderId: '',
        orderNo: String(order.orderNo || ''),
        billno: String(order.orderNo || ''),
        orderStatus: order.orderStatus ?? '',
        orderStatusDesc: candidate.orderStatusDesc,
        performStatus: order.orderStatus ?? '',
        performStatusDesc: candidate.performStatusDesc,
        allocateTime: String(businessTime).slice(0, 16),
        allocateTimeFull: businessTime,
        site: order.salesSite || '',
        orderType: order.orderType ?? '',
        pageStatus: candidate.pageStatus,
        pageStatusDesc: candidate.pageStatusDesc,
        orderCustomerTime: order.paymentTime || order.orderTime || '',
        orderCreateTime: businessTime,
        goodsId: String(item.goodsId || ''),
        entityId: '',
        goodsSn: item.goodsSn || '',
        skuSn: item.sellerSku || '',
        skuCode: item.skuCode || '',
        skcName: item.skc || '',
        suffix: '',
        goodsTitle: item.goodsTitle || '',
        number: 1,
        currencyCode: item.saleCurrency || item.orderCurrency || '',
        currencyPrice: validSale ? estimatedIncome : 0,
        openApiEstimatedIncome: estimatedIncome,
        newOrderGoodsStatus: item.newGoodsStatus ?? '',
        goodsPerformanceStatus: performanceStatus,
        goodsPerformanceStatusDesc: candidate.goodsPerformanceStatusDesc,
        goodsExchangeTag: item.goodsExchangeTag ?? '',
        performanceTag: item.performanceTag ?? '',
        storageTag: item.storageTag ?? '',
        openApiSkuAttributes: asArray(item.skuAttribute),
        isValidSale: validSale,
        salesExclusionReason: exclusionReason,
      });
    }
  }
  return rows;
}

export function mapOpenApiOrderDetails(orderDetails) {
  return {
    orderRows: toOpenApiOrderRows(orderDetails),
    goodsRows: toOpenApiGoodsRows(orderDetails),
  };
}
