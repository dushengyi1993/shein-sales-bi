#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {loadSheinWebhookCredentialRegistry} from '../lib/shein_webhook_config.mjs';

const retiredAppId = 'app-retired';
const registry = await loadSheinWebhookCredentialRegistry({config: {
  webhookRetiredAppIdSha256: [
    crypto.createHash('sha256').update(retiredAppId, 'utf8').digest('hex'),
  ],
  apps: {
    shared: {
      appId: 'app-shared',
      appSecretKey: 'secret-shared',
      webhookValidationStoreKey: 'AA',
    },
  },
  stores: [
    {storeKey: 'AA', openKeyId: 'open-aa', appKey: 'shared'},
    {storeKey: 'BB', openKeyId: 'open-bb', app: {appId: 'app-bb', appSecretKey: 'secret-bb'}},
    {storeKey: 'CC', openKeyId: 'open-cc', appKey: 'shared'},
    {storeKey: 'OFF', enabled: false, openKeyId: 'open-off', appId: 'app-off', appSecretKey: 'secret-off'},
  ],
}});

assert.deepEqual(registry.summary, {appCount: 2, storeCount: 3, retiredAppCount: 1, configFile: ''});
assert.equal(registry.isRetiredApp({'x-lt-appid': retiredAppId}), true);
assert.equal(registry.isRetiredApp({'x-lt-appid': 'app-shared'}), false);
assert.equal(registry.isRetiredApp({}), false);
assert.equal(registry.resolve({'x-lt-appid': 'app-bb'}).storeKey, 'BB');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb'}).identityScope, 'app_only');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'synthetic-test-open-key'}).storeKey, 'BB');
assert.equal(registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'synthetic-test-open-key'}).identityScope, 'app_only');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'open-aa'}).storeKey, 'AA');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'open-aa'}).identityScope, 'store');
assert.equal(registry.resolve({'x-lt-openkeyid': 'open-cc'}).appId, 'app-shared');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared'}).storeKey, 'AA');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared'}).identityScope, 'app_only');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'synthetic-test-open-key'}).storeKey, 'AA');
assert.equal(registry.resolve({'x-lt-appid': 'app-shared', 'x-lt-openkeyid': 'synthetic-test-open-key'}).identityScope, 'app_only');
assert.throws(() => registry.resolve({'x-lt-appid': 'app-bb', 'x-lt-openkeyid': 'open-aa'}), /mismatch/);
assert.throws(() => registry.resolve({'x-lt-appid': 'unknown'}), /Unknown/);
assert.equal(JSON.stringify(registry.summary).includes('secret'), false);

const sharedWithoutValidationStore = await loadSheinWebhookCredentialRegistry({config: {
  apps: {shared: {appId: 'app-shared', appSecretKey: 'secret-shared'}},
  stores: [
    {storeKey: 'AA', openKeyId: 'open-aa', appKey: 'shared'},
    {storeKey: 'CC', openKeyId: 'open-cc', appKey: 'shared'},
  ],
}});
assert.throws(() => sharedWithoutValidationStore.resolve({
  'x-lt-appid': 'app-shared',
  'x-lt-openkeyid': 'synthetic-test-open-key',
}), /multiple stores/);

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

await assert.rejects(() => loadSheinWebhookCredentialRegistry({config: {
  apps: {
    shared: {
      appId: 'app-shared',
      appSecretKey: 'secret-shared',
      webhookValidationStoreKey: 'MISSING',
    },
  },
  stores: [
    {storeKey: 'AA', openKeyId: 'open-aa', appKey: 'shared'},
    {storeKey: 'CC', openKeyId: 'open-cc', appKey: 'shared'},
  ],
}}), /not authorized/);

await assert.rejects(() => loadSheinWebhookCredentialRegistry({config: {
  webhookRetiredAppIdSha256: ['not-a-sha256'],
  stores: [{storeKey: 'AA', openKeyId: 'open-aa', appId: 'app-aa', appSecretKey: 'secret-aa'}],
}}), /hash is invalid/);

await assert.rejects(() => loadSheinWebhookCredentialRegistry({config: {
  webhookRetiredAppIdSha256: [
    crypto.createHash('sha256').update('app-aa', 'utf8').digest('hex'),
  ],
  stores: [{storeKey: 'AA', openKeyId: 'open-aa', appId: 'app-aa', appSecretKey: 'secret-aa'}],
}}), /also marked as retired/);

console.log('shein_webhook_config: app/store identity mapping passed');

const dualConfig = {
  apps:{OWN:{appId:'own-app',appSecretKey:'own-secret'},DL:{appId:'central-app',appSecretKey:'central-secret',webhookValidationStoreKey:'AA'}},
  stores:[{storeKey:'AA',appKey:'OWN',openKeyId:'own-open'}],
  webhookAdditionalAuthorizations:[{storeKey:'AA',appKey:'DL',openKeyId:'central-open'}],
  webhookDeduplicationAppKey:'DL',
};
const dual=await loadSheinWebhookCredentialRegistry({config:dualConfig,expectedStoreKeys:['AA']});
assert.equal(dual.summary.storeCount,1);
assert.equal(dual.summary.appCount,2);
assert.equal(dual.resolve({'x-lt-appid':'own-app','x-lt-openkeyid':'own-open'}).credentialRole,'primary');
assert.equal(dual.resolve({'x-lt-openkeyid':'central-open'}).credentialRole,'backup');
assert.deepEqual(dual.resolve({'x-lt-openkeyid':'own-open'}).deduplicationHeaders,{'x-lt-appid':'central-app','x-lt-openkeyid':'central-open'});
assert.throws(()=>dual.resolve({'x-lt-appid':'own-app','x-lt-openkeyid':'central-open'}),/mismatch/);
await assert.rejects(()=>loadSheinWebhookCredentialRegistry({config:{...dualConfig,webhookAdditionalAuthorizations:[...dualConfig.webhookAdditionalAuthorizations,...dualConfig.webhookAdditionalAuthorizations]}}),/Duplicate store\/app/);
await assert.rejects(()=>loadSheinWebhookCredentialRegistry({config:{...dualConfig,webhookAdditionalAuthorizations:[]}}),/Canonical webhook/);
