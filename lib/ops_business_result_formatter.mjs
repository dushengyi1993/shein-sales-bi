/**
 * Pure Chinese business result formatter and hook helpers.
 *
 * Implements requirement F2:
 * 1. Fixed prose order:
 *    - 做了什么 (what ran)
 *    - 成功多少 (count succeeded)
 *    - 哪家店哪件商品没成 (exact store + product / goods SN failure)
 *    - 原因 (why)
 *    - 下一步是否需你处理 (next action / needs human attention)
 * 2. Old request dates are explicit (e.g. 8月17日提交的旧请求, not 以前).
 * 3. No unexplained technical machine jargon (fence, hash, marker, pending, tracebacks, lock names).
 * 4. Structured diagnostics retained in a separate details/diagnostics object, never leaking into main copy.
 * 5. Deterministic, pure functions suitable for unit tests and snapshots.
 *
 * Explicit rules:
 * - formatOpsBusinessResult({}) or unknown input with 0/empty values does NOT falsely report "已全部完成".
 * - If status === "failed" or ok === false without failedItems, reports execution failure cleanly.
 * - If status is unknown / unverified, preserves unknown status cleanly.
 * - Does NOT promise automatic retry unless explicitly specified in input.nextAction or input.retryPolicy.
 * - Distinguishes dated pending requests from non-dated pending requests; groups by actual date.
 * - Always prefers canonicalGoodsSn / canonical identifiers over fallback placeholders.
 */

const ROUTINE_INVENTORY_SKIPPED_STATES = new Set([
  'skipped_target_already_matched',
  'skipped_owner_confirmed_same_target_above_target',
  'skipped_safety_no_increase',
  'skipped_within_scarcity_band',
  'skipped_recovered',
  'skipped_terminal_readback_recorded',
]);

function isStrictFiniteNumber(val) {
  if (val === null || val === undefined || typeof val === 'boolean' || Array.isArray(val)) return false;
  if (typeof val === 'string' && val.trim().length === 0) return false;
  const num = Number(val);
  return Number.isFinite(num);
}

function formatGoodsIdentifier(item) {
  const store = item.store || item.storeKey || item.store_key || item.storeName || '';
  const goods = item.canonicalGoodsSn || item.canonical || item.goodsSn || item.productCode || item.skuCode || item.sku || item.item || item.id || item.standardGoodsSn || item.standard_goods_sn || item.skc || '';
  if (store && goods) return store + '（款号 ' + goods + '）';
  if (goods) return '款号 ' + goods;
  if (store) return store;
  return '未命名商品行';
}

function formatDateChinese(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})?-?(\d{1,2})-(\d{1,2})/);
  if (m) {
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    return month + '月' + day + '日';
  }
  return String(dateStr);
}

function formatTargetDifferenceText(targetVal, actualVal) {
  if (!isStrictFiniteNumber(actualVal)) return '';
  const actualNum = Number(actualVal);
  if (!isStrictFiniteNumber(targetVal)) {
    return '，实际可用 ' + actualNum;
  }
  const targetNum = Number(targetVal);
  if (actualNum > targetNum) {
    return '，实际可用 ' + actualNum + '（高于目标 ' + (actualNum - targetNum) + '）';
  } else if (actualNum < targetNum) {
    const diff = targetNum - actualNum;
    return '，实际可用 ' + actualNum + '（低于目标 ' + diff + '，差额 ' + diff + '）';
  } else {
    return '，实际可用 ' + actualNum + '（与目标一致）';
  }
}

function toHumanInventoryReason(raw) {
  if (!raw) return '原因未明';
  const str = String(raw).trim();
  if (/permanently fenced by manual resolution/i.test(str)) {
    return '命中人工解决规则隔离保护，已禁止重复写入';
  }
  if (/multiple durable inventory intents exist/i.test(str)) {
    return '发现多个未决持久化意图，已安全阻断';
  }
  if (/stock-query readback is not an authoritative/i.test(str)) {
    return '库存查询回读非权威有效数据，已禁止写入';
  }
  if (/historical durable inventory intent scope cannot be proven/i.test(str)) {
    return '历史持久化意图范围无法核验，已禁止重复提交';
  }
  if (/historical durable inventory intent remains pending/i.test(str)) {
    return '历史待对账意图仍在处理中，已禁止重复提交';
  }
  if (/durable inventory intent does not belong to the current immutable plan/i.test(str)) {
    return '意图与当前不可变计划不符，已禁止重复提交';
  }
  if (/durable pre-submit intent exists and exact target is not visible/i.test(str)) {
    return '已存在提交前意图且未见终态，已禁止重复提交';
  }
  if (/assertStillListed|shelf_state|not listed/i.test(str)) {
    return '商品已下架或非在售状态，已禁止写入';
  }
  if (/suspicious_write_attempted/i.test(str)) {
    return '检测到可疑写入尝试，已安全拦截';
  }
  if (/pre_submit_blocked|preSubmitExclusion/i.test(str)) {
    return '提交前安全拦截';
  }
  return str;
}

