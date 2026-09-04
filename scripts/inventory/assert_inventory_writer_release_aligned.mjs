#!/usr/bin/env node
/**
 * Read-only release preflight for inventory writer compatibility.
 *
 * A source deployment is not complete merely because the checkout changed:
 * the external systemd guard must also be activated for the same release
 * authority.  This command detects that mismatch before a business run.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {inspectReleaseSourceState} from '../check_release_source_state.mjs';
import {sha256Hex, validateDeployedReleaseMarker} from '../../lib/source_release_attestation.mjs';
import {
  DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  readEmergencyLocalReleaseReceipt,
} from '../../lib/emergency_local_release_receipt.mjs';

export const COMPATIBILITY_AUTHORITY_KEYS = Object.freeze([
  'deployedCommit',
  'sourceFingerprint',
  'bundleSha256',
  'trackedSourceClean',
  'releaseReceiptKind',
  'releaseReceiptHash',
  'releaseReceiptFile',
]);

const DEFAULT_DEPLOYED_RELEASE_FILE = '/srv/shein-bi/runtime/deployed_release.json';
const DEFAULT_CONTROL_DIR = '/var/lib/shein-bi-control/inventory-writer-compatibility';
const DEFAULT_COMPATIBILITY_FILE = path.join(DEFAULT_CONTROL_DIR, 'compatibility.ndjson');
const DEFAULT_COMPATIBILITY_RECEIPT_FILE = path.join(DEFAULT_CONTROL_DIR, 'compatibility.receipt.json');
const DEFAULT_ACTIVATION_FILE = path.join(DEFAULT_CONTROL_DIR, 'activation.ndjson');
const DEFAULT_ACTIVATION_RECEIPT_FILE = path.join(DEFAULT_CONTROL_DIR, 'activation.receipt.json');

const HASH_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;

export class InventoryAlignmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryAlignmentError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new InventoryAlignmentError(code, message, details);
}

function text(value) {
  return String(value ?? '').trim();
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function normalizeCompatibilityAuthority(authority = {}) {
  const normalized = {
    deployedCommit: text(authority.deployedCommit).toLowerCase(),
    sourceFingerprint: text(authority.sourceFingerprint).toLowerCase(),
    bundleSha256: text(authority.bundleSha256).toLowerCase(),
    trackedSourceClean: authority.trackedSourceClean === true,
    releaseReceiptKind: text(authority.releaseReceiptKind),
    releaseReceiptHash: text(authority.releaseReceiptHash).toLowerCase(),
    releaseReceiptFile: path.resolve(text(authority.releaseReceiptFile)),
  };
  if (!COMMIT_RE.test(normalized.deployedCommit)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', `deployedCommit 格式不合法: ${authority.deployedCommit}`, {authority});
  }
  if (!HASH_RE.test(normalized.sourceFingerprint)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', `sourceFingerprint 格式不合法: ${authority.sourceFingerprint}`, {authority});
  }
  if (!HASH_RE.test(normalized.bundleSha256)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', `bundleSha256 格式不合法: ${authority.bundleSha256}`, {authority});
  }
  if (normalized.trackedSourceClean !== true) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', 'trackedSourceClean 必须为 true', {authority});
  }
  if (!['formal', 'emergency'].includes(normalized.releaseReceiptKind)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', `releaseReceiptKind 必须为 formal 或 emergency: ${authority.releaseReceiptKind}`, {authority});
  }
  if (!HASH_RE.test(normalized.releaseReceiptHash)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', `releaseReceiptHash 格式不合法: ${authority.releaseReceiptHash}`, {authority});
  }
  if (!text(authority.releaseReceiptFile)) {
    fail('INVENTORY_COMPATIBILITY_AUTHORITY_INVALID', 'releaseReceiptFile 路径不能为空', {authority});
  }
  return Object.freeze(normalized);
}

export async function captureCheckoutSourceAuthority({
  cwd = process.cwd(),
  expectedCommit: inputExpectedCommit = '',
  deploymentStateFile = process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || DEFAULT_DEPLOYED_RELEASE_FILE,
  emergencyReceiptFile = process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
  sourceInspector = inspectReleaseSourceState,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedDeploymentFile = path.resolve(deploymentStateFile);
  const resolvedEmergencyFile = path.resolve(emergencyReceiptFile);
  const emergency = readEmergencyLocalReleaseReceipt(resolvedEmergencyFile);
  const emergencyValid = emergency.ok === true;

  let formalExists = false;
  let formalJson = null;
  let formalSha256 = '';
  try {
    const raw = await fs.readFile(resolvedDeploymentFile);
    formalExists = true;
    formalJson = JSON.parse(raw.toString('utf8'));
    formalSha256 = sha256Hex(raw);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      fail('INVENTORY_WRITER_RELEASE_RECEIPT_INVALID', `读取 formal deployment receipt 失败: ${error.message}`, {
        file: resolvedDeploymentFile,
      });
    }
  }

  const formalValid = formalExists && validateDeployedReleaseMarker(formalJson, {requireV3: true}).ok;
  if (!emergencyValid && !formalValid) {
    fail(
      'INVENTORY_WRITER_RELEASE_RECEIPT_INVALID',
      '未检测到有效的 formal 或 emergency 部署凭据（deployed release receipt 缺失或损坏）',
      {deploymentStateFile: resolvedDeploymentFile, formalExists, emergencyReceiptFile: resolvedEmergencyFile, emergencyIssues: emergency.issues},
    );
  }

  const receiptCommit = emergencyValid ? emergency.receipt.commit : formalJson.commit;
  const normalizedInputCommit = text(inputExpectedCommit).toLowerCase();
  if (normalizedInputCommit && normalizedInputCommit !== receiptCommit.toLowerCase()) {
    fail(
      'INVENTORY_WRITER_RELEASE_RECEIPT_INVALID',
      `指定的 commit (${normalizedInputCommit}) 与部署凭据中的 commit (${receiptCommit}) 不一致`,
      {specifiedCommit: normalizedInputCommit, receiptCommit},
    );
  }

  const expectedCommit = normalizedInputCommit || receiptCommit;
  const source = sourceInspector({cwd: resolvedCwd, expectedCommit});
  if (!source.ok || source.head.toLowerCase() !== expectedCommit.toLowerCase()) {
    fail(
      'INVENTORY_WRITER_SOURCE_STATE_INVALID',
      `当前 checkout 源码状态与预期 commit 不符或工作区存在未跟踪/修改文件 (head=${source.head}, expected=${expectedCommit})`,
      {cwd: resolvedCwd, head: source.head, expectedCommit, dirtyCount: source.dirtyEntries?.length || 0, missingCount: source.missingTrackedFiles?.length || 0, hiddenCount: source.hiddenIndexEntries?.length || 0},
    );
  }

  let releaseReceiptKind;
  let releaseReceiptHash;
  let releaseReceiptFile;
  let bundleSha256;
  if (emergencyValid && emergency.receipt.commit.toLowerCase() === source.head.toLowerCase()) {
    releaseReceiptKind = 'emergency';
    releaseReceiptHash = emergency.receipt.receiptHash.toLowerCase();
    releaseReceiptFile = emergency.file;
    bundleSha256 = text(emergency.receipt.bundleSha256).toLowerCase();
  } else {
    bundleSha256 = text(formalJson?.bundleSha256).toLowerCase();
    if (!HASH_RE.test(bundleSha256)) {
      fail('INVENTORY_WRITER_RELEASE_BUNDLE_UNBOUND', 'formal deployment marker 未绑定合法的 bundle SHA-256 哈希', {formalJson});
    }
    releaseReceiptKind = 'formal';
    releaseReceiptHash = formalSha256.toLowerCase();
    releaseReceiptFile = resolvedDeploymentFile;
  }

  return normalizeCompatibilityAuthority({
    deployedCommit: source.head,
    sourceFingerprint: source.sourceFingerprint,
    bundleSha256,
    trackedSourceClean: true,
    releaseReceiptKind,
    releaseReceiptHash,
    releaseReceiptFile,
  });
}

export async function readInventoryCompatibilityStatus({
  compatibilityFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_COMPATIBILITY_FILE || DEFAULT_COMPATIBILITY_FILE,
  compatibilityReceiptFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_COMPATIBILITY_RECEIPT_FILE || DEFAULT_COMPATIBILITY_RECEIPT_FILE,
  activationFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_FILE || DEFAULT_ACTIVATION_FILE,
  activationReceiptFile = process.env.SHEIN_BI_INVENTORY_CUTOVER_ACTIVATION_RECEIPT_FILE || DEFAULT_ACTIVATION_RECEIPT_FILE,
} = {}) {
  const targetComp = path.resolve(compatibilityFile);
  const targetCompReceipt = path.resolve(compatibilityReceiptFile);
  const targetAct = path.resolve(activationFile);
  const targetActReceipt = path.resolve(activationReceiptFile);

  let actContent;
  try {
    actContent = await fs.readFile(targetAct, 'utf8');
  } catch (error) {
    fail('INVENTORY_WRITER_ACTIVATION_MISSING', `库存写入器 reader-first 激活注册表不存在或无法读取: ${error.message}`, {file: targetAct});
  }
  const actLines = actContent.split(/\r?\n/u).filter(line => line.trim());
  if (!actLines.length) fail('INVENTORY_WRITER_ACTIVATION_INVALID', 'activation.ndjson 内容为空', {file: targetAct});
  try { JSON.parse(actLines[0]); } catch { fail('INVENTORY_WRITER_ACTIVATION_INVALID', 'activation.ndjson 第一行不是合法 JSON', {file: targetAct}); }

  let compBytes;
  try {
    compBytes = await fs.readFile(targetComp);
  } catch (error) {
    fail('INVENTORY_WRITER_COMPATIBILITY_REGISTRY_MISSING', `库存写入器兼容性注册表 (compatibility.ndjson) 缺失或无法读取: ${error.message}`, {file: targetComp});
  }
  const compLines = compBytes.toString('utf8').split(/\r?\n/u).filter(line => line.trim());
  if (!compLines.length) fail('INVENTORY_WRITER_COMPATIBILITY_REGISTRY_INVALID', 'compatibility.ndjson 内容为空', {file: targetComp});
  const records = compLines.map((line, idx) => {
    try { return JSON.parse(line); } catch { fail('INVENTORY_WRITER_COMPATIBILITY_REGISTRY_INVALID', `compatibility.ndjson 第 ${idx + 1} 行不是合法 JSON`, {file: targetComp}); }
  });

  let activeRecord = null;
  let pendingStage = null;
  for (const record of records) {
    if (record.kind === 'compatibility_initial') {
      activeRecord = record;
      pendingStage = null;
    } else if (record.kind === 'compatibility_rotation_staged') {
      pendingStage = record;
    } else if (record.kind === 'compatibility_rotation_finalized') {
      activeRecord = record;
      pendingStage = null;
    }
  }
  if (!activeRecord) fail('INVENTORY_WRITER_COMPATIBILITY_REGISTRY_INVALID', '未找到有效的 active compatibility record', {file: targetComp});

  let receiptBytes;
  try { receiptBytes = await fs.readFile(targetCompReceipt); } catch (error) {
    fail('INVENTORY_WRITER_COMPATIBILITY_RECEIPT_MISSING', `库存写入器兼容性凭据 (compatibility.receipt.json) 缺失: ${error.message}`, {file: targetCompReceipt});
  }
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString('utf8')); } catch {
    fail('INVENTORY_WRITER_COMPATIBILITY_RECEIPT_INVALID', 'compatibility.receipt.json 不是合法的 JSON', {file: targetCompReceipt});
  }
  const actualRegistrySha256 = hashBytes(compBytes);
  if (receipt.compatibilityFileSha256 !== actualRegistrySha256) {
    fail('INVENTORY_WRITER_COMPATIBILITY_RECEIPT_INVALID', `compatibility.receipt.json 绑定的 registry 哈希不一致 (receipt=${receipt.compatibilityFileSha256}, actual=${actualRegistrySha256})`, {receipt, actualRegistrySha256});
  }
  if (receipt.activeRecordHash !== activeRecord.recordHash) {
    fail('INVENTORY_WRITER_COMPATIBILITY_RECEIPT_INVALID', `compatibility.receipt.json 的 activeRecordHash 与活跃记录不一致 (receipt=${receipt.activeRecordHash}, activeRecord=${activeRecord.recordHash})`, {receipt, activeRecord});
  }

  return {
    ok: true,
    activeGeneration: activeRecord.generation,
    activeRecord,
    activeAuthority: normalizeCompatibilityAuthority(activeRecord.authority),
    pendingStage: pendingStage ? {generation: pendingStage.generation, candidateAuthority: normalizeCompatibilityAuthority(pendingStage.candidateAuthority), recordHash: pendingStage.recordHash} : null,
    registrySha256: actualRegistrySha256,
    receipt,
    paths: {compatibilityFile: targetComp, compatibilityReceiptFile: targetCompReceipt, activationFile: targetAct, activationReceiptFile: targetActReceipt},
  };
}

export async function assertInventoryWriterReleaseAligned(options = {}, dependencies = {}) {
  const authorityReader = dependencies.authorityReader || captureCheckoutSourceAuthority;
  const statusReader = dependencies.statusReader || readInventoryCompatibilityStatus;
  const sourceAuthority = await authorityReader({...options, ...(dependencies.sourceInspector ? {sourceInspector: dependencies.sourceInspector} : {})});
  const compatibilityStatus = await statusReader(options);

  if (compatibilityStatus.pendingStage) {
    const stage = compatibilityStatus.pendingStage;
    fail(
      'INVENTORY_WRITER_COMPATIBILITY_PENDING_ROTATION',
      ['【发布门禁拦截】检测到未完成的库存写入器兼容性轮转：', `- generation=${stage.generation}`, `- candidate=${stage.candidateAuthority.deployedCommit}`, `- stageHash=${stage.recordHash}`, '', '必须完成 rotation-stage -> deploy -> rotation-finalize；不得自动放行或修改状态。'].join('\n'),
      {sourceAuthority, pendingStage: stage},
    );
  }

  const mismatches = COMPATIBILITY_AUTHORITY_KEYS.filter(key => sourceAuthority[key] !== compatibilityStatus.activeAuthority[key]).map(key => ({key, checkout: sourceAuthority[key], compatibilityActive: compatibilityStatus.activeAuthority[key]}));
  if (mismatches.length) {
    const lines = mismatches.map(item => `  * ${item.key}: checkout=${item.checkout} vs compatibility active=${item.compatibilityActive}`).join('\n');
    fail(
      'INVENTORY_WRITER_RELEASE_ALIGNMENT_MISMATCH',
      ['【发布门禁拦截】当前 checkout 与 inventory compatibility authority 未对齐：', lines, '', `当前 active generation=${compatibilityStatus.activeGeneration}`, '', '必须依次完成 rotation-stage -> deploy -> rotation-finalize；不得自动放行或手工改写兼容状态。'].join('\n'),
      {activeGeneration: compatibilityStatus.activeGeneration, sourceAuthority, activeAuthority: compatibilityStatus.activeAuthority, mismatches},
    );
  }

  return {ok: true, aligned: true, activeGeneration: compatibilityStatus.activeGeneration, authority: sourceAuthority, message: `当前 checkout 与 inventory compatibility authority 已对齐（generation ${compatibilityStatus.activeGeneration}, commit ${sourceAuthority.deployedCommit}）。`};
}

function parseCliArgs(argv) {
  const args = {
    cwd: process.cwd(),
    expectedCommit: '',
    deploymentStateFile: process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE || DEFAULT_DEPLOYED_RELEASE_FILE,
    emergencyReceiptFile: process.env.SHEIN_BI_EMERGENCY_LOCAL_RELEASE_FILE || DEFAULT_EMERGENCY_LOCAL_RELEASE_FILE,
    compatibilityFile: '',
    compatibilityReceiptFile: '',
    activationFile: '',
    activationReceiptFile: '',
    controlDir: process.env.SHEIN_BI_INVENTORY_WRITER_CONTROL_DIR || DEFAULT_CONTROL_DIR,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const opt = argv[i];
    if (opt === '--cwd') args.cwd = argv[++i];
    else if (opt === '--commit' || opt === '--expected-commit') args.expectedCommit = argv[++i];
    else if (opt === '--deployment-file' || opt === '--deployed-release-file' || opt === '--deployment-state-file') args.deploymentStateFile = path.resolve(argv[++i]);
    else if (opt === '--emergency-release-file') args.emergencyReceiptFile = path.resolve(argv[++i]);
    else if (opt === '--control-dir') args.controlDir = path.resolve(argv[++i]);
    else if (opt === '--compatibility-registry') args.compatibilityFile = path.resolve(argv[++i]);
    else if (opt === '--compatibility-receipt') args.compatibilityReceiptFile = path.resolve(argv[++i]);
    else if (opt === '--activation-registry') args.activationFile = path.resolve(argv[++i]);
    else if (opt === '--activation-receipt') args.activationReceiptFile = path.resolve(argv[++i]);
    else if (opt === '--json') args.json = true;
    else if (opt === '--quiet' || opt === '-q') args.quiet = true;
    else fail('INVENTORY_WRITER_ALIGNMENT_CLI_ARGUMENT_INVALID', `未知参数: ${opt}`);
  }
  if (!args.compatibilityFile) args.compatibilityFile = path.join(args.controlDir, 'compatibility.ndjson');
  if (!args.compatibilityReceiptFile) args.compatibilityReceiptFile = path.join(args.controlDir, 'compatibility.receipt.json');
  if (!args.activationFile) args.activationFile = path.join(args.controlDir, 'activation.ndjson');
  if (!args.activationReceiptFile) args.activationReceiptFile = path.join(args.controlDir, 'activation.receipt.json');
  return args;
}

export async function runCli(argv = process.argv.slice(2)) {
  let args;
  try { args = parseCliArgs(argv); } catch (error) {
    console.error(JSON.stringify({ok: false, code: error.code || 'CLI_ARG_ERROR', error: error.message}, null, 2));
    process.exitCode = 1;
    return;
  }
  try {
    const result = await assertInventoryWriterReleaseAligned(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else if (!args.quiet) console.log(`[OK] ${result.message}`);
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = 1;
    if (args.json) console.error(JSON.stringify({ok: false, aligned: false, code: error.code || 'INVENTORY_WRITER_ALIGNMENT_FAILED', error: error.message, details: error.details || null}, null, 2));
    else { console.error(error.message); if (error.code) console.error(`\n[错误代码: ${error.code}]`); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
