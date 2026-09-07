import crypto from 'node:crypto';

export const STORES = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
export const EVIDENCE_SCHEMA_VERSION = 'link-retire-evidence/v1';
export const EVIDENCE_HOST = 'shein-bi-tencent';
export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const keyOf = row => `${row.store_key || row.store}::${row.skc}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_TIMESTAMP_RE = /(?:Z|[+-]\d\d:\d\d)$/;
const addUnique = (list, value) => { if (!list.includes(value)) list.push(value); };
const num = value => value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export function validDate(value) {
  if (!DATE_RE.test(value || '') || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw new Error('invalid date');
  return value;
}

export const shiftDate = (date, days) => new Date(Date.parse(`${validDate(date)}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);

// Timezone-less warehouse timestamps are explicitly Asia/Shanghai; zoned
// timestamps are normalized to that same business day. Validate the calendar
// before Date.parse, which otherwise normalizes impossible days.
export function evidenceDay(value) {
  const text = String(value ?? '').trim();
  if (DATE_RE.test(text)) {
    try { return validDate(text); } catch { return null; }
  }
  const timestamp=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!timestamp || Number(timestamp[2])>23 || Number(timestamp[3])>59 || Number(timestamp[4])>59) return null;
  try { validDate(timestamp[1]); } catch { return null; }
  if (!ZONED_TIMESTAMP_RE.test(text)) return timestamp[1];
  const instant = Date.parse(text);
  if (!Number.isFinite(instant)) return null;
  return new Date(instant + 8 * 3600000).toISOString().slice(0,10);
}

function validGeneratedAt(value, runDate) {
  const text = String(value ?? '').trim();
  if (!ZONED_TIMESTAMP_RE.test(text) || !Number.isFinite(Date.parse(text)) || evidenceDay(text) !== runDate) {
    throw new Error('invalid evidence generatedAt');
  }
  const todayAtChina = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
  if (runDate > todayAtChina) throw new Error('future evidence runDate');
  return Date.parse(text);
}

function exactKeyCoverage(rows, expectedRows) {
  if (!Array.isArray(rows) || !Array.isArray(expectedRows)) return false;
  const actual = rows.map(keyOf);
  const expected = expectedRows.map(keyOf);
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every(key => expectedSet.has(key));
}

export function validateSavedQuery(bytes, manifest) {
  const artifact = manifest.artifacts?.find(item => item.role === 'query_evidence');
  if (manifest.run?.outcome !== 'succeeded' || manifest.run?.coverage?.issueCount !== 0 || !artifact || artifact.sha256 !== sha(bytes) || artifact.bytes !== bytes.length) throw new Error('query manifest/hash/coverage mismatch');
  for (const section of ['linksData','productState']) if (!manifest.run.coverage.loadedSections.includes(section)) throw new Error(`missing section ${section}`);
  const query = JSON.parse(bytes);
  if (query.ok !== true || query.aiInvoked !== false || query.mode !== 'direct-bi-data' || !Array.isArray(query.data?.storeLinks)) throw new Error('invalid direct query');
  const stores = [...new Set(query.data.storeLinks.map(row => row.store_key))].sort();
  if (JSON.stringify(stores) !== JSON.stringify(STORES)) throw new Error('storeLinks coverage mismatch');
  if (new Set(query.data.storeLinks.map(keyOf)).size !== query.data.storeLinks.length) throw new Error('duplicate query key');
  return query;
}

function potentialWeakLink(row) {
  if (row.is_on_shelf !== true) return false;
  const exposure = num(row.c7_eps_uv);
  const sales = num(row.c7_sale_cnt);
  if (exposure !== null && exposure > 300) return false;
  if (sales !== null && sales !== 0) return false;
  return true;
}

