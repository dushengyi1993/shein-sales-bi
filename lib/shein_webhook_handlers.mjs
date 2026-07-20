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
      title = urgent ? `${storeLabel}：有商品被下架` : `${storeLabel}：商品上下架状态已更新`;
      summary = urgent
        ? `${ref} 出现下架变化。请到 SHEIN 后台确认下架原因。`
        : `${ref} 的上下架状态已更新，系统已记录。`;
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

export function createSheinWebhookEventProcessor({webhookRepository, linkOpsRepository = null, orderReturnSync = null} = {}) {
  if (!webhookRepository) throw new TypeError('webhookRepository is required');
  return Object.freeze({
    async process(receipt) {
      if (receipt?.signal?.aborted) throw receipt.signal.reason || new Error('Webhook lease was lost');
      const normalized = receipt?.normalized || {};
      const severity = receipt?.severity || {severity: 'P3', notifyFeishu: false, reason: normalized.eventFamily || 'unknown'};
      const userCopy = humanizeSheinWebhookEvent(normalized, severity);
      const base = {
        title: userCopy.title,
        summary: userCopy.summary,
        businessKey: text(normalized.businessId),
        actionState: 'event_recorded',
      };
      if (normalized.appScopedOnly === true) {
        return {
          ...base,
          title: `${text(normalized.storeKey) || '未知店铺'} Webhook 应用级验证`,
          summary: '签名与接收链路验证通过；未携带已授权店铺 OpenKey，未执行店铺业务动作。',
          businessKey: '',
          actionState: 'app_scoped_event_recorded',
        };
      }
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
      const gate = await applyRiskGate({receipt, webhookRepository});
      if (gate) return {...base, ...gate};
      if (PRODUCT_FAMILIES.has(normalized.eventFamily)) {
        return {...base, ...(await reconcileProductTask({receipt, linkOpsRepository}))};
      }
      return base;
    },
  });
}
