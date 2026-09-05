/**
 * Shared ops business result stage & cloud bot delivery pipeline.
 *
 * Implements requirement F1:
 * - Persists completed / partial / blocked business stages into a shared staging area
 * - Promptly invokes cloud delivery bot (cloud_team_report_delivery)
 * - Retries pending deliveries without repeating underlying business execution
 * - Exposes clean, non-intrusive hook points for inventory replenishment,
 *   pending discuss daily scan, and link retire candidate reporting.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeFileAtomic, writeJsonFileAtomic} from './atomic_file_publish.mjs';
import {
  formatOpsBusinessResult,
  buildBusinessResultSnapshot,
} from './ops_business_result_formatter.mjs';
import {
  CLOUD_TEAM_REPORT_LANDING_ROOT,
  computeDeliveryFingerprint,
  normalizeAutomationId,
  normalizeBusinessDate,
  sha256Bytes,
} from './cloud_team_report_common.mjs';
import {
  buildCloudLandingPaths,
  deliverCloudTeamReport,
} from './cloud_team_report_cloud.mjs';

export const OPS_BUSINESS_STAGING_ROOT = '/srv/shein-bi/runtime/automation-delivery';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Stage and deliver an ops business result artifact via cloud bot.
 *
 * @param {Object} params
 * @param {string} params.automationId - e.g. 'inventory-replenishment', 'pending-discuss-daily', 'link-retire-candidates', 'marketing-daily'
 * @param {string} params.businessDate - YYYY-MM-DD
 * @param {Object} params.result - Structured business result to format and record
 * @param {string} [params.attachmentName] - Default 'result.json' or custom filename
 * @param {Buffer|string} [params.attachmentContent] - Detailed attachment payload (default: JSON string of result)
 * @param {string} [params.landingRoot] - Delivery landing root (default /srv/shein-bi/runtime/automation-delivery)
 * @param {Object} [params.config] - Lark config override if any
 * @param {Function} [params.spawnImpl] - spawn override for testing
 * @returns {Promise<Object>} Safe delivery outcome
 */
export async function stageAndDeliverBusinessResult({
  automationId,
  businessDate,
  result,
  attachmentName = 'result.json',
  attachmentContent,
  landingRoot = OPS_BUSINESS_STAGING_ROOT,
  config,
  configPath = process.env.CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  spawnImpl,
  signal,
} = {}) {
  const normAutomationId = normalizeAutomationId(automationId);
  const normDate = normalizeBusinessDate(businessDate);

  // Format human-readable summary copy
  const formatted = formatOpsBusinessResult(result);
  const summaryMarkdown = `# ${normDate} ${formatted.action}报告\n\n${formatted.copy}\n`;

  // Prepare attachment bytes
  const attachmentBytes = attachmentContent
    ? (Buffer.isBuffer(attachmentContent) ? attachmentContent : Buffer.from(String(attachmentContent), 'utf8'))
    : Buffer.from(JSON.stringify({
        schemaVersion: 'ops-business-result/v1',
        automationId: normAutomationId,
        businessDate: normDate,
        summary: formatted.copy,
        action: formatted.action,
        succeededCount: formatted.succeededCount,
        failedCount: formatted.failedCount,
        pendingCount: formatted.pendingCount,
        needsHuman: formatted.needsHuman,
        diagnostics: formatted.diagnostics,
        rawResult: result,
        ...(result && typeof result === 'object' && result.occupancyChange ? { occupancyChange: result.occupancyChange } : {}),
      }, null, 2), 'utf8');

  const attachmentSha = sha256Bytes(attachmentBytes);
  const fingerprint = computeDeliveryFingerprint({
    automationId: normAutomationId,
    businessDate: normDate,
    attachmentSha256: attachmentSha,
  });

  const bundle = {
    schemaVersion: 'cloud-team-report/v1',
    automationId: normAutomationId,
    businessDate: normDate,
    expectedAttachmentSha256: attachmentSha,
    fingerprint,
    attachmentName,
    summaryBase64: Buffer.from(summaryMarkdown, 'utf8').toString('base64'),
    attachmentBase64: attachmentBytes.toString('base64'),
  };

  // Deliver promptly via cloud bot
  const deliveryOutcome = await deliverCloudTeamReport({
    bundle,
    landingRoot,
    config,
    ...(configPath ? { configPath } : {}),
    spawnImpl,
    signal,
  });

  return {
    ok: deliveryOutcome.ok,
    status: deliveryOutcome.status,
    automationId: normAutomationId,
    businessDate: normDate,
    fingerprint,
    formatted,
    summaryMarkdown,
    delivery: deliveryOutcome,
  };
}