export function missingMetricReviewRows(query) {
  if (!Array.isArray(query?.data?.storeLinks)) throw new Error('invalid direct query rows');
  return query.data.storeLinks
    .filter(row => potentialWeakLink(row) && (num(row.c7_eps_uv) === null || num(row.c7_sale_cnt) === null))
    .map(row => {
      const issues = [];
      const exposure = num(row.c7_eps_uv);
      const sales = num(row.c7_sale_cnt);
      if (exposure === null) issues.push('missing_c7_exposure');
      if (sales === null) issues.push('missing_c7_sales');
      return {
        store: row.store_key,
        skc: row.skc,
        spu: row.spu,
        standard_goods_sn: row.standard_goods_sn,
        current_status: row.shelf_status_name || null,
        c7_exposure: exposure,
        c7_sale_cnt: sales,
        c30_sale_cnt: num(row.c30_sale_cnt),
        new_goods_tag: null,
        first_shelf_time: null,
        last_shelf_time: null,
        inventory_recovery_date: null,
        relisted_at: null,
        current_inventory: null,
        marketing_effective: null,
        marketing_source: null,
        marketing_source_at: null,
        openapi_fetched_at: null,
        recovery_evidence_complete: false,
        missing_inventory_dates: [],
        missing_status_dates: [],
        evidence_issues: issues,
        retire_candidate_bucket: 'cannotJudge',
        retire_candidate_reason: issues.join(';')
      };
    });
}

export function initialPool(query, performanceDate) {
  if (query.data?.dates?.linkDate !== performanceDate || query.data?.dates?.linkDateFallbackUsed === true) throw new Error('performance date mismatch/fallback');
  return query.data.storeLinks.filter(row => potentialWeakLink(row) && num(row.c7_eps_uv) !== null && num(row.c7_sale_cnt) !== null);
}

function buildDailyMap(records, {runDate, valueOf, issuePrefix, issues}) {
  const map = new Map();
  const blocked = new Set();
  if (!Array.isArray(records)) {
    addUnique(issues, `${issuePrefix}_history_invalid`);
    return {map, blocked};
  }
  for (const record of records) {
    const date = evidenceDay(record?.date);
    if (!date) {
      addUnique(issues, `${issuePrefix}_date_invalid`);
      continue;
    }
    if (date > runDate) {
      addUnique(issues, `${issuePrefix}_date_future:${date}`);
      blocked.add(date);
      continue;
    }
    const value = valueOf(record);
    if (map.has(date)) {
      const previous = map.get(date);
      addUnique(issues, previous.value === value ? `${issuePrefix}_date_duplicate:${date}` : `${issuePrefix}_date_conflict:${date}`);
      blocked.add(date);
      map.delete(date);
      continue;
    }
    if (!blocked.has(date)) map.set(date, {value, record});
  }
  return {map, blocked};
}

function dateFromRow(value, {runDate, label, issues, required = false}) {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) addUnique(issues, `missing_${label}`);
    return null;
  }
  const date = evidenceDay(value);
  if (!date) {
    addUnique(issues, `invalid_${label}`);
    return null;
  }
  if (date > runDate) {
    addUnique(issues, `future_${label}:${date}`);
    return null;
  }
  return date;
}

