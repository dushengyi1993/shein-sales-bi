#!/usr/bin/env node
/**
 * Deterministic one-shot daily pending-discuss entry point.
 *
 *   node scripts/pending_discuss_daily.mjs daily --out-dir <new-directory> [--send]
 *
 * The normal path runs the existing scan exactly once, persists scan.json and
 * verifies its hash, then writes report.txt, delivery.json and manifest.json.
 * With --send the fixed Linux cloud checkout uses the shared durable cloud
 * delivery directly; other checkouts validate files under outputs and send
 * the same byte-bound bundle over SSH. Both summary and attachment receipts
 * must be accepted. A failed scan never sends and is never reported as zero.
 *
 * Test injection (never touches the network):
 *   PENDING_DISCUSS_DAILY_LARK_BIN   fake lark binary (command or JSON array)
 *   PENDING_DISCUSS_DAILY_LARK_CONFIG default --lark-config
 *   --config/--stores-config/--store-truth/--expected-store-count are passed
 *   through to the existing scan runtime.
 */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {redactError, sha256Json} from '../lib/pending_discuss_batch.mjs';
import {
  PENDING_DISCUSS_DAILY_MANIFEST_SCHEMA_VERSION,
  buildDailyReportText,
  buildDeliveryDocument,
  buildIdempotencyKey,
  parseLarkSendResponse,
  resolveDailyIdentity,
  resolveDailyRecipientChatId,
  verifyScanHash,
} from '../lib/pending_discuss_daily.mjs';
import {stageAndDeliverBusinessResult} from '../lib/ops_business_result_pipeline.mjs';
import {runLocalCloudTeamReport} from '../lib/cloud_team_report_local.mjs';
import {deliverCloudTeamReport} from '../lib/cloud_team_report_cloud.mjs';
import {
  CLOUD_TEAM_REPORT_CLOUD_HOST,
  CLOUD_TEAM_REPORT_SCHEMA_VERSION,
  computeDeliveryFingerprint,
  sha256Bytes,
} from '../lib/cloud_team_report_common.mjs';
import {runPendingDiscussScan} from './pending_discuss_batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORES_CONFIG = path.join(ROOT, 'config', 'stores.json');
const DEFAULT_STORE_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const DEFAULT_LARK_CONFIG = process.env.PENDING_DISCUSS_DAILY_LARK_CONFIG || path.join(ROOT, 'config', 'lark_report.json');
const SEND_TIMEOUT_MS = 60_000;

export function isCloudEnvironment(root = ROOT) {
  if (process.platform !== 'linux') return false;
  let resolvedRoot;
  try {
    resolvedRoot = fsSync.realpathSync.native ? fsSync.realpathSync.native(root) : fsSync.realpathSync(root);
  } catch {
    return false;
  }
  return resolvedRoot.replaceAll('\\', '/') === '/opt/shein-bi/app';
}

function relativeOutputsSegments(outputsRoot, target) {
  const relative = path.relative(outputsRoot, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    const error = new Error('local report files must stay under repository outputs');
    error.code = 'LOCAL_ARTIFACT_OUTSIDE_OUTPUTS';
    throw error;
  }
  return relative.split(/[\\/]+/u).filter(Boolean);
}

async function lstatIfPresent(target) {
  try { return await fs.lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function validateDailyDeliveryPreflight({send, outDir, root = ROOT, isCloud = false}) {
  if (!send || isCloud) return;
  if (process.env.PENDING_DISCUSS_DAILY_LARK_BIN) return;
  const repositoryRoot = path.resolve(root);
  const outputsRoot = path.join(repositoryRoot, 'outputs');
  const target = path.resolve(repositoryRoot, String(outDir || ''));
  const outputStat = await lstatIfPresent(outputsRoot);
  if (outputStat && (!outputStat.isDirectory() || outputStat.isSymbolicLink())) {
    const error = new Error('repository outputs must be a real directory');
    error.code = 'LOCAL_OUTPUT_ROOT_INVALID';
    throw error;
  }
  const segments = relativeOutputsSegments(outputsRoot, target);
  let current = outputsRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      const error = new Error('local report directory must not be a symlink');
      error.code = 'LOCAL_ARTIFACT_SYMLINK';
      throw error;
    }
    if (!stat.isDirectory()) {
      const error = new Error('local report directory has a non-directory parent');
      error.code = 'LOCAL_ARTIFACT_PARENT_INVALID';
      throw error;
    }
  }
}

