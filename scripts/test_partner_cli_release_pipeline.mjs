#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPartnerCliRelease} from '../lib/partner_cli_release.mjs';
import {
  createPartnerCliReleaseStore,
  PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
  validatePartnerCliDeploymentPayload,
} from '../lib/partner_cli_release_store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-release-pipeline-'));

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

function workflowRunBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*run:\s*\|\s*$/.test(lines[index])) continue;
    const indentation = /^ */.exec(lines[index])?.[0].length || 0;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const width = /^ */.exec(line)?.[0].length || 0;
      if (line.trim() && width <= indentation) break;
      body.push(line.length >= indentation + 2 ? line.slice(indentation + 2) : '');
    }
    blocks.push(body.join('\n') + '\n');
  }
  return blocks;
}

async function copyPackageSource(sourceRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'partner_cli_package.json'), 'utf8'));
  for (const relative of [...manifest.files, 'config/partner_cli_package.json', 'scripts/install_partner_bi_ops_cli.ps1']) {
    const source = path.join(ROOT, relative);
    const target = path.join(sourceRoot, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(source, target);
  }
  return manifest;
}

function deploymentPayload({release, packageBytes, packageFileName, sourceCommit = 'a'.repeat(40)}) {
  return {
    schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
    tagName: `partner-cli-v${release.manifest.version}`,
    sourceCommit,
    publishedAt: '2026-07-13T17:03:08.000Z',
    manifest: release.manifest,
    bundle: release.bundle,
    package: {
      fileName: packageFileName,
      size: packageBytes.length,
      sha256: crypto.createHash('sha256').update(packageBytes).digest('hex'),
      dataBase64: packageBytes.toString('base64'),
    },
  };
}

