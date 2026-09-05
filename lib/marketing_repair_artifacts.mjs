import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {runtimeArtifactLocation, readCloudRuntimeArtifact} from './cloud_runtime_path_policy.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const shaPattern = /^[a-f0-9]{64}$/;
function safeLogical(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  const baselinePrefix = '../../../srv/shein-bi/runtime/marketing-plans/';
  if (raw.startsWith(baselinePrefix)) {
    const suffix = raw.slice(baselinePrefix.length);
    if (suffix && !suffix.split('/').includes('..') && suffix.endsWith('.json') && !/[\r\n\0]/.test(raw)) return raw;
  }
  if (!/^(outputs\/|tmp\/marketing-signup\/|state\/cloud_marketing_live_guard\/repair-queues\/)/.test(raw)
      || raw.split('/').includes('..') || !raw.endsWith('.json') || /[\r\n\0]/.test(raw)) {
    throw new Error(`Unsupported portable marketing artifact: ${value}`);
  }
  return path.posix.normalize(raw);
}

// These are the exact files consumed by the existing repair executor. Runtime
// credentials and source-only provenance (e.g. stores config) are never exported.
function references(document) {
  return [
    [document.sourceGuard, document.sourceGuardHash],
    [document.sourcePriceOverrides, document.sourcePriceOverridesSha256 || document.priceOverridesSha256],
    [document.sourceCurrentMarketingLiveScan],
    [document.targetPlanSelection?.priceOverrides, document.targetPlanSelection?.priceOverridesHash],
    [document.limitedDiscountTargetPriceDrift?.source],
    ...Object.values(document.stages || {}).map(stage => [stage.planPath]),
    ...(document.rescueFiles || []).map(file => [file.path, file.sha256 || file.contentHash]),
  ].filter(([file]) => file);
}

export async function inspectMarketingRepairArtifacts({root, queue, env = process.env}) {
  const queueLocation = runtimeArtifactLocation({root, file: queue, env});
  const queueLogicalPath = safeLogical(queueLocation.logicalPath);
  const files = new Map();
  async function visit(logical, expectedHash) {
    const name = safeLogical(logical);
    let artifact = files.get(name);
    if (!artifact) {
      artifact = await readCloudRuntimeArtifact({root, file: name, env});
      files.set(name, artifact);
      for (const [ref, expected] of references(parse(artifact.bytes))) await visit(ref, expected);
    }
    if (expectedHash && (!shaPattern.test(expectedHash) || artifact.sha256 !== expectedHash)) {
      throw new Error(`Artifact SHA-256 mismatch: ${name}`);
    }
  }
  await visit(queueLogicalPath);
  const queueDocument = parse(files.get(queueLogicalPath).bytes);
  if (!shaPattern.test(queueDocument.queueFingerprint) || !shaPattern.test(queueDocument.sourceGuardHash)) {
    throw new Error('Queue must retain its exact fingerprint and guard SHA-256');
  }
  // Re-read after collecting the closure. Do not export a mix of two queue runs.
  for (const artifact of files.values()) {
    const current = await readCloudRuntimeArtifact({root, file: artifact.logicalPath, env});
    if (current.sha256 !== artifact.sha256) throw new Error(`Artifact changed during inspection: ${artifact.logicalPath}`);
  }
  return {queueLogicalPath, queueFingerprint: queueDocument.queueFingerprint,
    sourceGuardHash: queueDocument.sourceGuardHash, queueStateSha256: files.get(queueLogicalPath).sha256,
    files: [...files.values()].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))};
}

export async function exportMarketingRepairArtifacts(options) {
  const inspected = await inspectMarketingRepairArtifacts(options);
  const bundle = {schemaVersion: 1, kind: 'marketing-repair-artifacts',
    queueLogicalPath: inspected.queueLogicalPath, queueFingerprint: inspected.queueFingerprint,
    sourceGuardHash: inspected.sourceGuardHash, queueStateSha256: inspected.queueStateSha256,
    files: inspected.files.map(file => ({logicalPath: file.logicalPath, sizeBytes: file.sizeBytes,
      sha256: file.sha256, base64: file.bytes.toString('base64')}))};
  await fs.writeFile(options.out, `${JSON.stringify(bundle)}\n`, {flag: 'wx', mode: 0o600});
  return bundle;
}

export async function importMarketingRepairArtifacts({bundleFile, destination}) {
  const bundle = parse(await fs.readFile(bundleFile));
  if (bundle.schemaVersion !== 1 || bundle.kind !== 'marketing-repair-artifacts' || !Array.isArray(bundle.files) || !bundle.files.length) {
    throw new Error('Invalid marketing artifact bundle');
  }
  const files = new Map();
  for (const file of bundle.files) {
    const logicalPath = safeLogical(file.logicalPath);
    if (files.has(logicalPath)) throw new Error(`Duplicate artifact: ${logicalPath}`);
    const bytes = Buffer.from(String(file.base64), 'base64');
    if (bytes.length !== file.sizeBytes || hash(bytes) !== file.sha256) throw new Error(`Artifact integrity mismatch: ${logicalPath}`);
    files.set(logicalPath, {bytes, sha256: file.sha256});
  }
  const queue = files.get(safeLogical(bundle.queueLogicalPath));
  if (!queue || queue.sha256 !== bundle.queueStateSha256) throw new Error('Bundled queue bytes mismatch');
  const document = parse(queue.bytes);
  if (document.queueFingerprint !== bundle.queueFingerprint || document.sourceGuardHash !== bundle.sourceGuardHash) throw new Error('Bundled queue identity mismatch');
  for (const {bytes} of files.values()) {
    for (const [ref, expected] of references(parse(bytes))) {
      const artifact = files.get(safeLogical(ref));
      if (!artifact) throw new Error(`Bundled artifact missing: ${ref}`);
      if (expected && artifact.sha256 !== expected) throw new Error(`Bundled reference hash mismatch: ${ref}`);
    }
  }
  // Import is isolated evidence, never an overwrite of a live queue or checkout.
  const dest = path.resolve(destination);
  await fs.mkdir(path.dirname(dest), {recursive: true});
  await fs.mkdir(dest);
  const importedEnv = {SHEIN_BI_MARKETING_PLAN_ROOT: path.join(dest, 'runtime', 'marketing-plans')};
  for (const [logical, artifact] of files) {
    const file = runtimeArtifactLocation({root: dest, file: logical, env: importedEnv}).path;
    const relative = path.relative(dest, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Import escapes destination: ${logical}`);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, artifact.bytes, {flag: 'wx', mode: 0o600});
  }
  return inspectMarketingRepairArtifacts({root: dest, queue: bundle.queueLogicalPath, env: importedEnv});
}
