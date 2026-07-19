import {createSheinWebhookRepository} from './shein_webhook_repository.mjs';
import {evaluateSheinWebhookWriteGates} from './shein_webhook_write_gate.mjs';

function normalizedStores(stores = []) {
  return [...new Set((Array.isArray(stores) ? stores : [stores])
    .map(value => String(value || '').trim().toUpperCase())
    .filter(Boolean))];
}

/**
 * Re-reads webhook-produced blocking gates immediately before an external
 * SHEIN write.  This deliberately owns a short-lived repository/pool so a
 * long-running executor cannot rely on a preflight-era database snapshot.
 */
export async function checkSheinWebhookExternalWriteGate({
  writeStores,
  env = process.env,
  createRepository = createSheinWebhookRepository,
} = {}) {
  const stores = normalizedStores(writeStores);
  if (!stores.length) {
    return {ok: false, blockers: ['平台动态安全闸门缺少目标店铺，真实提交已按失败关闭处理。'], blockingGates: [], clearedGates: []};
  }
  let repository;
  try {
    repository = createRepository({env});
    const result = await evaluateSheinWebhookWriteGates({repository, writeStores: stores});
    return result?.ok
      ? result
      : {...result, ok: false, blockers: result?.blockers?.length ? result.blockers : ['平台动态安全闸门检查失败，真实提交已按失败关闭处理。']};
  } catch (error) {
    return {
      ok: false,
      blockers: [`平台动态安全闸门当前不可用，真实提交已按失败关闭处理：${String(error?.message || error).slice(0, 180)}`],
      blockingGates: [],
      clearedGates: [],
    };
  } finally {
    if (repository?.close) {
      try {
        await repository.close();
      } catch {
        // The gate result above remains authoritative. A best-effort close
        // must not turn an already-blocked write into a process failure.
      }
    }
  }
}

/** Keeps the check adjacent to the write call and makes TOCTOU ordering testable. */
export async function runSheinWebhookExternalWriteGuarded({writeStores, guard, write} = {}) {
  const gate = await (guard || checkSheinWebhookExternalWriteGate)({writeStores});
  if (!gate?.ok) return {ok: false, gate};
  return {ok: true, gate, value: await write()};
}