/**
 * Scan landing root for pending/partial deliveries and retry them without re-executing business operations.
 *
 * @param {Object} params
 * @param {string} [params.landingRoot]
 * @param {Object} [params.config]
 * @param {Function} [params.spawnImpl]
 * @returns {Promise<Array<Object>>} Retried delivery outcomes
 */
export async function retryPendingBusinessDeliveries({
  landingRoot = OPS_BUSINESS_STAGING_ROOT,
  config,
  configPath = process.env.CLOUD_TEAM_REPORT_CLOUD_CONFIG,
  spawnImpl,
  maxDeliveriesPerRun = 10,
  maxDurationMs = 45_000,
  signal,
  now = () => Date.now(),
} = {}) {
  const startTime = now();
  const retried = [];
  let automations = [];
  try {
    automations = await fs.readdir(landingRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return retried;
    throw error;
  }

  for (const autoId of automations) {
    const autoPath = path.join(landingRoot, autoId);
    let autoStat;
    try { autoStat = await fs.lstat(autoPath); } catch { continue; }
    if (!autoStat.isDirectory() || autoStat.isSymbolicLink()) continue;

    let dates = [];
    try { dates = await fs.readdir(autoPath); } catch { continue; }
    for (const dateStr of dates) {
      const datePath = path.join(autoPath, dateStr);
      let dateStat;
      try { dateStat = await fs.lstat(datePath); } catch { continue; }
      if (!dateStat.isDirectory() || dateStat.isSymbolicLink()) continue;

      let fingerprints = [];
      try { fingerprints = await fs.readdir(datePath); } catch { continue; }
      for (const fp of fingerprints) {
        if (signal?.aborted) return retried;
        if (retried.length >= maxDeliveriesPerRun) return retried;
        if (now() - startTime >= maxDurationMs) return retried;

        try {
          const deliveryDir = path.join(datePath, fp);
          const stateFile = path.join(deliveryDir, 'state.json');
          const summaryFile = path.join(deliveryDir, 'summary.md');
          let state;
          try {
            state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
          } catch {
            continue;
          }

          // Strict retry decision:
          // 1. NEVER retry unknown delivery status or unknown receipts (unknown绝不盲重发)
          if (state.status === 'unknown' || state.items?.summary?.unknown === true || state.items?.attachment?.unknown === true) {
            continue;
          }

          // 2. Do not retry if already completely ok
          if (state.status === 'ok' || (state.items?.summary?.accepted === true && state.items?.attachment?.accepted === true)) {
            continue;
          }

          // 3. Retry pending, partial, or deterministically failed attempts
          const canRetry = state.status === 'pending'
            || state.status === 'partial'
            || (state.status === 'failed' && (state.items?.summary?.accepted !== true || state.items?.attachment?.accepted !== true));

          if (canRetry) {
            const safeAttachmentName = state.attachmentName || 'result.json';
            const attachmentFile = path.join(deliveryDir, safeAttachmentName);

            let summaryBytes, attachmentBytes;
            try {
              summaryBytes = await fs.readFile(summaryFile);
              attachmentBytes = await fs.readFile(attachmentFile);
            } catch {
              continue;
            }

            const bundle = {
              schemaVersion: 'cloud-team-report/v1',
              automationId: state.automationId,
              businessDate: state.businessDate,
              expectedAttachmentSha256: state.attachmentSha256,
              fingerprint: state.fingerprint,
              attachmentName: safeAttachmentName,
              summaryBase64: summaryBytes.toString('base64'),
              attachmentBase64: attachmentBytes.toString('base64'),
            };

            const outcome = await deliverCloudTeamReport({
              bundle,
              landingRoot,
              config,
              ...(configPath ? { configPath } : {}),
              spawnImpl,
              signal,
            });

            retried.push({
              automationId: state.automationId,
              businessDate: state.businessDate,
              fingerprint: state.fingerprint,
              previousStatus: state.status,
              newStatus: outcome.status,
              ok: outcome.ok,
            });
          }
        } catch (singleErr) {
          // Failure of one delivery does not block scanning and retrying other stages
          continue;
        }
      }
    }
  }

  return retried;
}
