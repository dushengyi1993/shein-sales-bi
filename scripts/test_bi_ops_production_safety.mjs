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
    assert.equal(pilot.json.pilotRules.length, 1);

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

    const forbiddenAction = await runCase(tmp, 'forbidden-action', {
      openapi: {
        safeWriteOperations: {
          enabled: true,
          requireDryRun: true,
          allowedOperations: ['retire_link'],
          allowedStores: ['HL'],
        },
      },
      whitelist: {
        enabled: true,
        rules: [{
          id: 'bad-retire',
          enabled: true,
          realSubmit: true,
          stores: ['HL'],
          operations: ['retire_link'],
          allowedUsers: ['owner_smoke'],
        }],
      },
      expectCode: 1,
    });
    assert.equal(forbiddenAction.json.ok, false);
    assert.match(forbiddenAction.stdout, /存量维护动作仍只允许 dry-run|当前不得真实提交/);

    const rolesOnly = await runCase(tmp, 'roles-only', {
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
      expectCode: 1,
    });
    assert.equal(rolesOnly.json.ok, false);
    assert.match(rolesOnly.stdout, /不能只靠角色泛放真实写/);

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
      expectCode: 1,
    });
    assert.equal(safeBroaderThanWhitelist.json.ok, false);
    assert.match(safeBroaderThanWhitelist.stdout, /没有有效白名单规则覆盖该店/);

    console.log(JSON.stringify({
      ok: true,
      cases: ['locked', 'pilot', 'wildcard', 'forbidden-action', 'roles-only', 'safe-broader'],
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
