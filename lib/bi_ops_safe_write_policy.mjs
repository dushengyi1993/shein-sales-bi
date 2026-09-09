// The optional per-store restriction only narrows the existing global gate.
function tokens(value, upper = false) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s，、]+/u) : [];
  return [...new Set(list.map(v => String(v || '').trim()).filter(Boolean).map(v => upper ? v.toUpperCase() : v.toLowerCase()))];
}
export function normalizeSafeWriteOperations(config) {
  const source = config?.safeWriteOperations || {};
  const restrictions = source.allowedOperationsByStore;
  const allowedOperationsByStore = Object.fromEntries(Object.entries(restrictions && typeof restrictions === 'object' && !Array.isArray(restrictions) ? restrictions : {}).map(([key, value]) => [key.trim().toUpperCase(), tokens(value)]));
  return {
    enabled: Boolean(source.enabled), requireDryRun: source.requireDryRun !== false,
    allowedOperations: tokens(source.allowedOperations || source.operations || []),
    allowedStores: tokens(source.allowedStores || source.stores || [], true),
    allowedOperationsByStore,
  };
}
export function safeWriteOperationAllowed(config, {operation = '', storeKey = ''} = {}) {
  const safe = normalizeSafeWriteOperations(config);
  const op = String(operation || '').trim().toLowerCase();
  const store = String(storeKey || '').trim().toUpperCase();
  const globalOperationAllowed = Boolean(op) && (safe.allowedOperations.includes('*') || safe.allowedOperations.includes(op));
  const restriction = safe.allowedOperationsByStore[store];
  const operationAllowed = globalOperationAllowed && (!restriction || restriction.includes(op));
  const storeAllowed = Boolean(store) && (safe.allowedStores.includes('*') || safe.allowedStores.includes(store));
  return {...safe, operation, storeKey: store, operationAllowed, storeAllowed, allowed: Boolean(safe.enabled && operationAllowed && storeAllowed)};
}
