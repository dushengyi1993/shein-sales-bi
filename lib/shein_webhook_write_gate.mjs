function text(value) {
  return String(value ?? '').trim();
}

function gateLabel(gateType) {
  if (gateType === 'authorization') return 'OpenAPI 授权异常';
  if (gateType === 'quota') return '商品额度为 0';
  return text(gateType) || '未知平台状态';
}

/**
 * Fail-closed evaluation used both during execute preflight and immediately
 * before an external SHEIN write.  Dependencies are injected so the ordering
 * and stale-gate behavior can be tested without a live portal or database.
 */
export async function evaluateSheinWebhookWriteGates({
  repository,
  writeStores = [],
  loadProbeSummary,
  probeIsReadReady,
} = {}) {
  if (!repository?.listStoreGates || !repository?.reopenAuthorizationGate) {
    return {
      ok: false,
      blockers: ['平台动态安全闸门当前不可用，真实提交已按失败关闭处理：webhook repository is not configured'],
      blockingGates: [],
      clearedGates: [],
    };
  }
  try {
    const gates = await repository.listStoreGates({storeKeys: writeStores, blockingOnly: true});
    if (!Array.isArray(gates) || gates.length === 0) {
      return {ok: true, blockers: [], blockingGates: [], clearedGates: []};
    }
    const probeSummary = typeof loadProbeSummary === 'function' ? await loadProbeSummary() : null;
    const blockers = [];
    const blockingGates = [];
    const clearedGates = [];
    for (const gate of gates || []) {
      const gateAt = Date.parse(gate.updatedAt || '');
      const probe = probeSummary?.byStore?.get?.(text(gate.storeKey).toUpperCase());
      const authorizationRecovered = gate.gateType === 'authorization'
        && Number.isFinite(gateAt)
        && probeSummary?.fresh === true
        && Number(probeSummary.generatedAtMs) > gateAt
        && typeof probeIsReadReady === 'function'
        && probeIsReadReady(probe);
      if (authorizationRecovered) {
        const reopened = await repository.reopenAuthorizationGate({
          storeKey: gate.storeKey,
          reason: 'A newer successful OpenAPI read probe cleared the authorization webhook gate',
          sourceReceiptId: gate.sourceReceiptId,
        });
        // A newer receipt may have arrived between list and upsert.  The
        // monotonic repository rejects our older reopen; never treat that as
        // recovery.
        if (reopened?.applied !== false && reopened?.state === 'open') {
          clearedGates.push(reopened);
          continue;
        }
      }
      blockingGates.push(gate);
      blockers.push(`${gate.storeKey} 平台动态安全闸门未恢复：${gateLabel(gate.gateType)}。请先处理平台问题并完成新一次成功探针/状态回读。`);
    }
    return {ok: blockers.length === 0, blockers, blockingGates, clearedGates};
  } catch (error) {
    return {
      ok: false,
      blockers: [`平台动态安全闸门当前不可用，真实提交已按失败关闭处理：${text(error?.message || error).slice(0, 180)}`],
      blockingGates: [],
      clearedGates: [],
    };
  }
}
