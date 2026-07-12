import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsPostgresRepository} from '../lib/link_ops_repository.mjs';
import {createOwnerKnowledgeService} from '../lib/owner_knowledge_service.mjs';
import {buildOwnerKnowledgeDistribution} from '../lib/owner_knowledge_distribution.mjs';

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-knowledge-service-'));
try {
  const repository = createLinkOpsJsonRepository({rootDir});
  const service = createOwnerKnowledgeService({repository, authorityId: 'dushengyi'});
  const publisher = {username: '杜圣宜', role: 'owner', knowledgePublisher: true};
  const outsider = {username: '其他Owner', role: 'owner'};

  await assert.rejects(
    () => service.ingest([{text: '以后默认这样处理。'}], {actor: outsider}),
    error => error?.code === 'OWNER_KNOWLEDGE_PUBLISH_FORBIDDEN'
  );

  const first = await service.ingest([{
    text: '以后商品图片排序必须先主图，再按卖点、参数、场景组织细节图。',
    sourceKind: 'owner_bi_message',
    sourceId: 'message-1',
  }], {actor: publisher});
  assert.equal(first.results[0].activation, 'active');
  assert.equal(first.bundle.ruleCount, 1);

  const firstBundle = await service.getActiveBundle({question: '图片怎么排序'}, {all: true});
  assert.equal(firstBundle.rules.length, 1);
  assert.match(firstBundle.rules[0].text, /先主图/);

  const candidate = await service.ingest([{
    text: '这次平台字段似乎发生了变化。',
    sourceKind: 'owner_codex_final',
  }], {actor: publisher});
  assert.equal(candidate.results[0].activation, 'candidate');
  assert.equal(candidate.bundle.ruleCount, 1, 'candidate cannot alter active bundle');

  const superseded = await service.ingest([{
    text: '以后商品图片排序必须先主图，然后按场景、卖点、参数组织细节图。',
    sourceKind: 'owner_bi_message',
    sourceId: 'message-2',
  }], {actor: publisher});
  assert.equal(superseded.bundle.ruleCount, 1, 'same rule key is superseded, not duplicated');
  const latest = await service.getActiveBundle({}, {all: true});
  assert.equal(latest.rules.length, 1);
  assert.match(latest.rules[0].text, /场景、卖点、参数/);
  assert.notEqual(latest.fingerprint, firstBundle.fingerprint);

  const staleReplay = await service.ingest([{
    text: '以后商品图片排序必须先主图，然后只按旧的参数、场景顺序组织细节图。',
    sourceKind: 'owner_codex_session',
    sourceId: 'old-replayed-session',
    sourceAt: '2020-01-01T00:00:00.000Z',
  }], {actor: publisher});
  assert.equal(staleReplay.results[0].ignoredStale, true, 'older replay cannot replace the current owner rule');
  const afterStaleReplay = await service.getActiveBundle({}, {all: true});
  assert.equal(afterStaleReplay.fingerprint, latest.fingerprint);
  assert.match(afterStaleReplay.rules[0].text, /场景、卖点、参数/);

  const futureReplay = await service.ingest([{
    text: '以后商品图片排序必须先主图，然后按旧的参数、场景顺序组织细节图。',
    sourceKind: 'owner_codex_session',
    sourceId: 'future-dated-old-session',
    sourceAt: '2099-01-01T00:00:00.000Z',
    explicitDurable: true,
    activation: 'active',
  }], {actor: publisher});
  assert.equal(futureReplay.results[0].activation, 'candidate', 'future-dated rules are quarantined');
  assert.equal(futureReplay.results[0].published, false);
  const afterFutureReplay = await service.getActiveBundle({}, {all: true});
  assert.equal(afterFutureReplay.fingerprint, latest.fingerprint);
  assert.match(afterFutureReplay.rules[0].text, /场景、卖点、参数/);

  const issued = await service.issueDevice({actor: publisher, deviceId: 'office-pc', deviceName: '办公室电脑'});
  assert.match(issued.token, /^okd\.office-pc\./);
  const deviceActor = await service.authenticateBearer(issued.token);
  assert.equal(deviceActor.role, 'knowledge_device');
  assert.equal(deviceActor.knowledgePublisher, true);
  assert.equal(await service.authenticateBearer(issued.token + 'tampered'), null);
  await assert.rejects(
    () => service.issueDevice({actor: deviceActor, deviceId: 'nested-device'}),
    error => error?.code === 'OWNER_KNOWLEDGE_DEVICE_ENROLL_FORBIDDEN'
  );

  const deviceResult = await service.ingest([{
    text: '以后同事操作只影响当前任务，不能反向覆盖负责人规则。',
    sourceKind: 'owner_local_sync',
    sourceId: 'local-session-1',
  }], {actor: deviceActor, deviceId: 'office-pc'});
  assert.equal(deviceResult.results[0].activation, 'active');

  const status = await service.status();
  assert.equal(status.activeRules, 2);
  assert.equal(status.candidates, 2);
  assert.equal(status.activeDevices, 1);
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(status.distribution.ready, true);
  assert.equal(status.distribution.current, true);
  assert.equal(status.distribution.source, 'runtime');
  assert.equal(status.distribution.fingerprint, status.fingerprint);

  const githubRepository = createLinkOpsJsonRepository({rootDir: path.join(rootDir, 'github-distribution')});
  let published = null;
  let publishNumber = 0;
  const fakeGitPublisher = {
    branch: 'owner-knowledge',
    async publish(activeBundle) {
      const built = buildOwnerKnowledgeDistribution(activeBundle);
      if (published?.manifest?.fingerprint === built.manifest.fingerprint) {
        return {...published, manifest: built.manifest, bundle: built.bundle, changed: false};
      }
      publishNumber += 1;
      published = {
        source: 'github',
        branch: 'owner-knowledge',
        sourceCommit: String(publishNumber).padStart(40, String(publishNumber)),
        manifest: built.manifest,
        bundle: built.bundle,
        changed: true,
      };
      return published;
    },
  };
  const githubService = createOwnerKnowledgeService({repository: githubRepository, authorityId: 'dushengyi', distributionPublisher: fakeGitPublisher});
  const githubFirst = await githubService.ingest([{
    text: '以后所有真实提交必须先完成系统检查。',
    sourceAt: '2026-07-12T00:00:00.000Z',
    explicitDurable: true,
  }], {actor: publisher});
  assert.equal(githubFirst.distribution.current, false, 'GitHub publication is pending until CI activation');
  assert.equal(githubFirst.distribution.pending, true);
  const firstPublication = structuredClone(published);
  const activated = await githubService.activatePendingDistribution({
    sourceCommit: firstPublication.sourceCommit,
    fingerprint: firstPublication.manifest.fingerprint,
    bundleSha256: firstPublication.manifest.bundleSha256,
  });
  assert.equal(activated.current, true);
  assert.equal(activated.source, 'github');
  const forcedSame = await githubService.ensureDistribution({actorUser: 'owner-knowledge-test', force: true});
  assert.equal(forcedSame.current, true, 'force publishing unchanged GitHub content remains current');
  assert.equal(forcedSame.pending, undefined, 'force publishing unchanged GitHub content does not create a ghost pending record');
  assert.equal(forcedSame.sourceCommit, firstPublication.sourceCommit);
  const afterForcedSame = await githubService.distributionManifest();
  assert.equal(afterForcedSame.pending, false);

  const githubSecond = await githubService.ingest([{
    text: '以后所有真实提交必须先完成系统检查、明确确认并强回读。',
    sourceAt: '2026-07-12T01:00:00.000Z',
    explicitDurable: true,
  }], {actor: publisher});
  assert.equal(githubSecond.distribution.current, false, 'new active rule makes the prior GitHub distribution stale');
  await assert.rejects(
    () => githubService.activatePendingDistribution({
      sourceCommit: firstPublication.sourceCommit,
      fingerprint: firstPublication.manifest.fingerprint,
      bundleSha256: firstPublication.manifest.bundleSha256,
    }),
    error => error?.code === 'OWNER_KNOWLEDGE_ACTIVATION_STALE'
  );
  const secondPublication = structuredClone(published);
  const secondActivated = await githubService.activatePendingDistribution({
    sourceCommit: secondPublication.sourceCommit,
    fingerprint: secondPublication.manifest.fingerprint,
    bundleSha256: secondPublication.manifest.bundleSha256,
  });
  assert.equal(secondActivated.current, true);
  assert.equal(secondActivated.sourceCommit, secondPublication.sourceCommit);

  const preparedStatements = new Map();
  const queryConfigs = [];
  const fakePgClient = {
    async query(config) {
      queryConfigs.push(config);
      if (config?.name) {
        const previous = preparedStatements.get(config.name);
        if (previous && previous !== config.text) throw new Error(`prepared statement ${config.name} changed SQL shape`);
        preparedStatements.set(config.name, config.text);
      }
      return {rows: [], rowCount: 0};
    },
  };
  const postgresRepository = createLinkOpsPostgresRepository({client: fakePgClient});
  await postgresRepository.listRecords('owner_knowledge_rule_version', {ownerUser: 'dushengyi'});
  await postgresRepository.listRecords('owner_knowledge_rule_current', {ownerUser: 'dushengyi', status: 'active'});
  assert.equal(queryConfigs.length, 2);
  assert.ok(queryConfigs.every(config => !config.name), 'dynamic listRecords queries must remain unnamed');

  console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_service', status}));
} finally {
  await fs.rm(rootDir, {recursive: true, force: true});
}
