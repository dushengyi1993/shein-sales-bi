const PRODUCT_FAMILIES = new Set([
  'product_receive',
  'product_audit',
  'product_audit_all_channels',
  'product_shelves',
  'product_delete_audit',
]);

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

function displayShelfChange(normalized = {}) {
  const rows = Array.isArray(normalized.shelfChanges) ? normalized.shelfChanges : [];
  return rows.find(row => text(row?.site).toLowerCase() === 'shein-sa') || rows[0] || {};
}

function shelfProductCopy(normalized, urgent) {
  const context = object(normalized.productContext);
  const sales = object(context.sales);
  const change = displayShelfChange(normalized);
  const supplierCode = text(context.supplierCode || context.standardGoodsSn);
  const productName = text(context.productName);
  const variantName = text(context.variantName);
  const skc = text(normalized.skc || context.skc || normalized.businessId);
  const productLabel = supplierCode || productName || skc || '相关商品';
  const title = urgent
    ? `${text(normalized.storeKey) || '未知'} 店：${productLabel}被下架`
    : `${text(normalized.storeKey) || '未知'} 店：${productLabel}上下架状态已更新`;
  if (!urgent) return {title, summary: `${skc ? `链接 ${skc}` : '该商品'}的上下架状态已更新，系统已记录。`};

  const firstShelf = text(change.firstShelfTime || context.firstShelfTime);
  const eventAt = text(normalized.eventTime || normalized.receivedAt);
  const firstShelfDate = parseBusinessDate(firstShelf);
  const eventDate = parseBusinessDate(eventAt);
  const ageDays = calendarDaysBetween(firstShelfDate, eventDate);
  const operator = text(normalized.shelfOperator);
  const reason = text(normalized.shelfReason);
  const lines = [
    supplierCode ? `货号：${supplierCode}` : '货号：BI 暂未匹配到',
    productName && productName !== supplierCode ? `商品：${productName}${variantName && variantName !== productName ? `（${variantName}）` : ''}` : variantName && variantName !== supplierCode ? `款式：${variantName}` : '',
    skc ? `链接：${skc}` : '',
    firstShelf ? `上架时间：${cnDateTime(firstShelf) || firstShelf}${ageDays === null ? '' : `（已上架 ${ageDays} 天）`}` : '上架时间：BI 暂未找到',
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
  } else {
    lines.push('销售：BI 暂未匹配到有效成交');
  }

  lines.push(`下架时间：${cnDateTime(eventAt) || eventAt || '时间待核对'}`);
  if (operator) lines.push(`下架人：${operator}`);
  if (reason) lines.push(`下架原因：${reason}`);
  if (text(change.recycleState) === '1') lines.push('当前状态：商品已进入回收站');
  lines.push(reason
    ? '下一步：请根据上述原因决定恢复上架或保持下架。'
    : '下一步：如需恢复上架，请到 SHEIN 后台查看商品操作记录后再处理。');
  return {title, summary: lines.join('\n')};
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
    document: scalarFields(payload, ['documentSn', 'document_sn', 'documentNo', 'document_no']),
    version: scalarFields(payload, ['version']),
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

function strongIdentityMatch(eventIdentity, candidateIdentity) {
  const populated = Object.entries(eventIdentity).filter(([, values]) => values.size);
  if (populated.length < 2) return false;
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
  if (family === 'logistics_order' || family === 'logistics_forecast') return normalized.businessId ? `物流单 ${text(normalized.businessId)}` : '这张物流单';
  const productKey = text(normalized.skc || normalized.sku || normalized.productId || normalized.businessId);
  return productKey ? `商品 ${productKey}` : '相关商品';
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
      title = `${storeLabel}：商品资料已被平台接收`;
      summary = `${ref} 的资料已被平台接收，系统已记录。`;
      break;
    case 'product_audit':
    case 'product_audit_all_channels':
      title = urgent ? `${storeLabel}：商品审核未通过` : `${storeLabel}：商品审核状态已更新`;
      summary = urgent
        ? `${ref} 未通过平台审核。请到 SHEIN 后台查看审核原因并补齐资料。`
        : `${ref} 的审核状态已更新，系统已记录。`;
      break;
    case 'product_shelves':
      ({title, summary} = shelfProductCopy(normalized, urgent));
      break;
    case 'product_delete_audit':
      title = urgent ? `${storeLabel}：商品删除状态需要处理` : `${storeLabel}：商品删除审核状态已更新`;
      summary = urgent
        ? `${ref} 出现删除或删除审核异常。请到 SHEIN 后台核对。`
        : `${ref} 的删除审核状态已更新，系统已记录。`;
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
      title = `${storeLabel}：建议零售价审核状态已更新`;
      summary = `${ref} 的建议零售价审核状态已更新，建议查看结果。`;
      break;
    case 'rrp_validity':
      title = `${storeLabel}：建议零售价有效期已更新`;
      summary = `${ref} 的建议零售价有效期已更新，建议查看结果。`;
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
      title = `${storeLabel}：物流单状态已更新`;
      summary = `${ref} 的状态已更新，系统已记录。`;
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

async function reconcileProductTask({receipt, linkOpsRepository}) {
  if (receipt.signal?.aborted) throw receipt.signal.reason || new Error('Webhook lease was lost');
  if (!linkOpsRepository?.getTaskStore || !linkOpsRepository?.updateTask) return {actionState: 'event_recorded_no_task_repository'};
  const normalized = receipt.normalized;
  const eventIdentity = identityFromPayload(receipt.payload, normalized);
  const store = text(normalized.storeKey).toUpperCase();
  const taskStore = await linkOpsRepository.getTaskStore({limit: 10_000});
  const matches = (taskStore?.tasks || []).filter(task => taskStores(task).has(store) && strongIdentityMatch(eventIdentity, taskIdentity(task)));
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
    idempotencyKey: `shein-webhook:${receipt.idempotencyKey}`,
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

async function enrichProductContext(receipt, webhookRepository) {
  const normalized = receipt?.normalized || {};
  if (normalized.eventFamily !== 'product_shelves' || normalized.appScopedOnly === true) return normalized;
  if (!webhookRepository?.getProductBusinessContext) return normalized;
  const skc = text(normalized.skc || normalized.businessId);
  const storeKey = text(normalized.storeKey).toUpperCase();
  if (!storeKey || !skc) return normalized;
  try {
    const eventDate = parseBusinessDate(normalized.eventTime || normalized.receivedAt);
    const productContext = await webhookRepository.getProductBusinessContext({
      storeKey,
      skc,
      eventAt: eventDate?.toISOString() || text(normalized.receivedAt) || new Date().toISOString(),
    });
    return {
      ...normalized,
      ...(productContext && typeof productContext === 'object' ? {productContext} : {}),
      productContextStatus: productContext ? 'resolved' : 'not_found',
    };
  } catch {
    // Product context is an operator convenience, never a prerequisite for a
    // P0 alert or a safety gate. Preserve the event and say the lookup is
    // unavailable instead of retrying the whole receipt or inventing facts.
    return {...normalized, productContextStatus: 'unavailable'};
  }
}

export function createSheinWebhookEventProcessor({webhookRepository, linkOpsRepository = null, orderReturnSync = null} = {}) {
  if (!webhookRepository) throw new TypeError('webhookRepository is required');
  return Object.freeze({
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
      normalized = await enrichProductContext({...receipt, normalized}, webhookRepository);
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
      if (PRODUCT_FAMILIES.has(normalized.eventFamily)) {
        return {...base, ...(await reconcileProductTask({receipt: workingReceipt, linkOpsRepository}))};
      }
      return base;
    },
  });
}
