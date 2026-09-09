#!/usr/bin/env node
// Offline focused test: real source cache/identity helpers and repository CAS;
// the CLI transport is injected, so no listener, network or business task is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {loadOpenApiProductDetail, buildProductDraftFromSnapshots} from '../lib/link_ops_product_draft_mapper.mjs';
import {buildProductAliasContext, resolveExplicitProductAlias, areDistinctProductModels} from '../lib/link_ops_product_attribute_binding.mjs';
import {writeOpenApiProductCacheAtomically, updateOpenApiProductCacheAtomically, readOpenApiProductCache} from '../lib/shein_openapi_product_cache.mjs';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {LinkOpsValidationError} from '../lib/link_ops_repository.mjs';

const portal = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');
const cli = await fs.readFile(new URL('./bi_ops_cli.mjs', import.meta.url), 'utf8');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-lock-recovery-'));
const auditFile = path.join(root, 'audit.jsonl');
const cacheDir = path.join(root, 'cache');
const OLD = 'sb20990101000000001';
const NEW = 'sb20990101000000002';
const aliases = buildProductAliasContext({
  aliasRegistryJson: {aliases: [{canonical: 'MODEL-A', aliases: ['MODEL-A', 'MODEL-A-ALIAS']}, {canonical: 'MODEL-B', aliases: ['MODEL-B']}]},
  catalogJson: {standards: ['MODEL-A', 'MODEL-B']},
  aliasRegistryFingerprint: 'a'.repeat(64), catalogFingerprint: 'b'.repeat(64),
});
const context = vm.createContext({
  fs, Date, Set, Map, JSON, Number, String, Boolean, Object, Array,
  asArray: value => Array.isArray(value) ? value : [],
  actorLabel: () => 'test', actorUser: () => 'test', actorHasGlobalOpsView: () => true,
  requireReadStores: (_actor, stores) => stores.includes('NO') ? {error: 'read denied'} : null,
  normalizeConcreteStoreKeys: values => values,
  LINK_MAINTENANCE_INTENTS: new Set(),
  LINK_OPS_PROTECTED_TASK_PATCH_FIELDS: new Set(),
  LINK_OPS_RESTRICTED_LIFECYCLE_STATUSES: new Set(['submitted_but_readback_pending', 'submitted_readback_failed', 'suspicious_write_attempted', 'needs_manual_resolve']),
  LINK_OPS_ALLOWED_STATUSES: new Set(['draft', 'confirmed', 'in_progress', 'waiting_review', 'done', 'archived']),
  loadProductAliasContextSync: () => aliases,
  loadOpenApiProductDetail: (store, skc, options) => loadOpenApiProductDetail(store, skc, {...options, cacheDir}),
  resolveOpenApiProductCacheFile: store => path.join(cacheDir, store, 'latest.json'),
  updateOpenApiProductCacheAtomically,
  openApiClientForConfiguredStore: () => { throw new Error('unexpected live call'); },
  verifyOpenApiStoreIdentityForUtility: () => { throw new Error('unexpected identity call'); },
  resolveExplicitProductAlias, areDistinctProductModels, LinkOpsValidationError,
  sanitizeLinkOpsClientText: value => value,
});
const names = ['normalizeStandardGoodsSnDisplayRef', 'normalizeLinkOpsAttributeOverrides', 'normalizeLinkOpsTargetSet',
  'normalizeTargetsForIntents', 'normalizeProgress', 'appendTaskHistory', 'isOwnerActor',
  'taskRequiresOwnerLifecycleResolve', 'descriptionBindingWriteEvidence', 'sourceLockWriteEvidence',
  'taskCannotRepeatRealExecution',
  'patchLinkOpsTask', 'portalExactCopySourceLock', 'compactSourceDetailLock',
  'descriptionBindingHistoricalAuditEvidence', 'verifySourceLockReplacement',
  'readSourceLockLiveDetail', 'sourceLockProductIdentity', 'cacheSourceLockLiveDetail',
  'repositoryRevisionAtRequestStart', 'linkOpsGatewayMethod', 'updateLinkOpsTaskRecord'];
