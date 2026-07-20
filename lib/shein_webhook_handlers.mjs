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

function eventTitle(normalized, severity) {
  const store = text(normalized.storeKey) || '未知店铺';
  const status = text(normalized.status);
  const family = normalized.eventFamily;
  if (family === 'authorization') return `${store} OpenAPI 授权异常`;
  if (family === 'quota' && normalized.quota === 0) return `${store} 商品额度已归零`;
  if (family === 'compliance') return `${store} 商品合规信息失效`;
  if (/audit/.test(family) && severity?.severity === 'P0') return `${store} 商品审核未通过`;
  if (family === 'product_shelves' && severity?.severity === 'P0') return `${store} 商品被下架`;
  if (family === 'order') return `${store} 订单动态`;
  if (family === 'return') return `${store} 退货动态`;
  return `${store} ${text(normalized.eventLabel) || '平台动态'}${status ? ` · ${status}` : ''}`;
}

function eventSummary(normalized, severity) {
  const pieces = [];
  if (normalized.businessId) pieces.push(`业务单号 ${normalized.businessId}`);
  if (normalized.status) pieces.push(`状态 ${normalized.status}`);
  if (Number.isFinite(normalized.quota)) pieces.push(`额度 ${normalized.quota}`);
  if (severity?.reason && severity.reason !== normalized.eventFamily) pieces.push(`原因 ${severity.reason}`);
  return pieces.join('；') || '平台已推送状态变更，详情已安全入库。';
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
      const base = {
        title: eventTitle(normalized, severity),
        summary: eventSummary(normalized, severity),
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
