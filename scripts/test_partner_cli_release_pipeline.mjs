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
  PARTNER_CLI_RELEASE_CONFLICT_CODE,
  PARTNER_CLI_RELEASE_DOWNGRADE_BLOCKED_CODE,
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

async function setPackageVersion(sourceRoot, version) {
  const manifestFile = path.join(sourceRoot, 'config', 'partner_cli_package.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.version = version;
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function writeFixturePackage(sourceRoot, version, packageBytes) {
  const fileName = `shein-bi-ops-cli-${version}.zip`;
  const file = path.join(sourceRoot, 'outputs', 'releases', fileName);
  const checksum = crypto.createHash('sha256').update(packageBytes).digest('hex');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, packageBytes);
  await fs.writeFile(`${file}.sha256`, `${checksum}  ${fileName}\n`, 'ascii');
  return {file, fileName, checksum};
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
  const credentialPriorityExpression = 'GH_TOKEN: ${{ secrets.SOURCE_RELEASE_ADMIN_TOKEN || github.token }}';
  const credentialDeclarations = releaseWorkflow.match(/GH_TOKEN: \$\{\{[^}]*\}\}/g) || [];
  assert.ok(credentialDeclarations.length > 0, 'partner CLI workflow must declare GH_TOKEN');
  assert.ok(
    credentialDeclarations.every(expression => expression === credentialPriorityExpression),
    'every partner CLI GH_TOKEN declaration must prefer SOURCE_RELEASE_ADMIN_TOKEN with github.token fallback',
  );
  assert.doesNotMatch(releaseWorkflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
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

  // A newer deployed source/fallback must not be shadowed by an older managed
  // pointer. Missing or corrupt newer fallback bytes fail closed instead of
  // silently downgrading; once the managed release catches up it becomes the
  // preferred source and no fallback file is required.
  const oldSource = path.join(temp, 'old-source');
  await copyPackageSource(oldSource);
  const oldManifest = await setPackageVersion(oldSource, '2026.08.16.5');
  const oldRelease = await buildPartnerCliRelease({sourceRoot: oldSource});
  const oldPackage = await writeFixturePackage(oldSource, oldManifest.version, packageBytes);
  const mixedManagedRoot = path.join(temp, 'mixed-release-store');
  const oldStore = createPartnerCliReleaseStore({
    releaseRoot: mixedManagedRoot,
    fallbackSourceRoot: oldSource,
    fallbackPackageFile: oldPackage.file,
  });
  await oldStore.deploy(deploymentPayload({
    release: oldRelease,
    packageBytes,
    packageFileName: oldPackage.fileName,
  }));
  const mixedStore = createPartnerCliReleaseStore({
    releaseRoot: mixedManagedRoot,
    fallbackSourceRoot: sourceRoot,
    fallbackPackageFile: packageFile,
  });
  const newerFallback = await mixedStore.status();
  assert.equal(newerFallback.source, 'fallback');
  assert.equal(newerFallback.version, manifest.version);

  await fs.rm(packageFile);
  await fs.rm(`${packageFile}.sha256`);
  const missingNewerFallback = createPartnerCliReleaseStore({
    releaseRoot: mixedManagedRoot,
    fallbackSourceRoot: sourceRoot,
    fallbackPackageFile: packageFile,
  });
  await assert.rejects(
    () => missingNewerFallback.status(),
    error => error?.code === PARTNER_CLI_RELEASE_DOWNGRADE_BLOCKED_CODE,
  );
  await fs.writeFile(packageFile, packageBytes);
  await fs.writeFile(`${packageFile}.sha256`, `${packageSha256}  ${packageFileName}\n`, 'ascii');

  const recoveredManaged = await mixedStore.deploy(payload);
  assert.equal(recoveredManaged.changed, true);
  assert.equal(recoveredManaged.active.source, 'managed');
  await fs.rm(packageFile);
  await fs.rm(`${packageFile}.sha256`);
  const managedWithoutFallback = createPartnerCliReleaseStore({
    releaseRoot: mixedManagedRoot,
    fallbackSourceRoot: sourceRoot,
    fallbackPackageFile: packageFile,
  });
  const managedCurrent = await managedWithoutFallback.status();
  assert.equal(managedCurrent.source, 'managed');
  assert.equal(managedCurrent.version, manifest.version);
  await fs.writeFile(packageFile, packageBytes);
  await fs.writeFile(`${packageFile}.sha256`, `${packageSha256}  ${packageFileName}\n`, 'ascii');

  const conflictingSource = path.join(temp, 'conflicting-source');
  await copyPackageSource(conflictingSource);
  await fs.appendFile(path.join(conflictingSource, 'AGENTS.md'), '\nSame-version source conflict fixture.\n', 'utf8');
  const conflictingPackage = await writeFixturePackage(conflictingSource, manifest.version, packageBytes);
  const conflictingSelection = createPartnerCliReleaseStore({
    releaseRoot: mixedManagedRoot,
    fallbackSourceRoot: conflictingSource,
    fallbackPackageFile: conflictingPackage.file,
  });
  await assert.rejects(
    () => conflictingSelection.status(),
    error => error?.code === PARTNER_CLI_RELEASE_CONFLICT_CODE,
  );

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
    sourceManagedSelectionVerified: true,
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
