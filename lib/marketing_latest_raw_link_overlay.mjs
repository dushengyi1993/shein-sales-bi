import fs from 'node:fs';
import path from 'node:path';

function normStore(value) {
  return String(value || '').trim().toUpperCase();
}

function normSkc(value) {
  return String(value || '').trim();
}

function linkKey(row) {
  const storeKey = normStore(row?.store_key || row?.storeKey || row?.store);
  const skc = normSkc(row?.skc || row?.SKC);
  return storeKey && skc ? `${storeKey}::${skc}` : '';
}

function normalizeRawRow(row, doc, sourceFile) {
  const storeKey = normStore(row?.storeKey || row?.store_key || doc?.store?.storeKey);
  const skc = normSkc(row?.skc || row?.SKC);
  if (!storeKey || !skc) return null;
  return {
    ...row,
    store_key: storeKey,
    skc,
    standard_goods_sn: String(row?.standard_goods_sn || row?.standardGoodsSn || row?.cleanedGoodsSn || row?.rawGoodsSn || '').trim(),
    raw_goods_sn: String(row?.raw_goods_sn || row?.rawGoodsSn || '').trim(),
    is_on_shelf: row?.is_on_shelf ?? row?.isOnShelf ?? null,
    shelf_status_name: String(row?.shelf_status_name || row?.shelfStatusName || '').trim(),
    first_shelf_time: String(row?.first_shelf_time || row?.firstShelfTime || '').trim(),
    created_time: String(row?.created_time || row?.createTime || '').trim(),
    link_date: String(row?.link_date || row?.date || doc?.date || '').slice(0, 10),
    c7_eps_uv: row?.c7_eps_uv ?? row?.c7EpsUv ?? null,
    raw_has_activity: row?.hasActivity ?? null,
    raw_link_snapshot_source: sourceFile,
    raw_link_snapshot_fetch_time: String(doc?.fetchTime || '').trim(),
  };
}

function isRawOnShelf(row) {
  const explicit = row?.is_on_shelf ?? row?.isOnShelf;
  if (explicit === true || explicit === 1 || explicit === '1') return true;
  if (explicit === false || explicit === 0 || explicit === '0') return false;
  const status = String(
    row?.shelf_status_name
      || row?.shelfStatusName
      || row?.shelf_status
      || row?.shelfStatus
      || '',
  ).trim();
  return /^ON_SHELF$/i.test(status) || status.includes('已上架');
}

function timestampMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}+08:00`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotRank(row) {
  return Math.max(
    timestampMs(row?.raw_link_snapshot_fetch_time),
    timestampMs(row?.current_price_source_at),
    timestampMs(row?.link_updated_at),
    timestampMs(row?.link_date),
  );
}

function overlayNewerRawShelfState(baseRow, rawRow) {
  if (!isRawOnShelf(rawRow) || snapshotRank(rawRow) < snapshotRank(baseRow)) {
    return {row: baseRow, updated: false};
  }
  const baseOnShelf = isRawOnShelf(baseRow);
  const rawFirstShelfTime = String(rawRow?.first_shelf_time || rawRow?.firstShelfTime || '').trim();
  const baseFirstShelfTime = String(baseRow?.first_shelf_time || baseRow?.firstShelfTime || '').trim();
  if (baseOnShelf) return {row: baseRow, updated: false};

  return {
    row: {
      ...baseRow,
      is_on_shelf: true,
      isOnShelf: true,
      is_wait_shelf: false,
      isWaitShelf: false,
      is_sold_out: false,
      isSoldOut: false,
      is_out_shelf: false,
      isOutShelf: false,
      shelf_status: 'ON_SHELF',
      shelfStatus: 'ON_SHELF',
      shelf_status_name: '已上架',
      shelfStatusName: '已上架',
      visible_shelf_statuses: 'ON_SHELF',
      health_bucket: '正常在售',
      first_shelf_time: rawFirstShelfTime || baseFirstShelfTime,
      firstShelfTime: rawFirstShelfTime || baseFirstShelfTime,
      link_date: String(rawRow?.link_date || baseRow?.link_date || '').slice(0, 10),
      raw_link_snapshot_source: rawRow?.raw_link_snapshot_source || '',
      raw_link_snapshot_fetch_time: rawRow?.raw_link_snapshot_fetch_time || '',
      raw_shelf_state_overlay: true,
    },
    updated: true,
  };
}

function candidateFiles(storeDir, reportDate) {
  return fs.readdirSync(storeDir, {withFileTypes: true})
    .filter(entry => entry.isFile() && /^20\d{2}-\d{2}-\d{2}\.json$/i.test(entry.name))
    .map(entry => ({name: entry.name, date: entry.name.slice(0, 10)}))
    .filter(entry => !reportDate || entry.date <= reportDate)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function collectLatestRawMarketingLinkRows({historyDir, reportDate = '', storeKeys = [], includeOffShelf = false} = {}) {
  const requestedHistoryDir = String(historyDir || '').trim();
  const wantedStores = new Set((storeKeys || []).map(normStore).filter(Boolean));
  const rows = [];
  const sourceFiles = [];
  const errors = [];
  if (!requestedHistoryDir) {
    return {rows, sourceFiles, errors: [{reason: 'history_dir_missing', path: ''}], storeCount: 0};
  }
  const root = path.resolve(requestedHistoryDir);
  if (!fs.existsSync(root)) {
    return {rows, sourceFiles, errors: [{reason: 'history_dir_missing', path: root}], storeCount: 0};
  }
  const storeDirs = fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .map(entry => ({storeKey: normStore(entry.name), dir: path.join(root, entry.name)}))
    .filter(entry => !wantedStores.size || wantedStores.has(entry.storeKey))
    .sort((a, b) => a.storeKey.localeCompare(b.storeKey));

  for (const store of storeDirs) {
    let selected = null;
    let candidates = [];
    try {
      candidates = candidateFiles(store.dir, reportDate);
    } catch (error) {
      errors.push({storeKey: store.storeKey, path: store.dir, reason: `snapshot_directory_unreadable: ${error.message}`});
      continue;
    }
    for (const candidate of candidates) {
      const file = path.join(store.dir, candidate.name);
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (doc?.ok === false) {
          errors.push({storeKey: store.storeKey, path: file, reason: 'snapshot_not_successful'});
          continue;
        }
        if (!Array.isArray(doc?.linkRows)) {
          errors.push({storeKey: store.storeKey, path: file, reason: 'snapshot_link_rows_missing'});
          continue;
        }
        selected = {file, doc, date: candidate.date};
        break;
      } catch (error) {
        errors.push({storeKey: store.storeKey, path: file, reason: error.message});
      }
    }
    if (!selected) {
      errors.push({storeKey: store.storeKey, reason: 'no_valid_snapshot_on_or_before_report_date'});
      continue;
    }
    const normalized = selected.doc.linkRows
      .filter(row => includeOffShelf || isRawOnShelf(row))
      .map(row => normalizeRawRow(row, selected.doc, selected.file))
      .filter(Boolean);
    rows.push(...normalized);
    sourceFiles.push({
      storeKey: store.storeKey,
      path: selected.file,
      date: selected.date,
      fetchTime: String(selected.doc.fetchTime || ''),
      rowCount: normalized.length,
    });
  }
  return {rows, sourceFiles, errors, storeCount: sourceFiles.length};
}

export function assessLatestRawMarketingLinkCoverage({sourceFiles = [], errors = [], storeKeys = []} = {}) {
  const expectedStoreKeys = [...new Set((storeKeys || []).map(normStore).filter(Boolean))].sort();
  const sourceStoreKeys = [...new Set((sourceFiles || []).map(file => normStore(file?.storeKey)).filter(Boolean))].sort();
  const sourceStoreSet = new Set(sourceStoreKeys);
  const missingStoreKeys = expectedStoreKeys.filter(storeKey => !sourceStoreSet.has(storeKey));
  return {
    complete: missingStoreKeys.length === 0 && (errors || []).length === 0,
    expectedStoreCount: expectedStoreKeys.length,
    sourceFileCount: sourceStoreKeys.length,
    missingStoreKeys,
    parseErrorCount: (errors || []).length,
  };
}

export function mergeMarketingLinkRows(baseRows = [], rawRows = []) {
  const rows = [];
  const indexByKey = new Map();
  for (const row of baseRows || []) {
    const key = linkKey(row);
    if (!key || indexByKey.has(key)) continue;
    indexByKey.set(key, rows.length);
    rows.push(row);
  }
  const addedRows = [];
  const updatedRows = [];
  for (const row of rawRows || []) {
    const key = linkKey(row);
    if (!key) continue;
    if (indexByKey.has(key)) {
      const index = indexByKey.get(key);
      const overlay = overlayNewerRawShelfState(rows[index], row);
      if (overlay.updated) {
        rows[index] = overlay.row;
        updatedRows.push(overlay.row);
      }
      continue;
    }
    indexByKey.set(key, rows.length);
    rows.push(row);
    addedRows.push(row);
  }
  return {
    rows,
    baseRowCount: rows.length - addedRows.length,
    rawRowCount: Array.isArray(rawRows) ? rawRows.length : 0,
    addedRowCount: addedRows.length,
    addedRows,
    updatedRowCount: updatedRows.length,
    updatedRows,
  };
}
