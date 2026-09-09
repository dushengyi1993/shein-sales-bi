#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  collectSystemdUnitSnapshot,
  compareSystemdUnitFiles,
  parseSystemdListUnitFiles,
  parseSystemdShowMany,
} from '../lib/systemd_unit_snapshot.mjs';

const fixture = `Id=shein-bi-portal.service
LoadState=loaded
ActiveState=active
SubState=running
Result=success
ExecMainCode=0
ExecMainStatus=0
StateChangeTimestamp=
ActiveEnterTimestamp=
ExecMainStartTimestamp=
ExecMainExitTimestamp=
NRestarts=0
ExecCondition=
ExecStartPre=
RequiresMountsFor=
BindPaths=
BindReadOnlyPaths=
ReadOnlyPaths=
InaccessiblePaths=

Id=shein-bi-webhook.service
LoadState=loaded
ActiveState=inactive
SubState=dead
Result=exit-code
ExecMainCode=1
ExecMainStatus=1
StateChangeTimestamp=
ActiveEnterTimestamp=
ExecMainStartTimestamp=
ExecMainExitTimestamp=
NRestarts=2
ExecCondition=
ExecStartPre=
RequiresMountsFor=
BindPaths=
BindReadOnlyPaths=
ReadOnlyPaths=/data/shein-bi/state /data/shein-bi/outputs
InaccessiblePaths=

Id=not-found.service
LoadState=not-found
ActiveState=inactive
SubState=dead
Result=success
ExecMainCode=0
ExecMainStatus=0
StateChangeTimestamp=
ActiveEnterTimestamp=
ExecMainStartTimestamp=
ExecMainExitTimestamp=
NRestarts=0
ExecCondition=
ExecStartPre=
RequiresMountsFor=
BindPaths=
BindReadOnlyPaths=
ReadOnlyPaths=
InaccessiblePaths=

Id=shein-bi-daily.timer
LoadState=loaded
ActiveState=active
SubState=waiting
Result=success
StateChangeTimestamp=
ActiveEnterTimestamp=
`;

const parsed = parseSystemdShowMany(fixture, [
  'shein-bi-portal.service', 'shein-bi-webhook.service', 'missing.service',
], {code: 1, stderr: 'one unit missing'});
assert.equal(parsed['shein-bi-portal.service'].ActiveState, 'active');
assert.equal(parsed['shein-bi-portal.service'].NRestarts, '0');
assert.equal(parsed['shein-bi-webhook.service'].Result, 'exit-code');
assert.equal(parsed['shein-bi-webhook.service'].NRestarts, '2');
assert.equal(parsed['missing.service'].LoadState, 'unknown');
assert.equal(parsed['not-found.service'].LoadState, 'not-found');
assert.equal(parsed['not-found.service'].complete, true);
assert.equal(parsed['not-found.service'].ok, false);
assert.equal(parsed['shein-bi-daily.timer'].complete, true);
assert.equal(parsed['shein-bi-daily.timer'].ok, true);

const serviceWithoutExecMain = parseSystemdShowMany(
  'Id=no-exec.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nStateChangeTimestamp=\nActiveEnterTimestamp=\n',
  ['no-exec.service'],
  {code: 0},
);
assert.equal(serviceWithoutExecMain['no-exec.service'].complete, true);
assert.equal(serviceWithoutExecMain['no-exec.service'].ExecMainStatus, '');
assert.equal(serviceWithoutExecMain['no-exec.service'].ExecCondition, '');

const incomplete = parseSystemdShowMany('Id=partial.service\nLoadState=loaded\n', ['partial.service'], {code: 1});
assert.equal(incomplete['partial.service'].complete, false);
assert.ok(incomplete['partial.service'].missingProperties.includes('ActiveState'));

const aliasMismatch = parseSystemdShowMany(
  'Id=canonical.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\nStateChangeTimestamp=\nActiveEnterTimestamp=\nExecMainStartTimestamp=\nExecMainExitTimestamp=\nNRestarts=0\nExecCondition=\nRequiresMountsFor=\nBindPaths=\nBindReadOnlyPaths=\nReadOnlyPaths=\nInaccessiblePaths=\n',
  ['alias.service'],
  {code: 0},
);
assert.equal(aliasMismatch['alias.service'].complete, false);
assert.equal(aliasMismatch['canonical.service'].complete, true);

const unitFileFixture = `shein-bi-portal.service enabled enabled
shein-bi-webhook.service enabled enabled
shein-bi-cloud-link-business.timer masked enabled
shein-bi-cloud-openapi-hl.service masked enabled
shein-bi-unexpected.timer disabled enabled
shein-bi-unknown.path future-state enabled
unrelated.service enabled enabled
`;
const unitFileInventory = parseSystemdListUnitFiles(unitFileFixture, {code: 0});
assert.equal(unitFileInventory.complete, true);
assert.equal(unitFileInventory.entries['shein-bi-portal.service'].state, 'enabled');
assert.equal(unitFileInventory.entries['shein-bi-cloud-link-business.timer'].state, 'masked');
assert.deepEqual(unitFileInventory.unknownState, [{name: 'shein-bi-unknown.path', state: 'future-state'}]);

