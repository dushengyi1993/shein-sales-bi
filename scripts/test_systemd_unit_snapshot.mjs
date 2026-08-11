#!/usr/bin/env node
import assert from 'node:assert/strict';

import {collectSystemdUnitSnapshot, parseSystemdShowMany} from '../lib/systemd_unit_snapshot.mjs';

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
`;

const parsed = parseSystemdShowMany(fixture, [
  'shein-bi-portal.service', 'shein-bi-webhook.service', 'missing.service',
], {code: 1, stderr: 'one unit missing'});
assert.equal(parsed['shein-bi-portal.service'].ActiveState, 'active');
assert.equal(parsed['shein-bi-webhook.service'].Result, 'exit-code');
assert.equal(parsed['missing.service'].LoadState, 'unknown');
assert.equal(parsed['not-found.service'].LoadState, 'not-found');
assert.equal(parsed['not-found.service'].complete, true);
assert.equal(parsed['not-found.service'].ok, false);

const incomplete = parseSystemdShowMany('Id=partial.service\nLoadState=loaded\n', ['partial.service'], {code: 1});
assert.equal(incomplete['partial.service'].complete, false);
assert.ok(incomplete['partial.service'].missingProperties.includes('ActiveState'));

const aliasMismatch = parseSystemdShowMany(
  'Id=canonical.service\nLoadState=loaded\nActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\nStateChangeTimestamp=\nActiveEnterTimestamp=\nExecMainStartTimestamp=\nExecMainExitTimestamp=\n',
  ['alias.service'],
  {code: 0},
);
assert.equal(aliasMismatch['alias.service'].complete, false);
assert.equal(aliasMismatch['canonical.service'].complete, true);

let calls = 0;
const snapshot = await collectSystemdUnitSnapshot([
  'shein-bi-portal.service', 'shein-bi-webhook.service', 'shein-bi-portal.service',
], {
  execute: async args => {
    calls += 1;
    assert.equal(args[0], 'show');
    assert.equal(args.filter(value => value === 'shein-bi-portal.service').length, 1);
    return {code: 1, stdout: fixture, stderr: 'one unrelated unit was not found'};
  },
});
assert.equal(calls, 1);
assert.equal(snapshot.commandCount, 1);
assert.equal(snapshot.requested.length, 2);
assert.equal(snapshot.units['shein-bi-portal.service'].ok, true);
assert.equal(snapshot.ok, true, 'nonzero command semantics are evaluated per complete unit block');

console.log(JSON.stringify({ok: true, unitCount: snapshot.requested.length, systemctlCommandCount: snapshot.commandCount}, null, 2));
