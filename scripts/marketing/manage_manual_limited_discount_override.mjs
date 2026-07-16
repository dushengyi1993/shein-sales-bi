#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_MANUAL_LIMITED_DISCOUNT_OVERRIDES_PATH,
  formatShanghaiDateTime,
  loadManualLimitedDiscountRegistry,
  manualLimitedDiscountKey,
  normalizeManualLimitedDiscountEntry,
  validateManualLimitedDiscountRegistry,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {acquireCrossProcessTicketLock} from '../../lib/cross_process_ticket_lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {command: argv[0] || 'validate', registry: DEFAULT_MANUAL_LIMITED_DISCOUNT_OVERRIDES_PATH};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    args[key] = value;
  }
  args.registry = path.resolve(String(args.registry));
  return args;
}

async function writeRegistry(file, doc) {
  const validation = validateManualLimitedDiscountRegistry(doc);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const output = {...doc, updatedAt: new Date().toISOString(), entries: validation.entries};
  const temp = `${file}.tmp-${process.pid}`;
  const content = `${JSON.stringify(output, null, 2)}\n`;
  try {
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, {force: true}).catch(() => {});
    if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
    // Production keeps config/ root-owned while this specific registry file is
    // writable by sheinops. Fall back to a guarded in-place replacement.
    await fs.writeFile(file, content, 'utf8');
  }
  return output;
}

function required(args, names) {
  for (const name of names) if (args[name] === undefined || args[name] === '') throw new Error(`Missing --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mutating = new Set(['register', 'update-activity', 'disable']).has(args.command);
  const lockFile = process.env.SHEIN_BI_MANUAL_LIMITED_DISCOUNT_LOCK_FILE
    || path.join(ROOT, 'state', 'locks', 'manual-limited-discount-registry.lock');
  const release = mutating ? await acquireCrossProcessTicketLock(lockFile, {
    timeoutMs: 30_000,
    staleMs: 10 * 60_000,
    timeoutMessage: 'manual limited-discount registry is being updated by another process',
    timeoutCode: 'MANUAL_LIMITED_DISCOUNT_REGISTRY_LOCK_TIMEOUT',
  }) : null;
  try {
    // Mutating commands intentionally load only after acquiring the lock. This
    // prevents two timer/CLI processes from both reading an old registry and
    // then silently overwriting each other's updates.
    const registry = await loadManualLimitedDiscountRegistry(args.registry);
    if (args.command === 'validate') {
      console.log(JSON.stringify({ok: true, registry: args.registry, entries: registry.entries.length}, null, 2));
    } else if (args.command === 'list') {
      console.log(JSON.stringify({ok: true, registry: args.registry, entries: registry.entries}, null, 2));
    } else if (args.command === 'register') {
      required(args, ['store', 'skc', 'specialPrice', 'validFrom', 'validTo', 'activityStock', 'reason', 'sourceThreadId', 'sourceArtifact']);
      const entry = normalizeManualLimitedDiscountEntry({
        storeKey: args.store,
        skc: args.skc,
        canonical: args.canonical || '',
        specialPrice: args.specialPrice,
        validFrom: args.validFrom,
        validTo: args.validTo,
        activityStock: args.activityStock,
        reason: args.reason,
        sourceThreadId: args.sourceThreadId,
        sourceArtifact: args.sourceArtifact,
        originalActivityId: args.originalActivityId || null,
        currentActivityId: args.activityId || null,
        status: args.status || 'active',
        registeredAt: formatShanghaiDateTime(),
      });
      const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
      if (registry.entries.some(row => manualLimitedDiscountKey(row.storeKey, row.skc) === key) && args.replace !== true && args.replace !== 'true') {
        throw new Error(`Registry entry already exists for ${key}; pass --replace true to update it intentionally`);
      }
      const entries = registry.entries.filter(row => manualLimitedDiscountKey(row.storeKey, row.skc) !== key);
      entries.push(entry);
      const output = await writeRegistry(args.registry, {...registry, entries, sourcePath: undefined});
      console.log(JSON.stringify({ok: true, action: 'register', key, entry: output.entries.find(row => manualLimitedDiscountKey(row.storeKey, row.skc) === key)}, null, 2));
    } else if (args.command === 'update-activity') {
      required(args, ['store', 'skc', 'activityId']);
      const key = manualLimitedDiscountKey(args.store, args.skc);
      let found = false;
      const entries = registry.entries.map(row => {
        if (manualLimitedDiscountKey(row.storeKey, row.skc) !== key) return row;
        found = true;
        return {...row, currentActivityId: Number(args.activityId), status: String(args.status || row.status || 'active'), lastReadbackAt: formatShanghaiDateTime(), lastReadbackArtifact: args.readbackArtifact || row.lastReadbackArtifact || ''};
      });
      if (!found) throw new Error(`Registry entry not found for ${key}`);
      await writeRegistry(args.registry, {...registry, entries, sourcePath: undefined});
      console.log(JSON.stringify({ok: true, action: 'update-activity', key, activityId: Number(args.activityId)}, null, 2));
    } else if (args.command === 'disable') {
      required(args, ['store', 'skc']);
      const key = manualLimitedDiscountKey(args.store, args.skc);
      let found = false;
      const entries = registry.entries.map(row => {
        if (manualLimitedDiscountKey(row.storeKey, row.skc) !== key) return row;
        found = true;
        return {...row, status: 'disabled', disabledAt: formatShanghaiDateTime(), disabledReason: args.reason || 'manual_disable'};
      });
      if (!found) throw new Error(`Registry entry not found for ${key}`);
      await writeRegistry(args.registry, {...registry, entries, sourcePath: undefined});
      console.log(JSON.stringify({ok: true, action: 'disable', key}, null, 2));
    } else {
      throw new Error(`Unknown command: ${args.command}`);
    }
  } finally {
    await release?.();
  }
}

await main();
