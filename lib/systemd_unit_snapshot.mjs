import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const SHEIN_SYSTEMD_UNIT_FILE = /^shein-bi-[A-Za-z0-9_.@-]+\.(?:service|timer|path)$/;

export const SYSTEMD_KNOWN_UNIT_FILE_STATES = Object.freeze([
  'enabled',
  'enabled-runtime',
  'linked',
  'linked-runtime',
  'alias',
  'masked',
  'masked-runtime',
  'static',
  'disabled',
  'indirect',
  'generated',
  'transient',
]);

const KNOWN_UNIT_FILE_STATES = new Set(SYSTEMD_KNOWN_UNIT_FILE_STATES);

export const SYSTEMD_SNAPSHOT_COMMON_PROPERTIES = Object.freeze([
  'Id', 'LoadState', 'ActiveState', 'SubState', 'Result',
  'StateChangeTimestamp', 'ActiveEnterTimestamp',
]);

export const SYSTEMD_SNAPSHOT_SERVICE_PROPERTIES = Object.freeze([
  'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'NRestarts',
  'ExecCondition', 'RequiresMountsFor', 'BindPaths', 'BindReadOnlyPaths', 'ReadOnlyPaths', 'InaccessiblePaths',
]);

export const SYSTEMD_SNAPSHOT_PROPERTIES = Object.freeze([
  ...SYSTEMD_SNAPSHOT_COMMON_PROPERTIES,
  ...SYSTEMD_SNAPSHOT_SERVICE_PROPERTIES,
]);

const SYSTEMD_SNAPSHOT_STRUCTURAL_PROPERTIES = Object.freeze([
  'Id', 'LoadState', 'ActiveState', 'SubState',
]);

function requiredPropertiesForUnit(name) {
  return String(name || '').endsWith('.service')
    ? SYSTEMD_SNAPSHOT_PROPERTIES
    : SYSTEMD_SNAPSHOT_COMMON_PROPERTIES;
}

function uniqueNames(names) {
  return [...new Set((names || []).map(value => String(value || '').trim()).filter(Boolean))];
}

export function parseSystemdShowMany(stdout, expectedNames = [], command = {}) {
  const expected = uniqueNames(expectedNames);
  const units = {};
  const blocks = String(stdout || '').trim().split(/\r?\n\s*\r?\n/).filter(Boolean);
  for (const block of blocks) {
    const data = {};
    for (const line of block.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index > 0) data[line.slice(0, index)] = line.slice(index + 1);
    }
    const name = String(data.Id || '').trim();
    if (!name) continue;
    const missingProperties = SYSTEMD_SNAPSHOT_STRUCTURAL_PROPERTIES
      .filter(property => !Object.hasOwn(data, property));
    // systemd 255 omits explicitly requested properties whose effective value
    // is empty. Preserve structural completeness as the transport boundary,
    // then normalize omitted optional properties to the semantic empty value.
    // Every non-empty maintenance/runtime-path expectation is still checked by
    // the shared exact-policy validators after parsing.
    for (const property of requiredPropertiesForUnit(name)) {
      if (!Object.hasOwn(data, property)) data[property] = '';
    }
    units[name] = {
      name,
      ok: missingProperties.length === 0 && data.LoadState !== 'not-found',
      complete: missingProperties.length === 0,
      missingProperties,
      code: Number.isInteger(command.code) ? command.code : 0,
      ...data,
      stderr: data.LoadState === 'not-found' ? String(command.stderr || '').slice(0, 500) : '',
    };
  }
  for (const name of expected) {
    if (units[name]) continue;
    units[name] = {
      name,
      ok: false,
      complete: false,
      missingProperties: [...requiredPropertiesForUnit(name)],
      code: Number.isInteger(command.code) ? command.code : 1,
      LoadState: 'unknown',
      ActiveState: 'unknown',
      SubState: 'unknown',
      Result: 'unknown',
      stderr: String(command.stderr || 'systemctl returned no block for this unit').slice(0, 500),
    };
  }
  return units;
}

