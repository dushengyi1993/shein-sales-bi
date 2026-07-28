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
  const saleRowsBySource = new Map();
  const shortfallQueues = new Map();
  const rows = [];

  for (const event of sortInventoryCostEvents(events)) {
    const matchKey = String(event.matchKey || '').trim();
    if (!matchKey) continue;
    let state = states.get(matchKey);
    if (!state) {
      const opening = openingStates.get(matchKey) || {};
      state = {quantity: n(opening.quantity), value: n(opening.value), avg: n(opening.avgUnitCost)};
      if (!state.avg && state.quantity > 0) state.avg = state.value / state.quantity;
      if (!state.avg && state.quantity < 0 && state.value < 0) state.avg = state.value / state.quantity;
      // Older ledger versions zeroed the carrying value as soon as inventory
      // became negative. Reconstruct the estimated negative balance at an
      // open-period boundary so a later receipt can settle it instead of
      // inflating the remaining positive inventory.
      if (state.quantity < 0 && state.value === 0 && state.avg > 0) {
        state.value = state.quantity * state.avg;
      }
      states.set(matchKey, state);
    }
    const before = {...state};
    let valuedQuantity = 0;
    let unvaluedQuantity = 0;
    let estimatedQuantity = 0;
    let settledEstimatedQuantity = 0;
    let estimationVarianceSar = 0;
    let cogsSar = 0;
    let eventCostSar = n(event.costAmountSar);
    let valuationStatus = 'valued';
    let valuationBasis = '';
    const quantity = Math.max(0, n(event.quantity));

    const queue = shortfallQueues.get(matchKey) || [];
    shortfallQueues.set(matchKey, queue);

    const consumeShortfall = (settleQuantity, actualUnitCost = null, {settleCost = true} = {}) => {
      let remaining = Math.max(0, n(settleQuantity));
      let variance = 0;
      let settledEstimated = 0;
      let settledUnvalued = 0;
      while (remaining > 0 && queue.length > 0) {
        const entry = queue[0];
        const consumed = Math.min(remaining, entry.remainingQuantity);
        if (consumed <= 0) {
          queue.shift();
          continue;
        }
        entry.remainingQuantity = round(entry.remainingQuantity - consumed);
        remaining = round(remaining - consumed);

        if (settleCost && n(actualUnitCost) > 0) {
          const assignment = saleAssignments.get(entry.sourceKey);
          const saleRow = saleRowsBySource.get(entry.sourceKey);
          const priorUnitCost = n(entry.estimatedUnitCostSar);
          const costDelta = consumed * (n(actualUnitCost) - priorUnitCost);
          variance += costDelta;
          if (assignment) {
            assignment.cogsSar = round(assignment.cogsSar + costDelta);
            assignment.estimationVarianceSar = round(n(assignment.estimationVarianceSar) + costDelta);
            if (entry.wasEstimated) {
              assignment.estimatedQuantity = round(Math.max(0, assignment.estimatedQuantity - consumed));
              assignment.settledEstimatedQuantity = round(n(assignment.settledEstimatedQuantity) + consumed);
              settledEstimated += consumed;
            } else {
              assignment.unvaluedQuantity = round(Math.max(0, assignment.unvaluedQuantity - consumed));
              assignment.valuedQuantity = round(assignment.valuedQuantity + consumed);
              settledUnvalued += consumed;
            }
            assignment.unitCostSar = assignment.valuedQuantity > 0
              ? round(assignment.cogsSar / assignment.valuedQuantity)
              : null;
            if (assignment.estimatedQuantity > 0) {
              assignment.valuationStatus = 'estimated_inventory_gap_partially_settled';
              assignment.valuationBasis = `${entry.valuationBasis || 'cost_estimate'}+partial_receipt_settlement`;
            } else if (assignment.unvaluedQuantity > 0) {
              assignment.valuationStatus = 'partially_unvalued_shortfall';
              assignment.valuationBasis = 'receipt_cost_partial_settlement';
            } else {
              assignment.valuationStatus = 'valued_after_inventory_gap_receipt';
              assignment.valuationBasis = 'receipt_cost_settlement';
            }
            if (saleRow) {
              saleRow.cogsSar = assignment.cogsSar;
              saleRow.valuedQuantity = assignment.valuedQuantity;
              saleRow.unvaluedQuantity = assignment.unvaluedQuantity;
              saleRow.estimatedQuantity = assignment.estimatedQuantity;
              saleRow.settledEstimatedQuantity = assignment.settledEstimatedQuantity;
              saleRow.estimationVarianceSar = assignment.estimationVarianceSar;
              saleRow.valuationStatus = assignment.valuationStatus;
              saleRow.valuationBasis = assignment.valuationBasis;
            }
          }
        }

        if (entry.remainingQuantity <= 0) queue.shift();
      }
      return {
        unmatchedQuantity: round(remaining),
        varianceSar: round(variance),
        settledEstimatedQuantity: round(settledEstimated),
        settledUnvaluedQuantity: round(settledUnvalued),
      };
    };

    if (event.eventType === 'opening') {
      state.quantity += quantity;
      state.value += eventCostSar;
      if (state.quantity > 0) state.avg = state.value / state.quantity;
      else if (!state.avg && quantity > 0) state.avg = eventCostSar / quantity;
      valuedQuantity = quantity;
      valuationBasis = 'approved_opening_cost';
    } else if (event.eventType === 'inventory_count_reset') {
      const resetUnitCost = quantity > 0 ? eventCostSar / quantity : (n(event.unitCostSar) || state.avg);
      state.quantity = quantity;
      state.value = eventCostSar;
      state.avg = resetUnitCost;
      // An approved physical count is a new quantity boundary. Old negative
      // inventory may remain visibly estimated on its original sale, but a
      // later receipt must not settle a deficit that the count superseded.
      queue.length = 0;
      valuedQuantity = quantity;
      valuationStatus = 'approved_inventory_count_reset';
      valuationBasis = 'approved_inventory_count_reset';
    } else if (event.eventType === 'receipt' || event.eventType === 'adjustment') {
      const unitCost = quantity > 0 ? eventCostSar / quantity : n(event.unitCostSar);
      if (state.quantity < 0) {
        const coversShortfall = Math.min(quantity, -state.quantity);
        const settlement = consumeShortfall(coversShortfall, unitCost);
        const implicitQuantity = settlement.unmatchedQuantity;
        const implicitUnitCost = n(state.avg);
        const implicitVariance = unitCost > 0 && implicitUnitCost > 0
          ? implicitQuantity * (unitCost - implicitUnitCost)
          : 0;
        estimationVarianceSar = settlement.varianceSar + implicitVariance;
        settledEstimatedQuantity = settlement.settledEstimatedQuantity;
        state.quantity += quantity;
        state.value += eventCostSar - estimationVarianceSar;
        if (Math.abs(state.value) < 1e-8) state.value = 0;
        const derivedAverage = state.quantity !== 0 ? state.value / state.quantity : 0;
        state.avg = derivedAverage > 0 ? derivedAverage : (unitCost || state.avg);
        valuedQuantity = quantity;
        unvaluedQuantity = 0;
        valuationStatus = state.quantity > 0 ? 'shortfall_settled_then_received' : 'shortfall_settled';
        valuationBasis = coversShortfall > 0 ? 'receipt_cost_settlement' : 'receipt_moving_average';
      } else {
        state.quantity += quantity;
        state.value += eventCostSar;
        if (state.quantity > 0) state.avg = state.value / state.quantity;
        else if (unitCost > 0) state.avg = unitCost;
        valuedQuantity = quantity;
        valuationBasis = 'receipt_moving_average';
      }
    } else if (event.eventType === 'sale') {
      const availableQuantity = Math.min(quantity, Math.max(0, state.quantity));
      const shortfallQuantity = Math.max(0, quantity - availableQuantity);
      const lastKnownUnitCost = n(state.avg);
      const evidenceUnitCost = n(event.estimatedUnitCostSar);
      const evidenceBasis = String(event.estimatedCostBasis || '').trim();
      const exactQuantity = lastKnownUnitCost > 0 ? availableQuantity : 0;
      const estimatedAvailableQuantity = lastKnownUnitCost <= 0 && evidenceUnitCost > 0
        ? availableQuantity
        : 0;
      const preferIncomingCost = evidenceUnitCost > 0
        && evidenceBasis === 'in_transit_weighted_as_of_sale';
      const shortfallUnitCost = preferIncomingCost
        ? evidenceUnitCost
        : (lastKnownUnitCost || evidenceUnitCost);
      const shortfallBasis = preferIncomingCost
        ? evidenceBasis
        : (lastKnownUnitCost > 0 ? 'last_moving_average_after_inventory_gap' : evidenceBasis);
      const estimatedShortfallQuantity = shortfallUnitCost > 0 ? shortfallQuantity : 0;
      estimatedQuantity = estimatedAvailableQuantity + estimatedShortfallQuantity;
      valuedQuantity = exactQuantity + estimatedQuantity;
      unvaluedQuantity = Math.max(0, quantity - valuedQuantity);
      cogsSar =
        exactQuantity * lastKnownUnitCost
        + estimatedAvailableQuantity * evidenceUnitCost
        + estimatedShortfallQuantity * shortfallUnitCost;

      if (estimatedQuantity > 0) {
        const basis = estimatedShortfallQuantity > 0 ? shortfallBasis : evidenceBasis;
        valuationBasis = basis || 'cost_estimate';
        if (basis === 'in_transit_weighted_as_of_sale') {
          valuationStatus = 'estimated_inventory_gap_in_transit_cost';
        } else if (basis === 'last_moving_average_after_inventory_gap') {
          valuationStatus = 'estimated_inventory_gap_last_moving_average';
        } else if (basis === 'past_arrived_weighted_as_of_sale') {
          valuationStatus = 'estimated_missing_opening_past_arrived_cost';
        } else if (basis === 'shipped_weighted_as_of_sale') {
          valuationStatus = 'estimated_missing_opening_shipped_cost';
        } else {
          valuationStatus = 'estimated_inventory_gap_cost';
        }
      } else if (unvaluedQuantity > 0) {
        valuationStatus = valuedQuantity > 0 ? 'partially_unvalued_shortfall' : 'missing_opening';
        valuationBasis = valuedQuantity > 0 ? 'moving_average_plus_missing_shortfall' : 'missing_cost_evidence';
      } else {
        valuationStatus = 'valued';
        valuationBasis = 'moving_average';
      }
      // Preserve the estimated carrying value while inventory is negative.
      // A later receipt settles the FIFO shortfall and transfers only the
      // actual-vs-estimated variance from inventory into the original sale.
      if (lastKnownUnitCost <= 0 && evidenceUnitCost > 0 && state.quantity > 0) {
        state.value = state.quantity * evidenceUnitCost;
        state.avg = evidenceUnitCost;
      }
      state.quantity -= quantity;
      state.value -= cogsSar;
      if (Math.abs(state.value) < 1e-8) state.value = 0;
      const derivedAverage = state.quantity !== 0 ? state.value / state.quantity : 0;
      state.avg = derivedAverage > 0
        ? derivedAverage
        : (lastKnownUnitCost || shortfallUnitCost || evidenceUnitCost || state.avg);
      const sourceKey = String(event.sourceKey || event.eventKey);
      const assignment = {
        cogsSar: round(cogsSar),
        unitCostSar: valuedQuantity > 0 ? round(cogsSar / valuedQuantity) : null,
        valuedQuantity: round(valuedQuantity),
        unvaluedQuantity: round(unvaluedQuantity),
        estimatedQuantity: round(estimatedQuantity),
        settledEstimatedQuantity: 0,
        estimationVarianceSar: 0,
        valuationStatus,
        valuationBasis,
      };
      saleAssignments.set(sourceKey, assignment);
      if (shortfallQuantity > 0) {
        queue.push({
          sourceKey,
          remainingQuantity: round(shortfallQuantity),
          estimatedUnitCostSar: round(shortfallUnitCost),
          wasEstimated: estimatedShortfallQuantity > 0,
          valuationBasis: shortfallBasis,
        });
      }
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
          const settlement = consumeShortfall(coversShortfall, unitCost);
          const implicitQuantity = settlement.unmatchedQuantity;
          const implicitUnitCost = n(state.avg);
          const implicitVariance = implicitUnitCost > 0
            ? implicitQuantity * (unitCost - implicitUnitCost)
            : 0;
          estimationVarianceSar = settlement.varianceSar + implicitVariance;
          settledEstimatedQuantity = settlement.settledEstimatedQuantity;
          state.quantity += quantity;
          state.value += eventCostSar - estimationVarianceSar;
          if (Math.abs(state.value) < 1e-8) state.value = 0;
          const derivedAverage = state.quantity !== 0 ? state.value / state.quantity : 0;
          state.avg = derivedAverage > 0 ? derivedAverage : (state.avg || unitCost);
          valuedQuantity = quantity;
          unvaluedQuantity = 0;
          valuationStatus = state.quantity > 0 ? 'rtv_shortfall_settled_then_valued' : 'rtv_shortfall_settled';
          valuationBasis = 'original_sale_cost_settlement';
        } else {
          state.quantity += quantity;
          state.value += eventCostSar;
          state.avg = state.quantity > 0 ? state.value / state.quantity : 0;
          valuedQuantity = quantity;
          valuationBasis = 'original_sale_cost';
        }
      } else {
        if (state.quantity < 0) {
          consumeShortfall(Math.min(quantity, -state.quantity), null, {settleCost: false});
        }
        state.quantity += quantity;
        unvaluedQuantity = quantity;
        valuationStatus = 'rtv_missing_original_cost';
        valuationBasis = 'missing_original_sale_cost';
      }
    } else {
      valuationStatus = 'unknown_event_type';
      valuationBasis = 'unknown';
    }

    const outputRow = {
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
      estimatedQuantity: round(estimatedQuantity),
      settledEstimatedQuantity: round(settledEstimatedQuantity),
      estimationVarianceSar: round(estimationVarianceSar),
      cogsSar: round(cogsSar),
      valuationStatus,
      valuationBasis,
      ledgerVersion,
    };
    rows.push(outputRow);
    if (event.eventType === 'sale') {
      saleRowsBySource.set(String(event.sourceKey || event.eventKey), outputRow);
    }
  }
  return {rows, saleAssignments, endingStates: states};
}
