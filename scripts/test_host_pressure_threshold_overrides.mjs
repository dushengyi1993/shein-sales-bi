import assert from 'node:assert/strict';
import {
  HOST_RESOURCE_PRESSURE_PROFILES,
  hostResourcePressureOverrideName,
  main,
  resolveHostResourcePressureProfiles,
} from './check_host_resource_pressure.mjs';

// The resource gate's numbers were tuned on a 2 vCPU cloud host and will be
// re-measured on the 4 vCPU fnOS VM. The knobs must therefore be settable per
// host without a code edit, the compiled defaults must not move, and an invalid
// value must fail closed instead of silently opening the gate.

let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };

// 1. With no environment overrides the compiled defaults are untouched.
assert.deepEqual(resolveHostResourcePressureProfiles({}), {...HOST_RESOURCE_PRESSURE_PROFILES});
assert.deepEqual(resolveHostResourcePressureProfiles({SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU: ''}),
  {...HOST_RESOURCE_PRESSURE_PROFILES}, 'an empty override must not change the default');
ok('compiled defaults are unchanged without overrides');

// 2. Each class/field pair has a stable, documented environment name.
assert.equal(hostResourcePressureOverrideName('browser', 'maximumLoadPerCpu'), 'SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU');
assert.equal(hostResourcePressureOverrideName('browser-secondary', 'maximumLoadPerCpu'), 'SHEIN_BI_HOST_PRESSURE_BROWSER_SECONDARY_MAXIMUM_LOAD_PER_CPU');
assert.equal(hostResourcePressureOverrideName('openapi', 'minimumAvailableMemoryMiB'), 'SHEIN_BI_HOST_PRESSURE_OPENAPI_MINIMUM_AVAILABLE_MEMORY_MIB');
ok('override names are stable per resource class and field');

// 3. An override changes exactly one field of exactly one class.
const overridden = resolveHostResourcePressureProfiles({
  SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU: '1.2',
  SHEIN_BI_HOST_PRESSURE_BROWSER_SECONDARY_MAXIMUM_LOAD_PER_CPU: '0.9',
});
assert.equal(overridden.browser.maximumLoadPerCpu, 1.2);
assert.equal(overridden['browser-secondary'].maximumLoadPerCpu, 0.9);
assert.equal(overridden.browser.minimumAvailableMemoryMiB, HOST_RESOURCE_PRESSURE_PROFILES.browser.minimumAvailableMemoryMiB);
assert.equal(overridden.openapi.maximumLoadPerCpu, HOST_RESOURCE_PRESSURE_PROFILES.openapi.maximumLoadPerCpu);
ok('an override touches one field of one class');

// 4. Nonsense values fail closed rather than opening the gate.
for (const [name, value] of [
  ['SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU', 'abc'],
  ['SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU', '0'],
  ['SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU', '-1'],
  ['SHEIN_BI_HOST_PRESSURE_BROWSER_MINIMUM_AVAILABLE_MEMORY_MIB', '2048.5'],
  ['SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_CPU_BUSY_RATIO_WHEN_LOAD_HIGH', '1.4'],
]) {
  assert.throws(() => resolveHostResourcePressureProfiles({[name]: value}), /HOST_RESOURCE_PRESSURE_THRESHOLD_INVALID/u,
    `${name}=${value} must be rejected`);
}
ok('invalid override values are rejected');

// 5. The gate decision follows the configured value, and the effective profile
//    is echoed so a release readback shows what was actually applied.
const snapshot = Object.freeze({
  '/proc/uptime': '100000.00 900000.00\n',
  '/proc/loadavg': '4.00 3.00 2.00 1/100 12345\n',
  '/proc/meminfo': 'MemAvailable: 8388608 kB\n',
  '/proc/pressure/memory': 'some avg10=0.00 total=0\nfull avg10=0.00 total=0\n',
  '/proc/pressure/io': 'some avg10=0.00 total=0\nfull avg10=0.00 total=0\n',
  '/proc/stat': 'cpu  1000 0 1000 8000 0 0 0 0 0 0\n',
});
const reader = async file => snapshot[file] ?? '';
const capture = async (env) => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  let exitCode;
  try {
    exitCode = await main(['--class=browser'], {reader, cpuCount: 4, cpuSampleMs: 50, env});
  } finally {
    console.log = original;
  }
  return {exitCode, payload: JSON.parse(lines.at(-1))};
};

// load1 4.00 on 4 cores is a normalized load of 1.00: deferred at the 0.75
// default, ready once the measured value for this host is 1.2.
const defaultDecision = await capture({});
assert.equal(defaultDecision.exitCode, 75);
assert.equal(defaultDecision.payload.ok, false);
assert.ok(defaultDecision.payload.reasonCodes.includes('CPU_LOAD_PRESSURE'));
assert.equal(defaultDecision.payload.thresholdOverrides, undefined, 'no override must not be reported as one');

const overriddenDecision = await capture({SHEIN_BI_HOST_PRESSURE_BROWSER_MAXIMUM_LOAD_PER_CPU: '1.2'});
assert.equal(overriddenDecision.exitCode, 0);
assert.equal(overriddenDecision.payload.ok, true);
assert.deepEqual(overriddenDecision.payload.thresholdOverrides, {maximumLoadPerCpu: 1.2});
assert.equal(overriddenDecision.payload.defaultProfile.maximumLoadPerCpu, HOST_RESOURCE_PRESSURE_PROFILES.browser.maximumLoadPerCpu);
ok('the gate follows the configured threshold and echoes the effective profile');

console.log(JSON.stringify({ok: true, checks}, null, 2));
