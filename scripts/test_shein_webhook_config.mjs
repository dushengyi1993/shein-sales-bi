#!/usr/bin/env node
import assert from 'node:assert/strict';
import {loadSheinWebhookCredentialRegistry} from '../lib/shein_webhook_config.mjs';

const registry = await loadSheinWebhookCredentialRegistry({config: {
  apps: {shared: {appId: 'app-shared', appSecretKey: 'secret-shared'}},
  stores: [
    {storeKey: 'AA', openKeyId: 'open-aa', appKey: 'shared'},
    {storeKey: 'BB', openKeyId: 'open-bb', app: {appId: 'app-bb', appSecretKey: 'secret-bb'}},
    {storeKey: 'CC', openKeyId: 'open-cc', appKey: 'shared'},
    {storeKey: 'OFF', enabled: false, openKeyId: 'open-off', appId: 'app-off', appSecretKey: 'secret-off'},
  ],
}});

assert.deepEqual(registry.summary, {appCount: 2, storeCount: 3, configFile: ''});
assert.equal(registry.resolve({'x-lt-appid': 'app-bb'}).storeKey, 'BB');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb'}).identityScope, 'app_only');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'synthetic-test-open-key'}).storeKey, 'BB');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'synthetic-test-open-key'}).identityScope, 'app_only');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'open-aa'}).storeKey, 'AA');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'open-aa'}).identityScope, 'store');
assert.equal(registry.resolve({'x-lt-openkeyid': 'open-cc'}).appId, 'app-shared');
assert.throws(() => registry.resolve({'x-lt-appid': 'app-shared'}), /multiple stores/);
assert.throws(() => registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'synthetic-test-open-key'}), /multiple stores/);
assert.throws(() => registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'open-aa'}), /mismatch/);
assert.throws(() => registry.resolve({'x-lt-appid': 'unknown'}), /Unknown/);
assert.equal(JSON.stringify(registry.summary).includes('secret'), false);

await assert.rejects(() => loadSheinWebhookCredentialRegistry({config: {
  stores: [
    {storeKey: 'AA', openKeyId: 'open-aa', appId: 'app-aa', appSecretKey: 'secret-aa'},
    {storeKey: 'AA', openKeyId: 'open-aa-2', appId: 'app-aa-2', appSecretKey: 'secret-aa-2'},
  ],
}}), /appears more than once/);

await assert.rejects(() => loadSheinWebhookCredentialRegistry({
  config: {stores: [{storeKey: 'AA', openKeyId: 'open-aa', appId: 'app-aa', appSecretKey: 'secret-aa'}]},
  expectedStoreKeys: ['AA', 'BB'],
}), /missing=BB/);

console.log('shein_webhook_config: app/store identity mapping passed');
