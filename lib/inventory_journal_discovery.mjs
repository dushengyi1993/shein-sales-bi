import fs from 'node:fs/promises';
import path from 'node:path';
const INVENTORY_JOURNAL_FILE_RE = /^daily-inventory-replenishment-(\d{4}-\d{2}-\d{2})\.json\.journal\.ndjson$/;

export async function discoverInventoryJournalFiles(currentJournalFile, {
  includeAll = false,
  additionalDirectories = [],
} = {}) {
  const current = path.resolve(String(currentJournalFile || ''));
  if (!Array.isArray(additionalDirectories)) throw new Error('additionalDirectories must be an array');
  const managedDirectories = [];
  for (let ancestor = path.dirname(current); path.dirname(ancestor) !== ancestor; ancestor = path.dirname(ancestor)) {
    if (path.basename(ancestor) === 'runs') {
      managedDirectories.push(ancestor, path.join(path.dirname(ancestor), 'results'));
      break;
    }
  }
  const directories = [...new Set([
    path.dirname(current),
    ...managedDirectories,
    ...additionalDirectories
      .map(directory => String(directory || '').trim())
      .filter(Boolean)
      .map(directory => path.resolve(directory)),
  ])];
  const candidates = [];
  const scan = async (directory, recursive) => {
    let entries;
    try { entries = await fs.readdir(directory, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (recursive && entry.isDirectory() && !['archive', 'snapshots', 'versions'].includes(entry.name)) await scan(file, true);
      else if (entry.isFile() && entry.name.endsWith('.journal.ndjson') && (includeAll || INVENTORY_JOURNAL_FILE_RE.test(entry.name))) candidates.push(file);
    }
  };
  for (const directory of directories) {
    // The current output directory is one journal domain, not a mandate to
    // absorb unrelated nested exports or diagnostic copies. Declared other
    // domains and managed runs are recursive.
    const recursive = directory !== path.dirname(current) || directory.split(path.sep).includes('runs');
    await scan(directory, recursive);
  }
  const files = [];
  const seenPaths = new Set();
  const seenFileIdentities = new Set();
  // ET execution hard-links its stable journal to a timestamped attempt
  // journal. Prefer the current executor path and de-duplicate the same inode;
  // otherwise strict aggregation would mistake one physical intent history
  // for two conflicting journals.
  for (const candidate of [current, ...candidates]) {
    const resolved = path.resolve(candidate);
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    let identity = '';
    try {
      const stat = await fs.stat(resolved, {bigint: true});
      if (stat.ino > 0n) identity = `${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (identity && seenFileIdentities.has(identity)) continue;
    if (identity) seenFileIdentities.add(identity);
    files.push(resolved);
  }
  return files;
}
