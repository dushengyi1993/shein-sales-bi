import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export function marketingLinkKey(storeKey, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}::${String(skc || '').trim()}`;
}

export function isInactiveLinkSnapshot(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isSoldOut === true || row.is_sold_out === true) return true;
  if (row.isOutShelf === true || row.is_out_shelf === true) return true;
  return /SOLD_OUT|OUT_SHELF|已售罄|售罄|已下架|下架/i.test(String(
    row.shelfStatus
    || row.shelf_status
    || row.shelfStatusName
    || row.shelf_status_name
    || '',
  ));
}

export function isOnShelfLinkSnapshot(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.isOnShelf === true || row.is_on_shelf === true) return true;
  if (row.isOnShelf === false || row.is_on_shelf === false) return false;
  return /ON_SHELF|已上架|在售/i.test(String(
    row.shelfStatus
    || row.shelf_status
    || row.shelfStatusName
    || row.shelf_status_name
    || '',
  ));
}

export function collectRelistedLinkHistoryEvidence({
  historyDir,
  reportDate,
  lookbackDays = 60,
  currentKeys = null,
  storeKeys = null,
} = {}) {
  const root = path.resolve(String(historyDir || ''));
  const reportDayMs = localDateMs(reportDate);
  const windowDays = positiveInt(lookbackDays, 60);
  const earliestMs = Number.isFinite(reportDayMs) ? reportDayMs - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;
  const allowedStores = storeKeys ? new Set([...storeKeys].map(value => String(value || '').trim().toUpperCase()).filter(Boolean)) : null;
  const wantedKeys = currentKeys ? new Set([...currentKeys].map(String)) : null;
  const files = listSnapshotFiles(root, allowedStores)
    .filter(file => {
      const dayMs = localDateMs(file.date);
      return Number.isFinite(dayMs)
        && dayMs >= earliestMs
        && (!Number.isFinite(reportDayMs) || dayMs <= reportDayMs);
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.storeKey.localeCompare(b.storeKey) || a.path.localeCompare(b.path));

  const stateBySkc = new Map();
  const parseErrors = [];
  let snapshotRows = 0;
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file.path, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      parseErrors.push({path: file.path, error: String(error?.message || error)});
      continue;
    }
    for (const row of Array.isArray(doc?.linkRows) ? doc.linkRows : []) {
      const storeKey = String(row?.storeKey || row?.store_key || file.storeKey || '').trim().toUpperCase();
      const skc = String(row?.skc || row?.SKC || '').trim();
      const key = marketingLinkKey(storeKey, skc);
      if (!storeKey || !skc || (wantedKeys && !wantedKeys.has(key))) continue;
      snapshotRows += 1;
      const state = stateBySkc.get(key) || {
        storeKey,
        skc,
        firstInactiveDate: '',
        lastInactiveDate: '',
        lastInactiveStatus: '',
        inactiveSnapshotCount: 0,
        relistedAt: '',
        latestSnapshotDate: '',
        latestStatus: '',
        latestOnShelf: false,
        latestHasActivity: null,
      };
      const inactive = isInactiveLinkSnapshot(row);
      const onShelf = isOnShelfLinkSnapshot(row);
      const status = String(row?.shelfStatusName || row?.shelf_status_name || row?.shelfStatus || row?.shelf_status || '').trim();
      if (inactive) {
        if (!state.firstInactiveDate) state.firstInactiveDate = file.date;
        state.lastInactiveDate = file.date;
        state.lastInactiveStatus = status;
        state.inactiveSnapshotCount += 1;
        state.relistedAt = '';
      } else if (onShelf && state.lastInactiveDate && file.date > state.lastInactiveDate && !state.relistedAt) {
        state.relistedAt = file.date;
      }
      if (!state.latestSnapshotDate || file.date >= state.latestSnapshotDate) {
        state.latestSnapshotDate = file.date;
        state.latestStatus = status;
        state.latestOnShelf = onShelf;
        state.latestHasActivity = booleanOrNull(row?.hasActivity ?? row?.has_activity);
      }
      stateBySkc.set(key, state);
    }
  }

  const rows = [...stateBySkc.values()]
    .filter(row => row.lastInactiveDate && row.relistedAt && row.latestOnShelf)
    .sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.skc.localeCompare(b.skc));
  return {
    status: fs.existsSync(root) ? (parseErrors.length ? 'partial' : 'ok') : 'missing',
    historyDir: root,
    reportDate: String(reportDate || ''),
    lookbackDays: windowDays,
    sourceFileCount: files.length,
    snapshotRows,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.slice(0, 20),
    rows,
    bySkc: new Map(rows.map(row => [marketingLinkKey(row.storeKey, row.skc), row])),
  };
}

function listSnapshotFiles(root, allowedStores) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const storeEntry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!storeEntry.isDirectory()) continue;
    const storeKey = storeEntry.name.trim().toUpperCase();
    if (allowedStores && !allowedStores.has(storeKey)) continue;
    const storeDir = path.join(root, storeEntry.name);
    for (const fileEntry of fs.readdirSync(storeDir, {withFileTypes: true})) {
      if (!fileEntry.isFile()) continue;
      const match = fileEntry.name.match(/^(20\d{2}-\d{2}-\d{2})\.json$/i);
      if (!match) continue;
      out.push({storeKey, date: match[1], path: path.join(storeDir, fileEntry.name)});
    }
  }
  return out;
}

function localDateMs(value) {
  const match = String(value || '').match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function booleanOrNull(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}
