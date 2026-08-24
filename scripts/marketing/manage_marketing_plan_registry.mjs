#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
  verifyMarketingPlanRegistrySync,
} from '../../lib/marketing_plan_registry.mjs';

function usage() {
  return `Usage:
  node scripts/marketing/manage_marketing_plan_registry.mjs publish \
    --selection <file> --prices <file> --registry-file <absolute-file> [--registry-root <absolute-dir>] \
    --baseline-id <id> \
    --expected-selection-sha256 <sha256> --expected-prices-sha256 <sha256> \
    --confirm ${MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN}
  node scripts/marketing/manage_marketing_plan_registry.mjs verify \
    --registry-file <absolute-file> [--registry-root <absolute-dir>]`;
}

function nextValue(argv, index, option) {
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function absoluteOption(value, option) {
  if (!path.isAbsolute(value)) throw new Error(`${option} must be an absolute path`);
  return path.resolve(value);
}

function parseArgs(argv) {
  const command = String(argv[0] || '').trim().toLowerCase();
  if (!['publish', 'verify'].includes(command)) throw new Error(usage());
  const args = {
    command,
    selectionPath: '',
    priceOverridesPath: '',
    registryRoot: '',
    registryFile: '',
    baselineId: '',
    expectedSelectionSha256: '',
    expectedPriceOverridesSha256: '',
    confirm: '',
    storesConfig: '',
  };
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--selection' || option === '--target-plan') args.selectionPath = path.resolve(nextValue(argv, i++, option));
    else if (option === '--prices' || option === '--price-overrides') args.priceOverridesPath = path.resolve(nextValue(argv, i++, option));
    else if (option === '--registry-root') args.registryRoot = absoluteOption(nextValue(argv, i++, option), option);
    else if (option === '--registry-file') args.registryFile = absoluteOption(nextValue(argv, i++, option), option);
    else if (option === '--baseline-id') args.baselineId = nextValue(argv, i++, option);
    else if (option === '--expected-selection-sha256' || option === '--expected-selection-sha') args.expectedSelectionSha256 = nextValue(argv, i++, option).toLowerCase();
    else if (option === '--expected-prices-sha256' || option === '--expected-price-overrides-sha256' || option === '--expected-prices-sha') args.expectedPriceOverridesSha256 = nextValue(argv, i++, option).toLowerCase();
    else if (option === '--confirm') args.confirm = nextValue(argv, i++, option);
    else if (option === '--stores-config') args.storesConfig = path.resolve(nextValue(argv, i++, option));
    else if (option === '--help' || option === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${option}\n${usage()}`);
  }
  if (!args.registryFile) throw new Error('--registry-file is required');
  if (!args.registryRoot) args.registryRoot = path.dirname(args.registryFile);
  if (!path.isAbsolute(args.registryRoot) || !path.isAbsolute(args.registryFile)) throw new Error('--registry-root and --registry-file must be absolute');
  if (command === 'publish') {
    for (const [key, option] of [
      ['selectionPath', '--selection'],
      ['priceOverridesPath', '--prices'],
      ['baselineId', '--baseline-id'],
      ['expectedSelectionSha256', '--expected-selection-sha256'],
      ['expectedPriceOverridesSha256', '--expected-prices-sha256'],
      ['confirm', '--confirm'],
    ]) if (!args[key]) throw new Error(`${option} is required`);
  }
  return args;
}

function expectedStoreKeys(storesConfigPath) {
  if (!storesConfigPath) return [];
  const doc = JSON.parse(fs.readFileSync(storesConfigPath, 'utf8'));
  return [...new Set((doc?.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => String(store?.storeKey || store?.store_key || store?.key || '').trim().toUpperCase())
    .filter(Boolean))].sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stores = expectedStoreKeys(args.storesConfig);
  if (args.command === 'verify') {
    const result = verifyMarketingPlanRegistrySync({
      registryFile: args.registryFile,
      registryRoot: args.registryRoot,
      expectedStoreKeys: stores,
    });
    console.log(JSON.stringify({
      ok: true,
      mode: 'verify',
      registryFile: result.registryFile,
      registryRoot: result.registryRoot,
      baselineId: result.registry.baselineId,
      registryHash: result.registryHash,
      manifestPath: result.manifestPath,
      selectionPlan: result.targetPlan,
      priceOverrides: result.priceOverrides,
      selectionPlanHash: result.selectionPlanHash,
      priceOverridesHash: result.priceOverridesHash,
      rowCount: result.rowCount,
      storeKeys: result.storeKeys,
      activityBatch: result.activityBatch,
      promotedAt: result.promotedAt,
      workFingerprint: result.workFingerprint,
    }, null, 2));
    return;
  }
  const result = await publishMarketingPlanRegistry({
    selectionPath: args.selectionPath,
    priceOverridesPath: args.priceOverridesPath,
    expectedSelectionSha256: args.expectedSelectionSha256,
    expectedPriceOverridesSha256: args.expectedPriceOverridesSha256,
    registryRoot: args.registryRoot,
    registryFile: args.registryFile,
    baselineId: args.baselineId,
    confirm: args.confirm,
    expectedStoreKeys: stores,
  });
  console.log(JSON.stringify({...result, mode: 'publish'}, null, 2));
}

await main().catch(error => {
  console.error(error?.message || error);
  process.exit(1);
});
