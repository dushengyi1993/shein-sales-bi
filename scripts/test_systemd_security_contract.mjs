#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readUnit(name) {
  return fs.readFileSync(new URL(`../infra/systemd/${name}`, import.meta.url), 'utf8');
}

function property(unit, key) {
  const matches = [...unit.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))];
  assert.equal(matches.length, 1, `${key} must be declared exactly once`);
  return matches[0][1].trim();
}

function assertCommonHardening(unit, name) {
  assert.equal(property(unit, 'UMask'), '0027', `${name} must not create world-readable runtime secrets`);
  assert.equal(property(unit, 'ProtectSystem'), 'full');
  assert.equal(property(unit, 'ProtectKernelTunables'), 'true');
  assert.equal(property(unit, 'ProtectKernelModules'), 'true');
  assert.equal(property(unit, 'ProtectKernelLogs'), 'true');
  assert.equal(property(unit, 'ProtectControlGroups'), 'true');
  assert.equal(property(unit, 'ProtectClock'), 'true');
  assert.equal(property(unit, 'ProtectHostname'), 'true');
  assert.equal(property(unit, 'LockPersonality'), 'true');
  assert.equal(property(unit, 'RestrictRealtime'), 'true');
  assert.equal(property(unit, 'RestrictSUIDSGID'), 'true');
}

const portal = readUnit('shein-bi-portal.service');
assert.equal(property(portal, 'User'), 'sheinops');
assert.equal(property(portal, 'Group'), 'sheinops');
assert.equal(property(portal, 'OOMPolicy'), 'stop');
assertCommonHardening(portal, 'portal');
assert.doesNotMatch(portal, /^NoNewPrivileges=true$/m, 'portal uses audited sudo child commands and cannot enable this yet');
assert.doesNotMatch(portal, /^PrivateTmp=true$/m, 'portal browser maintenance must share the host temporary namespace');

const lark = readUnit('shein-bi-lark-sales-qa.service');
assert.equal(property(lark, 'User'), 'sheinops');
assert.equal(property(lark, 'Group'), 'sheinops');
assert.match(lark, /^Environment=HOME=\/home\/sheinops$/m);
assert.equal(property(lark, 'NoNewPrivileges'), 'true');
assert.equal(property(lark, 'PrivateTmp'), 'true');
assert.equal(property(lark, 'OOMPolicy'), 'stop');
assertCommonHardening(lark, 'lark bot');
assert.doesNotMatch(lark, /(?:Wants|After)=.*docker\.service/m, 'read-only Lark bot has no Docker dependency');
assert.doesNotMatch(lark, /HOME=\/root|^User=root$|^Group=root$/m, 'Lark bot must never run from root HOME');

console.log(JSON.stringify({ok: true, checked: ['shein-bi-portal.service', 'shein-bi-lark-sales-qa.service']}, null, 2));
