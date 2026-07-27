const PRODUCT_FAMILIES = new Set([
  'product_receive',
  'product_audit',
  'product_audit_all_channels',
  'product_shelves',
  'product_delete_audit',
]);
const PRODUCT_CONTEXT_FAMILIES = new Set([...PRODUCT_FAMILIES, 'price_audit', 'rrp_review', 'rrp_validity', 'compliance']);
const PRODUCT_STATE_EVENT_FAMILIES = new Set([...PRODUCT_FAMILIES, 'price_audit', 'rrp_review']);
const EXACT_PRODUCT_STATE_ACTIONS = new Set(['on_shelf', 'wait_shelf', 'sold_out', 'off_shelf']);

function text(value) {
  return String(value ?? '').trim();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBusinessDate(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    const milliseconds = raw.length <= 10 ? numeric * 1000 : raw.length <= 13 ? numeric : numeric / (10 ** (raw.length - 13));
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T00:00:00+08:00`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(raw)
      ? `${raw.replace(' ', 'T')}+08:00`
      : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

const CN_DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function cnDateTime(value) {
  const date = parseBusinessDate(value);
  if (!date) return '';
  return CN_DATE_TIME.format(date).replaceAll('/', '-');
}

function calendarDaysBetween(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return null;
  const startKey = CN_DATE_TIME.format(start).replaceAll('/', '-').slice(0, 10);
  const endKey = CN_DATE_TIME.format(end).replaceAll('/', '-').slice(0, 10);
  const startMs = Date.parse(`${startKey}T00:00:00Z`);
  const endMs = Date.parse(`${endKey}T00:00:00Z`);
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, Math.floor((endMs - startMs) / 86_400_000)) : null;
}

function decimal(value) {
  const parsed = number(value);
  if (parsed === null) return '';
  const fixed = parsed.toFixed(2);
  const [whole, fraction] = fixed.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function count(value) {
  const parsed = number(value);
  if (parsed === null) return '';
  return Math.round(parsed).toLocaleString('en-US');
}

function auditPassed(normalized = {}) {
  const status = text(normalized.auditState || normalized.status).toLowerCase();
  return status === '2' || /(?:success|pass|passed|approved|accept|审核通过|已通过)/iu.test(status);
}

function needsProductStateReadback(normalized = {}) {
  const family = text(normalized.eventFamily);
  if (family === 'product_shelves') return text(normalized.action) === 'not_on_shelf';
  return ['product_audit', 'product_audit_all_channels', 'price_audit', 'rrp_review'].includes(family)
    && auditPassed(normalized);
}

function displayShelfChange(normalized = {}) {
  const rows = Array.isArray(normalized.shelfChanges) ? normalized.shelfChanges : [];
  return rows.find(row => text(row?.site).toLowerCase() === 'shein-sa') || rows[0] || {};
}

function usableShelfTime(value) {
  const raw = text(value);
  if (!raw || raw === '1970-01-01 08:00:01' || raw === '2018-08-28 00:00:00') return '';
  return raw;
}

function shelfProductCopy(normalized, urgent) {
  const context = object(normalized.productContext);
  const sales = object(context.sales);
  const change = displayShelfChange(normalized);
  const supplierCode = text(context.supplierCode || context.standardGoodsSn);
  const productName = text(context.productName);
  const skc = text(normalized.skc || context.skc || normalized.businessId);
  const productLabel = supplierCode || productName || skc || '相关商品';
  const title = urgent
    ? `${text(normalized.storeKey) || '未知'} 店：${productLabel}被下架`
    : `${text(normalized.storeKey) || '未知'} 店：${productLabel}上下架状态已更新`;
  if (!urgent) {
    const pendingState = text(normalized.action) === 'not_on_shelf';
    return {
      title,
      summary: pendingState
        ? `${skc ? `链接 ${skc}` : '该商品'}当前不是已上架状态；没有发现实际下架证据，无需告警。`
        : `${skc ? `链接 ${skc}` : '该商品'}的上下架状态已更新，系统已记录。`,
    };
  }

  const firstShelf = usableShelfTime(change.firstShelfTime || context.firstShelfTime);
  const eventAt = text(normalized.eventTime || normalized.receivedAt);
  const firstShelfDate = parseBusinessDate(firstShelf);
  const eventDate = parseBusinessDate(eventAt);
  const ageDays = calendarDaysBetween(firstShelfDate, eventDate);
  const operator = text(normalized.shelfOperator);
  const reason = text(normalized.shelfReason);
  const lines = [
    supplierCode ? `货号：${supplierCode}` : '',
    productName && productName !== supplierCode ? `商品：${productName}` : '',
    skc ? `链接：${skc}` : '',
    firstShelf ? `上架时间：${cnDateTime(firstShelf) || firstShelf}${ageDays === null ? '' : `（已上架 ${ageDays} 天）`}` : '',
  ].filter(Boolean);

  const units7 = count(sales.units7d);
  const amount7 = decimal(sales.grossSales7dSar);
  const units30 = count(sales.units30d);
  const amount30 = decimal(sales.grossSales30dSar);
  const unitsAll = count(sales.unitsLifetime);
  const amountAll = decimal(sales.grossSalesLifetimeSar);
  if (units7 || units30 || unitsAll) {
    const parts = [
      units7 ? `近7天 ${units7} 件${amount7 ? ` / ${amount7} SAR` : ''}` : '',
      units30 ? `近30天 ${units30} 件${amount30 ? ` / ${amount30} SAR` : ''}` : '',
      unitsAll ? `累计 ${unitsAll} 件${amountAll ? ` / ${amountAll} SAR` : ''}` : '',
    ].filter(Boolean);
    const lastSale = cnDateTime(sales.lastSaleDate) || text(sales.lastSaleDate);
    lines.push(`销售：${parts.join('；')}${lastSale ? `；最近成交 ${lastSale.slice(0, 10)}` : ''}`);
  } else if (Object.keys(sales).length) {
    lines.push('销售：暂无有效成交');
  }

  lines.push(`下架时间：${cnDateTime(eventAt) || eventAt || '时间待核对'}`);
  if (operator) lines.push(`下架人：${operator}`);
  if (reason) lines.push(`下架原因：${reason}`);
  lines.push(reason
    ? '下一步：请根据上述原因决定恢复上架或保持下架。'
    : '下一步：如需恢复上架，请到 SHEIN 后台查看商品操作记录后再处理。');
  return {title, summary: lines.join('\n')};
}

function priceLabel(price) {
  const item = object(price);
  const min = number(item.min);
  const max = number(item.max);
  if (min === null || max === null) return '';
  const currency = text(item.currency);
  const amount = min === max ? decimal(min) : `${decimal(min)}–${decimal(max)}`;
  return `${amount}${currency ? ` ${currency}` : ''}`;
}

function auditProductCopy(normalized, urgent) {
  const storeLabel = `${text(normalized.storeKey) || '未知'} 店`;
  const context = object(normalized.auditContext);
  const productContext = object(normalized.productContext);
  const supplierCode = text(context.supplierCode || productContext.supplierCode || productContext.standardGoodsSn);
  const skc = text(normalized.skc || context.skc || normalized.businessId);
  if (!urgent) {
    return {
      title: `${storeLabel}：商品审核状态已更新`,
      summary: `${skc ? `商品 ${skc}` : '相关商品'}的审核状态已更新，系统已记录。`,
    };
  }
  const reason = text(context.failureReason || normalized.auditFailureReason);
  const merchantOffer = priceLabel(context.merchantOffer);
  const platformSuggested = priceLabel(context.platformSuggested);
  const appealCount = context.appealCount === null || context.appealCount === undefined || text(context.appealCount) === ''
    ? null
    : number(context.appealCount);
  const label = supplierCode || skc || '商品';
  const lines = [
    supplierCode ? `货号：${supplierCode}` : '',
    skc ? `链接：${skc}` : '',
    reason ? `失败原因：${reason.replaceAll(':', '：').replaceAll(';', '；')}` : '',
    merchantOffer ? `我方申报价：${merchantOffer}` : '',
    platformSuggested ? `平台建议价：${platformSuggested}` : '',
    appealCount !== null ? `剩余议价次数：${Math.max(0, Math.trunc(appealCount))}` : '',
  ].filter(Boolean);
  if (reason || merchantOffer || platformSuggested) {
    lines.push(platformSuggested
      ? '下一步：请确认是否接受平台建议价；如不接受，请到议价单核对是否仍可重新报价并补充依据。'
      : '下一步：请根据失败原因补齐资料或调整报价后重新提交。');
  } else {
    lines.push('下一步：请到 SHEIN 后台查看审核详情并补齐资料。');
  }
  return {title: `${storeLabel}：${label}审核未通过`, summary: lines.join('\n')};
}

function boolField(payload, names) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const name of names) {
      if (!Object.hasOwn(current, name)) continue;
      const value = current[name];
      if (typeof value === 'boolean') return value;
      if (/^(?:1|true|yes|required)$/i.test(text(value))) return true;
      if (/^(?:0|false|no|optional)$/i.test(text(value))) return false;
    }
    for (const value of Object.values(current)) if (value && typeof value === 'object') queue.push(value);
  }
  return null;
}

/** Normalize platform event time to integer microseconds for monotonic gates. */
function sourceEventOrder(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{1,30}$/.test(raw)) {
    const digits = raw.replace(/^0+(?=\d)/, '');
    let order = BigInt(digits);
    if (digits.length <= 10) order *= 1_000_000n;
    else if (digits.length <= 13) order *= 1_000n;
    else if (digits.length > 16) order /= 1_000n;
    return order.toString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? (BigInt(parsed) * 1_000n).toString() : null;
}

function scalarFields(payload, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const values = new Set();
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const value of current) if (value && typeof value === 'object') queue.push(value);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key.toLowerCase()) && ['string', 'number'].includes(typeof value) && text(value)) values.add(text(value));
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return values;
}

function taskStores(task) {
  const targets = task?.targets || {};
  return new Set([
    ...(Array.isArray(targets.writeStores) ? targets.writeStores : []),
    ...(Array.isArray(targets.stores) ? targets.stores : []),
    ...(Array.isArray(targets.targetStores) ? targets.targetStores : []),
  ].map(value => text(value).toUpperCase()).filter(Boolean));
}

function identityFromPayload(payload, normalized) {
  return {
    spu: new Set([text(normalized?.productId), ...scalarFields(payload, ['spuName', 'spu_name', 'spu'])].filter(Boolean)),
    skc: new Set([text(normalized?.skc), ...scalarFields(payload, ['skcName', 'skc_name', 'skc'])].filter(Boolean)),
    document: new Set([text(normalized?.documentId), ...scalarFields(payload, ['documentSn', 'document_sn', 'documentNo', 'document_no'])].filter(Boolean)),
    version: new Set([text(normalized?.version), ...scalarFields(payload, ['version'])].filter(Boolean)),
  };
}

function taskIdentity(task) {
  return {
    spu: scalarFields(task, ['spuName', 'spu_name', 'spu']),
    skc: scalarFields(task, ['skcName', 'skc_name', 'skc']),
    document: scalarFields(task, ['documentSn', 'document_sn', 'documentNo', 'document_no']),
    version: scalarFields(task, ['version']),
  };
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function strongIdentityMatch(eventIdentity, candidateIdentity, {allowSingleSkc = false} = {}) {
  const populated = Object.entries(eventIdentity).filter(([, values]) => values.size);
  if (populated.length < 2) {
    return allowSingleSkc
      && eventIdentity.skc.size > 0
      && intersects(eventIdentity.skc, candidateIdentity.skc);
  }
  return populated.every(([key, values]) => intersects(values, candidateIdentity[key]));
}

function businessReference(normalized = {}) {
  const family = text(normalized.eventFamily);
  if (family === 'order') return normalized.orderId || normalized.businessId ? `订单 ${text(normalized.orderId || normalized.businessId)}` : '这笔订单';
  if (family === 'return') return normalized.returnId || normalized.businessId ? `退货单 ${text(normalized.returnId || normalized.businessId)}` : '这笔退货单';
  if (family === 'purchase_order') return normalized.businessId ? `采购单 ${text(normalized.businessId)}` : '这张采购单';
  if (family === 'delivery') return normalized.businessId ? `发货单 ${text(normalized.businessId)}` : '这张发货单';
  if (family === 'purchase_return_application') return normalized.businessId ? `采购退货申请 ${text(normalized.businessId)}` : '这张采购退货申请';
  if (family === 'purchase_return') return normalized.businessId ? `采购退货单 ${text(normalized.businessId)}` : '这张采购退货单';
  if (family === 'logistics_order') {
    const requestId = text(normalized.placeRequestId);
    const deliveryNo = text(normalized.deliveryNo);
    return requestId ? `物流下单请求 ${requestId}` : deliveryNo ? `运单 ${deliveryNo}` : '这张物流单';
  }
  if (family === 'logistics_forecast') return normalized.businessId ? `物流单 ${text(normalized.businessId)}` : '这张物流单';
  const context = object(normalized.productContext);
  const productKey = text(context.supplierCode || context.standardGoodsSn || normalized.skc || normalized.sku || normalized.productId || normalized.businessId);
  return productKey ? `商品 ${productKey}` : '相关商品';
}

function productIdentityLines(normalized = {}) {
  const context = object(normalized.productContext);
  const supplierCode = text(context.supplierCode || context.standardGoodsSn);
  const productName = text(context.productName);
  const skc = text(normalized.skc || context.skc || normalized.businessId);
  return {
    label: supplierCode || productName || skc || '相关商品',
    lines: [
      supplierCode ? `货号：${supplierCode}` : '',
      productName && productName !== supplierCode ? `商品：${productName}` : '',
      skc ? `链接：${skc}` : '',
    ].filter(Boolean),
  };
}

function productReceiveCopy(normalized, needsAction) {
  const storeLabel = `${text(normalized.storeKey) || '未知'} 店`;
  const {label, lines} = productIdentityLines(normalized);
  const auditContext = object(normalized.auditContext);
  const reason = text(auditContext.failureReason || normalized.auditFailureReason);
  if (!needsAction) {
    return {
      title: `${storeLabel}：${label}资料已被平台接收`,
      summary: [...lines, '平台已经收到商品资料，系统已记录，无需人工处理。'].join('\n'),
    };
  }
  if (reason) lines.push(`失败原因：${reason.replaceAll(':', '：').replaceAll(';', '；')}`);
  lines.push(reason
    ? '下一步：请根据失败原因补齐资料后重新提交。'
    : '下一步：请到 SHEIN 后台查看商品接收失败详情并补齐资料。');
  return {title: `${storeLabel}：${label}资料接收失败`, summary: lines.join('\n')};
}

const RRP_AUDIT_STATE_LABELS = Object.freeze({
  '1': '审核中',
  '2': '审核通过',
  '3': '审核未通过',
  '5': '部分审核未通过',
  '6': '已撤回',
});

function rrpReviewCopy(normalized) {
  const storeLabel = `${text(normalized.storeKey) || '未知'} 店`;
  const {label, lines} = productIdentityLines(normalized);
  const state = RRP_AUDIT_STATE_LABELS[text(normalized.auditState || normalized.status)] || text(normalized.status);
  if (state) lines.push(`审核结果：${state}`);
  const at = cnDateTime(normalized.eventTime);
  if (at) lines.push(`审核时间：${at}`);
  if (['3', '5'].includes(text(normalized.auditState || normalized.status))) {
    lines.push('下一步：请到 SHEIN 后台查看驳回项，修正建议零售价资料后重新提交。');
  } else if (text(normalized.auditState || normalized.status) === '6') {
    lines.push('当前申请已撤回；如仍需使用建议零售价，请重新提交。');
  } else {
    lines.push('系统已记录，无需人工处理。');
  }
  return {title: `${storeLabel}：${label}建议零售价${state || '状态已更新'}`, summary: lines.join('\n')};
}

function rrpValidityCopy(normalized) {
  const storeLabel = `${text(normalized.storeKey) || '未知'} 店`;
  const {label, lines} = productIdentityLines(normalized);
  const end = text(normalized.rrpEndEffectiveDate);
  const status = text(normalized.status).toUpperCase();
  if (end.startsWith('9999-12-31')) lines.push('有效期：长期有效');
  else if (end) lines.push(`有效期至：${cnDateTime(end) || end}`);
  if (status === 'EXPIRED') lines.push('下一步：建议零售价已失效；如仍需使用，请到 SHEIN 后台重新提交。');
  else if (status === 'EXPIRING_SOON') lines.push('下一步：建议零售价将在 7 天内到期，请确认是否续期。');
  else lines.push('当前仍在有效期内，无需人工处理。');
  const stateLabel = status === 'EXPIRED' ? '已失效' : status === 'EXPIRING_SOON' ? '即将到期' : '有效期已更新';
  return {title: `${storeLabel}：${label}建议零售价${stateLabel}`, summary: lines.join('\n')};
}

/**
 * User-facing copy shared by BI persistence and Feishu P0 alerts.
 *
 * Numeric platform states, internal severity codes, event codes, action-state
 * names and classifier reasons remain audit-only. Operators should only see
 * what happened, what the system did, and whether they need to act.
 */
export function humanizeSheinWebhookEvent(normalized = {}, severity = {}) {
  const store = text(normalized.storeKey) || '未知';
  const storeLabel = `${store} 店`;
  const family = text(normalized.eventFamily);
  const urgent = text(severity?.severity) === 'P0';
  const needsAction = ['P0', 'P1'].includes(text(severity?.severity));
  const ref = businessReference(normalized);
  let title = `${storeLabel}：平台状态已更新`;
  let summary = `${ref} 的状态变化已记录到 BI，无需人工处理。`;

  switch (family) {
    case 'order':
      title = `${storeLabel}：订单已同步`;
      summary = `${ref} 已同步到 BI，无需人工处理。`;
      break;
    case 'return':
      title = `${storeLabel}：退货信息已同步`;
      summary = `${ref} 已同步到 BI，无需人工处理。`;
      break;
    case 'product_receive':
      ({title, summary} = productReceiveCopy(normalized, needsAction));
      break;
    case 'product_audit':
    case 'product_audit_all_channels':
      ({title, summary} = auditProductCopy(normalized, urgent));
      break;
    case 'product_shelves':
      ({title, summary} = shelfProductCopy(normalized, urgent));
      break;
    case 'product_delete_audit':
      {
        const identity = productIdentityLines(normalized);
        title = urgent ? `${storeLabel}：${identity.label}删除状态需要处理` : `${storeLabel}：${identity.label}删除审核状态已更新`;
        summary = [
          ...identity.lines,
          urgent
            ? '该商品已删除或删除审核出现异常。下一步：请到 SHEIN 后台核对，确认是否需要恢复。'
            : '删除审核状态已更新，系统已记录。',
        ].join('\n');
      }
      break;
    case 'authorization':
      title = `${storeLabel}：店铺授权需要处理`;
      summary = 'SHEIN 店铺授权发生变化，系统已暂停该店的自动操作，避免误写。请重新检查并恢复授权。';
      break;
    case 'quota':
      if (normalized.quota === 0) {
        title = `${storeLabel}：可上架商品额度已用完`;
        summary = '该店当前不能继续新增商品，系统已暂停新增商品操作。请到 SHEIN 后台检查商品额度。';
      } else {
        title = `${storeLabel}：可上架商品额度已恢复`;
        summary = Number.isFinite(normalized.quota)
          ? `该店当前可用商品额度为 ${normalized.quota}，系统已恢复相关操作。`
          : '该店的商品额度已恢复，系统已记录。';
      }
      break;
    case 'compliance':
      title = urgent ? `${storeLabel}：商品合规资料需要处理` : `${storeLabel}：商品合规信息已更新`;
      summary = urgent
        ? `${ref} 的必需合规资料失效或缺失。请到 SHEIN 后台补齐。`
        : `${ref} 的合规信息已更新，系统已记录。`;
      break;
    case 'price_abnormal':
      title = `${storeLabel}：商品价格需要关注`;
      summary = `${ref} 出现价格异常提示，请到 SHEIN 后台核对。`;
      break;
    case 'price_audit':
      title = `${storeLabel}：商品调价审核状态已更新`;
      summary = `${ref} 的调价审核状态已更新，系统已记录。`;
      break;
    case 'rrp_review':
      ({title, summary} = rrpReviewCopy(normalized));
      break;
    case 'rrp_validity':
      ({title, summary} = rrpValidityCopy(normalized));
      break;
    case 'inventory_warning':
      title = `${storeLabel}：商品库存偏低`;
      summary = `${ref} 库存偏低，建议检查补货计划。`;
      break;
    case 'out_of_stock':
      title = `${storeLabel}：平台发来补货需求`;
      summary = `平台发来 ${ref} 的补货需求，请检查可用库存。`;
      break;
    case 'invoice':
      title = `${storeLabel}：开票状态已更新`;
      summary = '相关开票状态已更新，系统已记录。';
      break;
    case 'logistics_order':
      title = `${storeLabel}：SHEIN 物流单已创建`;
      summary = [
        normalized.placeRequestId ? `下单编号：${text(normalized.placeRequestId)}` : '',
        normalized.deliveryNo ? `运单包裹号：${text(normalized.deliveryNo)}` : '',
        normalized.eventTime ? `创建时间：${cnDateTime(normalized.eventTime) || text(normalized.eventTime)}` : '',
        '系统已记录，可用于后续物流追踪，无需人工处理。',
      ].filter(Boolean).join('\n');
      break;
    case 'purchase_order':
      title = `${storeLabel}：采购单已更新`;
      summary = `${ref} 已更新，系统已记录。`;
      break;
    case 'delivery':
      title = `${storeLabel}：发货单已更新`;
      summary = `${ref} 已更新，系统已记录。`;
      break;
    case 'purchase_return_application':
      title = `${storeLabel}：采购退货申请已更新`;
      summary = `${ref} 已更新，系统已记录。`;
      break;
    case 'logistics_forecast':
      title = `${storeLabel}：采购物流状态已更新`;
      summary = `${ref} 的状态已更新，系统已记录。`;
      break;
    case 'purchase_return':
      title = `${storeLabel}：采购退货单已更新`;
      summary = `${ref} 已更新，系统已记录。`;
      break;
    default:
      if (urgent) {
        title = `${storeLabel}：平台有一项需要处理`;
        summary = `${ref} 出现需要人工处理的变化。请到 SHEIN 后台核对。`;
      }
  }
  return Object.freeze({title, summary});
}

export async function reconcileProductTask({receipt, linkOpsRepository, taskStore = null}) {
  if (receipt.signal?.aborted) throw receipt.signal.reason || new Error('Webhook lease was lost');
  if (!linkOpsRepository?.getTaskStore || !linkOpsRepository?.updateTask) return {actionState: 'event_recorded_no_task_repository'};
  const normalized = receipt.normalized;
  const eventIdentity = identityFromPayload(receipt.payload, normalized);
  const store = text(normalized.storeKey).toUpperCase();
  const currentTaskStore = taskStore || await linkOpsRepository.getTaskStore({limit: 10_000});
  const allowSingleSkc = ['product_shelves', 'product_delete_audit'].includes(text(normalized.eventFamily));
  const matches = (currentTaskStore?.tasks || []).filter(task => taskStores(task).has(store)
    && strongIdentityMatch(eventIdentity, taskIdentity(task), {allowSingleSkc}));
  if (matches.length !== 1) return {actionState: matches.length ? 'task_match_ambiguous' : 'task_unmatched'};
  const task = matches[0];
  const at = new Date().toISOString();
  const currentReadbacks = Array.isArray(task?.lifecycle?.webhookReadbacks) ? task.lifecycle.webhookReadbacks : [];
  if (currentReadbacks.some(row => String(row?.receiptId) === String(receipt.id))) {
    return {actionState: 'task_readback_attached', taskId: task.id, replayed: true};
  }
  const readback = {
    at,
    source: 'shein_webhook',
    receiptId: receipt.id,
    eventCode: normalized.eventCode,
    status: normalized.status,
    businessId: normalized.businessId,
  };
  const next = {
    ...task,
    lifecycle: {
      ...(task.lifecycle && typeof task.lifecycle === 'object' ? task.lifecycle : {}),
      webhookReadbacks: [...currentReadbacks.filter(row => String(row?.receiptId) !== String(receipt.id)), readback].slice(-50),
      lastWebhookAt: at,
    },
    history: [...(Array.isArray(task.history) ? task.history : []), {at, event: 'shein_webhook_readback', receiptId: receipt.id, eventCode: normalized.eventCode}].slice(-500),
    updatedAt: at,
  };
  await linkOpsRepository.updateTask(task.id, next, {
    expectedRevision: task.repositoryRevision,
    idempotencyKey: `shein-webhook:${receipt.idempotencyKey || receipt.id}`,
    ownerUser: task.ownerUser || task.ownerKey || '',
    actorUser: 'shein-webhook',
  });
  return {actionState: 'task_readback_attached', taskId: task.id};
}

async function applyRiskGate({receipt, webhookRepository}) {
  const normalized = receipt.normalized;
  const family = normalized.eventFamily;
  if (family === 'authorization') {
    const gate = await webhookRepository.upsertStoreGate({storeKey: normalized.storeKey, gateType: 'authorization', state: 'blocked', reason: 'SHEIN authorization relationship changed', sourceReceiptId: receipt.id, sourceEventOrder: sourceEventOrder(normalized.eventTime)});
    return {actionState: gate?.applied === false ? 'authorization_gate_stale_ignored' : 'authorization_gate_blocked'};
  }
  if (family === 'quota' && Number.isFinite(normalized.quota)) {
    const blocked = normalized.quota <= 0;
    const gate = await webhookRepository.upsertStoreGate({storeKey: normalized.storeKey, gateType: 'quota', state: blocked ? 'blocked' : 'open', reason: blocked ? 'SHEIN product quota is zero' : 'SHEIN product quota restored', sourceReceiptId: receipt.id, sourceEventOrder: sourceEventOrder(normalized.eventTime)});
    return {actionState: gate?.applied === false ? 'quota_gate_stale_ignored' : blocked ? 'quota_gate_blocked' : 'quota_gate_open'};
  }
  if (family === 'compliance') {
    const required = boolField({isRequired: normalized.complianceRequired}, ['required', 'isRequired', 'is_required']);
    if (required === false) return {actionState: 'optional_compliance_event_recorded'};
    // Compliance invalidation is normally scoped to a product/certificate. A
    // store-wide gate would incorrectly stop unrelated listings, so keep it as
    // a P0 event and let the affected business key be handled explicitly.
    return {actionState: 'required_compliance_attention'};
  }
  return null;
}

async function applyProductState({receipt, webhookRepository}) {
  const normalized = receipt?.normalized || {};
  const family = text(normalized.eventFamily);
  const declaredAction = text(normalized.action);
  const readback = object(normalized.productStateReadback);
  const readbackAction = EXACT_PRODUCT_STATE_ACTIONS.has(text(readback.action)) ? text(readback.action) : '';
  const action = EXACT_PRODUCT_STATE_ACTIONS.has(declaredAction) ? declaredAction : readbackAction;
  const skc = text(normalized.skc || normalized.businessId);
  const order = sourceEventOrder(normalized.eventTime || normalized.receivedAt || receipt?.receivedAt);
  const supported = (family === 'product_shelves' && EXACT_PRODUCT_STATE_ACTIONS.has(action))
    || (family === 'product_delete_audit' && text(normalized.status) === '2');
  const readbackSupported = PRODUCT_STATE_EVENT_FAMILIES.has(family) && Boolean(readbackAction);
  if ((!supported && !readbackSupported) || !skc || !order || !webhookRepository?.applyProductState) return null;
  const eventDate = parseBusinessDate(normalized.eventTime || normalized.receivedAt || receipt?.receivedAt);
  const productContext = {
    ...object(normalized.productContext),
    ...(text(readback.supplierCode) ? {supplierCode: text(readback.supplierCode)} : {}),
    ...(text(readback.spu) ? {spu: text(readback.spu)} : {}),
  };
  const applied = await webhookRepository.applyProductState({
    receiptId: receipt.id,
    storeKey: normalized.storeKey,
    skc,
    eventFamily: family,
    action,
    status: normalized.status,
    sourceEventOrder: order,
    eventAt: eventDate?.toISOString() || normalized.receivedAt || receipt?.receivedAt,
    productContext,
  });
  return {
    actionState: applied ? 'product_state_synced' : 'product_state_stale_ignored',
    productStateApplied: applied,
  };
}

async function enrichProductContext(receipt, webhookRepository, productAuditContextProvider) {
  const normalized = receipt?.normalized || {};
  if (normalized.appScopedOnly === true) return normalized;
  let enriched = normalized;
  const skc = text(normalized.skc || normalized.businessId);
  const storeKey = text(normalized.storeKey).toUpperCase();

  if (PRODUCT_CONTEXT_FAMILIES.has(normalized.eventFamily)
    && webhookRepository?.getProductBusinessContext
    && storeKey && skc) {
    try {
      const eventDate = parseBusinessDate(normalized.eventTime || normalized.receivedAt);
      const productContext = await webhookRepository.getProductBusinessContext({
        storeKey,
        skc,
        eventAt: eventDate?.toISOString() || text(normalized.receivedAt) || new Date().toISOString(),
      });
      enriched = {
        ...enriched,
        ...(productContext && typeof productContext === 'object' ? {productContext} : {}),
        productContextStatus: productContext ? 'resolved' : 'not_found',
      };
    } catch {
      // Product context is an operator convenience, never a prerequisite for
      // processing a P0 alert or a safety gate.
      enriched = {...enriched, productContextStatus: 'unavailable'};
    }
  }

  const currentProductContext = object(enriched.productContext);
  const productStateReadbackNeeded = needsProductStateReadback(enriched);
  const needsProductIdentity = normalized.eventFamily === 'product_shelves'
    && !productStateReadbackNeeded
    && (!text(currentProductContext.supplierCode || currentProductContext.standardGoodsSn));
  if (needsProductIdentity && productAuditContextProvider?.getProductIdentity && storeKey && skc) {
    try {
      const productIdentity = await productAuditContextProvider.getProductIdentity({storeKey, skc});
      if (productIdentity && typeof productIdentity === 'object') {
        enriched = {
          ...enriched,
          productContext: {...currentProductContext, ...productIdentity},
          productContextStatus: 'resolved',
        };
      }
    } catch {
      if (enriched.productContextStatus === 'not_found') enriched = {...enriched, productContextStatus: 'unavailable'};
    }
  }

  const needsAuditLookup = ['product_audit', 'product_audit_all_channels', 'product_delete_audit'].includes(normalized.eventFamily)
    || (normalized.eventFamily === 'product_receive'
      && /^(?:0|false|no|fail|failed|reject)$/i.test(text(normalized.receivedSuccess || normalized.status)));
  if (needsAuditLookup && productAuditContextProvider?.getAuditContext && storeKey && skc) {
    try {
      const auditContext = await productAuditContextProvider.getAuditContext({
        storeKey,
        skc,
        productId: text(normalized.productId),
        version: text(normalized.version),
        documentId: text(normalized.documentId || normalized.businessId),
        auditFailureReason: text(normalized.auditFailureReason),
      });
      enriched = {
        ...enriched,
        ...(auditContext && typeof auditContext === 'object' ? {auditContext} : {}),
        auditContextStatus: auditContext ? 'resolved' : 'not_found',
      };
    } catch {
      // The callback's own failure reason remains authoritative and alertable.
      // A read-only detail lookup must not delay retries or suppress P0/P1.
      enriched = {...enriched, auditContextStatus: 'unavailable'};
    }
  }

  if (needsProductStateReadback(enriched)
    && productAuditContextProvider?.getProductState
    && storeKey && skc) {
    try {
      const productStateReadback = await productAuditContextProvider.getProductState({storeKey, skc});
      const stateAction = text(productStateReadback?.action);
      if (productStateReadback && EXACT_PRODUCT_STATE_ACTIONS.has(stateAction)) {
        const context = object(enriched.productContext);
        enriched = {
          ...enriched,
          productStateReadback,
          productStateReadbackStatus: 'resolved',
          productContext: {
            ...context,
            ...(text(productStateReadback.supplierCode) ? {supplierCode: text(productStateReadback.supplierCode)} : {}),
            ...(text(productStateReadback.spu) ? {spu: text(productStateReadback.spu)} : {}),
          },
          productContextStatus: 'resolved',
        };
      } else {
        enriched = {...enriched, productStateReadbackStatus: 'not_found'};
      }
    } catch {
      // Webhook receipt processing and alerts must remain reliable even if the
      // read-only product detail endpoint is temporarily unavailable. The next
      // lifecycle event or daily snapshot remains the reconciliation backstop.
      enriched = {...enriched, productStateReadbackStatus: 'unavailable'};
    }
  }
  return enriched;
}

export function createSheinWebhookEventProcessor({webhookRepository, linkOpsRepository = null, orderReturnSync = null, productAuditContextProvider = null} = {}) {
  if (!webhookRepository) throw new TypeError('webhookRepository is required');
  const enrich = receipt => enrichProductContext(receipt, webhookRepository, productAuditContextProvider);
  return Object.freeze({
    enrich,
    async process(receipt) {
      if (receipt?.signal?.aborted) throw receipt.signal.reason || new Error('Webhook lease was lost');
      let normalized = receipt?.normalized || {};
      const severity = receipt?.severity || {severity: 'P3', notifyFeishu: false, reason: normalized.eventFamily || 'unknown'};
      if (normalized.appScopedOnly === true) {
        return {
          title: `${text(normalized.storeKey) || '未知店铺'} Webhook 应用级验证`,
          summary: '签名与接收链路验证通过；未携带已授权店铺 OpenKey，未执行店铺业务动作。',
          businessKey: '',
          actionState: 'app_scoped_event_recorded',
          normalized,
        };
      }
      const productStateReadbackComplete = !needsProductStateReadback(normalized)
        || normalized.productStateReadbackStatus === 'resolved';
      const contextAlreadyResolved = (normalized.productContextStatus || normalized.auditContextStatus)
        && productStateReadbackComplete;
      normalized = contextAlreadyResolved ? normalized : await enrich({...receipt, normalized});
      const workingReceipt = {...receipt, normalized};
      const userCopy = humanizeSheinWebhookEvent(normalized, severity);
      const base = {
        title: userCopy.title,
        summary: userCopy.summary,
        businessKey: text(normalized.businessId),
        actionState: 'event_recorded',
        normalized,
      };
      if (normalized.eventFamily === 'order') {
        if (!normalized.orderId) throw new Error('Order webhook has no order number');
        if (!orderReturnSync?.syncOrder) throw new Error('Targeted order sync is unavailable');
        const result = await orderReturnSync.syncOrder({
          storeKey: normalized.storeKey,
          orderNo: normalized.orderId,
          ...(receipt.signal ? {signal: receipt.signal} : {}),
        });
        return {...base, actionState: 'order_warehouse_synced', result};
      }
      if (normalized.eventFamily === 'return') {
        if (!normalized.returnId) throw new Error('Return webhook has no return order number');
        if (!orderReturnSync?.syncReturn) throw new Error('Targeted return sync is unavailable');
        const result = await orderReturnSync.syncReturn({
          storeKey: normalized.storeKey,
          returnOrderNo: normalized.returnId,
          ...(receipt.signal ? {signal: receipt.signal} : {}),
        });
        return {...base, actionState: 'return_warehouse_synced', result};
      }
      const gate = await applyRiskGate({receipt: workingReceipt, webhookRepository});
      if (gate) return {...base, ...gate};
      if (PRODUCT_STATE_EVENT_FAMILIES.has(normalized.eventFamily)) {
        const productState = await applyProductState({receipt: workingReceipt, webhookRepository});
        const task = PRODUCT_FAMILIES.has(normalized.eventFamily)
          ? await reconcileProductTask({receipt: workingReceipt, linkOpsRepository})
          : null;
        return {
          ...base,
          ...(task || {}),
          ...(productState ? {
            productState,
            normalized: {
              ...normalized,
              productState: {
                applied: productState.productStateApplied,
                state: productState.actionState,
              },
            },
          } : {}),
        };
      }
      return base;
    },
  });
}
