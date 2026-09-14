#!/usr/bin/env node
/**
 * Persistent pause switch for the bounded cloud marketing write lane.
 *
 * On 2026-09-11 a root-created, reasonless marker in /run silently stopped the
 * whole cloud write chain for three days, and because it lived in /run it also
 * disappeared on the next boot. The switch therefore lives in the root-owned
 * persistent control directory, every set/clear must carry a real reason, and
 * each transition is appended to an audit log.
 *
 * The paired systemd drop-in uses
 * `ConditionPathExists=!/var/lib/shein-bi-control/marketing-write-pause.json`,
 * so the presence of the marker is what pauses the lane and `clear` removes it.
 *
 * Usage:
 *   node scripts/manage_marketing_write_pause.mjs set --reason "<why>" [--actor <who>] [--expires-at <ISO>]
 *   node scripts/manage_marketing_write_pause.mjs clear --reason "<why>" [--actor <who>]
 *   node scripts/manage_marketing_write_pause.mjs status
 *   node scripts/manage_marketing_write_pause.mjs prune
 *
 * `status` exits 0 while the lane runs and 1 while it is paused or expired, so
 * a guard can branch on it without parsing JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {CLOUD_MAINTENANCE_CONTROL_DIR} from '../lib/cloud_maintenance_mode.mjs';

export const MARKETING_WRITE_PAUSE_SCHEMA_VERSION = 'marketing-write-pause/v1';
export const MARKETING_WRITE_PAUSE_MARKER_NAME = 'marketing-write-pause.json';
export const MARKETING_WRITE_PAUSE_AUDIT_NAME = 'marketing-write-pause.audit.ndjson';
export const CANONICAL_MARKETING_WRITE_PAUSE_FILE = `${CLOUD_MAINTENANCE_CONTROL_DIR}/${MARKETING_WRITE_PAUSE_MARKER_NAME}`;
export const MARKETING_WRITE_PAUSE_CONTROL_MODE = 0o755;
export const MARKETING_WRITE_PAUSE_MARKER_MODE = 0o644;
export const MIN_MARKETING_WRITE_PAUSE_REASON_LENGTH = 8;
export const MAX_MARKETING_WRITE_PAUSE_REASON_LENGTH = 500;

export const MARKETING_WRITE_PAUSE_EXIT_CODES = Object.freeze({
  running: 0,
  paused: 1,
  configuration: 64,
  permission: 77,
});

// A pause without a real reason is exactly the 2026-09-11 failure, so the
// obvious placeholders are rejected instead of being accepted as "a reason".
const PLACEHOLDER_REASONS = new Set([
  'x', 'xx', 'na', 'n/a', 'none', 'null', 'nil', 'todo', 'tbd', 'fixme',
  'asdf', 'test', 'testing', 'reason', 'pause', 'paused', 'unknown', '-', '--', '...',
]);
const SECRET_LIKE_TEXT = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\b(?:authorization|cookie|password|passwd|secret|token|api[-_ ]?key)\s*[:=]\s*\S+|\bbearer\s+[a-z0-9._~+/-]{12,})/iu;

export class MarketingWritePauseConfigurationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MarketingWritePauseConfigurationError';
    this.code = 'MARKETING_WRITE_PAUSE_CONFIGURATION_ERROR';
    this.exitCode = MARKETING_WRITE_PAUSE_EXIT_CODES.configuration;
    this.detail = detail;
  }
}

export class MarketingWritePausePermissionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MarketingWritePausePermissionError';
    this.code = 'MARKETING_WRITE_PAUSE_PERMISSION_DENIED';
    this.exitCode = MARKETING_WRITE_PAUSE_EXIT_CODES.permission;
    this.detail = detail;
  }
}

export function marketingWritePauseFile(controlDir = CLOUD_MAINTENANCE_CONTROL_DIR) {
  return path.join(path.resolve(controlDir), MARKETING_WRITE_PAUSE_MARKER_NAME);
}

export function marketingWritePauseAuditFile(controlDir = CLOUD_MAINTENANCE_CONTROL_DIR) {
  return path.join(path.resolve(controlDir), MARKETING_WRITE_PAUSE_AUDIT_NAME);
}

export function validateMarketingWritePauseReason(reason) {
  const text = String(reason ?? '').trim();
  if (text.length < MIN_MARKETING_WRITE_PAUSE_REASON_LENGTH || text.length > MAX_MARKETING_WRITE_PAUSE_REASON_LENGTH) {
    throw new MarketingWritePauseConfigurationError(
      `a pause reason of ${MIN_MARKETING_WRITE_PAUSE_REASON_LENGTH}-${MAX_MARKETING_WRITE_PAUSE_REASON_LENGTH} characters is required`,
      {length: text.length},
    );
  }
  const normalized = text.toLowerCase().replace(/[\s._-]+/gu, '');
  if (PLACEHOLDER_REASONS.has(normalized) || PLACEHOLDER_REASONS.has(text.toLowerCase())) {
    throw new MarketingWritePauseConfigurationError('the pause reason is a placeholder, not a reason', {reason: text});
  }
  if (SECRET_LIKE_TEXT.test(text)) {
    throw new MarketingWritePauseConfigurationError('the pause reason looks like secret material');
  }
  return text;
}

function parseIsoInstant(value, label) {
  const text = String(value ?? '').trim();
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new MarketingWritePauseConfigurationError(`${label} must be an exact ISO-8601 UTC instant`);
  }
  return text;
}

export function buildMarketingWritePauseMarker({reason, actor = '', setAt, expiresAt = null}) {
  return {
    schemaVersion: MARKETING_WRITE_PAUSE_SCHEMA_VERSION,
    paused: true,
    reason,
    actor: String(actor || '').trim(),
    setAt,
    expiresAt,
  };
}

export function evaluateMarketingWritePause(marker, now = new Date()) {
  const exists = Boolean(marker);
  if (!exists) return {exists: false, paused: false, expired: false, marker: null};
  if (marker?.schemaVersion !== MARKETING_WRITE_PAUSE_SCHEMA_VERSION || marker?.paused !== true) {
    throw new MarketingWritePauseConfigurationError('the pause marker is not a valid marketing write pause', {marker});
  }
  const expiresAt = marker.expiresAt ?? null;
  const expired = Boolean(expiresAt) && Date.parse(expiresAt) <= now.getTime();
  return {exists: true, paused: !expired, expired, marker};
}

async function readMarker(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new MarketingWritePauseConfigurationError('the pause marker is not valid JSON', {file, cause: error.message});
  }
}

async function appendAudit(file, entry) {
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, {encoding: 'utf8', mode: MARKETING_WRITE_PAUSE_MARKER_MODE});
}

function requireRootForCanonicalControlDir(controlDir) {
  if (path.resolve(controlDir) !== path.resolve(CLOUD_MAINTENANCE_CONTROL_DIR)) return;
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  if (process.getuid() !== 0) {
    throw new MarketingWritePausePermissionError('the marketing write pause marker must be changed by root');
  }
}

export async function readMarketingWritePause(controlDir = CLOUD_MAINTENANCE_CONTROL_DIR, {now = new Date()} = {}) {
  const file = marketingWritePauseFile(controlDir);
  return {...evaluateMarketingWritePause(await readMarker(file), now), file};
}

export async function setMarketingWritePause({controlDir = CLOUD_MAINTENANCE_CONTROL_DIR, reason, actor = '', expiresAt = null, now = new Date()} = {}) {
  requireRootForCanonicalControlDir(controlDir);
  const validatedReason = validateMarketingWritePauseReason(reason);
  const resolvedExpiry = expiresAt === null || expiresAt === undefined || String(expiresAt).trim() === ''
    ? null
    : parseIsoInstant(expiresAt, '--expires-at');
  if (resolvedExpiry && Date.parse(resolvedExpiry) <= now.getTime()) {
    throw new MarketingWritePauseConfigurationError('--expires-at must be in the future');
  }
  const file = marketingWritePauseFile(controlDir);
  await fs.mkdir(path.dirname(file), {recursive: true, mode: MARKETING_WRITE_PAUSE_CONTROL_MODE});
  const marker = buildMarketingWritePauseMarker({reason: validatedReason, actor, setAt: now.toISOString(), expiresAt: resolvedExpiry});
  await writeJsonFileAtomic(file, marker, {mode: MARKETING_WRITE_PAUSE_MARKER_MODE, trailingNewline: true});
  await appendAudit(marketingWritePauseAuditFile(controlDir), {
    at: now.toISOString(), action: 'set', actor: marker.actor, reason: validatedReason, expiresAt: resolvedExpiry, file,
  });
  return {ok: true, action: 'set', file, marker};
}

export async function clearMarketingWritePause({controlDir = CLOUD_MAINTENANCE_CONTROL_DIR, reason, actor = '', now = new Date()} = {}) {
  requireRootForCanonicalControlDir(controlDir);
  const validatedReason = validateMarketingWritePauseReason(reason);
  const file = marketingWritePauseFile(controlDir);
  const previous = await readMarker(file);
  // The drop-in pauses on the marker's existence, so resuming is a removal.
  await fs.rm(file, {force: true});
  await fs.mkdir(path.dirname(file), {recursive: true, mode: MARKETING_WRITE_PAUSE_CONTROL_MODE});
  await appendAudit(marketingWritePauseAuditFile(controlDir), {
    at: now.toISOString(), action: 'clear', actor: String(actor || '').trim(), reason: validatedReason, previousReason: previous?.reason ?? null, file,
  });
  return {ok: true, action: 'clear', file, previousMarker: previous};
}

export async function pruneExpiredMarketingWritePause({controlDir = CLOUD_MAINTENANCE_CONTROL_DIR, reason = '', actor = 'watchdog', now = new Date()} = {}) {
  requireRootForCanonicalControlDir(controlDir);
  const file = marketingWritePauseFile(controlDir);
  const state = evaluateMarketingWritePause(await readMarker(file), now);
  if (!state.exists || !state.expired) return {ok: true, action: 'prune', pruned: false, file};
  await fs.rm(file, {force: true});
  await appendAudit(marketingWritePauseAuditFile(controlDir), {
    at: now.toISOString(), action: 'prune-expired', actor: String(actor || '').trim(), reason: String(reason || 'expired marketing write pause').trim(), previousReason: state.marker?.reason ?? null, expiresAt: state.marker?.expiresAt ?? null, file,
  });
  return {ok: true, action: 'prune', pruned: true, file};
}

function parseArgs(argv) {
  const args = {command: '', reason: '', actor: process.env.USER || process.env.LOGNAME || '', expiresAt: null, controlDir: process.env.SHEIN_BI_CONTROL_DIR || CLOUD_MAINTENANCE_CONTROL_DIR};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-') && !args.command) args.command = token;
    else if (token === '--reason') args.reason = String(argv[++index] ?? '');
    else if (token === '--actor') args.actor = String(argv[++index] ?? '');
    else if (token === '--expires-at') args.expiresAt = String(argv[++index] ?? '');
    else if (token === '--control-dir') args.controlDir = String(argv[++index] ?? '');
    else if (token === '--help' || token === '-h') args.command = 'help';
    else throw new MarketingWritePauseConfigurationError(`unknown argument: ${token}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'set': {
      const result = await setMarketingWritePause({controlDir: args.controlDir, reason: args.reason, actor: args.actor, expiresAt: args.expiresAt});
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case 'clear': {
      const result = await clearMarketingWritePause({controlDir: args.controlDir, reason: args.reason, actor: args.actor});
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    case 'prune': {
      const result = await pruneExpiredMarketingWritePause({controlDir: args.controlDir});
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.pruned ? 0 : 1;
    }
    case 'status': {
      const state = await readMarketingWritePause(args.controlDir);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        paused: state.paused,
        expired: state.expired,
        file: state.file,
        reason: state.marker?.reason ?? null,
        actor: state.marker?.actor ?? null,
        setAt: state.marker?.setAt ?? null,
        expiresAt: state.marker?.expiresAt ?? null,
      }, null, 2)}\n`);
      return state.paused ? MARKETING_WRITE_PAUSE_EXIT_CODES.paused : MARKETING_WRITE_PAUSE_EXIT_CODES.running;
    }
    default:
      process.stderr.write('usage: manage_marketing_write_pause.mjs set|clear|status|prune [--reason <why>] [--actor <who>] [--expires-at <ISO>] [--control-dir <dir>]\n');
      return MARKETING_WRITE_PAUSE_EXIT_CODES.configuration;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ok: false, code: error?.code || 'MARKETING_WRITE_PAUSE_FAILED', error: String(error?.message || error)}, null, 2)}\n`);
    process.exitCode = error?.exitCode ?? 1;
  }
}