try {
  const releaseWorkflow = await fs.readFile(
    path.join(ROOT, '.github', 'workflows', 'partner-cli-release.yml'),
    'utf8',
  );
  assert.match(releaseWorkflow, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(releaseWorkflow, /^  release:\s*$/m);
  assert.match(releaseWorkflow, /^      expected_commit:\s*$/m);
  assert.match(releaseWorkflow, /^  actions: read\s*$/m);
  assert.match(releaseWorkflow, /^  contents: write\s*$/m);
  assert.match(releaseWorkflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(releaseWorkflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.doesNotMatch(releaseWorkflow, /^\s+npm test\s*$/m);
  for (const command of [
    'npm run check:generated',
    'npm run check:source',
    'npm run build:portal-shell',
    'node scripts/test_partner_cli_package.mjs',
    'node scripts/test_partner_cli_version_change.mjs',
    'node scripts/test_partner_cli_updater.mjs',
    'node scripts/test_partner_cli_portal_release.mjs',
    'node scripts/test_partner_cli_release_pipeline.mjs',
  ]) assert.ok(releaseWorkflow.includes(command), 'Partner CLI release workflow is missing ' + command);
  for (const contract of [
    'fetchRepositoryTrustEvidence',
    'fetchLatestCiBindingEvidence',
    '.object.type == "tag"',
    '.object.sha == $commit',
    '.immutable == true',
    '.state == "uploaded"',
    '.digest == $zipDigest',
    'path: automation',
    'path: release-source',
    'working-directory: release-source',
    '--source-root "$PWD/release-source"',
    'if [ "$mode" = \'draft\' ] && [ "$main_head" != "$expected_commit" ]',
    'artifacts-terminal',
    'PUBLISH_OUTCOME_UNKNOWN',
    'no publish retry was attempted',
    'Re-read GitHub facts immediately before BI deployment',
  ]) assert.ok(releaseWorkflow.includes(contract), 'Partner CLI immutable release contract is missing ' + contract);
  assert.equal(occurrenceCount(releaseWorkflow, 'gh release upload'), 1);
  assert.equal(occurrenceCount(releaseWorkflow, '--request PATCH'), 1);
  const credentialGateIndex = releaseWorkflow.indexOf('Check deployment credential before release mutation');
  const draftBranchIndex = releaseWorkflow.indexOf('if [ "$INITIAL_MODE" = \'draft\' ]; then');
  const uploadIndex = releaseWorkflow.indexOf('gh release upload');
  const publishIndex = releaseWorkflow.indexOf('--request PATCH');
  const publishedBranchIndex = releaseWorkflow.indexOf("asset_origin='existing-immutable-release-assets'");
  const terminalReadbackIndex = releaseWorkflow.indexOf('download_and_verify published artifacts-terminal');
  const deploymentPreflightIndex = releaseWorkflow.indexOf('Re-read GitHub facts immediately before BI deployment');
  const deploymentIndex = releaseWorkflow.indexOf('Deploy atomically to BI and read back');
  assert.ok(credentialGateIndex > 0 && credentialGateIndex < draftBranchIndex);
  assert.ok(draftBranchIndex < uploadIndex && uploadIndex < publishIndex);
  assert.ok(publishIndex < publishedBranchIndex && publishedBranchIndex < terminalReadbackIndex);
  assert.ok(terminalReadbackIndex < deploymentPreflightIndex && deploymentPreflightIndex < deploymentIndex);
  const bashBlocks = workflowRunBlocks(releaseWorkflow);
  assert.equal(bashBlocks.length, 8, 'Partner CLI release workflow Bash block inventory drifted');
  for (const [index, block] of bashBlocks.entries()) {
    const syntax = spawnSync('bash', ['-n'], {input: block, encoding: 'utf8'});
    assert.equal(
      syntax.status,
      0,
      'Partner CLI release Bash block ' + (index + 1) + ' failed syntax validation: ' + syntax.stderr,
    );
  }

  const sourceRoot = path.join(temp, 'source');
  const manifest = await copyPackageSource(sourceRoot);
  const release = await buildPartnerCliRelease({sourceRoot});
  const packageFileName = `shein-bi-ops-cli-${manifest.version}.zip`;
  const packageBytes = Buffer.from('504b030414000000000000000000000000000000000000000000', 'hex');
  const packageFile = path.join(sourceRoot, 'outputs', 'releases', packageFileName);
  await fs.mkdir(path.dirname(packageFile), {recursive: true});
  await fs.writeFile(packageFile, packageBytes);
  const packageSha256 = crypto.createHash('sha256').update(packageBytes).digest('hex');
  await fs.writeFile(`${packageFile}.sha256`, `${packageSha256}  ${packageFileName}\n`, 'ascii');

  const store = createPartnerCliReleaseStore({
    releaseRoot: path.join(temp, 'release-store'),
    fallbackSourceRoot: sourceRoot,
    fallbackPackageFile: packageFile,
  });
  const fallback = await store.status();
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.version, manifest.version);

  const payload = deploymentPayload({release, packageBytes, packageFileName});
  const validated = validatePartnerCliDeploymentPayload(payload);
  assert.equal(validated.version, manifest.version);
  const deployed = await store.deploy(payload);
  assert.equal(deployed.changed, true);
  assert.equal(deployed.active.source, 'managed');
  assert.equal(deployed.active.package.sha256, packageSha256);
  const idempotent = await store.deploy(payload);
  assert.equal(idempotent.changed, false);

  const alternateSource = path.join(temp, 'alternate-source');
  await copyPackageSource(alternateSource);
  await fs.appendFile(path.join(alternateSource, 'AGENTS.md'), '\nRelease conflict fixture.\n', 'utf8');
  const alternateRelease = await buildPartnerCliRelease({sourceRoot: alternateSource});
  const conflictingPayload = deploymentPayload({release: alternateRelease, packageBytes, packageFileName, sourceCommit: 'b'.repeat(40)});
  await assert.rejects(() => store.deploy(conflictingPayload), error => error?.code === 'VERSION_CONFLICT');

  const invalidPayload = structuredClone(payload);
  invalidPayload.package.dataBase64 = Buffer.from('not-a-zip').toString('base64');
  await assert.rejects(() => store.deploy(invalidPayload), error => error?.code === 'INVALID_DEPLOYMENT');

  const payloadOutput = path.join(temp, 'deployment-payload.json');
  const payloadBuild = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'build_partner_cli_deploy_payload.mjs'),
    '--source-root', sourceRoot,
    '--package-file', packageFile,
    '--checksum-file', `${packageFile}.sha256`,
    '--tag', `partner-cli-v${manifest.version}`,
    '--source-commit', 'c'.repeat(40),
    '--published-at', '2026-07-13T17:03:08.000Z',
    '--output', payloadOutput,
  ], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(payloadBuild.status, 0, payloadBuild.stderr || payloadBuild.stdout);
  const builtPayload = JSON.parse(await fs.readFile(payloadOutput, 'utf8'));
  assert.equal(validatePartnerCliDeploymentPayload(builtPayload).sourceCommit, 'c'.repeat(40));

  const extractedRoot = path.join(temp, 'extracted');
  const extractedPackageRoot = path.join(extractedRoot, `shein-bi-ops-cli-${manifest.version}`);
  for (const relative of manifest.files) {
    const target = path.join(extractedPackageRoot, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(sourceRoot, relative), target);
  }
  await fs.mkdir(path.join(extractedPackageRoot, 'config'), {recursive: true});
  await fs.copyFile(path.join(sourceRoot, 'config', 'partner_cli_package.json'), path.join(extractedPackageRoot, 'config', 'partner_cli_package.json'));
  await fs.copyFile(path.join(sourceRoot, 'scripts', 'install_partner_bi_ops_cli.ps1'), path.join(extractedPackageRoot, 'install.ps1'));
  const agentsArtifact = path.join(extractedPackageRoot, 'AGENTS.md');
  const agentsText = await fs.readFile(agentsArtifact, 'utf8');
  await fs.writeFile(agentsArtifact, agentsText.includes('\r\n') ? agentsText.replace(/\r\n/g, '\n') : agentsText.replace(/\n/g, '\r\n'), 'utf8');
  const artifactVerify = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'verify_partner_cli_package_artifact.mjs'),
    '--source-root', sourceRoot,
    '--extracted-root', extractedRoot,
  ], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(artifactVerify.status, 0, artifactVerify.stderr || artifactVerify.stdout);
  await fs.appendFile(agentsArtifact, '\nunauthorized-content-change\n', 'utf8');
  const changedArtifactVerify = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'verify_partner_cli_package_artifact.mjs'),
    '--source-root', sourceRoot,
    '--extracted-root', extractedRoot,
  ], {cwd: ROOT, encoding: 'utf8'});
  assert.notEqual(changedArtifactVerify.status, 0, 'artifact verifier accepted a real content change');

  console.log(JSON.stringify({
    ok: true,
    version: manifest.version,
    bundleSha256: validated.bundleSha256,
    packageSha256,
    managedActivation: true,
    immutableConflictRejected: true,
    artifactSourceMatchVerified: true,
    platformLineEndingsAccepted: true,
    realArtifactChangeRejected: true,
    draftFirstImmutableWorkflowVerified: true,
    workflowBashSyntaxVerified: true,
  }));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
