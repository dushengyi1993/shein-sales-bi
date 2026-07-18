const MATCH_STATUSES = new Set(['matched', 'not_matched', 'stale']);

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Older portal snapshots did not carry inventory_match_status. Keep their
// explicit has_et_inventory signal readable until a refreshed projection adds
// the richer state.
export function inventoryMatchStatus(row = {}) {
  const explicit = String(row.inventory_match_status || '').trim();
  if (MATCH_STATUSES.has(explicit)) return explicit;
  return row.has_et_inventory === true ? 'matched' : 'not_matched';
}

export function normalizeInventoryProjection(row = {}) {
  const inventory_match_status = inventoryMatchStatus(row);
  const has_et_inventory = inventory_match_status !== 'not_matched';
  const fresh_matched = inventory_match_status === 'matched';
  const current_sellable_quantity = fresh_matched
    ? finiteNumber(row.current_sellable_quantity ?? row.et_estimated_available_qty ?? row.estimated_on_hand_quantity)
    : null;
  const incoming_quantity = finiteNumber(row.incoming_quantity ?? row.et_ship_in_transit_quantity);
  const arrived_quantity = finiteNumber(row.arrived_quantity ?? row.et_ship_arrived_quantity);
  return {
    ...row,
    inventory_match_status,
    has_et_inventory,
    fresh_matched,
    current_sellable_quantity,
    arrived_quantity,
    incoming_quantity,
    is_fresh_matched_out_of_stock: fresh_matched && current_sellable_quantity === 0,
  };
}

export function inventoryMatchStatusLabel(row = {}) {
  switch (inventoryMatchStatus(row)) {
    case 'matched': return 'ET快照已匹配';
    case 'stale': return 'ET快照已过期';
    default: return '未匹配到ET快照';
  }
}
