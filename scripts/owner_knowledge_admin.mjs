#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConfiguredLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {createOwnerKnowledgeService} from '../lib/owner_knowledge_service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {command: argv.shift() || 'status', authorityId: process.env.SHEIN_OWNER_KNOWLEDGE_PRINCIPAL || 'dushengyi', publisherUser: '', deviceId: '', deviceName: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--authority-id') args.authorityId = argv[++index];
    else if (arg === '--publisher-user') args.publisherUser = argv[++index];
    else if (arg === '--device-id') args.deviceId = argv[++index];
    else if (arg === '--device-name') args.deviceName = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const gateway = createConfiguredLinkOpsStoreGateway({env: process.env, rootDir: ROOT});
try {
  const health = await gateway.health();
  if (!health?.ok) throw new Error('Link Ops repository is unavailable');
  const service = createOwnerKnowledgeService({repository: gateway.repository, authorityId: args.authorityId});
  if (args.command === 'status') {
    console.log(JSON.stringify({ok: true, data: await service.status()}));
  } else if (args.command === 'issue-device') {
    if (!args.publisherUser || !args.deviceId) throw new Error('issue-device requires --publisher-user and --device-id');
    const actor = {username: args.publisherUser, displayName: args.publisherUser, role: 'owner', knowledgePublisher: true};
    const issued = await service.issueDevice({actor, actorUser: args.publisherUser, deviceId: args.deviceId, deviceName: args.deviceName});
    console.log(JSON.stringify(issued));
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
} finally {
  await gateway.close();
}
