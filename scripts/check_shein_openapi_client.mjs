#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildAuthorizationUrl,
  buildGetByTokenHeaders,
  buildSignedHeaders,
  decryptSheinSecretKey,
  encryptSheinSecretKeyForTest,
  generateSheinSignature,
} from '../lib/shein_openapi_client.mjs';

const deterministicExample = generateSheinSignature({
  openKeyId: 'OPENKEY',
  secretKey: 'SECRET',
  path: '/open-api/order/purchase-order-info',
  timestamp: '1740709414000',
  randomKey: 'test1',
});

assert.equal(
  deterministicExample.hex,
  '3d1458d722718ab1e8ca109fdf900f137da6cf8be7905a6fba663634c649d00e',
  '签名 HEX 不一致',
);
assert.equal(
  deterministicExample.signature,
  'test1M2QxNDU4ZDcyMjcxOGFiMWU4Y2ExMDlmZGY5MDBmMTM3ZGE2Y2Y4YmU3OTA1YTZmYmE2NjM2MzRjNjQ5ZDAwZQ==',
  '签名不一致',
);

const signedHeaders = buildSignedHeaders({
  openKeyId: 'OPENKEY',
  secretKey: 'SECRET',
  path: 'open-api/order/order-list',
  timestamp: '1740709414000',
  randomKey: 'abc12',
});
assert.equal(signedHeaders.headers['Content-Type'], 'application/json;charset=UTF-8');
assert.equal(signedHeaders.headers['x-lt-openKeyId'], 'OPENKEY');
assert.equal(signedHeaders.headers['x-lt-timestamp'], '1740709414000');
assert.match(signedHeaders.headers['x-lt-signature'], /^abc12/);

const getByTokenHeaders = buildGetByTokenHeaders({
  appId: 'APPID',
  appSecretKey: 'APPSECRET',
  timestamp: '1740709414000',
  randomKey: 'app99',
});
assert.equal(getByTokenHeaders.headers['x-lt-appid'], 'APPID');
assert.equal(getByTokenHeaders.signed.path, '/open-api/auth/get-by-token');

const encrypted = encryptSheinSecretKeyForTest('plain-store-secret', 'app-secret-key-1234567890');
assert.equal(decryptSheinSecretKey(encrypted, 'app-secret-key-1234567890'), 'plain-store-secret');

const authUrl = buildAuthorizationUrl({
  env: 'test',
  appId: 'APPID',
  redirectUrl: 'https://example.com/callback',
  state: 'AUTH-SHEIN-TEST',
});
assert.ok(authUrl.startsWith('https://openapi-sem-test01.dotfashion.cn/#/empower?'));
assert.ok(authUrl.includes('appid=APPID'));
assert.ok(authUrl.includes('state=AUTH-SHEIN-TEST'));
const authQuery = new URLSearchParams(authUrl.split('?')[1]);
assert.equal(authQuery.get('redirectUrl'), Buffer.from('https://example.com/callback', 'utf8').toString('base64'));

console.log(JSON.stringify({
  ok: true,
  checked: [
    'official-signature-example',
    'normal-api-headers',
    'get-by-token-headers',
    'aes-secret-key-decrypt',
    'authorization-url',
  ],
}, null, 2));
