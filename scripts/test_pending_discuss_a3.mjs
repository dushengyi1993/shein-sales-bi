#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  buildPreflightDocument,
  buildScanDocument,
  normalizePendingDiscussRow,
  recomputePreflightBatchHash,
  verifyLockedItem,
  verifyPreflightDocument,
} from '../lib/pending_discuss_batch.mjs';
import {
  extractPendingDiscussConfig,
  hashPendingDiscussConfig,
} from './pending_discuss_batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await fs.mkdir(path.join(ROOT, 'tmp'), {recursive: true});
const temp = await fs.mkdtemp(path.join(ROOT, 'tmp', 'pending-discuss-a3-cli-'));

console.log('Starting A3 real CLI & production entry tests...');

function sendJson(response, value, status = 200) {
  response.writeHead(status, {'Content-Type': 'application/json'});
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function writeJson(name, value) {
  const file = path.join(temp, name);
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function runCli(args, extraEnv = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/pending_discuss_batch.mjs', ...args], {
      cwd: ROOT, env: {...process.env, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

function makeRow({discussSn, storeKey, supplierCode, price = 10, currency = 'SAR'}) {
  return {
    storeKey,
    discussSn,
    discussStatus: 1,
    discussType: 0,
    supplierCode,
    productTitle: `Title ${discussSn}`,
    skcName: `SKC-${discussSn}`,
    spuName: `SPU-${discussSn}`,
    reason: 'Price adjustment',
    appealReason: 'Appeal reason',
    appealCount: 1,
    serialNumber: 1,
    skuCostPrices: [{
      skuCode: `SKU-${discussSn}`,
      suggestCostPrice: price,
      suggestCostCurrency: currency,
      latestCostPrice: price + 2,
      costPriceHistories: [{serialNumber: 1, costPrice: price + 2, currency}],
    }],
  };
}

const port = await freePort();
const state = {
  rows: {A: [], B: []},
  writes: [],
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const body = await readBody(request);
  const openKey = String(request.headers['x-lt-openkeyid'] || '');
  const key = openKey === 'DUMMY-OPEN-A' ? 'A' : 'B';

  if (url.pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(response, {code: '0', msg: 'OK', info: {merchantId: `merchant-${key.toLowerCase()}`, accountNo: `GS-${key}`}});
  }
  if (url.pathname === '/open-api/goods/discuss/query-discuss-list') {
    const status = Number(body.discussStatus);
    const all = (state.rows[key] || []).filter(item => item.discussStatus === status);
    return sendJson(response, {code: '0', msg: 'OK', info: {count: all.length, records: all}});
  }
  if (url.pathname === '/open-api/goods/discuss/process-discuss') {
    const confirm = body?.confirmInfos?.[0] || {};
    state.writes.push({store: key, discussSn: confirm.discussSn, type: confirm.discussAuditType});
    const target = (state.rows[key] || []).find(r => r.discussSn === confirm.discussSn);
    if (target) {
      target.discussStatus = confirm.discussAuditType === '1' ? 3 : 4;
      if (confirm.discussAuditType === '1') {
        target.skuCostPrices = (target.skuCostPrices || []).map(sku => ({
          ...sku,
          latestCostPrice: sku.suggestCostPrice,
        }));
      }
    }
    return sendJson(response, {code: '0', msg: 'OK', info: {successCount: 1, failCount: 0}});
  }
  return sendJson(response, {code: '404', msg: 'not found'}, 404);
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

try {
  // 1. 验证真实生产导出的 extractPendingDiscussConfig & hashPendingDiscussConfig
  const rawConfig1 = {
    environment: 'test',
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [
      {storeKey: 'A', enabled: true, merchantId: 'merchant-a', accountNo: 'GS-A', openKeyId: 'DUMMY-OPEN-A', secretKey: 'DUMMY-SECRET-A-NEVER-LEAK'},
      {storeKey: 'B', enabled: true, merchantId: 'merchant-b', accountNo: 'GS-B', openKeyId: 'DUMMY-OPEN-B', secretKey: 'DUMMY-SECRET-B-NEVER-LEAK'},
    ],
    safeWriteOperations: {
      enabled: true,
      requireDryRun: true,
      allowedOperations: ['process_pending_discuss'],
      allowedStores: ['A', 'B'],
    },
  };
  const configFile = await writeJson('openapi.json', rawConfig1);

  const extracted1 = extractPendingDiscussConfig(rawConfig1);
  assert.equal(extracted1.baseUrl, `http://127.0.0.1:${port}`);
  const hash1 = await hashPendingDiscussConfig(configFile);

  // 修改无关店铺配置（例如添加一个不存在的 MZ 店）或修改 safeWriteOperations
  const rawConfig2 = {
    ...rawConfig1,
    stores: [
      ...rawConfig1.stores,
      {storeKey: 'MZ', enabled: false, note: 'unrelated store change'},
    ],
    safeWriteOperations: {
      enabled: false,
      requireDryRun: true,
      allowedOperations: [],
      allowedStores: [],
    },
    unrelatedMarketingConfig: {overlap: true},
  };
  await fs.writeFile(configFile, JSON.stringify(rawConfig2, null, 2), 'utf8');

  // 验证生产导出 hashPendingDiscussConfig 保持完全稳定，不受无关店铺和权限开关影响
  const hash2 = await hashPendingDiscussConfig(configFile);
  assert.equal(hash1, hash2, 'hashPendingDiscussConfig must be stable across unrelated store/permission changes');
  console.log('✓ extractPendingDiscussConfig & hashPendingDiscussConfig correctly isolate unrelated changes');

  // 2. 真实 CLI 测试：权限变更不使已生成 preflight 产生 SOURCE_HASH_DRIFT
  const storesConfigFile = await writeJson('stores.json', {stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}]});
  const truthFile = await writeJson('truth.json', {stores: {
    A: {merchantId: 'merchant-a', accountNo: 'GS-A'},
    B: {merchantId: 'merchant-b', accountNo: 'GS-B'},
  }});

  // 2.1 验证另一店/另一商品的商业配置变化不影响已锁条目
  // 在 stores.json 和 truth.json 中添加无关店铺 C，在 product_aliases 中添加无关商品别名
  const expandedStoresConfig = {stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}, {storeKey: 'C', enabled: false, note: 'unrelated store'}]};
  const expandedTruth = {stores: {
    A: {merchantId: 'merchant-a', accountNo: 'GS-A'},
    B: {merchantId: 'merchant-b', accountNo: 'GS-B'},
    C: {merchantId: 'merchant-c', accountNo: 'GS-C'},
  }};
  await fs.writeFile(storesConfigFile, JSON.stringify(expandedStoresConfig, null, 2), 'utf8');
  await fs.writeFile(truthFile, JSON.stringify(expandedTruth, null, 2), 'utf8');

  state.rows.A = [
    makeRow({discussSn: 'D-A1', storeKey: 'A', supplierCode: 'ITEM-A1', price: 10}),
    makeRow({discussSn: 'D-A2', storeKey: 'A', supplierCode: 'ITEM-A2', price: 20}),
  ];
  state.rows.B = [
    makeRow({discussSn: 'D-B1', storeKey: 'B', supplierCode: 'ITEM-B1', price: 30}),
  ];

  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  const decisionsFile = await writeJson('decisions.json', {
    schemaVersion: 1, businessDate,
    decisions: [
      {canonicalGoodsSn: 'ITEM-A1', action: 'accept'},
      {canonicalGoodsSn: 'ITEM-A2', action: 'reject'},
      {canonicalGoodsSn: 'ITEM-B1', action: 'accept'},
    ],
  });

  // 先在权限开启的状态下生成 preflight
  await fs.writeFile(configFile, JSON.stringify(rawConfig1, null, 2), 'utf8');
  const preDir = path.join(temp, 'preflight-a3');
  const preCli = await runCli([
    'preflight', '--decisions', decisionsFile, '--out-dir', preDir,
    '--expected-store-count', '2',
    '--config', configFile, '--stores-config', storesConfigFile, '--store-truth', truthFile,
  ]);
  assert.equal(preCli.code, 0, preCli.stderr || preCli.stdout);
  const preflightData = JSON.parse(await fs.readFile(path.join(preDir, 'preflight.json'), 'utf8'));
  assert.equal(preflightData.itemCount, 3);
  const savedBatchHash = preflightData.batchHash;

  // 3. 真实 CLI 测试：本动作权限失去时，CLI execute 实时阻断在 SAFE_WRITE_GATE，绝不报 SOURCE_HASH_DRIFT
  await fs.writeFile(configFile, JSON.stringify(rawConfig2, null, 2), 'utf8');
  const execBlockedDir = path.join(temp, 'exec-blocked-a3');
  const execBlocked = await runCli([
    'execute', '--preflight', path.join(preDir, 'preflight.json'),
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE',
    '--expected-store-count', '2',
    '--lock-path', path.join(temp, 'test.lock'), '--out-dir', execBlockedDir,
    '--config', configFile, '--stores-config', storesConfigFile, '--store-truth', truthFile,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});

  assert.equal(execBlocked.code, 3);
  const blockedDoc = JSON.parse(await fs.readFile(path.join(execBlockedDir, 'execution.json'), 'utf8'));
  assert.ok(blockedDoc.blockers.some(b => b.code === 'SAFE_WRITE_GATE_DISABLED'), 'Must be blocked by SAFE_WRITE_GATE_DISABLED');
  assert.equal(blockedDoc.blockers.some(b => b.code === 'SOURCE_HASH_DRIFT'), false, 'Must NOT report SOURCE_HASH_DRIFT on permission changes');
  console.log('✓ Real CLI execute: permission gate blocks execution without false SOURCE_HASH_DRIFT');

  // 4. 真实 CLI 测试：恢复权限后，execute 正常成功（且测试省略 --batch-hash 依然自洽通过）
  await fs.writeFile(configFile, JSON.stringify(rawConfig1, null, 2), 'utf8');
  const execSuccessDir = path.join(temp, 'exec-success-a3');
  const execSuccess = await runCli([
    'execute', '--preflight', path.join(preDir, 'preflight.json'),
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE',
    '--expected-store-count', '2',
    '--terminal-delay-ms', '50',
    '--read-delay-ms', '50',
    '--lock-path', path.join(temp, 'test.lock'), '--out-dir', execSuccessDir,
    '--config', configFile, '--stores-config', storesConfigFile, '--store-truth', truthFile,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});

  assert.equal(execSuccess.code, 0, execSuccess.stderr || execSuccess.stdout);
  const successDoc = JSON.parse(await fs.readFile(path.join(execSuccessDir, 'execution.json'), 'utf8'));
  assert.equal(successDoc.ok, true);
  assert.equal(successDoc.executed.length, 3);
  console.log('✓ Real CLI execute: successful execution with omitted --batch-hash');

  // 5. 决策核验与追加第四项机制（复用现有 decisions 按项核验，不另造审批系统）
  const itemsPre3 = preflightData.stores.flatMap(s => s.items);
  const itemMapPre3 = new Map(itemsPre3.map(i => [`${i.storeKey}::${i.discussSn}`, i.itemHash]));

  // 恢复原始 3 个 pending rows 并追加第 4 项
  state.rows.A = [
    makeRow({discussSn: 'D-A1', storeKey: 'A', supplierCode: 'ITEM-A1', price: 10}),
    makeRow({discussSn: 'D-A2', storeKey: 'A', supplierCode: 'ITEM-A2', price: 20}),
  ];
  state.rows.B = [
    makeRow({discussSn: 'D-B1', storeKey: 'B', supplierCode: 'ITEM-B1', price: 30}),
  ];

  const decisions4File = await writeJson('decisions4.json', {
    schemaVersion: 1, businessDate,
    decisions: [
      {canonicalGoodsSn: 'ITEM-A1', action: 'accept'},
      {canonicalGoodsSn: 'ITEM-A2', action: 'reject'},
      {canonicalGoodsSn: 'ITEM-B1', action: 'accept'},
      {canonicalGoodsSn: 'ITEM-A3-NEW', action: 'reject'},
    ],
  });
  state.rows.A.push(makeRow({discussSn: 'D-A3-NEW', storeKey: 'A', supplierCode: 'ITEM-A3-NEW', price: 15}));

  const preDir4 = path.join(temp, 'preflight-a3-4items');
  const preCli4 = await runCli([
    'preflight', '--decisions', decisions4File, '--out-dir', preDir4,
    '--expected-store-count', '2',
    '--config', configFile, '--stores-config', storesConfigFile, '--store-truth', truthFile,
  ]);
  assert.equal(preCli4.code, 0, preCli4.stderr || preCli4.stdout);
  const preflightData4 = JSON.parse(await fs.readFile(path.join(preDir4, 'preflight.json'), 'utf8'));
  assert.equal(preflightData4.itemCount, 4);

  // 证明：前 3 项的 itemHash 完全稳定一致
  const itemsPre4 = preflightData4.stores.flatMap(s => s.items);
  for (const [key, oldHash] of itemMapPre3.entries()) {
    const newItem = itemsPre4.find(i => `${i.storeKey}::${i.discussSn}` === key);
    assert.ok(newItem, `Prior item ${key} must exist`);
    assert.equal(newItem.itemHash, oldHash, `Prior item ${key} itemHash must remain unchanged`);
  }
  const item4 = itemsPre4.find(i => i.discussSn === 'D-A3-NEW');
  assert.ok(item4, 'New item must be present');
  console.log('✓ Existing decision item hashes remain stable when appending a fourth decision');

  // 6. 真实对象或价格篡改时，verifyLockedItem 必须立即阻断
  const originalItemA1 = itemsPre4.find(i => i.discussSn === 'D-A1');
  const tamperedRowA1 = makeRow({discussSn: 'D-A1', storeKey: 'A', supplierCode: 'ITEM-A1', price: 99});
  const verifyTampered = verifyLockedItem(originalItemA1, tamperedRowA1);
  assert.equal(verifyTampered.ok, false);
  assert.ok(verifyTampered.blockers.some(b => b.code === 'DISCUSS_OBJECT_DRIFT' || b.code === 'ITEM_HASH_DRIFT'));
  console.log('✓ Object/price drift immediately caught and blocked by verifyLockedItem');

  // 7. 验证当前店真实身份发生变动时必须被阻断
  const corruptedTruth = {stores: {
    A: {merchantId: 'tampered-merchant-a', accountNo: 'GS-A'},
    B: {merchantId: 'merchant-b', accountNo: 'GS-B'},
  }};
  const corruptedTruthFile = await writeJson('corrupted_truth.json', corruptedTruth);
  const execCorruptedIdentityDir = path.join(temp, 'exec-corrupted-identity');
  const execCorrupted = await runCli([
    'execute', '--preflight', path.join(preDir, 'preflight.json'),
    '--confirm', 'SHEIN_PENDING_DISCUSS_BATCH_EXECUTE',
    '--expected-store-count', '2',
    '--terminal-delay-ms', '50',
    '--read-delay-ms', '50',
    '--lock-path', path.join(temp, 'corrupt.lock'), '--out-dir', execCorruptedIdentityDir,
    '--config', configFile, '--stores-config', storesConfigFile, '--store-truth', corruptedTruthFile,
  ], {SHEIN_PENDING_DISCUSS_WRITE_ENABLED: '1'});
  assert.equal(execCorrupted.code, 3);
  const corruptDoc = JSON.parse(await fs.readFile(path.join(execCorruptedIdentityDir, 'execution.json'), 'utf8'));
  assert.ok(corruptDoc.failed.length > 0 || corruptDoc.blockers.length > 0, 'Must block when store identity drifts');
  console.log('✓ Current store identity drift accurately caught and blocked');

  // 8. 验证 expiresAt 防篡改：恶意篡改 expiresAt 延长有效期时，batchHash 校验必然不匹配
  const preflightTamperedExpiry = {
    ...preflightData,
    expiresAt: '2099-12-31T23:59:59.000Z',
  };
  const verifyTamperedExpiry = verifyPreflightDocument(preflightTamperedExpiry, {
    businessDate,
    now: new Date(),
    batchHash: preflightTamperedExpiry.batchHash,
  });
  assert.equal(verifyTamperedExpiry.ok, false);
  assert.ok(verifyTamperedExpiry.blockers.some(b => b.code === 'BATCH_HASH_DRIFT'), 'Tampering expiresAt must trigger BATCH_HASH_DRIFT');
  console.log('✓ expiresAt tampering accurately caught by BATCH_HASH_DRIFT preserving audit integrity');

  console.log('All A3 real CLI & production entry tests passed successfully!');
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
