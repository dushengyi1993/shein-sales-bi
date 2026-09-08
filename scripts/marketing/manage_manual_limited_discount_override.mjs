#!/usr/bin/env node
import {verifyPlatformPriceAudit} from '../../lib/marketing_fixed_tier_pricing.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MANUAL_LIMITED_DISCOUNT_OVERRIDES_PATH,
  MANUAL_LIMITED_DISCOUNT_SEED_PATH,
  formatShanghaiDateTime,
  loadManualLimitedDiscountRegistry,
  manualLimitedDiscountKey,
  normalizeManualLimitedDiscountEntry,
  validateManualLimitedDiscountRegistry,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {acquireCrossProcessTicketLock} from '../../lib/cross_process_ticket_lock.mjs';
import {writeFileAtomic, writeJsonFileAtomic} from '../../lib/atomic_file_publish.mjs';

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
  await writeJsonFileAtomic(file, output, {mode: 0o660});
  return output;
}

function required(args, names) {
  for (const name of names) if (args[name] === undefined || args[name] === '') throw new Error(`Missing --${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mutating = new Set(['register', 'update-activity', 'disable', 'migrate']).has(args.command);
  const lockFile = process.env.SHEIN_BI_MANUAL_LIMITED_DISCOUNT_LOCK_FILE
    || `${args.registry}.lock`;
  const release = mutating ? await acquireCrossProcessTicketLock(lockFile, {
    timeoutMs: 30_000,
    staleMs: 10 * 60_000,
    timeoutMessage: 'manual limited-discount registry is being updated by another process',
    timeoutCode: 'MANUAL_LIMITED_DISCOUNT_REGISTRY_LOCK_TIMEOUT',
  }) : null;
  try {
    if (args.command === 'migrate') {
      // Existing runtime always wins. Never merge stale business values during
      // deployment or roll back a registry together with tracked source.
      try {
        const current = JSON.parse((await fs.readFile(args.registry, 'utf8')).replace(/^\uFEFF/, ''));
        const validation = validateManualLimitedDiscountRegistry(current);
        if (!validation.ok) throw new Error(validation.errors.join('; '));
        console.log(JSON.stringify({ok: true, action: 'preserved_existing', registry: args.registry, entries: validation.entries.length}));
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const seed = path.resolve(String(args.seed || MANUAL_LIMITED_DISCOUNT_SEED_PATH));
      if (seed === args.registry) throw new Error('Migration requires distinct seed and runtime paths');
      const bytes = await fs.readFile(seed);
      const validation = validateManualLimitedDiscountRegistry(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
      if (!validation.ok) throw new Error(validation.errors.join('; '));
      await writeFileAtomic(args.registry, bytes, {mode: 0o660});
      console.log(JSON.stringify({ok: true, action: 'migrated', registry: args.registry, entries: validation.entries.length}));
      return;
    }
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
        fixedTierPricing: args.fixedTierPricing ? JSON.parse(args.fixedTierPricing) : null,
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
      let readback=null;
      if(args.readbackArtifact) {try {readback=JSON.parse(await fs.readFile(path.resolve(String(args.readbackArtifact)),'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}}
      const audits=readback?.platformPriceAudits || readback?.desiredCreate?.platformPriceAudits || [];
      const entries = registry.entries.map(row => {
        if (manualLimitedDiscountKey(row.storeKey, row.skc) !== key) return row;
        found = true;
        const platform=verifyPlatformPriceAudit(row,audits.find(a=>a?.skc===row.skc));
        if(platform && readback?.ok===true) row={...row,originalSpecialPrice:row.originalSpecialPrice ?? row.specialPrice,specialPrice:platform.actualPrice,platformPriceAudit:platform,fixedTierPricing:row.fixedTierPricing?{...row.fixedTierPricing,price:platform.actualPrice,platform}:null};
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
