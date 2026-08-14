import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

export const SYSTEMD_SNAPSHOT_COMMON_PROPERTIES = Object.freeze([
  'Id', 'LoadState', 'ActiveState', 'SubState', 'Result',
  'StateChangeTimestamp', 'ActiveEnterTimestamp',
]);

export const SYSTEMD_SNAPSHOT_SERVICE_PROPERTIES = Object.freeze([
  'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'NRestarts',
]);

export const SYSTEMD_SNAPSHOT_PROPERTIES = Object.freeze([
  ...SYSTEMD_SNAPSHOT_COMMON_PROPERTIES,
  ...SYSTEMD_SNAPSHOT_SERVICE_PROPERTIES,
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
    const missingProperties = requiredPropertiesForUnit(name).filter(property => !Object.hasOwn(data, property));
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
  if (!requested.length) return {ok: true, commandCount: 0, requested: [], units: {}};
  const execute = options.execute || defaultExecute;
  const args = [
    'show', ...requested, '--no-pager',
    `--property=${SYSTEMD_SNAPSHOT_PROPERTIES.join(',')}`,
  ];
  const result = await execute(args);
  const units = parseSystemdShowMany(result.stdout, requested, result);
  return {
    ok: requested.every(name => units[name]?.complete === true),
    commandCount: 1,
    requested,
    units,
    commandCode: Number.isInteger(result.code) ? result.code : 1,
  };
}
