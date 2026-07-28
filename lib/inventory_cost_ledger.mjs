const EVENT_PRIORITY = Object.freeze({opening: 0, inventory_count_reset: 1, receipt: 10, sale: 20, rtv_09_return: 30, adjustment: 40});

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round((n(value) + Number.EPSILON) * factor) / factor;
}

export function sortInventoryCostEvents(events) {
  return [...events].sort((a, b) => {
    const product = String(a.matchKey || '').localeCompare(String(b.matchKey || ''));
    if (product) return product;
    const time = String(a.effectiveAt || '').localeCompare(String(b.effectiveAt || ''));
    if (time) return time;
    const priority = (EVENT_PRIORITY[a.eventType] ?? 99) - (EVENT_PRIORITY[b.eventType] ?? 99);
    if (priority) return priority;
    return String(a.eventKey || '').localeCompare(String(b.eventKey || ''));
  });
}

export function buildInventoryCostLedger(events, {openingStates = new Map(), ledgerVersion = ''} = {}) {
  const states = new Map();
  const saleAssignments = new Map();
  const rows = [];

  for (const event of sortInventoryCostEvents(events)) {
    const matchKey = String(event.matchKey || '').trim();
    if (!matchKey) continue;
    let state = states.get(matchKey);
    if (!state) {
      const opening = openingStates.get(matchKey) || {};
      state = {quantity: n(opening.quantity), value: n(opening.value), avg: n(opening.avgUnitCost)};
      if (!state.avg && state.quantity > 0) state.avg = state.value / state.quantity;
      states.set(matchKey, state);
    }
    const before = {...state};
    let valuedQuantity = 0;
    let unvaluedQuantity = 0;
    let cogsSar = 0;
    let eventCostSar = n(event.costAmountSar);
    let valuationStatus = 'valued';
    const quantity = Math.max(0, n(event.quantity));

    if (event.eventType === 'opening') {
      state.quantity += quantity;
      state.value += eventCostSar;
      if (state.quantity > 0) state.avg = state.value / state.quantity;
      else if (!state.avg && quantity > 0) state.avg = eventCostSar / quantity;
      valuedQuantity = quantity;
    } else if (event.eventType === 'inventory_count_reset') {
      const resetUnitCost = quantity > 0 ? eventCostSar / quantity : (n(event.unitCostSar) || state.avg);
      state.quantity = quantity;
      state.value = eventCostSar;
      state.avg = resetUnitCost;
      valuedQuantity = quantity;
      valuationStatus = 'approved_inventory_count_reset';
    } else if (event.eventType === 'receipt' || event.eventType === 'adjustment') {
      const unitCost = quantity > 0 ? eventCostSar / quantity : n(event.unitCostSar);
      if (state.quantity < 0) {
        const coversShortfall = Math.min(quantity, -state.quantity);
        const remaining = quantity - coversShortfall;
        state.quantity += quantity;
        state.value = remaining > 0 ? remaining * unitCost : 0;
        state.avg = state.quantity > 0 ? state.value / state.quantity : (unitCost || state.avg);
        valuedQuantity = remaining;
        unvaluedQuantity = coversShortfall;
        valuationStatus = remaining > 0 ? 'shortfall_covered_then_valued' : 'shortfall_covered';
      } else {
        state.quantity += quantity;
        state.value += eventCostSar;
        if (state.quantity > 0) state.avg = state.value / state.quantity;
        else if (unitCost > 0) state.avg = unitCost;
        valuedQuantity = quantity;
      }
    } else if (event.eventType === 'sale') {
      const availableQuantity = Math.max(0, state.quantity);
      const shortfallQuantity = Math.max(0, quantity - availableQuantity);
      const lastKnownUnitCost = n(state.avg);
      if (lastKnownUnitCost > 0) {
        valuedQuantity = quantity;
        unvaluedQuantity = 0;
        cogsSar = quantity * lastKnownUnitCost;
        valuationStatus = shortfallQuantity > 0 ? 'estimated_negative_inventory_last_cost' : 'valued';
      } else {
        valuedQuantity = 0;
        unvaluedQuantity = quantity;
        cogsSar = 0;
        valuationStatus = 'missing_opening';
      }
      state.quantity -= quantity;
      state.value = Math.max(0, state.value - Math.min(quantity, availableQuantity) * lastKnownUnitCost);
      if (state.quantity <= 0) state.value = 0;
      state.avg = state.quantity > 0 ? state.value / state.quantity : lastKnownUnitCost;
      saleAssignments.set(String(event.sourceKey || event.eventKey), {
        cogsSar: round(cogsSar),
        unitCostSar: valuedQuantity > 0 ? round(cogsSar / valuedQuantity) : null,
        valuedQuantity: round(valuedQuantity),
        unvaluedQuantity: round(unvaluedQuantity),
        valuationStatus,
      });
    } else if (event.eventType === 'rtv_09_return') {
      const original = saleAssignments.get(String(event.sourceOrderItemKey || ''));
      // A sale assignment produced in this rebuild is authoritative. The
      // event-level value is only a frozen-period fallback for a sale outside
      // the rebuild window; prioritising it used to re-import a stale prior-run
      // assignment and contaminate the new moving-average ledger.
      const unitCost = n(original?.unitCostSar) || n(event.unitCostSar);
      if (unitCost > 0) {
        eventCostSar = quantity * unitCost;
        if (state.quantity < 0) {
          const coversShortfall = Math.min(quantity, -state.quantity);
          const remaining = quantity - coversShortfall;
          state.quantity += quantity;
          state.value = remaining > 0 ? remaining * unitCost : 0;
          state.avg = state.quantity > 0 ? state.value / state.quantity : (state.avg || unitCost);
          valuedQuantity = remaining;
          unvaluedQuantity = coversShortfall;
          valuationStatus = remaining > 0 ? 'rtv_shortfall_covered_then_valued' : 'rtv_shortfall_covered';
        } else {
          state.quantity += quantity;
          state.value += eventCostSar;
          state.avg = state.quantity > 0 ? state.value / state.quantity : 0;
          valuedQuantity = quantity;
        }
      } else {
        state.quantity += quantity;
        unvaluedQuantity = quantity;
        valuationStatus = 'rtv_missing_original_cost';
      }
    } else {
      valuationStatus = 'unknown_event_type';
    }

    rows.push({
      eventKey: event.eventKey,
      matchKey,
      effectiveAt: event.effectiveAt,
      eventType: event.eventType,
      sourceTable: event.sourceTable || '',
      sourceKey: event.sourceKey || '',
      sourceOrderItemKey: event.sourceOrderItemKey || '',
      quantity: round(quantity),
      costAmountSar: round(eventCostSar),
      quantityBefore: round(before.quantity),
      valueBeforeSar: round(before.value),
      avgUnitCostBeforeSar: before.avg > 0 ? round(before.avg) : null,
      quantityAfter: round(state.quantity),
      valueAfterSar: round(state.value),
      avgUnitCostAfterSar: state.avg > 0 ? round(state.avg) : null,
      valuedQuantity: round(valuedQuantity),
      unvaluedQuantity: round(unvaluedQuantity),
      cogsSar: round(cogsSar),
      valuationStatus,
      ledgerVersion,
    });
  }
  return {rows, saleAssignments, endingStates: states};
}