vm.runInContext(names.map(name => extract(portal, name)).join('\n'), context);
const clone = value => JSON.parse(JSON.stringify(value));
const checks = [];
let compactFixtureEvidence;
async function check(name, work) { await work(); checks.push(name); }
function task() {
  return {id: 'lot_source_lock_test', ownerUser: 'test', repositoryRevision: 1,
    status: 'waiting_review', intents: ['copy_product_draft'],
    targets: {sourceStores: ['AA'], sourceSkc: OLD, stores: ['CC'], writeStores: ['CC'], productRefs: ['MODEL-A'],
      publishPreparation: {standardGoodsSn: 'MODEL-A', titleGroup: 'title1', inventory: 11, supplyPrice: 9}},
    parameters: {inventory: 11, supplyPrice: 9}, command: 'reviewed business facts',
    assets: [{originalName: 'reviewed.png', mime: 'image/png', sourceApproved: true, sha256: 'c'.repeat(64)}],
    execution: {state: 'preflight_ready', preflight: {ok: true}, openApiProductExecutors: [{result: {mode: 'dry-run', state: 'ready_for_submit', payload: {payloadHash: 'd'.repeat(64)}}}]},
    history: [{event: 'openapi_product_preflight_ready', writeAudit: {executorEvidence: [{mode: 'dry-run', payloadHash: 'e'.repeat(64)}]}}]};
}
function body(t = task()) { return {event: 'lock_source_skc_cli', sourceStore: 'BB', sourceSkc: NEW,
  expectedRevision: t.repositoryRevision, expectedSource: {sourceStores: clone(t.targets.sourceStores), sourceSkc: t.targets.sourceSkc}}; }