/**
 * Format a business execution result into concise, natural Chinese prose.
 *
 * @param {Object} input
 * @param {string} [input.action] - What ran
 * @param {string} [input.status] - "completed" | "partial" | "failed" | "blocked" | "pending" | "unknown"
 * @param {boolean} [input.ok] - High-level boolean success flag
 * @param {number} [input.succeededCount] - Number of succeeded items/actions
 * @param {number} [input.totalCount] - Optional total count
 * @param {Array<Object>} [input.failedItems] - List of failed items: { store, goodsSn, canonicalGoodsSn, reason, targetDifference, oldRequestDate }
 * @param {Array<Object>} [input.pendingItems] - List of pending/in-flight items: { store, goodsSn, canonicalGoodsSn, oldRequestDate, reason }
 * @param {string} [input.nextAction] - Explicit next step
 * @param {boolean} [input.needsHuman] - Whether human intervention is required
 * @param {Object} [input.diagnostics] - Raw diagnostics (kept separate)
 * @returns {{ copy: string, status: string, succeededCount: number, failedCount: number, pendingCount: number, totalCount: number, needsHuman: boolean, diagnostics: Object }}
 */
export function formatOpsBusinessResult(input = {}) {
  // Empty or non-object fails closed to unknown
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
    return {
      copy: '业务操作运行状态未知，当前无有效确认数据。需检查云端运行日志核验真实执行情况。',
      action: '业务操作',
      status: 'unknown',
      succeededCount: 0,
      failedCount: 0,
      pendingCount: 0,
      totalCount: 0,
      needsHuman: false,
      diagnostics: {},
    };
  }

  // 1. Pending discuss daily scan pattern: { mode: 'daily', rowCount, coverage, summary }
  const isPendingDiscussDaily = input.mode === 'daily' || (input.action && input.action.includes('待议价') && input.coverage !== undefined);
  if (isPendingDiscussDaily) {
    const action = input.action || '待议价每日巡检扫描';
    const rowCount = isStrictFiniteNumber(input.rowCount) ? Number(input.rowCount) : null;
    const coverage = input.coverage || {};
    const failedStores = Array.isArray(coverage.failedStores) ? coverage.failedStores : [];
    const missingStores = Array.isArray(coverage.missingStores) ? coverage.missingStores : [];
    const unexpectedStores = Array.isArray(coverage.unexpectedStores) ? coverage.unexpectedStores : [];
    const expectedCount = isStrictFiniteNumber(coverage.expectedCount) ? Number(coverage.expectedCount) : null;
    const scannedCount = isStrictFiniteNumber(coverage.succeededCount) ? Number(coverage.succeededCount) : null;
    const coverageIncomplete = failedStores.length > 0 || missingStores.length > 0 || unexpectedStores.length > 0
      || expectedCount === null || expectedCount <= 0 || scannedCount === null || scannedCount !== expectedCount;
    const summaryList = Array.isArray(input.summary) ? input.summary : [];

    if (input.ok === false || rowCount === null || coverageIncomplete) {
      const blockers = Array.isArray(input.blockers) ? input.blockers : [];
      const coverageReason = failedStores.length > 0
        ? '扫描失败店铺：' + failedStores.join('、')
        : (coverageIncomplete ? '店铺扫描覆盖不完整' : '店铺扫描异常');
      return {
        copy: action + '执行失败：部分店铺巡检异常，未生成完整结果（阻断项：' + (blockers.join('、') || coverageReason) + '）。当前未安排自动重试，请根据报错原因核对。',
        action,
        status: 'failed',
        succeededCount: 0,
        failedCount: failedStores.length || 1,
        pendingCount: 0,
        totalCount: expectedCount,
        needsHuman: true,
        diagnostics: input.diagnostics || { blockers, coverage },
      };
    }

    if (rowCount === 0) {
      return {
        copy: action + '已全部完成：检查结果为 0 项待议价商品。无需人工处理。',
        action,
        status: 'completed',
        succeededCount: 0,
        failedCount: 0,
        pendingCount: 0,
        totalCount: 0,
        needsHuman: false,
        diagnostics: input.diagnostics || { coverage },
      };
    }

    const summarySnippets = summaryList.slice(0, 5).map(s => {
      const name = s.supplierCode || s.standardGoodsSn || s.goodsSn || '商品';
      const storeStr = s.store ? ('店铺 ' + s.store + '，') : '';
      const countStr = s.count ? (s.count + ' 条') : '';
      return storeStr + name + ' ' + countStr;
    }).filter(Boolean);
    const pendingSummary = summarySnippets.length > 0 ? ('：' + summarySnippets.join('；')) : '';
    return {
      copy: action + '已全部完成：扫描到 ' + rowCount + ' 条待议价商品' + pendingSummary + '。需要你人工确认后继续处理。',
      action,
      status: 'completed',
      succeededCount: rowCount,
      failedCount: 0,
      pendingCount: rowCount,
      totalCount: rowCount,
      needsHuman: true,
      diagnostics: input.diagnostics || { coverage, summaryCount: summaryList.length },
    };
  }

  // 3. Real daily inventory replenishment result pattern:
  const isDailyInventoryResult = input.schemaVersion === 'daily-inventory-replenishment-result/v1'
    || (Array.isArray(input.results) && input.counts && (input.counts.updated !== undefined || input.counts.blocked !== undefined));
  if (isDailyInventoryResult) {
    const action = input.action || '每日虚拟库存补货执行';
    const rawResults = Array.isArray(input.results) ? input.results : [];
    const counts = input.counts || {};

    const updatedRows = rawResults.filter(r => r.state === 'updated_readback_matched');
    const allSkippedRows = rawResults.filter(r => typeof r.state === 'string' && r.state.startsWith('skipped_'));
    const routineSkippedRows = allSkippedRows.filter(r => ROUTINE_INVENTORY_SKIPPED_STATES.has(r.state) && !r.deferred);
    const nonRoutineSkippedRows = rawResults.filter(r => (
      (typeof r.state === 'string' && r.state.startsWith('skipped_') && !ROUTINE_INVENTORY_SKIPPED_STATES.has(r.state))
      || r.state === 'historical_readback_matched'
      || r.state === 'skipped_historical_target_differs'
      || r.deferred === true
    ));
    const preSubmitBlockedRows = rawResults.filter(r => r.state === 'pre_submit_blocked');
    const readbackPendingRows = rawResults.filter(r => r.state === 'submitted_but_readback_pending');
    const dryRunReadyRows = rawResults.filter(r => r.state === 'dry_run_ready');
    const plannedRows = rawResults.filter(r => r.state === 'planned');

    const knownStates = new Set([
      'updated_readback_matched',
      'pre_submit_blocked',
      'submitted_but_readback_pending',
      'dry_run_ready',
      'planned',
      'historical_readback_matched',
      'skipped_historical_target_differs',
      'blocked', 'blocked_by_manual_resolution_fence', 'needs_manual_resolve',
      'suspicious_write_attempted', 'submitted_readback_failed',
      ...ROUTINE_INVENTORY_SKIPPED_STATES,
    ]);
    // Any unrecognized / unknown state fails closed to unsafeBlockedRows
    const unsafeBlockedRows = rawResults.filter(r => (
      !r.state
      || (!knownStates.has(r.state) && !String(r.state).startsWith('skipped_'))
      || [
        'blocked', 'blocked_by_manual_resolution_fence', 'needs_manual_resolve',
        'suspicious_write_attempted', 'submitted_readback_failed'
      ].includes(r.state)
    ));

    const succeededCount = updatedRows.length;
    const pendingCount = readbackPendingRows.length;
    const dryRunCount = dryRunReadyRows.length || counts.dryRunReady || 0;
    const failedCount = rawResults.length > 0
      ? (unsafeBlockedRows.length + preSubmitBlockedRows.length)
      : (counts.blocked || 0);
    const deferredHistoricalCount = (counts.deferredHistorical && counts.deferredHistorical > 0)
      ? counts.deferredHistorical
      : (Array.isArray(input.deferredHistorical) ? input.deferredHistorical.length : 0);

    const isPreviewOnly = input.ok !== false
      && (input.execute === false || dryRunCount > 0)
      && succeededCount === 0
      && failedCount === 0
      && pendingCount === 0
      && plannedRows.length === 0
      && nonRoutineSkippedRows.length === 0
      && deferredHistoricalCount === 0;
    const totalCount = rawResults.length || counts.total || (succeededCount + pendingCount + failedCount + allSkippedRows.length + dryRunCount + plannedRows.length);

    if (rawResults.length === 0) {
      const hasPositiveCounts = Object.values(counts).some(v => isStrictFiniteNumber(v) && Number(v) > 0);
      if (hasPositiveCounts) {
        // Positive counts without results rows means evidence is missing!
        const status = input.ok === false ? 'failed' : 'partial';
        const missingSummary = Object.entries(counts).filter(([k, v]) => Number(v) > 0).map(([k, v]) => k + ' ' + v).join('，');
        const prose = action + '执行结果明细缺失：汇总计数显示存在项目（' + missingSummary + '），但未获取到具体商品明细记录。需要你人工确认后继续处理。';
        return {
          copy: prose,
          action,
          status,
          succeededCount: 0,
          failedCount: counts.blocked || 1,
          pendingCount: 0,
          totalCount: counts.total || 0,
          needsHuman: true,
          diagnostics: input.diagnostics || { counts },
        };
      }
      const verifiedEmpty = Array.isArray(input.results) && input.ok !== false
        && isStrictFiniteNumber(counts.total) && Number(counts.total) === 0
        && Object.values(counts).every(value => isStrictFiniteNumber(value) && Number(value) === 0)
        && deferredHistoricalCount === 0;
      if (verifiedEmpty) {
        // Only an explicit empty result with consistent zero counts proves no work was needed.
        const prose = action + '已全部完成：检查结果为 0 项需要补货。无需人工处理。';
        return {
          copy: prose,
          action,
          status: 'completed',
          succeededCount: 0,
          failedCount: 0,
          pendingCount: 0,
          totalCount: 0,
          needsHuman: false,
          diagnostics: input.diagnostics || { counts },
        };
      }
      return {
        copy: action + '：' + (input.ok === false
          ? '执行失败：上游执行未通过，当前无完整有效结果。需核对原始执行结果与云端日志。'
          : '结果无法确认：结果明细或汇总计数缺失、无效或相互矛盾。需核对原始执行结果与云端日志。'),
        action,
        status: input.ok === false ? 'failed' : 'unknown',
        succeededCount: null,
        failedCount: input.ok === false ? 1 : null,
        pendingCount: null,
        totalCount: isStrictFiniteNumber(counts.total) && Number(counts.total) >= 0 ? Number(counts.total) : null,
        needsHuman: true,
        diagnostics: input.diagnostics || { counts },
      };
    }

    let status = 'completed';
    if (isPreviewOnly) {
      // Dry run preview is not execution complete
      status = 'partial';
    } else if (input.ok === false || failedCount > 0) {
      status = succeededCount > 0 ? 'partial' : 'failed';
    } else if (pendingCount > 0 || nonRoutineSkippedRows.length > 0 || deferredHistoricalCount > 0 || plannedRows.length > 0) {
      status = 'partial';
    }

    const diagnosticItems = rawResults.map(r => ({
      storeKey: r.storeKey || r.store || '',
      canonical: r.canonical || r.canonicalGoodsSn || r.goodsSn || '',
      state: r.state || '',
      ...(r.error ? { error: r.error } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.warning ? { warning: r.warning } : {}),
    }));
    const defaultDiagnostics = { counts, items: diagnosticItems };

    let prose = '';
    if (isPreviewOnly) {
      prose = action + '计划预览已就绪（未执行实际写入）：共规划就绪 ' + dryRunCount + ' 条';
      if (routineSkippedRows.length > 0) {
        prose += '，条件已满足跳过 ' + routineSkippedRows.length + ' 条';
      }
      prose += '。仅完成预览，尚未执行。';
      return {
        copy: prose,
        action,
        status,
        succeededCount: 0,
        failedCount: 0,
        pendingCount: 0,
        totalCount,
        needsHuman: false,
        diagnostics: input.diagnostics || { counts },
      };
    }

    prose = action + (status === 'completed' ? '已全部完成：' : (status === 'partial' ? '已部分完成：' : '执行遇到阻断：'));
    prose += '成功更新并回读核对 ' + succeededCount + ' 条';
    if (routineSkippedRows.length > 0) {
      prose += '，条件已满足跳过 ' + routineSkippedRows.length + ' 条';
    }

    // Detail planned items (planned cannot be claimed as terminal)
    if (plannedRows.length > 0) {
      prose += '；另有 ' + plannedRows.length + ' 条仍处于计划待执行状态未达终态';
    }

    // Detail non-routine skipped items (such as historical target differs or deferred)
    if (nonRoutineSkippedRows.length > 0) {
      const diffDetails = nonRoutineSkippedRows.slice(0, 5).map(row => {
        const id = formatGoodsIdentifier(row);
        let diffStr = '';
        if (row.after !== undefined) {
          if (isStrictFiniteNumber(row.after?.totalUsableInventory)) {
            diffStr = formatTargetDifferenceText(row.targetUsableInventory, row.after.totalUsableInventory);
          } else {
            diffStr = '，实际可用未知（回读未获取有效数据）';
          }
        } else if (row.readback !== undefined) {
          if (isStrictFiniteNumber(row.readback?.totalUsableInventory)) {
            diffStr = formatTargetDifferenceText(row.targetUsableInventory, row.readback.totalUsableInventory);
          } else {
            diffStr = '，实际可用未知（回读未获取有效数据）';
          }
        } else if (row.before !== undefined && isStrictFiniteNumber(row.before?.totalUsableInventory)) {
          diffStr = formatTargetDifferenceText(row.targetUsableInventory, row.before.totalUsableInventory);
        } else if (isStrictFiniteNumber(row.currentLiveUsableInventory)) {
          diffStr = formatTargetDifferenceText(row.targetUsableInventory, row.currentLiveUsableInventory);
        }

        const reason = toHumanInventoryReason(row.error || row.reason || row.warning || (row.state === 'historical_readback_matched' ? '历史目标匹配但与当前计划目标不同已受控顺延' : (row.state ? ('状态 ' + row.state) : '受控顺延')));
        return id + diffStr + '：' + reason;
      });
      prose += '；目标不同或受控顺延 ' + nonRoutineSkippedRows.length + ' 条（' + diffDetails.join('；') + '）';
    }

    if (deferredHistoricalCount > 0) {
      prose += '；另有 ' + deferredHistoricalCount + ' 条历史未决请求不在当前计划内已受控顺延';
    }

    // Detail failed/blocked items
    if (unsafeBlockedRows.length > 0) {
      const failDetails = unsafeBlockedRows.map(row => {
        const id = formatGoodsIdentifier(row);
        const reason = toHumanInventoryReason(row.error || row.reason || (row.state ? ('状态 ' + row.state) : '未知异常阻断'));
        return id + '：' + reason;
      });
      prose += '；异常阻断 ' + unsafeBlockedRows.length + ' 条（' + failDetails.join('；') + '）';
    }

    // Detail pre-submit blocked items (separated from execution errors)
    if (preSubmitBlockedRows.length > 0) {
      const preDetails = preSubmitBlockedRows.slice(0, 5).map(row => {
        const id = formatGoodsIdentifier(row);
        const reason = toHumanInventoryReason(row.error || row.preSubmitExclusion?.reason || '提交前校验阻断');
        return id + '：' + reason;
      });
      prose += '；提交前安全拦截 ' + preSubmitBlockedRows.length + ' 条（' + preDetails.join('；') + '）';
    }

    // Detail submitted but readback pending items
    if (readbackPendingRows.length > 0) {
      const pendingDetails = readbackPendingRows.map(row => {
        const id = formatGoodsIdentifier(row);
        let dateStr = '';
        const pendingDate = row.historicalRunDate || row.oldRequestDate || row.runDate;
        if (pendingDate) {
          dateStr = '（' + formatDateChinese(pendingDate) + '提交的待对账请求）';
        }

        // Check live usable inventory strictly:
        // If after exists on row, use after.totalUsableInventory; if null/invalid, do NOT fallback to before!
        // Only if after is undefined and before exists (pure recovery observation), use before!
        let liveInventory = null;
        let liveInventoryUnknown = false;
        if (row.after !== undefined) {
          if (isStrictFiniteNumber(row.after?.totalUsableInventory)) {
            liveInventory = Number(row.after.totalUsableInventory);
          } else {
            liveInventoryUnknown = true;
          }
        } else if (row.readback !== undefined) {
          if (isStrictFiniteNumber(row.readback?.totalUsableInventory)) {
            liveInventory = Number(row.readback.totalUsableInventory);
          } else {
            liveInventoryUnknown = true;
          }
        } else if (row.before !== undefined) {
          if (isStrictFiniteNumber(row.before?.totalUsableInventory)) {
            liveInventory = Number(row.before.totalUsableInventory);
          }
        } else if (isStrictFiniteNumber(row.currentLiveUsableInventory)) {
          liveInventory = Number(row.currentLiveUsableInventory);
        }

        let diffStr = '';
        if (liveInventoryUnknown) {
          diffStr = '，实际可用未知（回读未获取有效数据）';
        } else if (liveInventory !== null) {
          // Check historicalTarget vs current plan target
          const hasHistoricalTarget = isStrictFiniteNumber(row.historicalTargetUsableInventory);
          const hasCurrentTarget = isStrictFiniteNumber(row.targetUsableInventory);
          if (hasHistoricalTarget && hasCurrentTarget && Number(row.historicalTargetUsableInventory) !== Number(row.targetUsableInventory)) {
            const histTarget = Number(row.historicalTargetUsableInventory);
            const currTarget = Number(row.targetUsableInventory);
            const histDiff = histTarget - liveInventory;
            const diffDesc = histDiff > 0 ? ('旧请求目标 ' + histTarget + ' 还差 ' + histDiff) : ('高于旧目标 ' + Math.abs(histDiff));
            diffStr = '，实际可用 ' + liveInventory + '（' + diffDesc + '，本次目标 ' + currTarget + '）';
          } else {
            const targetVal = hasHistoricalTarget ? row.historicalTargetUsableInventory : (hasCurrentTarget ? row.targetUsableInventory : (row.approvedTarget ?? null));
            diffStr = formatTargetDifferenceText(targetVal, liveInventory);
          }
        }

        let occStr = '';
        // Only display occupancyChange if authentic non-null object exists; do NOT fake or zero-pad missing fields
        if (row.occupancyChange && typeof row.occupancyChange === 'object') {
          const parts = [];
          if (row.occupancyChange.ordinary !== undefined && row.occupancyChange.ordinary !== null) {
            parts.push('普通 ' + row.occupancyChange.ordinary);
          }
          if (row.occupancyChange.temporary !== undefined && row.occupancyChange.temporary !== null) {
            parts.push('临时 ' + row.occupancyChange.temporary);
          }
          if (parts.length > 0) occStr = '，占用变动[' + parts.join('，') + ']';
        }
        return id + dateStr + diffStr + occStr;
      });
      prose += '；另有 ' + readbackPendingRows.length + ' 条已提交但回读未匹配待人工或下一轮核验（' + pendingDetails.join('；') + '），无需重复提交';
    }

    const needsHuman = Boolean(input.needsHuman)
      || input.ok === false
      || failedCount > 0
      || pendingCount > 0
      || nonRoutineSkippedRows.length > 0
      || deferredHistoricalCount > 0
      || plannedRows.length > 0;

    if (needsHuman) {
      if (input.ok === false && failedCount === 0 && pendingCount === 0 && nonRoutineSkippedRows.length === 0 && deferredHistoricalCount === 0 && plannedRows.length === 0) {
        prose += '。上游执行未完全通过，需要你人工确认后继续处理。';
      } else {
        prose += '。存在需人工确认或核验项，系统未安排自动重试，请根据明细核对。';
      }
    } else {
      prose += '。无需人工处理。';
    }

    return {
      copy: prose,
      action,
      status,
      succeededCount,
      failedCount,
      pendingCount,
      totalCount,
      needsHuman,
      diagnostics: input.diagnostics || defaultDiagnostics,
    };
  }

  // 4. Real marketing 3-runner execution result pattern:
  const isMarketingBatchResult = Boolean(input.totals && typeof input.totals === 'object' && (
    input.totals.storesProcessed !== undefined || input.totals.storesOk !== undefined || input.totals.restored !== undefined || input.totals.alreadyCovered !== undefined || input.totals.targetSkcs !== undefined
  ));
  if (isMarketingBatchResult) {
    const action = input.action || '营销活动与限时折扣批次处理';
    const totals = input.totals || {};
    const rawResults = Array.isArray(input.results) ? input.results : [];

    const succeededCount = (totals.storesOk !== undefined ? totals.storesOk : (totals.restored || 0) + (totals.alreadyCovered || 0));
    const failedCount = (totals.storesFailed !== undefined ? totals.storesFailed : totals.blocked || 0);
    const blockedCount = totals.storesBlocked || totals.terminalBlocked || 0;
    const deferredCount = totals.deadlineDeferred || totals.recoverableDeferred || (input.deferredGroups || []).length || 0;
    const totalCount = totals.storesProcessed || totals.processed || rawResults.length || (succeededCount + failedCount + blockedCount + deferredCount);

    let status = 'completed';
    if (failedCount > 0) {
      status = succeededCount > 0 ? 'partial' : 'failed';
    } else if (input.ok === false || blockedCount > 0 || deferredCount > 0) {
      status = 'partial';
    }

    let prose = action + (status === 'completed' ? '已全部完成：' : (status === 'partial' ? '已部分完成：' : '执行失败：'));
    prose += '成功处理 ' + succeededCount + ' 项';
    if (totals.targetSkcs !== undefined) {
      prose += '（覆盖 ' + (totals.targetSkcs || 0) + ' 个目标SKC，新增/保留 ' + (totals.createdSkcs || 0) + ' 个，移除 ' + (totals.removedSkcs || 0) + ' 个）';
    }
    if (failedCount > 0) {
      prose += '，失败 ' + failedCount + ' 项';
      const failedItems = rawResults.filter(r => r.ok === false || r.status === 'failed' || r.status === 'error');
      if (failedItems.length > 0) {
        const details = failedItems.slice(0, 5).map(r => {
          const id = formatGoodsIdentifier(r);
          const reason = r.reason || r.error || (r.classification === 'submitted_without_exact_readback' ? '已提交但未获取终态回读' : '活动写入未完成');
          return id + '：' + reason;
        });
        prose += '（' + details.join('；') + '）';
      }
    }
    if (blockedCount > 0) {
      prose += '，受控阻断 ' + blockedCount + ' 项';
      const blockedItems = rawResults.filter(r => r.terminalBlocked === true || r.status === 'blocked' || r.classification === 'terminal_drift_business_block');
      if (blockedItems.length > 0) {
        const details = blockedItems.slice(0, 5).map(r => {
          const id = formatGoodsIdentifier(r);
          const reason = r.reason || r.error || '命中业务价格或底线保护规则';
          return id + '：' + reason;
        });
        prose += '（' + details.join('；') + '）';
      }
    }
    if (deferredCount > 0) {
      prose += '，因窗口截止等顺延 ' + deferredCount + ' 项无需重复提交';
    }

    const needsHuman = Boolean(input.needsHuman) || input.ok === false || failedCount > 0 || blockedCount > 0;
    if (needsHuman) {
      if (input.ok === false && failedCount === 0 && blockedCount === 0) {
        prose += '。上游执行未完全通过，需要你人工确认后继续处理。';
      } else {
        prose += '。需要你人工确认后继续处理。';
      }
    } else {
      prose += '。无需人工处理。';
    }

    return {
      copy: prose,
      action,
      status,
      succeededCount,
      failedCount,
      pendingCount: deferredCount,
      totalCount,
      needsHuman,
      diagnostics: input.diagnostics || { totals },
    };
  }

  // 2. Retire candidates report pattern: { counts: { candidateRows, inputRows, ... }, summary }
  const isRetireCandidateReport = (input.counts && typeof input.counts === 'object' && input.counts.candidateRows !== undefined)
    || (input.action && input.action.includes('退链候选'));
  if (isRetireCandidateReport) {
    const action = input.action || '待下架链接候选报告筛选';
    const counts = input.counts || {};
    const candidateRows = Number.isFinite(Number(counts.candidateRows)) ? Number(counts.candidateRows) : 0;
    const inputRows = Number.isFinite(Number(counts.inputRows)) ? Number(counts.inputRows) : 0;
    const cannotJudgeRows = Number.isFinite(Number(counts.cannotJudgeRows)) ? Number(counts.cannotJudgeRows) : 0;
    const excluded15d = (counts.excludedByFirstShelf15d || 0) + (counts.excludedByRecentRecovery15d || 0);

    if (input.ok === false) {
      return {
        copy: action + '执行失败。当前未安排自动重试，请根据报错原因核对。',
        action,
        status: 'failed',
        succeededCount: 0,
        failedCount: 1,
        pendingCount: 0,
        totalCount: inputRows,
        needsHuman: true,
        diagnostics: input.diagnostics || { counts },
      };
    }

    let prose = action + '已全部完成：共分析 ' + inputRows + ' 条链接，筛选出 ' + candidateRows + ' 条建议下架候选商品';
    if (excluded15d > 0) {
      prose += '（另有 ' + excluded15d + ' 条处于15天安全保护期已受控排除）';
    }
    if (cannotJudgeRows > 0) {
      prose += '，另有 ' + cannotJudgeRows + ' 条因证据不足待确认';
    }
    prose += '。仅供人工核验确认，系统未执行下架写入，需要你人工确认后继续处理。';

    return {
      copy: prose,
      action,
      status: 'completed',
      succeededCount: candidateRows,
      failedCount: 0,
      pendingCount: candidateRows + cannotJudgeRows,
      totalCount: inputRows,
      needsHuman: true,
      diagnostics: input.diagnostics || { counts },
    };
  }
  const action = String(input.action || '').trim() || '业务操作';
  const hasStatus = typeof input.status === 'string' && input.status.trim().length > 0;
  const rawStatus = hasStatus ? input.status.trim().toLowerCase() : '';
  const hasOk = typeof input.ok === 'boolean';
  const succeededCount = Number.isFinite(Number(input.succeededCount)) ? Number(input.succeededCount) : 0;
  const failedItems = Array.isArray(input.failedItems) ? input.failedItems : [];
  const pendingItems = Array.isArray(input.pendingItems) ? input.pendingItems : [];
  const explicitTotal = Number.isFinite(Number(input.totalCount)) ? Number(input.totalCount) : null;
  const totalCount = explicitTotal !== null ? explicitTotal : (succeededCount + failedItems.length + pendingItems.length);

  // Derive normalized status without false-success trap
  let status = 'unknown';
  if (rawStatus === 'unknown' || rawStatus === 'stale' || rawStatus === 'unverified') {
    status = rawStatus;
  } else if (rawStatus === 'completed' || rawStatus === 'ok') {
    status = (failedItems.length === 0 && pendingItems.length === 0 && (succeededCount > 0 || explicitTotal === 0)) ? 'completed' : (succeededCount > 0 ? 'partial' : 'failed');
  } else if (rawStatus === 'partial') {
    status = 'partial';
  } else if (rawStatus === 'failed' || rawStatus === 'error') {
    status = 'failed';
  } else if (rawStatus === 'blocked') {
    status = 'blocked';
  } else if (rawStatus === 'pending') {
    status = 'pending';
  } else if (hasOk) {
    if (input.ok) {
      status = (failedItems.length === 0 && pendingItems.length === 0 && (succeededCount > 0 || explicitTotal === 0)) ? 'completed' : (succeededCount > 0 ? 'partial' : 'failed');
    } else {
      status = (succeededCount > 0 && (failedItems.length > 0 || pendingItems.length > 0)) ? 'partial' : 'failed';
    }
  } else if (!hasStatus && !hasOk && Object.keys(input).length === 0) {
    status = 'unknown';
  } else if (failedItems.length === 0 && pendingItems.length === 0 && succeededCount > 0) {
    status = 'completed';
  } else if (succeededCount > 0) {
    status = 'partial';
  } else if (failedItems.length > 0) {
    status = 'failed';
  }

  const sentences = [];

  // 1. 做了什么 + 成功多少
  if (status === 'unknown') {
    sentences.push(action + '运行状态未知，当前无有效确认数据');
  } else if (status === 'stale') {
    sentences.push(action + '状态已过期，数据时效性未通过核验');
  } else if (status === 'unverified') {
    sentences.push(action + '状态未核验，当前证据不完整');
  } else if (status === 'completed') {
    if (succeededCount === 0 && explicitTotal === 0) {
      sentences.push(action + '已全部完成：检查结果为 0 项需要处理');
    } else {
      sentences.push(action + '已全部完成：成功处理 ' + succeededCount + ' 条');
    }
  } else if (status === 'partial') {
    sentences.push(action + '已部分完成：已成功处理 ' + succeededCount + ' 条');
  } else if (status === 'blocked') {
    sentences.push(action + '被业务条件阻断' + (succeededCount > 0 ? '（已处理 ' + succeededCount + ' 条）' : ''));
  } else if (status === 'pending') {
    sentences.push(action + '正在处理中' + (succeededCount > 0 ? '，已完成 ' + succeededCount + ' 条' : ''));
  } else {
    sentences.push(action + '执行未完成或失败' + (succeededCount > 0 ? '：已处理 ' + succeededCount + ' 条' : '：当前未有成功处理项'));
  }

  // 2. 哪家店哪件商品没成 + 原因
  if (failedItems.length > 0) {
    const failDetails = failedItems.map(item => {
      const id = formatGoodsIdentifier(item);
      let diff = '';
      if (item.targetDifference !== undefined && item.targetDifference !== null) {
        if (isStrictFiniteNumber(item.targetDifference)) {
          const num = Number(item.targetDifference);
          if (num < 0) diff = '高于目标 ' + Math.abs(num);
          else if (num > 0) diff = '低于目标 ' + num;
          else diff = '与目标一致';
        } else {
          diff = String(item.targetDifference);
        }
      }
      const dateNotice = item.oldRequestDate ? ('（' + formatDateChinese(item.oldRequestDate) + '提交的旧请求）') : '';
      const reason = toHumanInventoryReason(item.reason || item.error || '原因未明');
      const parts = [id, dateNotice, diff, reason].filter(Boolean);
      return parts.join('：');
    });
    sentences.push('未完成 ' + failedItems.length + ' 条：' + failDetails.join('；'));
  }

  // 3. 旧请求 / 进行中项目：严格按实际日期与无日期独立分组
  if (pendingItems.length > 0) {
    const datedGroups = new Map();
    const undatedItems = [];
    for (const item of pendingItems) {
      if (item.oldRequestDate) {
        const d = formatDateChinese(item.oldRequestDate);
        if (!datedGroups.has(d)) datedGroups.set(d, []);
        datedGroups.get(d).push(item);
      } else {
        undatedItems.push(item);
      }
    }

    if (datedGroups.size > 0) {
      const groupSummaries = [];
      for (const [dateLabel, group] of datedGroups.entries()) {
        groupSummaries.push(group.length + ' 条为 ' + dateLabel + ' 提交的旧请求');
      }
      sentences.push('另有 ' + groupSummaries.join('、') + '，正在逐条核对，无需重复提交');
    }
    if (undatedItems.length > 0) {
      sentences.push('另有 ' + undatedItems.length + ' 条请求处于处理中状态，无需重复发送');
    }
  }

  // 4. 下一步与是否需要你处理（杜绝未经策略承诺的默认自动重试）
  const needsHuman = Boolean(input.needsHuman)
    || input.ok === false
    || status === 'partial'
    || status === 'failed'
    || status === 'stale'
    || status === 'unverified'
    || (status === 'unknown' && (succeededCount > 0 || explicitTotal > 0));

  if (input.nextAction) {
    sentences.push(input.nextAction);
  } else if (status === 'unknown') {
    sentences.push('需检查云端运行日志核验真实执行情况');
  } else if (status === 'stale') {
    sentences.push('快照已过期失效，需要你重新核实后继续处理');
  } else if (status === 'unverified') {
    sentences.push('证据缺失未通过核验，需要你人工确认后继续处理');
  } else if (input.ok === false) {
    sentences.push('上游执行未完全通过，需要你人工确认后继续处理');
  } else if (input.needsHuman || needsHuman) {
    if (status === 'completed' && !input.ok && hasOk) {
      sentences.push('上游状态未就绪，需要你人工确认');
    } else if (status === 'completed') {
      sentences.push('无需人工处理');
    } else {
      sentences.push('需要你人工确认后继续处理');
    }
  } else if (status === 'completed') {
    sentences.push('无需人工处理');
  } else if (status === 'blocked') {
    sentences.push('当前处于受控阻断状态，需待对应库存或平台条件就绪');
  } else {
    sentences.push('当前未安排自动重试，请根据报错原因核对');
  }

  const copy = sentences.join('。') + '。';

  return {
    copy,
    action,
    status,
    succeededCount,
    failedCount: failedItems.length,
    pendingCount: pendingItems.length,
    totalCount,
    needsHuman: Boolean(input.needsHuman) || (input.ok === false) || (status !== 'completed' && (status !== 'unknown' || succeededCount > 0 || explicitTotal > 0)),
    diagnostics: input.diagnostics || {},
  };
}

export function buildBusinessResultSnapshot(input) {
  const result = formatOpsBusinessResult(input);
  return {
    copy: result.copy,
    status: result.status,
    succeededCount: result.succeededCount,
    failedCount: result.failedCount,
    pendingCount: result.pendingCount,
    needsHuman: result.needsHuman,
  };
}
