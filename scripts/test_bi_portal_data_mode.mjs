#!/usr/bin/env node

import assert from 'node:assert/strict';

import {resolveBiPortalDataMode} from '../lib/bi_portal_data_mode.mjs';

const production = {
  root: '/opt/shein-bi/app',
  outDir: '/opt/shein-bi/app/outputs/bi-portal',
  platform: 'linux',
};

assert.deepEqual(resolveBiPortalDataMode(production), {
  mode: 'api',
  source: 'formal-cloud-default',
}, 'an omitted formal cloud mode must never downgrade the API core');

assert.deepEqual(resolveBiPortalDataMode({...production, cliMode: 'legacy'}), {
  mode: 'api',
  source: 'formal-cloud-guard',
}, 'even a wrapper-reified legacy CLI value cannot downgrade the formal core');

assert.deepEqual(resolveBiPortalDataMode({...production, envMode: 'legacy'}), {
  mode: 'api',
  source: 'formal-cloud-guard',
}, 'an inherited legacy environment cannot silently downgrade the formal core');

assert.deepEqual(resolveBiPortalDataMode({...production, cliMode: 'api', envMode: 'legacy'}), {
  mode: 'api',
  source: 'cli',
}, 'the explicit CLI flag must win over the environment');

assert.deepEqual(resolveBiPortalDataMode({
  ...production,
  outDir: '/tmp/bi-portal-legacy-diagnostic',
  cliMode: 'legacy',
}), {mode: 'legacy', source: 'cli'}, 'legacy diagnostics remain available only outside the formal output');

assert.deepEqual(resolveBiPortalDataMode({
  ...production,
  root: '/tmp/shein-bi',
  outDir: '/tmp/shein-bi/outputs/bi-portal',
}), {mode: 'legacy', source: 'default'}, 'non-production Linux output keeps compatibility');

assert.deepEqual(resolveBiPortalDataMode({
  root: 'E:\\Codex WorkSpace\\Shein销售统计',
  outDir: 'E:\\Codex WorkSpace\\Shein销售统计\\outputs\\bi-portal',
  platform: 'win32',
}), {mode: 'legacy', source: 'default'}, 'Windows/local static generation keeps compatibility');

assert.throws(() => resolveBiPortalDataMode({...production, cliMode: 'unsafe'}), /Invalid --data-mode: unsafe/);

console.log('bi_portal_data_mode: formal cloud defaults to api and explicit/local legacy compatibility passed');