function patch(t = task(), b = body(t)) { return context.patchLinkOpsTask(t, b, {}, {}); }
async function detail(code = 'MODEL-A-ALIAS', options = {}) {
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  await writeOpenApiProductCacheAtomically(path.join(cacheDir, 'BB', 'latest.json'), {
    ok: true, storeKey: 'BB', fetchedAt,
    detailFallbackResults: [],
    normalizedRows: [{storeKey: 'BB', spu: 'v209901010001', skc: NEW}],
    detailResults: [{ok: true, detailFetchedAt: fetchedAt, info: {spuName: 'v209901010001',
      supplierCode: code, skcInfoList: [{skcName: options.skc || NEW, supplierCode: code}]}}],
  }, {storeKey: 'BB', generatedAt: fetchedAt});
}
try {
  await fs.writeFile(auditFile, '');
  await detail();
  await check('cache hit never fetches live detail', async () => {
    const t = task(); await context.verifySourceLockReplacement(t, patch(t), {auditFile});
  });
  const cacheFile = path.join(cacheDir, 'BB', 'latest.json');
  const otherSkc = 'sb20990101000000003';
  const oldStamp = new Date(Date.now() - 3600000).toISOString();
  const otherRow = {storeKey: 'BB', skc: otherSkc, spu: 'v209901010003', fetchedAt: oldStamp,
    sourceCompleteness: {detailFetchedAt: oldStamp}, sheinUsableInventory: 17};
  const otherDetail = {ok: true, detailFetchedAt: oldStamp, info: {spuName: otherRow.spu,
    skcInfoList: [{skcName: otherSkc, supplierCode: 'MODEL-B'}]}};
  async function missingCache() {
    await writeOpenApiProductCacheAtomically(cacheFile, {ok: true, storeKey: 'BB', fetchedAt: oldStamp,
      normalizedRows: [otherRow], detailResults: [otherDetail], detailFallbackResults: [],
      productList: [{spuName: otherRow.spu}], stockResponses: [{preserved: true}]}, {storeKey: 'BB', generatedAt: oldStamp});
  }
  function liveInfo() {
    return {spuName: 'v209901010001', supplierCode: 'MODEL-A', categoryId: 13127, productTypeId: 9851,
      brandCode: '2a64l', productMultiNameList: [{language: 'en', productName: 'Fixture source'}, {language: 'ar', productName: 'منتج'}],
      productAttributeInfoList: [{attributeId: 1000546, attributeValue: 'MODEL-A', attributeValueId: 0}, {attributeId: 160, attributeValueId: 62}],
      skcInfoList: [{skcName: NEW, supplierCode: 'MODEL-A', skcImageInfoList: [
        {imageUrl: 'https://example.invalid/main.jpg', imageType: 'MAIN'},
        {imageUrl: 'https://example.invalid/square.jpg', imageType: 'SQUARE'}],
        skuInfoList: [{skuCode: 'SKU-FIXTURE', length: 10, width: 10, height: 10, weight: 1000,
          costInfoList: [{currency: 'SAR', costPrice: 90}], saleAttributeList: [{attributeId: 27, attributeValueId: 536}]}]}]};
  }
  let liveCalls = [];
  function installLive({identity = {ok: true}, mutateSearch, mutateDetail, failSearch = false, failDetail = false, beforeDetail} = {}) {
    liveCalls = [];
    context.openApiClientForConfiguredStore = store => {
      assert.equal(store, 'BB');
      return {store: {storeKey: store}, client: {request: async (endpoint, options) => {
        liveCalls.push(endpoint);
        if (endpoint.endsWith('/searchProduct')) {
          assert.deepEqual(clone(options.body.skcNameList), [NEW]);
          // Minimal product shape observed in the owner's redacted controlled
          // search result; identifiers/values below are synthetic.
          const result = {ok: !failSearch, data: {code: failSearch ? '1' : '0', info: {data: [{spuName: 'v209901010001',
            spuShelfStatus: 1, categoryId: 13127, skcList: [{skcName: NEW, skcShelfStatus: 1, supplierCode: 'MODEL-A', skuList: []}]}]}}};
          mutateSearch?.(result); return result;
        }
        assert.equal(endpoint, '/open-api/goods/spu-info');
        assert.equal(options.body.spuName, 'v209901010001');
        await beforeDetail?.();
        const result = {ok: !failDetail, data: {code: failDetail ? '1' : '0', info: liveInfo()}};
        mutateDetail?.(result); return result;
      }}};
    };
    context.verifyOpenApiStoreIdentityForUtility = async () => { liveCalls.push('identity'); return identity; };
  }
  await check('cache miss exact live read merges target and supports subsequent mapper payload', async () => {
    await missingCache(); installLive();
    const t = task(); const next = patch(t);
    await context.verifySourceLockReplacement(t, next, {auditFile});
    assert.deepEqual(liveCalls, ['identity', '/open-api/goods/searchProduct', '/open-api/goods/spu-info']);
    const current = (await readOpenApiProductCache(cacheFile, {expectedStore: 'BB'})).data;
    assert.equal(current.generatedAt, oldStamp); assert.equal(current.fetchedAt, oldStamp);
    assert.deepEqual(current.normalizedRows.find(row => row.skc === otherSkc), otherRow);
    assert.deepEqual(current.detailResults.find(row => row.info.spuName === otherRow.spu), otherDetail);
    assert.deepEqual(current.stockResponses, [{preserved: true}]);
    const loaded = await loadOpenApiProductDetail('BB', NEW, {cacheDir});
    assert.equal(loaded.matchedSkcName, NEW);
    const draft = await buildProductDraftFromSnapshots({sourceStore: 'BB', sourceSkc: NEW, targetStore: 'CC',
      date: '2099-01-01', cacheDir});
    assert.equal(draft.sourceDetailLock.matchedSkcName, NEW);
    assert.equal(draft.canonicalDraft.source.skc, NEW);
    assert.equal(draft.readyForOpenApiSubmit, true, draft.blockers.join(' | '));
    const oldOutputDir = process.env.SHEIN_BI_OUTPUT_DIR;
    const oldCacheDir = process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR;
    const oldSelfTest = process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST;
    try {
      process.env.SHEIN_BI_OUTPUT_DIR = path.join(root, 'mapper');
      process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR = cacheDir;
      process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST = '1';
      const linkDir = path.join(process.env.SHEIN_BI_OUTPUT_DIR, 'shein_links', 'BB');
      await fs.mkdir(linkDir, {recursive: true});
      await fs.writeFile(path.join(linkDir, '2099-01-01.json'), JSON.stringify({linkRows: [], inventoryRows: [], performanceRows: []}));
      const {findOrBuildPublishPayload} = await import('./link_ops_hl_openapi_executor.mjs');
      const subsequent = await findOrBuildPublishPayload({...clone(next), assets: []}, {targetStore: 'CC'});
      assert.ok(subsequent.payload, subsequent.generationError);
      assert.equal(subsequent.sourceDetailLock.matchedSkcName, NEW);
    } finally {
      for (const [key, value] of [['SHEIN_BI_OUTPUT_DIR', oldOutputDir], ['SHEIN_OPENAPI_PRODUCT_CACHE_DIR', oldCacheDir], ['SHEIN_LINK_OPS_EXECUTOR_SELF_TEST', oldSelfTest]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    // Independent subsequent read requires no live transport.
    context.openApiClientForConfiguredStore = () => { throw new Error('cache hit fetched'); };
    await context.verifySourceLockReplacement(t, patch(t), {auditFile});
  });
  for (const [label, options] of [
    ['wrong identity', {identity: {ok: false}}], ['skipped identity', {identity: {ok: true, skipped: true}}],
    ['failed search', {failSearch: true}], ['failed detail', {failDetail: true}],
    ['wrong search SKC', {mutateSearch: r => r.data.info.data[0].skcList[0].skcName = OLD}],
    ['ambiguous search', {mutateSearch: r => r.data.info.data.push(clone(r.data.info.data[0]))}],
    ['wrong detail SKC', {mutateDetail: r => r.data.info.skcInfoList[0].skcName = OLD}],
    ['wrong detail SPU', {mutateDetail: r => r.data.info.spuName = 'vwrong'}],
    ['wrong product', {mutateSearch: r => r.data.info.data[0].skcList[0].supplierCode = 'MODEL-B',
      mutateDetail: r => { r.data.info.supplierCode = 'MODEL-B'; r.data.info.skcInfoList[0].supplierCode = 'MODEL-B'; }}],
  ]) await check(`live ${label} leaves cache and original task unchanged`, async () => {
    await missingCache(); const bytes = await fs.readFile(cacheFile, 'utf8'); installLive(options);
    const t = task(); const before = clone(t);
    await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile}));
    assert.equal(await fs.readFile(cacheFile, 'utf8'), bytes); assert.deepEqual(t, before);
    if (label.includes('identity')) assert.deepEqual(liveCalls, ['identity']);
  });
  await check('concurrent cache writer is preserved by locked re-read and unrelated timestamps do not advance', async () => {
    await missingCache();
    let releaseWriter, writerStarted;
    const waiting = new Promise(resolve => { releaseWriter = resolve; });
    const entered = new Promise(resolve => { writerStarted = resolve; });
    const concurrentRow = {skc: 'sb20990101000000004', spu: 'v209901010004', fetchedAt: oldStamp};
    const writer = updateOpenApiProductCacheAtomically(cacheFile, async current => {
      writerStarted(); await waiting; return {...current, normalizedRows: [...current.normalizedRows, concurrentRow]};
    }, {storeKey: 'BB'});
    await entered;
    installLive({beforeDetail: async () => { releaseWriter(); await writer; }});
    const t = task(); await context.verifySourceLockReplacement(t, patch(t), {auditFile});
    const current = (await readOpenApiProductCache(cacheFile)).data;
    assert.deepEqual(current.normalizedRows.find(row => row.skc === concurrentRow.skc), concurrentRow);
    assert.equal(current.generatedAt, oldStamp); assert.equal(current.normalizedRows.find(row => row.skc === otherSkc).fetchedAt, oldStamp);
  });
  await check('separate process cache writer shares the cache merge lock', async () => {
    await missingCache();
    const childScript = `import {updateOpenApiProductCacheAtomically} from ${JSON.stringify(new URL('../lib/shein_openapi_product_cache.mjs', import.meta.url).href)};
      await updateOpenApiProductCacheAtomically(process.argv[1], async current => {
        process.stdout.write('locked\\n');
        await new Promise(resolve => process.stdin.once('data', resolve));
        return {...current, concurrentMarker: 'child'};
      }, {storeKey: 'BB'});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, cacheFile], {stdio: ['pipe', 'pipe', 'pipe']});
    let errorText = '';
    child.stderr.on('data', bytes => { errorText += bytes; });
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errorText || `child exit ${code}`))); });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(errorText)); }); });
    const live = {info: liveInfo(), skcInfo: liveInfo().skcInfoList[0], matchedSpuName: 'v209901010001', detailFetchedAt: new Date().toISOString()};
    const merging = context.cacheSourceLockLiveDetail({sourceStore: 'BB', sourceSkc: NEW}, live);
    child.stdin.end('release'); await ended; await merging;
    const current = (await readOpenApiProductCache(cacheFile)).data;
    assert.equal(current.concurrentMarker, 'child');
    assert.ok(await loadOpenApiProductDetail('BB', NEW, {cacheDir}));
    assert.deepEqual(current.normalizedRows.find(row => row.skc === otherSkc), otherRow);
  });
  await check('absent store cache can be created without inventing other product timestamps', async () => {
    await fs.unlink(cacheFile); installLive();
    const t = task(); await context.verifySourceLockReplacement(t, patch(t), {auditFile});
    const current = (await readOpenApiProductCache(cacheFile)).data;
    assert.equal(current.normalizedRows.length, 1); assert.equal(current.normalizedRows[0].skc, NEW);
  });
  await check('target detail replacement preserves same-SPU siblings and their original detail timestamp', async () => {
    await missingCache();
    const sibling = {skcName: otherSkc, supplierCode: 'MODEL-B', unchanged: 'sibling'};
    await updateOpenApiProductCacheAtomically(cacheFile, current => ({...current,
      detailResults: [{ok: true, detailFetchedAt: oldStamp, info: {spuName: 'v209901010001',
        skcInfoList: [{skcName: NEW, supplierCode: 'MODEL-A'}, sibling]}}]}), {storeKey: 'BB'});
    const info = liveInfo();
    await context.cacheSourceLockLiveDetail({sourceStore: 'BB', sourceSkc: NEW}, {
      info, skcInfo: info.skcInfoList[0], matchedSpuName: info.spuName, detailFetchedAt: new Date().toISOString()});
    const current = (await readOpenApiProductCache(cacheFile)).data;
    const preserved = current.detailResults.find(row => row.info.skcInfoList.some(skc => skc.skcName === otherSkc));
    assert.deepEqual(preserved.info.skcInfoList, [sibling]); assert.equal(preserved.detailFetchedAt, oldStamp);
    assert.equal(current.generatedAt, oldStamp);
    assert.equal((await loadOpenApiProductDetail('BB', NEW, {cacheDir})).skcInfo.supplierCode, 'MODEL-A');
  });
  context.openApiClientForConfiguredStore = () => { throw new Error('unexpected live call'); };
  await detail();
  await check('actual compact check DTO planned_not_run semantics do not imply submission', () => {
    const projected = {preflight: {ok: false}, execution: {mode: 'openapi_product_executor', state: 'blocked',
      writeAudit: {requestedMode: 'check', submitted: false, executeAllowed: false, actualWriteSubmitted: false,
        issuedExecuteToExecutor: false, sheinWriteAttempted: false},
      openApiProductExecutors: [{mode: 'check', state: 'blocked', status: '',
        payload: {found: false, payloadHash: '', payloadHashAlgorithm: ''},
        readback: {ok: false, status: 'planned_not_run', pendingReview: false, descriptionReadback: null},
        publishResult: null}], linkMaintenancePrechecks: [], linkMaintenanceExecutors: []}};
    assert.equal(context.sourceLockWriteEvidence(projected).ok, true);
    const t = task(); t.preflight = projected.preflight; t.execution = projected.execution;
    assert.equal(patch(t).targets.sourceSkc, NEW);
    projected.execution.openApiProductExecutors[0].result = {state: 'failed', execution: {status: 'error'}};
    assert.equal(context.sourceLockWriteEvidence(projected).ok, true, 'nested failure inherits check');
  });
  const fixtureArg = process.argv.indexOf('--task-fixture');
  if (fixtureArg >= 0) await check('read-only owner compact DTO evidence semantics (not complete persisted state)', async () => {
    const bytes = await fs.readFile(process.argv[fixtureArg + 1]);
    const dto = JSON.parse(bytes.toString('utf8'));
    assert.equal(dto.preflight?.ok, false);
    // Deliberately do not patch this DTO: omitted history/bindings say nothing
    // about complete persistent task state or source-replacement eligibility.
    const observed = {preflight: dto.preflight, execution: dto.execution};
    assert.equal(context.sourceLockWriteEvidence(observed).ok, true);
    compactFixtureEvidence = {sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      repositoryRevision: dto.repositoryRevision, mode: dto.execution?.mode,
      requestedMode: dto.execution?.writeAudit?.requestedMode, state: dto.execution?.state,
      completePersistentStateVerified: false};
  });
  assert.ok((await loadOpenApiProductDetail('BB', NEW, {cacheDir, includeConflict: true}))?.info, 'fixture exact detail must resolve');
  await check('first lock remains compatible without expectedSource', () => {
    const t = task(); t.targets.sourceSkc = ''; t.targets.sourceStores = ['BB'];
    const b = body(t); delete b.expectedSource;
    assert.equal(patch(t, b).targets.sourceSkc, NEW);
  });
  await check('same source is idempotent without resetting evidence', () => {
    const t = task(); const b = {...body(t), sourceStore: 'AA', sourceSkc: OLD};
    assert.equal(patch(t, b), t);
  });
  for (const kind of ['missing', 'expired-fallback']) {
    await check(`same source ${kind} hydrates exact detail without changing task evidence`, async () => {
      await missingCache(); installLive();
      if (kind === 'expired-fallback') await updateOpenApiProductCacheAtomically(cacheFile, cache => ({...cache,
        detailFallbackResults: [{ok: true, detailFetchedAt: '2000-01-01T00:00:00Z', info: liveInfo()}],
      }), {storeKey: 'BB'});
      assert.equal(await loadOpenApiProductDetail('BB', NEW, {cacheDir}), null);
      const t = task(); t.targets.sourceStores = ['BB']; t.targets.sourceSkc = NEW;
      const before = clone(t); const next = patch(t, body(t));
      const receipt = await context.verifySourceLockReplacement(t, next, {auditFile});
      assert.deepEqual(t, before); assert.equal(next, t);
      assert.equal(receipt.sourceSkc, NEW);
      assert.equal(receipt.productIdentity.canonical, 'MODEL-A');
      assert.deepEqual(liveCalls, ['identity', '/open-api/goods/searchProduct', '/open-api/goods/spu-info']);
      assert.equal((await loadOpenApiProductDetail('BB', NEW, {cacheDir})).matchedSkcName, NEW);
      const priorCalls = liveCalls.length;
      await context.verifySourceLockReplacement(t, patch(t, body(t)), {auditFile});
      assert.equal(liveCalls.length, priorCalls, 'fresh same-source replay does not fetch again');
    });
  }
  await check('same source refresh failure leaves original cache and task intact', async () => {
    await missingCache(); installLive({failDetail: true});
    const beforeCache = await fs.readFile(cacheFile, 'utf8');
    const t = task(); t.targets.sourceStores = ['BB']; t.targets.sourceSkc = NEW;
    const before = clone(t);
    await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t, body(t)), {auditFile}));
    assert.deepEqual(t, before); assert.equal(await fs.readFile(cacheFile, 'utf8'), beforeCache);
  });
  await detail();
  await check('unbound replacement verifies identity and preserves business facts/raw reviewed assets', async () => {
    const t = task(); const n = patch(t);
    await context.verifySourceLockReplacement(t, n, {auditFile});
    assert.deepEqual(clone(n.targets), {...t.targets, sourceStores: ['BB'], sourceSkc: NEW});
    for (const key of ['parameters', 'command', 'assets', 'status']) assert.deepEqual(n[key], t[key]);
    assert.equal(n.execution.state, 'needs_repreflight');
    assert.equal(n.execution.openapiPayloadHash, undefined);
    assert.equal(n.execution.openApiProductExecutors.length, 0);
    assert.equal(n.history.some(row => row.event === 'openapi_product_preflight_ready'), false);
    const audit = n.history.find(row => row.event === 'source_lock_changed');
    assert.deepEqual(clone(audit.oldSource), {sourceStores: ['AA'], sourceSkc: OLD});
    assert.equal(audit.productIdentity.canonical, 'MODEL-A');
    assert.equal(t.history[0].event, 'openapi_product_preflight_ready');
  });
  for (const [label, mutate] of [
    ['revision conflict', b => b.expectedRevision++],
    ['old SKC conflict', b => b.expectedSource.sourceSkc = NEW],
    ['old store conflict', b => b.expectedSource.sourceStores = ['BB']],
    ['missing old source', b => delete b.expectedSource],
    ['mixed business mutation', b => b.command = 'change product'],
    ['unreadable new store', b => b.sourceStore = 'NO'],
  ]) await check(label, () => { const b = body(); mutate(b); assert.throws(() => patch(task(), b)); });
  for (const key of ['descriptionMaterialBinding', 'openapiPublishPayload', 'sheinOpenapiPublishPayload',
    'publishPayload', 'publishOrEditPayload', 'publishAssetBinding', 'productAttributeBinding',
    'descriptionUpdatePayloadRef', 'emptyDescriptionAuthorization']) {
    await check(`bound protection ${key}`, () => { const t = task(); t[key] = {}; assert.throws(() => patch(t)); });
  }
  await check('reviewed JSON payload asset is protected', () => {
    const t = task(); t.assets.push({originalName: 'publish.json', sourceApproved: true}); assert.throws(() => patch(t));
  });
  for (const [label, mutate] of [
    ['done', t => t.status = 'done'], ['archived', t => t.status = 'archived'],
    ['terminal lifecycle', t => t.lifecycle = {terminal: true}],
    ['write claim', t => t.execution.writeClaim = {}],
    ['ordinary state residual submit', t => t.execution.actualWriteSubmitted = true],
    ['history submit', t => t.executionHistory = [{actualWriteSubmitted: true}]],
    ['nested result submission', t => t.history.push({result: {writeAudit: {submitted: true}}})],
    ['explicit prevalidation rejection still blocked', t => t.history.push({state: 'publish_pre_valid_failed', publishResult: {info: {success: false}}})],
    ['aborted unknown', t => t.executionHistory = [{aborted: true}]],
    ['unknown state', t => t.executionHistory = [{state: 'unknown'}]],
    ['execute without result', t => t.executionHistory = [{mode: 'execute'}]],
    ['failed without known dry run', t => t.executionHistory = [{state: 'failed'}]],
    ['malformed write flag', t => t.execution.actualWriteSubmitted = 'false'],
    ['opaque execution evidence', t => t.execution = 'unknown'],
    ['malformed historical entry', t => t.executionHistory = [null]],
    ['historical readback identity', t => t.executionHistory = [{readbackFingerprint: {publishSkcNames: [NEW]}}]],
  ]) await check(label, () => { const t = task(); mutate(t); assert.throws(() => patch(t)); });
  for (const [label, code, options] of [
    ['different product', 'MODEL-B', {}], ['missing alias', 'UNREGISTERED', {}],
    ['missing source supplier', '', {}], ['wrong exact SKC', 'MODEL-A', {skc: OLD}],
  ]) await check(label, async () => {
    await detail(code, options); const t = task(); await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile}));
  });
  await detail();
  await check('cache detail age follows existing loader contract without a new 24h gate', async () => {
    await detail('MODEL-A', {fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString()});
    const t = task(); await context.verifySourceLockReplacement(t, patch(t), {auditFile});
    await detail();
  });
  await check('first exactdetail preflight failure and nested readonly failures can recover', async () => {
    const t = task();
    // Match executeLinkOpsTask's persisted dry-run result, writeAudit,
    // controlled_execution_run and executor_blocked projections. The nested
    // query failures have no mode of their own and must inherit dry-run.
    const run = {storeKey: 'CC', mode: 'dry-run', result: {
      ok: false, state: 'blocked', payload: {found: false, generationError: 'exact_source_snapshot_error'},
      evidence: {sourceDetailLockGate: {ok: false, blockers: [{code: 'SOURCE_DETAIL_LOCK_MISSING'}]},
        exactdetail: {state: 'failed', error: {status: 'error'}}},
      execution: {state: 'failed', result: {status: 'error'}},
      publishResult: null, readback: {status: 'not_requested'},
    }};
    const writeAudit = {requestedMode: 'dry-run', issuedExecuteToExecutor: false, sheinWriteAttempted: false,
      actualWriteSubmitted: false, submitted: false, executorEvidence: [run]};
    t.execution = {state: 'blocked', writeAudit, openApiProductExecutors: [run], hlOpenApiExecutor: run.result};
    t.executionHistory = [{event: 'controlled_execution_run', requestedMode: 'dry-run', finalState: 'blocked',
      submitted: false, actualWriteSubmitted: false, issuedExecuteToExecutor: false, sheinWriteAttempted: false,
      executorRuns: [run]}];
    t.history = [{event: 'executor_blocked', writeAudit, openApiProductExecutors: [run]}];
    t.planning = {mode: 'execute', terminal: true, outcome: {state: 'failed'}};
    await fs.writeFile(auditFile, JSON.stringify({task: {id: t.id}, execution: t.execution}) + '\n');
    const n = patch(t); await context.verifySourceLockReplacement(t, n, {auditFile});
    assert.equal(n.targets.sourceSkc, NEW); assert.deepEqual(n.planning, t.planning);
    // A real/unknown historical executor does not borrow the current dry-run.
    t.executionHistory.push({event: 'controlled_execution_run', executorRuns: [{mode: 'execute', aborted: true}]});
    assert.throws(() => patch(t));
    await fs.writeFile(auditFile, '');
  });
  await check('missing task identity blocks', async () => {
    const t = task(); t.targets.productRefs = []; delete t.targets.publishPreparation;
    await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile}));
  });
  for (const entry of [{taskId: task().id, mode: 'execute'}, {task: {id: task().id}, execution: {aborted: true}}]) {
    await check('append-only old audit blocks ordinary current task', async () => {
      await fs.writeFile(auditFile, JSON.stringify(entry) + '\n'); const t = task();
      await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile}));
    });
  }
  await check('missing/malformed historical audit fails closed', async () => {
    const t = task(); await fs.writeFile(auditFile, '{broken');
    await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile}));
    await assert.rejects(() => context.verifySourceLockReplacement(t, patch(t), {auditFile: path.join(root, 'missing')}));
  });
  await fs.writeFile(auditFile, '');
  await check('replacement persists and reads back through real repository', async () => {
    const repository = createLinkOpsJsonRepository({rootDir: path.join(root, 'success-repo')});
    const gateway = createLinkOpsStoreGateway({repository});
    const original = await gateway.createTaskRecord(task(), {actorUser: 'test'});
    const replacement = patch(original, body(original));
    await context.verifySourceLockReplacement(original, replacement, {auditFile});
    const saved = await context.updateLinkOpsTaskRecord({linkOpsStoreGateway: gateway}, original, clone(replacement), 'test');
    const readback = (await gateway.readTaskStore()).tasks[0];
    assert.equal(readback.repositoryRevision, saved.repositoryRevision);
    assert.equal(readback.targets.sourceSkc, NEW);
    assert.deepEqual(readback.assets, original.assets);
    assert.equal(readback.history.find(row => row.event === 'source_lock_changed').productIdentity.canonical, 'MODEL-A');
  });
  await check('concurrent binding wins repository CAS and is never overwritten', async () => {
    const repository = createLinkOpsJsonRepository({rootDir: path.join(root, 'repo')});
    const gateway = createLinkOpsStoreGateway({repository});
    const original = await gateway.createTaskRecord(task(), {actorUser: 'test'});
    const replacement = patch(original, body(original));
    await context.verifySourceLockReplacement(original, replacement, {auditFile});
    const bound = await gateway.updateTaskRecord(original.id, {...original, publishAssetBinding: {bindingFingerprint: 'f'.repeat(64)}},
      {expectedRevision: original.repositoryRevision, actorUser: 'test'});
    await assert.rejects(() => context.updateLinkOpsTaskRecord({linkOpsStoreGateway: gateway}, original, clone(replacement), 'test'), /revision|conflict/i);
    assert.equal(bound.targets.sourceSkc, OLD);
    const current = await gateway.readTaskStore();
    assert.equal(current.tasks[0].publishAssetBinding.bindingFingerprint, 'f'.repeat(64));
    assert.throws(() => patch(current.tasks[0], body(current.tasks[0])));
  });
  await check('CLI reads live old-source CAS, dry-runs then reads original task back', async () => {
    const t = task(); const saved = patch(t); saved.repositoryRevision = 2;
    let calls = []; let output;
    const ctx = vm.createContext({
      request: async (_args, route, options) => {
        calls.push({route, options});
        if (calls.length === 1) return {json: {data: {tasks: [t]}}};
        if (calls.length === 2) { assert.deepEqual(JSON.parse(JSON.stringify(options.body.expectedSource)), body(t).expectedSource); assert.equal(options.body.expectedRevision, 1); return {json: {task: saved}}; }
        if (calls.length === 3) { assert.equal(options.body.mode, 'dry-run'); return {json: {ok: true, task: saved, execution: saved.execution}}; }
        return {json: {data: {tasks: [saved]}}};
      }, print: value => output = value, LINK_OPS_DEFERRED_OUTCOMES: new Set(),
    });
    vm.runInContext(['linkOpsExecutionResponse', 'linkOpsExecutionSummary', 'runLockSource'].map(name => extract(cli, name)).join('\n'), ctx);
    await ctx.runLockSource({taskId: t.id, sourceStores: ['BB'], sourceSkcs: [NEW]});
    assert.equal(calls.length, 4); assert.equal(output.task.id, t.id); assert.equal(output.safety.realPublishOccurred, false);
    for (const [label, readbackTasks] of [['missing', []], ['drift', [t]]]) {
      calls = []; output = undefined;
      const successfulRequest = ctx.request;
      ctx.request = async (...args) => {
        if (calls.length === 3) { calls.push({route: args[1]}); return {json: {data: {tasks: readbackTasks}}}; }
        return successfulRequest(...args);
      };
      await assert.rejects(() => ctx.runLockSource({taskId: t.id, sourceStores: ['BB'], sourceSkcs: [NEW]}), /回读缺失或漂移/);
      assert.equal(output, undefined, label);
      ctx.request = successfulRequest;
    }
  });
  console.log(JSON.stringify({ok: true, checks: checks.length, cases: checks, compactFixtureEvidence}, null, 2));
} finally {
  // Only this test's freshly allocated OS temp directory is removed.
  await fs.rm(root, {recursive: true, force: true});
}
