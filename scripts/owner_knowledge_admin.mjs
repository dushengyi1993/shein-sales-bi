#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createConfiguredLinkOpsStoreGateway} from '../lib/link_ops_store_gateway.mjs';
import {createOwnerKnowledgeService} from '../lib/owner_knowledge_service.mjs';
import {createOwnerKnowledgeGitPublisher} from '../lib/owner_knowledge_distribution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    command: argv.shift() || 'status',
    authorityId: process.env.SHEIN_OWNER_KNOWLEDGE_PRINCIPAL || 'dushengyi',
    publisherUser: '',
    deviceId: '',
    deviceName: '',
    gitRepoDir: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR || '',
    gitBranch: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_BRANCH || 'owner-knowledge',
    gitRemote: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_REMOTE || 'origin',
    gitLockFile: process.env.SHEIN_OWNER_KNOWLEDGE_GIT_LOCK_FILE || '',
    force: false,
    planFile: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--authority-id') args.authorityId = argv[++index];
    else if (arg === '--publisher-user') args.publisherUser = argv[++index];
    else if (arg === '--device-id') args.deviceId = argv[++index];
    else if (arg === '--device-name') args.deviceName = argv[++index];
    else if (arg === '--git-repo-dir') args.gitRepoDir = path.resolve(argv[++index]);
    else if (arg === '--git-branch') args.gitBranch = argv[++index];
    else if (arg === '--git-remote') args.gitRemote = argv[++index];
    else if (arg === '--git-lock-file') args.gitLockFile = path.resolve(argv[++index]);
    else if (arg === '--force') args.force = true;
    else if (arg === '--plan') args.planFile = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const gateway = createConfiguredLinkOpsStoreGateway({env: process.env, rootDir: ROOT});
try {
  const health = await gateway.health();
  if (!health?.ok) throw new Error('Link Ops repository is unavailable');
  const distributionPublisher = args.gitRepoDir ? createOwnerKnowledgeGitPublisher({
    repoDir: args.gitRepoDir,
    branch: args.gitBranch,
    remote: args.gitRemote,
    lockFile: args.gitLockFile,
  }) : null;
  const service = createOwnerKnowledgeService({repository: gateway.repository, authorityId: args.authorityId, distributionPublisher});
  if (args.command === 'status') {
    console.log(JSON.stringify({ok: true, data: await service.status()}));
  } else if (args.command === 'issue-device') {
    if (!args.publisherUser || !args.deviceId) throw new Error('issue-device requires --publisher-user and --device-id');
    const actor = {username: args.publisherUser, displayName: args.publisherUser, role: 'owner', knowledgePublisher: true};
    const issued = await service.issueDevice({actor, actorUser: args.publisherUser, deviceId: args.deviceId, deviceName: args.deviceName});
    console.log(JSON.stringify(issued));
  } else if (args.command === 'publish' || args.command === 'publish-distribution') {
    const distribution = await service.ensureDistribution({actorUser: args.publisherUser || 'owner-knowledge-admin', force: args.force});
    console.log(JSON.stringify({ok: Boolean(distribution.ready && distribution.current), distribution}));
    if (!distribution.ready || !distribution.current) process.exitCode = 1;
  } else if (args.command === 'reconcile') {
    if (!args.publisherUser || !args.planFile) throw new Error('reconcile requires --publisher-user and --plan');
    const plan = JSON.parse(await fs.readFile(args.planFile, 'utf8'));
    const actor = {username: args.publisherUser, displayName: args.publisherUser, role: 'owner', knowledgePublisher: true};
    console.log(JSON.stringify(await service.reconcileRules(plan, {actor, actorUser: args.publisherUser})));
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
} finally {
  await gateway.close();
}
