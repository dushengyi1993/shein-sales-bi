#!/usr/bin/env node
/**
 * Smoke tests for scripts/check_bi_ops_production_safety.mjs.
 *
 * These tests use temporary config files only. They do not touch production
 * local config, do not start the BI portal, and do not call SHEIN.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {safeWriteOperationAllowed} from '../lib/bi_ops_safe_write_policy.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = path.join(ROOT, 'scripts', 'check_bi_ops_production_safety.mjs');

function runNode(args, {expectCode = 0} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== expectCode) {
        reject(new Error(`Unexpected exit code ${code}, expected ${expectCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      let json = null;
      try { json = stdout ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}

async function writeJson(file, data) {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function runCase(tmp, name, {openapi, whitelist, args = [], expectCode = 0}) {
  const openapiFile = path.join(tmp, `${name}-openapi.json`);
  const whitelistFile = path.join(tmp, `${name}-whitelist.json`);
  await writeJson(openapiFile, openapi);
  await writeJson(whitelistFile, whitelist);
  return await runNode([
    CHECKER,
    '--openapi-config', openapiFile,
    '--write-whitelist', whitelistFile,
    ...args,
  ], {expectCode});
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-ops-production-safety-'));
  try {
    const locked = await runCase(tmp, 'locked', {
      openapi: {safeWriteOperations: {enabled: false, requireDryRun: true, allowedOperations: [], allowedStores: []}},
      whitelist: {enabled: false, rules: []},
      args: ['--expect', 'locked'],
    });
    assert.equal(locked.json.ok, true);
    assert.equal(locked.json.state, 'locked');

    const pilot = await runCase(tmp, 'pilot', {
      openapi: {
        stores: [{storeKey: 'HL', enabled: true, openKeyId: 'dummy', secretKey: 'dummy'}],
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['copy_product_draft'],
          allowedStores: ['HL'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'owner-hl-copy',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['copy_product_draft'],
          allowedUsers: ['owner_smoke'],
          allowedRoles: ['owner'],
        }],
      },
      args: ['--expect', 'pilot', '--require-store', 'HL', '--require-operation', 'copy_product_draft', '--require-user', 'owner_smoke'],
    });
    assert.equal(pilot.json.ok, true);
    assert.equal(pilot.json.state, 'pilot_ready');
    assert.equal(pilot.json.pilotRules.length, 0);
    assert.match((pilot.json.warnings || []).join('；'), /require-user 已废弃/);

    const wildcard = await runCase(tmp, 'wildcard', {
      openapi: {
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['copy_product_draft'],
          allowedStores: ['*'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'bad-wide-store',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['copy_product_draft'],
          allowedUsers: ['owner_smoke'],
        }],
      },
      expectCode: 1,
    });
    assert.equal(wildcard.json.ok, false);
    assert.match(wildcard.stdout, /不能使用 \*/);

    const maintenancePilot = await runCase(tmp, 'maintenance-pilot', {
      openapi: {
        stores: [{storeKey: 'HL', enabled: true, openKeyId: 'dummy', secretKey: 'dummy'}],
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['activate_link', 'retire_link', 'update_inventory', 'update_description'],
          allowedStores: ['HL'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'owner-hl-maintenance',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['activate_link', 'retire_link', 'update_inventory', 'update_description'],
          allowedUsers: ['owner_smoke'],
        }],
      },
      args: ['--expect', 'pilot', '--require-store', 'HL', '--require-operation', 'activate_link', '--require-operation', 'retire_link', '--require-operation', 'update_inventory', '--require-operation', 'update_description', '--require-user', 'owner_smoke'],
    });
    assert.equal(maintenancePilot.json.ok, true);
    assert.equal(maintenancePilot.json.state, 'pilot_ready');

    const unsupportedAction = await runCase(tmp, 'unsupported-action', {
      openapi: {
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['campaign_signup'],
          allowedStores: ['HL'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'bad-campaign',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['campaign_signup'],
          allowedUsers: ['owner_smoke'],
        }],
      },
      expectCode: 1,
    });
    assert.equal(unsupportedAction.json.ok, false);
    assert.match(unsupportedAction.stdout, /尚未实现真实提交适配器/);

    const legacyRolesOnlyIgnored = await runCase(tmp, 'roles-only', {
      openapi: {
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['copy_product_draft'],
          allowedStores: ['HL'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'bad-roles-only',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['copy_product_draft'],
          allowedRoles: ['owner'],
        }],
      },
    });
    assert.equal(legacyRolesOnlyIgnored.json.ok, true);
    assert.equal(legacyRolesOnlyIgnored.json.state, 'pilot_ready');
    assert.match((legacyRolesOnlyIgnored.json.notes || []).join('；'), /退出人员授权链路/);

    const safeBroaderThanWhitelist = await runCase(tmp, 'safe-broader', {
      openapi: {
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['copy_product_draft'],
          allowedStores: ['HL', 'DX'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'owner-hl-copy-only',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['copy_product_draft'],
          allowedUsers: ['owner_smoke'],
        }],
      },
    });
    assert.equal(safeBroaderThanWhitelist.json.ok, true);
    assert.equal(safeBroaderThanWhitelist.json.state, 'pilot_ready');

    console.log(JSON.stringify({
      ok: true,
      cases: ['locked', 'pilot', 'maintenance-pilot', 'wildcard', 'unsupported-action', 'legacy-whitelist-ignored', 'safe-scope-independent-of-legacy-whitelist'],
      tmpCleaned: true,
    }, null, 2));
  } finally {
    await fs.rm(tmp, {recursive: true, force: true}).catch(() => {});
  }
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exit(1);
});

const scopedConfig = {safeWriteOperations: {enabled: true, requireDryRun: true, allowedStores: ['DL','LG','HY'], allowedOperations: ['copy_product_draft','update_inventory'], allowedOperationsByStore: {LG:['copy_product_draft'],HY:['copy_product_draft']}}};
for (const storeKey of ['LG','HY']) {
  assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey,operation:'copy_product_draft'}).allowed,true);
  assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey,operation:'update_inventory'}).allowed,false);
}
assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey:'DL',operation:'update_inventory'}).allowed,true);
assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey:'TZ',operation:'copy_product_draft'}).allowed,false);
scopedConfig.safeWriteOperations.allowedOperationsByStore.LG = [];
assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey:'LG',operation:'copy_product_draft'}).allowed,false);

scopedConfig.safeWriteOperations.allowedOperationsByStore = null;
assert.equal(safeWriteOperationAllowed(scopedConfig,{storeKey:'LG',operation:'copy_product_draft'}).allowed,false);