export function parseSystemdListUnitFiles(stdout, command = {}) {
  const entries = {};
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    const name = String(columns[0] || '').trim();
    if (!SHEIN_SYSTEMD_UNIT_FILE.test(name)) continue;
    const state = String(columns[1] || 'unknown').trim().toLowerCase();
    const preset = String(columns[2] || '').trim().toLowerCase();
    if (entries[name]) {
      entries[name] = {
        ...entries[name],
        state: 'unknown',
        knownState: false,
        duplicate: true,
      };
      continue;
    }
    entries[name] = {
      name,
      state,
      preset,
      knownState: KNOWN_UNIT_FILE_STATES.has(state),
      duplicate: false,
    };
  }
  const installed = Object.keys(entries).sort();
  const unknownState = installed
    .filter(name => entries[name].knownState !== true)
    .map(name => ({name, state: entries[name].state}));
  return {
    complete: Number.isInteger(command.code) ? command.code === 0 : true,
    commandCode: Number.isInteger(command.code) ? command.code : 0,
    stderr: String(command.stderr || '').slice(0, 500),
    installed,
    entries,
    unknownState,
  };
}

export function compareSystemdUnitFiles({
  inventory = {},
  expectedNames = [],
  legacyMaskedAllowlist = [],
} = {}) {
  const expected = uniqueNames(expectedNames).sort();
  const expectedSet = new Set(expected);
  const allowlist = new Set(uniqueNames(legacyMaskedAllowlist));
  const entries = inventory.entries || {};
  const installed = uniqueNames(inventory.installed || Object.keys(entries)).sort();
  const installedSet = new Set(installed);
  const missing = expected.filter(name => !installedSet.has(name));
  const unexpected = [];
  const allowedLegacyMasked = [];
  for (const name of installed) {
    if (expectedSet.has(name)) continue;
    const entry = entries[name] || {name, state: 'unknown'};
    if (allowlist.has(name) && ['masked', 'masked-runtime'].includes(entry.state)) {
      allowedLegacyMasked.push({name, state: entry.state});
    } else {
      unexpected.push({name, state: entry.state});
    }
  }
  const unknownState = Array.isArray(inventory.unknownState)
    ? inventory.unknownState.map(row => ({name: row.name, state: row.state}))
    : installed
      .filter(name => entries[name]?.knownState !== true)
      .map(name => ({name, state: entries[name]?.state || 'unknown'}));
  return {
    ok: inventory.complete === true
      && missing.length === 0
      && unexpected.length === 0
      && unknownState.length === 0,
    expected,
    installed,
    missing,
    unexpected,
    unknownState,
    allowedLegacyMasked,
  };
}

async function defaultExecute(args) {
  try {
    const result = await execFileAsync('systemctl', args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    return {code: 0, stdout: result.stdout, stderr: result.stderr};
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || error?.message || error),
    };
  }
}

export async function collectSystemdUnitSnapshot(names, options = {}) {
  const requested = uniqueNames(names);
  const execute = options.execute || defaultExecute;
  const showArgs = [
    'show', ...requested, '--no-pager',
    `--property=${SYSTEMD_SNAPSHOT_PROPERTIES.join(',')}`,
  ];
  const listArgs = [
    'list-unit-files',
    'shein-bi-*.service',
    'shein-bi-*.timer',
    'shein-bi-*.path',
    '--no-legend',
    '--no-pager',
  ];
  const [showResult, listResult] = await Promise.all([
    requested.length
      ? execute(showArgs)
      : Promise.resolve({code: 0, stdout: '', stderr: ''}),
    execute(listArgs),
  ]);
  const units = parseSystemdShowMany(showResult.stdout, requested, showResult);
  const unitFileInventory = parseSystemdListUnitFiles(listResult.stdout, listResult);
  const unitFileComparison = Array.isArray(options.expectedUnitFiles)
    ? compareSystemdUnitFiles({
      inventory: unitFileInventory,
      expectedNames: options.expectedUnitFiles,
      legacyMaskedAllowlist: options.legacyMaskedAllowlist,
    })
    : null;
  const unitShowOk = requested.every(name => units[name]?.complete === true);
  const unitFileProbeOk = unitFileInventory.complete === true
    && unitFileInventory.unknownState.length === 0;
  return {
    ok: unitShowOk && unitFileProbeOk && (unitFileComparison?.ok ?? true),
    commandCount: (requested.length ? 1 : 0) + 1,
    showCommandCount: requested.length ? 1 : 0,
    listUnitFilesCommandCount: 1,
    requested,
    units,
    commandCode: Number.isInteger(showResult.code) ? showResult.code : 1,
    showCommandCode: Number.isInteger(showResult.code) ? showResult.code : 1,
    listUnitFilesCommandCode: Number.isInteger(listResult.code) ? listResult.code : 1,
    unitFileInventory,
    unitFileComparison,
  };
}