const unexpectedInstalled = compareSystemdUnitFiles({
  inventory: unitFileInventory,
  expectedNames: ['shein-bi-portal.service', 'shein-bi-webhook.service'],
  legacyMaskedAllowlist: [
    'shein-bi-cloud-link-business.timer',
    'shein-bi-cloud-openapi-hl.service',
  ],
});
assert.equal(unexpectedInstalled.ok, false);
assert.deepEqual(unexpectedInstalled.allowedLegacyMasked, [
  {name: 'shein-bi-cloud-link-business.timer', state: 'masked'},
  {name: 'shein-bi-cloud-openapi-hl.service', state: 'masked'},
]);
assert.ok(unexpectedInstalled.unexpected.some(row => row.name === 'shein-bi-unexpected.timer'));
assert.ok(unexpectedInstalled.unknownState.some(row => row.name === 'shein-bi-unknown.path'));

const missingInstalled = compareSystemdUnitFiles({
  inventory: parseSystemdListUnitFiles('shein-bi-portal.service enabled enabled\n', {code: 0}),
  expectedNames: ['shein-bi-portal.service', 'shein-bi-webhook.service'],
});
assert.deepEqual(missingInstalled.missing, ['shein-bi-webhook.service']);
assert.equal(missingInstalled.ok, false);

let calls = 0;
let listCalls = 0;
let showCalls = 0;
const snapshot = await collectSystemdUnitSnapshot([
  'shein-bi-portal.service', 'shein-bi-webhook.service', 'shein-bi-portal.service',
], {
  execute: async args => {
    calls += 1;
    if (args[0] === 'show') {
      showCalls += 1;
      assert.equal(args.filter(value => value === 'shein-bi-portal.service').length, 1);
      return {code: 1, stdout: fixture, stderr: 'one unrelated unit was not found'};
    }
    assert.equal(args[0], 'list-unit-files');
    listCalls += 1;
    assert.equal(args.filter(value => value === 'shein-bi-*.service').length, 1);
    return {
      code: 0,
      stdout: 'shein-bi-portal.service enabled enabled\nshein-bi-webhook.service enabled enabled\n',
      stderr: '',
    };
  },
  expectedUnitFiles: ['shein-bi-portal.service', 'shein-bi-webhook.service'],
});
assert.equal(calls, 2);
assert.equal(showCalls, 1);
assert.equal(listCalls, 1);
assert.equal(snapshot.commandCount, 2);
assert.equal(snapshot.showCommandCount, 1);
assert.equal(snapshot.listUnitFilesCommandCount, 1);
assert.equal(snapshot.requested.length, 2);
assert.equal(snapshot.units['shein-bi-portal.service'].ok, true);
assert.equal(snapshot.unitFileComparison.ok, true);
assert.equal(snapshot.ok, true, 'nonzero command semantics are evaluated per complete unit block');


const readOnlyCollected = parseSystemdShowMany(
  'Id=readonly-collect.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\nStateChangeTimestamp=\nActiveEnterTimestamp=\nExecMainStartTimestamp=\nExecMainExitTimestamp=\nNRestarts=0\nExecCondition=\nRequiresMountsFor=\nBindPaths=\nBindReadOnlyPaths=\nReadOnlyPaths=/data/shein-bi/state /data/shein-bi/outputs\nInaccessiblePaths=\n',
  ['readonly-collect.service'],
  {code: 0},
);
assert.equal(readOnlyCollected['readonly-collect.service'].complete, true);
assert.equal(readOnlyCollected['readonly-collect.service'].ReadOnlyPaths, '/data/shein-bi/state /data/shein-bi/outputs');

const readOnlyOmitted = parseSystemdShowMany(
  'Id=readonly-omitted.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\nStateChangeTimestamp=\nActiveEnterTimestamp=\nExecMainStartTimestamp=\nExecMainExitTimestamp=\nNRestarts=0\nExecCondition=\nRequiresMountsFor=\nBindPaths=\nBindReadOnlyPaths=\nInaccessiblePaths=\n',
  ['readonly-omitted.service'],
  {code: 0},
);
assert.equal(readOnlyOmitted['readonly-omitted.service'].complete, true);
assert.equal(readOnlyOmitted['readonly-omitted.service'].ReadOnlyPaths, '');
// Exercise the real collector request: a handcrafted snapshot would hide an
// omitted systemctl property and falsely pass the intentional-pause policy.
const {intentionalCloudTimerPause} = await import('../lib/cloud_runtime_inventory.mjs');
const repairTimer = 'shein-bi-cloud-marketing-repair.timer';
for (const state of ['disabled', 'enabled', '']) {
  const collected = await collectSystemdUnitSnapshot([repairTimer], {
    execute: async args => args[0] === 'show'
      ? {code: 0, stdout: [
        `Id=${repairTimer}`, 'LoadState=loaded', 'ActiveState=inactive', 'SubState=dead',
        ...(args.some(arg => arg.startsWith('--property=') && arg.slice(11).split(',').includes('UnitFileState')) && state
          ? [`UnitFileState=${state}`] : []),
      ].join('\n'), stderr: ''}
      : {code: 0, stdout: `${repairTimer} ${state || 'disabled'} enabled\n`, stderr: ''},
  });
  assert.equal(collected.units[repairTimer].UnitFileState, state);
  assert.equal(Boolean(intentionalCloudTimerPause(repairTimer, collected.units[repairTimer])), state === 'disabled');
}
console.log(JSON.stringify({
  ok: true,
  unitCount: snapshot.requested.length,
  systemctlCommandCount: snapshot.commandCount,
  unexpectedInstalledCounterexample: true,
  missingInstalledCounterexample: true,
  unknownStateCounterexample: true,
}, null, 2));