function parseArgs(argv) {
  const args = {
    command: '', outDir: '', config: DEFAULT_CONFIG, storesConfig: DEFAULT_STORES_CONFIG,
    storeTruth: DEFAULT_STORE_TRUTH, larkConfig: DEFAULT_LARK_CONFIG,
    expectedStoreCount: Number(process.env.SHEIN_PENDING_DISCUSS_EXPECTED_STORE_COUNT || 19),
    pageSize: 200, readAttempts: 3, readDelayMs: 250, requestTimeoutMs: 20_000,
    send: false, quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-') && !args.command) args.command = token;
    else if (token === '--out-dir') args.outDir = path.resolve(String(argv[++index] || ''));
    else if (token === '--config') args.config = path.resolve(String(argv[++index] || ''));
    else if (token === '--stores-config') args.storesConfig = path.resolve(String(argv[++index] || ''));
    else if (token === '--store-truth') args.storeTruth = path.resolve(String(argv[++index] || ''));
    else if (token === '--lark-config') args.larkConfig = path.resolve(String(argv[++index] || ''));
    else if (token === '--expected-store-count') args.expectedStoreCount = Number(argv[++index]);
    else if (token === '--page-size') args.pageSize = Number(argv[++index]);
    else if (token === '--read-attempts') args.readAttempts = Number(argv[++index]);
    else if (token === '--read-delay-ms') args.readDelayMs = Number(argv[++index]);
    else if (token === '--request-timeout-ms') args.requestTimeoutMs = Number(argv[++index]);
    else if (token === '--send') args.send = true;
    else if (token === '--stage-delivery') args.stageDelivery = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--help' || token === '-h') args.command = 'help';
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function help() {
  return `Usage:
  node scripts/pending_discuss_daily.mjs daily --out-dir <new-directory> [--send]

Options:
  --send                     send the report to config/lark_report.json recipientChatId
  --lark-config <file>       lark report config (default config/lark_report.json)
  --config <file>            SHEIN OpenAPI config (default config/shein_openapi.local.json)
  --stores-config <file>     stores config (default config/stores.json)
  --store-truth <file>       store account truth (default config/store_account_truth.json)
  --expected-store-count <n> enabled store coverage (default 19)
  --page-size <n>            scan page size (default 200)
  --read-attempts <n>        scan read attempts (default 3)
  --read-delay-ms <n>        scan read delay (default 250)
  --request-timeout-ms <n>   scan request timeout (default 20000)
  --quiet                    suppress compact JSON output

Test injection:
  PENDING_DISCUSS_DAILY_LARK_BIN      fake lark binary, e.g. 'node fake.mjs' or a JSON array
  PENDING_DISCUSS_DAILY_LARK_CONFIG   default --lark-config

The daily command runs the existing scan exactly once, verifies the persisted
scan hash, never sends on a failed scan and never reports a failed scan as 0.
`;
}

function requireInteger(value, label, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

function validateArgs(args) {
  if (args.command === 'help') return;
  if (args.command !== 'daily') throw new Error('command must be daily');
  if (!args.outDir) throw new Error('--out-dir is required');
  requireInteger(args.pageSize, '--page-size', {min: 1, max: 200});
  requireInteger(args.readAttempts, '--read-attempts', {min: 1, max: 8});
  requireInteger(args.readDelayMs, '--read-delay-ms', {min: 0, max: 60_000});
  requireInteger(args.requestTimeoutMs, '--request-timeout-ms', {min: 100, max: 120_000});
  requireInteger(args.expectedStoreCount, '--expected-store-count', {min: 1, max: 100});
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function prepareOutDir(outDir) {
  const target = path.resolve(outDir);
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  try {
    await fs.mkdir(target, {mode: 0o700});
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('--out-dir must be a real directory');
    const entries = await fs.readdir(target);
    if (entries.length) throw new Error(`--out-dir must be new or empty: ${target}`);
  }
  try { await fs.chmod(target, 0o700); } catch {}
  return target;
}

async function writeArtifact(outDir, name, value) {
  const file = path.join(outDir, name);
  await writeJsonFileAtomic(file, value, {mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
  return file;
}

async function writeTextArtifact(outDir, name, text) {
  const file = path.join(outDir, name);
  await fs.writeFile(file, String(text), {encoding: 'utf8', mode: 0o600});
  try { await fs.chmod(file, 0o600); } catch {}
  return file;
}

async function writeManifest(outDir, artifactFiles, metadata = {}) {
  const artifacts = [];
  for (const file of artifactFiles) {
    const stat = await fs.stat(file);
    artifacts.push({name: path.basename(file), bytes: stat.size, sha256: await sha256File(file)});
  }
  const manifest = {
    schemaVersion: PENDING_DISCUSS_DAILY_MANIFEST_SCHEMA_VERSION,
    command: 'daily',
    generatedAt: new Date().toISOString(),
    artifacts,
    outputOmitsCredentialsAndRawResponses: true,
    ...metadata,
  };
  const manifestFile = await writeArtifact(outDir, 'manifest.json', manifest);
  return {manifest, manifestFile, manifestHash: sha256Json(manifest)};
}

function resolveLarkBin() {
  const raw = String(process.env.PENDING_DISCUSS_DAILY_LARK_BIN || 'lark-cli').trim();
  let parts;
  try {
    parts = JSON.parse(raw);
  } catch {
    parts = raw.split(/\s+/);
  }
  if (!Array.isArray(parts) || !parts.length || parts.some(part => typeof part !== 'string' || !part.trim())) {
    throw new Error('PENDING_DISCUSS_DAILY_LARK_BIN must be a command string or a JSON array of arguments');
  }
  const [bin, ...prefix] = parts;
  return {bin, prefix};
}

function sendLarkReport({chatId, identity, idempotencyKey, markdown}) {
  const {bin, prefix} = resolveLarkBin();
  const args = [
    ...prefix,
    'im', '+messages-send',
    '--as', identity,
    '--chat-id', chatId,
    '--markdown', markdown,
    '--idempotency-key', idempotencyKey,
  ];
  return new Promise(resolve => {
    const child = spawn(bin, args, {cwd: ROOT, env: {...process.env}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ok: false, error: Object.assign(new Error(`lark-cli timed out after ${SEND_TIMEOUT_MS}ms`), {code: 'LARK_SEND_TIMEOUT'})});
    }, SEND_TIMEOUT_MS);
    child.on('error', error => finish({ok: false, error}));
    child.on('close', code => {
      if (code !== 0) {
        finish({ok: false, error: Object.assign(new Error(`lark-cli exited ${code}: ${stderr || stdout}`), {code: 'LARK_SEND_PROCESS_FAILED'})});
        return;
      }
      try {
        finish({ok: true, receipt: parseLarkSendResponse(stdout)});
      } catch (error) {
        finish({ok: false, error});
      }
    });
  });
}

function compactCoverage(coverage) {
  return {
    expectedCount: coverage?.expectedCount ?? 0,
    succeededCount: coverage?.succeededCount ?? 0,
    failedStores: coverage?.failedStores ?? [],
    missingStores: coverage?.missingStores ?? [],
  };
}

async function runDailyCommand(args, outDir, dependencies = {}) {
  const effectiveRoot = dependencies.root || ROOT;
  const effectiveIsCloud = typeof dependencies.isCloud === 'boolean' ? dependencies.isCloud : isCloudEnvironment(effectiveRoot);
  const scan = await runPendingDiscussScan(args);
  const scanFile = await writeArtifact(outDir, 'scan.json', scan);
  const persisted = await readJson(scanFile);
  const hashCheck = verifyScanHash(persisted);
  const hashOk = hashCheck.ok && persisted?.scanHash === scan.scanHash;
  if (!scan.ok || !hashOk) {
    const failure = {
      schemaVersion: 'pending-discuss-daily-error/v1',
      ok: false,
      command: 'daily',
      businessDate: scan.businessDate,
      rowCount: null,
      at: new Date().toISOString(),
      blockers: [
        ...(scan.ok ? [] : (scan.blockers || [])),
        ...(hashOk ? [] : [{code: 'SCAN_HASH_MISMATCH', message: 'persisted scan.json does not reproduce its scanHash'}]),
      ],
    };
    const errorFile = await writeArtifact(outDir, 'error.json', failure);
    const manifest = await writeManifest(outDir, [scanFile, errorFile], {
      businessDate: scan.businessDate, ok: false, scanHash: scan.scanHash || '',
    });
    return {
      result: {
        ok: false, mode: 'daily', businessDate: scan.businessDate, rowCount: null,
        blockers: failure.blockers.map(row => row.code),
        files: {scanFile, errorFile},
        manifestFile: manifest.manifestFile, manifestHash: manifest.manifestHash,
      },
      exitCode: 3,
    };
  }

  const verifiedScan = persisted;
  const reportText = buildDailyReportText(verifiedScan);
  const reportFile = await writeTextArtifact(outDir, 'report.txt', reportText);
  const reportSha256 = await sha256File(reportFile);
  const at = new Date().toISOString();

  let delivery;
  if (!args.send) {
    delivery = buildDeliveryDocument({
      status: 'skipped', businessDate: verifiedScan.businessDate, at,
      reason: 'send not requested', scanHash: verifiedScan.scanHash, reportSha256,
    });
  } else {
    try {
      if (process.env.PENDING_DISCUSS_DAILY_LARK_BIN) {
        const config = await readJson(args.larkConfig);
        const chatId = resolveDailyRecipientChatId(config);
        const identity = resolveDailyIdentity(config);
        const idempotencyKey = buildIdempotencyKey(verifiedScan.businessDate);
        const sent = await sendLarkReport({chatId, identity, idempotencyKey, markdown: reportText});
        if (!sent.ok) throw sent.error;
        delivery = buildDeliveryDocument({
          status: 'ok', businessDate: verifiedScan.businessDate, idempotencyKey, at,
          scanHash: verifiedScan.scanHash, reportSha256,
        });
      } else if (effectiveIsCloud) {
        // Real cloud production path: deliver directly without SSHing to localhost or re-formatting bytes
        const scanBytes = await fs.readFile(scanFile);
        const reportBytes = await fs.readFile(reportFile);
        const actualScanFileSha = sha256Bytes(scanBytes);
        const fingerprint = computeDeliveryFingerprint({
          automationId: 'pending-discuss-daily',
          businessDate: verifiedScan.businessDate,
          attachmentSha256: actualScanFileSha,
        });
        const bundle = {
          schemaVersion: CLOUD_TEAM_REPORT_SCHEMA_VERSION,
          automationId: 'pending-discuss-daily',
          businessDate: verifiedScan.businessDate,
          expectedAttachmentSha256: actualScanFileSha,
          fingerprint,
          attachmentName: 'scan.json',
          summaryBase64: reportBytes.toString('base64'),
          attachmentBase64: scanBytes.toString('base64'),
        };
        const deliverFn = dependencies.deliverCloudFn || deliverCloudTeamReport;
        const cloudResult = await deliverFn({
          bundle,
          ...(dependencies.landingRoot ? {landingRoot: dependencies.landingRoot} : {}),
          ...(dependencies.cloudConfig ? {config: dependencies.cloudConfig} : {}),
          ...(dependencies.spawnImpl ? {spawnImpl: dependencies.spawnImpl} : {}),
        });
        if (!cloudResult.ok) throw Object.assign(new Error(cloudResult.reason || 'cloud delivery failed'), {code: cloudResult.errorCode});
        delivery = buildDeliveryDocument({
          status: 'ok', businessDate: verifiedScan.businessDate,
          idempotencyKey: buildIdempotencyKey(verifiedScan.businessDate), at,
          scanHash: verifiedScan.scanHash, reportSha256,
        });
      } else {
        // Default local path: use shared cloud team report channel (runLocalCloudTeamReport)
        const scanBytes = await fs.readFile(scanFile);
        const actualScanFileSha = sha256Bytes(scanBytes);
        const sshBin = process.env.CLOUD_TEAM_REPORT_SSH_BIN;
        const sshSpawnImpl = sshBin
          ? (bin, a, o) => {
              if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(sshBin)) {
                return spawn(process.env.ComSpec || 'cmd.exe', ['/c', sshBin, ...a], o);
              }
              return spawn(sshBin, a, o);
            }
          : undefined;
        const runLocalFn = dependencies.runLocalFn || runLocalCloudTeamReport;
        const cloudResult = await runLocalFn({
          automationId: 'pending-discuss-daily',
          businessDate: verifiedScan.businessDate,
          summaryFile: reportFile,
          attachment: scanFile,
          expectedAttachmentSha256: actualScanFileSha,
          cloudSsh: process.env.CLOUD_TEAM_REPORT_SSH_HOST || CLOUD_TEAM_REPORT_CLOUD_HOST,
          root: effectiveRoot,
          ...(sshSpawnImpl ? { spawnImpl: sshSpawnImpl } : {}),
        });
        if (!cloudResult.ok) throw Object.assign(new Error(cloudResult.reason || 'cloud delivery failed'), {code: cloudResult.errorCode});
        delivery = buildDeliveryDocument({
          status: 'ok', businessDate: verifiedScan.businessDate,
          idempotencyKey: buildIdempotencyKey(verifiedScan.businessDate), at,
          scanHash: verifiedScan.scanHash, reportSha256,
        });
      }
    } catch (error) {
      delivery = buildDeliveryDocument({
        status: 'failed', businessDate: verifiedScan.businessDate,
        idempotencyKey: buildIdempotencyKey(verifiedScan.businessDate), at,
        error, scanHash: verifiedScan.scanHash, reportSha256,
      });
    }
  }

  const deliveryFile = await writeArtifact(outDir, 'delivery.json', delivery);
  const deliveryOk = delivery.status === 'ok' || delivery.status === 'skipped';

  // F1 hook: stage into shared automation delivery staging area if requested via env or flag
  let stagedResult = null;
  if (process.env.STAGE_OPS_DELIVERY === '1' || args.stageDelivery) {
    if (args.send) {
      // Avoid duplicate delivery when --send is already active
      stagedResult = {
        status: delivery.status === 'ok' ? 'shared-delivered' : 'delivery-skipped',
        skippedDuplicate: true,
      };
    } else {
      try {
        const stageFn = dependencies.stageFn || stageAndDeliverBusinessResult;
        stagedResult = await stageFn({
          automationId: 'pending-discuss-daily',
          businessDate: verifiedScan.businessDate,
          result: {
            action: '待议价每日巡检扫描',
            ok: true,
            mode: 'daily',
            rowCount: verifiedScan.rowCount,
            coverage: verifiedScan.coverage,
            summary: verifiedScan.summary,
          },
          attachmentName: 'scan.json',
          attachmentContent: JSON.stringify(verifiedScan, null, 2),
        });
      } catch {}
    }
  }

  const manifest = await writeManifest(outDir, [scanFile, reportFile, deliveryFile], {
    businessDate: verifiedScan.businessDate, ok: deliveryOk, scanHash: verifiedScan.scanHash,
    delivery: delivery.status,
    ...(stagedResult ? { stagedDelivery: stagedResult.status } : {}),
  });
  return {
    result: {
      ok: deliveryOk,
      mode: 'daily',
      businessDate: verifiedScan.businessDate,
      rowCount: verifiedScan.rowCount,
      coverage: compactCoverage(verifiedScan.coverage),
      summaryCount: (verifiedScan.summary || []).length,
      delivery: {status: delivery.status, messageIdVerified: delivery.messageIdVerified === true},
      files: {scanFile, reportFile, deliveryFile},
      manifestFile: manifest.manifestFile,
      manifestHash: manifest.manifestHash,
    },
    exitCode: deliveryOk ? 0 : 3,
  };
}

export async function runCli(rawArgs, dependencies = {}) {
  const args = Array.isArray(rawArgs) ? parseArgs(rawArgs) : {...parseArgs([]), ...rawArgs};
  if (args.command === 'help') return {result: {ok: true, help: help()}, exitCode: 0};
  if (!args.outDir) throw new Error('--out-dir is required');
  const rawOutDir = path.resolve(String(args.outDir));
  let outDir = '';
  try {
    validateArgs(args);
    const effectiveRoot = dependencies.root || ROOT;
    const effectiveIsCloud = typeof dependencies.isCloud === 'boolean' ? dependencies.isCloud : isCloudEnvironment(effectiveRoot);
    await validateDailyDeliveryPreflight({send: args.send, outDir: rawOutDir, root: effectiveRoot, isCloud: effectiveIsCloud});
    outDir = await prepareOutDir(rawOutDir);
    return await runDailyCommand(args, outDir, dependencies);
  } catch (error) {
    const failure = {
      schemaVersion: 'pending-discuss-daily-error/v1',
      ok: false,
      command: 'daily',
      at: new Date().toISOString(),
      error: redactError(error),
    };
    const failureFile = outDir ? await writeArtifact(outDir, 'error.json', failure).catch(() => '') : '';
    const manifest = failureFile
      ? await writeManifest(outDir, [failureFile], {ok: false}).catch(() => null)
      : null;
    return {
      result: {
        ok: false, mode: 'daily', ...failure,
        failureFile,
        manifestFile: manifest?.manifestFile || '',
        manifestHash: manifest?.manifestHash || '',
      },
      exitCode: 3,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log(help());
    return;
  }
  const outcome = await runCli(args);
  if (!args.quiet) console.log(JSON.stringify(outcome.result, null, 2));
  process.exitCode = outcome.exitCode;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(error => {
    console.error(JSON.stringify({ok: false, error: redactError(error)}, null, 2));
    process.exitCode = 3;
  });
}
