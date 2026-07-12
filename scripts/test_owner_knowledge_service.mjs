import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLinkOpsJsonRepository} from '../lib/link_ops_json_repository.mjs';
import {createLinkOpsPostgresRepository} from '../lib/link_ops_repository.mjs';
import {createOwnerKnowledgeService} from '../lib/owner_knowledge_service.mjs';

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
  assert.equal(status.candidates, 1);
  assert.equal(status.activeDevices, 1);
  assert.match(status.fingerprint, /^[a-f0-9]{64}$/);

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