function historyIssueDate(issue) {
  const match = String(issue || '').match(/(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  try { return validDate(match[1]); } catch { return null; }
}

function currentStatusKind(status) {
  const value = String(status || '').trim();
  if (value === '已上架' || value === 'ON_SHELF') return 'on';
  if (value === '已下架' || value === '下架' || value === 'OFF_SHELF') return 'off';
  return 'unknown';
}

export function classifyEvidence(pool, evidence, {runDate, performanceDate, querySha256}) {
  validDate(runDate);
  validDate(performanceDate);
  if (performanceDate > runDate) throw new Error('future performance date');
  if (evidence?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw new Error('evidence schema mismatch');
  const generatedAtMs = validGeneratedAt(evidence.generatedAt, runDate);
  if (evidence.querySha256 !== querySha256 || evidence.runDate !== runDate || evidence.performanceDate !== performanceDate) throw new Error('evidence input binding mismatch');
  if (!exactKeyCoverage(evidence.rows, pool)) throw new Error('evidence coverage/duplicate mismatch');
  const byKey = new Map(evidence.rows.map(row => [keyOf(row), row]));
  // Include the preceding observation to identify a recovery on the first protected day.
  const cutoff = shiftDate(runDate, -14);
  const start = shiftDate(runDate, -15);
  const days = Array.from({length:16}, (_, index) => shiftDate(start, index));

  return pool.map(queryRow => {
    const evidenceRow = byKey.get(keyOf(queryRow));
    if (!evidenceRow) throw new Error('missing evidence key');
    const performance = evidenceRow.performance || {};
    const openapi = evidenceRow.openapi || {};
    const issues = [];
    const queryExposure = num(queryRow.c7_eps_uv);
    const querySales = num(queryRow.c7_sale_cnt);

    const inventorySeries = buildDailyMap(evidenceRow.inventory, {
      runDate,
      valueOf: record => num(record?.usable),
      issuePrefix: 'inventory',
      issues
    });
    const statusSeries = buildDailyMap(evidenceRow.statusHistory, {
      runDate,
      valueOf: record => typeof record?.isOnShelf === 'boolean' ? record.isOnShelf : null,
      issuePrefix: 'status',
      issues
    });
    const currentObservationIsUsable = openapi.found === true
      && evidenceRow.openapiCount === 1
      && evidenceDay(openapi.fetchedAt) === runDate
      && currentStatusKind(openapi.status) !== 'unknown';
    const historyIssues = Array.isArray(evidenceRow.historyIssues)
      ? [...new Set(evidenceRow.historyIssues.map(String))].filter(issue => !(currentObservationIsUsable && issue === `unavailable:${runDate}`))
      : ['history_issues_invalid'];
    for (const issue of historyIssues) {
      addUnique(issues, issue);
      const affectedDate = historyIssueDate(issue);
      if (affectedDate) {
        statusSeries.blocked.add(affectedDate);
        statusSeries.map.delete(affectedDate);
      }
    }

    const openapiDay = dateFromRow(openapi.fetchedAt, {runDate, label:'openapi_fetched_at', issues});
    const statusKind = currentStatusKind(openapi.status);
    // The audit day's current OpenAPI observation closes the daily series;
    // historical files intentionally end at the previous business day.
    if (openapi.found && evidenceRow.openapiCount === 1 && openapiDay === runDate) {
      if (num(openapi.inventory) !== null) inventorySeries.map.set(runDate, {value:num(openapi.inventory), record:{usable:openapi.inventory}});
      if (statusKind !== 'unknown') statusSeries.map.set(runDate, {value:statusKind === 'on', record:{isOnShelf:statusKind === 'on'}});
    }

    const missingInventoryDays = days.filter(date => num(inventorySeries.map.get(date)?.value) === null);
    const missingStatusDays = days.filter(date => typeof statusSeries.map.get(date)?.value !== 'boolean');
    let recovery = null;
    let relisted = null;
    for (let index = 1; index < days.length; index++) {
      const beforeDate = days[index - 1];
      const afterDate = days[index];
      if (!inventorySeries.blocked.has(beforeDate) && !inventorySeries.blocked.has(afterDate)) {
        const before = num(inventorySeries.map.get(beforeDate)?.value);
        const after = num(inventorySeries.map.get(afterDate)?.value);
        if (before !== null && after !== null && before <= 0 && after > 0) recovery = afterDate;
      }
      if (!statusSeries.blocked.has(beforeDate) && !statusSeries.blocked.has(afterDate)) {
        const before = statusSeries.map.get(beforeDate)?.value;
        const after = statusSeries.map.get(afterDate)?.value;
        if (before === false && after === true) relisted = afterDate;
      }
    }

    const performanceDay = DATE_RE.test(String(performance.date || '')) ? evidenceDay(performance.date) : null;
    if (!performance.found || performanceDay !== performanceDate) addUnique(issues, 'missing_performance_row');
    if (performance.newTagPresent !== true || performance.newTag === null) addUnique(issues, 'missing_new_goods_tag');
    if (num(performance.sales7) !== querySales || num(performance.exposure7) !== queryExposure) addUnique(issues, 'performance_source_drift');
    if (!openapi.found || evidenceRow.openapiCount !== 1) addUnique(issues, 'missing_or_duplicate_openapi');
    if (openapiDay !== runDate) addUnique(issues, 'stale_openapi');
    if (String(openapi.spu || '') !== String(queryRow.spu || '')) addUnique(issues, 'spu_identity_mismatch');
    if (num(openapi.inventory) === null) addUnique(issues, 'missing_current_inventory');
    if (statusKind === 'unknown') addUnique(issues, 'missing_or_unknown_current_status');
    if (missingInventoryDays.length) addUnique(issues, 'inventory_history_incomplete');
    if (missingStatusDays.length || historyIssues.length) addUnique(issues, 'status_history_incomplete');

    const firstShelf = dateFromRow(openapi.firstShelf, {runDate, label:'first_shelf_time', issues, required:true});
    const lastShelf = dateFromRow(openapi.lastShelf, {runDate, label:'last_shelf_time', issues});
    const marketing = evidenceRow.marketing || {};
    if (marketing.covered !== true || evidenceDay(marketing.sourceAt) !== runDate) addUnique(issues, 'marketing_live_incomplete');
    const marketingEffective = (Array.isArray(marketing.matches) ? marketing.matches : []).some(match => {
      const startsAt = Date.parse(match.start);
      const endsAt = Date.parse(match.end);
      return evidenceDay(match.sourceAt) === runDate && match.current === true && Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= generatedAtMs && endsAt >= generatedAtMs;
    });

    let bucket = 'candidate';
    let reason = 'pass';
    // Independent, affirmative exclusions remain usable when unrelated evidence is unavailable.
    if (performance.newTagPresent === true && Boolean(performance.newTag)) {
      bucket = 'excluded'; reason = 'new_goods_tag_present';
    } else if (statusKind === 'off' && openapi.found && evidenceRow.openapiCount === 1 && openapiDay === runDate) {
      bucket = 'excluded'; reason = 'not_on_shelf_now';
    } else if (firstShelf && firstShelf >= cutoff) {
      bucket = 'excluded'; reason = 'first_shelf_within_15d';
    } else if ([recovery, relisted, lastShelf].some(date => date && date >= cutoff)) {
      bucket = 'excluded'; reason = 'recovery_or_relist_within_15d';
    } else if (issues.length) {
      bucket = 'cannotJudge'; reason = issues.join(';');
    }

    return {
      store: queryRow.store_key,
      skc: queryRow.skc,
      spu: queryRow.spu,
      standard_goods_sn: queryRow.standard_goods_sn,
      current_status: openapi.status || null,
      c7_exposure: queryExposure,
      c7_sale_cnt: querySales,
      c30_sale_cnt: num(queryRow.c30_sale_cnt),
      new_goods_tag: performance.newTagPresent ? performance.newTag : null,
      first_shelf_time: firstShelf,
      last_shelf_time: lastShelf,
      inventory_recovery_date: recovery,
      relisted_at: relisted,
      current_inventory: num(openapi.inventory),
      marketing_effective: marketingEffective,
      marketing_source: marketing.source,
      marketing_source_at: marketing.sourceAt,
      openapi_fetched_at: openapi.fetchedAt,
      recovery_evidence_complete: missingInventoryDays.length === 0 && missingStatusDays.length === 0 && historyIssues.length === 0 && inventorySeries.blocked.size === 0 && statusSeries.blocked.size === 0,
      missing_inventory_dates: missingInventoryDays,
      missing_status_dates: missingStatusDays,
      evidence_issues: issues,
      retire_candidate_bucket: bucket,
      retire_candidate_reason: reason
    };
  });
}
