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
  const artifactVerify = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'verify_partner_cli_package_artifact.mjs'),
    '--source-root', sourceRoot,
    '--extracted-root', extractedRoot,
  ], {cwd: ROOT, encoding: 'utf8'});
  assert.equal(artifactVerify.status, 0, artifactVerify.stderr || artifactVerify.stdout);

  console.log(JSON.stringify({
    ok: true,
    version: manifest.version,
    bundleSha256: validated.bundleSha256,
    packageSha256,
    managedActivation: true,
    immutableConflictRejected: true,
    artifactSourceMatchVerified: true,
  }));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
