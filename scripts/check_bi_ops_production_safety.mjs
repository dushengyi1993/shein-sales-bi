#!/usr/bin/env node
import {normalizeSafeWriteOperations, safeWriteOperationAllowed} from '../lib/bi_ops_safe_write_policy.mjs';
/**
 * Read-only production safety checker for BI Ops real-submit pilot config.
 *
 * It never calls SHEIN and never prints OpenAPI secrets. It only inspects the
 * two local control files that can enable real writes:
 *   - config/shein_openapi.local.json
 *   - config/bi_ops_write_whitelist.local.json
 *
 * Default mode accepts either fully locked production or a narrowly scoped
 * pilot. Use --expect locked before normal deployments, and --expect pilot
 * before intentionally opening the first real-submit pilot.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OPENAPI_CONFIG_FILE = process.env.SHEIN_OPENAPI_CONFIG_FILE
  || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_WRITE_WHITELIST_FILE = process.env.SHEIN_BI_OPS_WRITE_WHITELIST_FILE
  || path.join(ROOT, 'config', 'bi_ops_write_whitelist.local.json');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const ALLOWED_REAL_SUBMIT_OPERATIONS = new Set([
  'copy_product_draft',
  'activate_link',
  'retire_link',
  'update_title',
  'update_description',
  'update_images',
  'update_inventory',
  'update_supply_price',
  'update_product_price',
  'certificate_review',
  'process_pending_discuss',
]);

function parseArgs(argv) {
  const args = {
    openapiConfigFile: DEFAULT_OPENAPI_CONFIG_FILE,
    whitelistFile: DEFAULT_WRITE_WHITELIST_FILE,
    expect: 'any',
    requireStores: [],
    requireOperations: [],
    requireUsers: [],
    json: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--openapi-config') args.openapiConfigFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--write-whitelist' || a === '--whitelist') args.whitelistFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--expect') args.expect = String(argv[++i] || 'any').trim().toLowerCase();
    else if (a === '--require-store' || a === '--require-stores') args.requireStores.push(...splitList(argv[++i], {caseMode: 'upper'}));
    else if (a === '--require-operation' || a === '--require-operations') args.requireOperations.push(...splitList(argv[++i], {caseMode: 'lower'}));
    else if (a === '--require-user' || a === '--require-users') args.requireUsers.push(...splitList(argv[++i], {caseMode: 'raw'}));
    else if (a === '--pretty') args.json = false;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!['any', 'locked', 'pilot'].includes(args.expect)) {
    throw new Error('--expect must be one of: any, locked, pilot');
  }
  args.requireStores = [...new Set(args.requireStores)];
  args.requireOperations = [...new Set(args.requireOperations)];
  args.requireUsers = [...new Set(args.requireUsers)];
  return args;
}

function help() {
  return `BI Ops production safety checker

Usage:
  node scripts/check_bi_ops_production_safety.mjs
  node scripts/check_bi_ops_production_safety.mjs --expect locked
  node scripts/check_bi_ops_production_safety.mjs --expect pilot --require-store HL --require-operation copy_product_draft --require-user <BI账号>

Options:
  --openapi-config <file>     Default: ${DEFAULT_OPENAPI_CONFIG_FILE}
  --write-whitelist <file>    Default: ${DEFAULT_WRITE_WHITELIST_FILE}
  --expect any|locked|pilot   Default: any
  --require-store <list>      Optional pilot rule requirement, comma/space separated
  --require-operation <list>  Optional pilot rule requirement, comma/space separated
  --require-user <list>       Optional pilot rule requirement, comma/space separated
  --pretty                    Human-readable output

This script is read-only. It does not call SHEIN and does not print secrets.`;
}

function splitList(value, {caseMode = 'upper'} = {}) {
  return String(value || '')
    .split(/[,\s/]+/)
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      if (caseMode === 'upper') return x.toUpperCase();
      if (caseMode === 'lower') return x.toLowerCase();
      return x;
    });
}

function normalizeTokenList(value, {caseMode = 'lower'} = {}) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) out.push(...splitList(item, {caseMode}));
  return [...new Set(out)];
}

function normalizeStoreList(value) {
  return normalizeTokenList(value, {caseMode: 'upper'});
}

async function readJsonFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return {path: file, exists: true, json: JSON.parse(text)};
  } catch (err) {
    if (err?.code === 'ENOENT') return {path: file, exists: false, json: {}};
    throw new Error(`Failed to read JSON ${file}: ${err?.message || err}`);
  }
}

function loadKnownStores() {
  try {
    const config = JSON.parse(fssync.readFileSync(STORES_PATH, 'utf8'));
    const fromGroups = Array.isArray(config?.groups?.ALL) ? config.groups.ALL : [];
    const fromStores = Array.isArray(config?.stores) ? config.stores.map(s => s?.storeKey) : [];
    return new Set([...fromGroups, ...fromStores].map(x => String(x || '').trim().toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}


function normalizeWhitelistRule(input = {}, defaults = {}) {
  const rule = input && typeof input === 'object' ? input : {};
  const operations = normalizeTokenList(rule.operations || rule.operation || rule.allowedOperations || defaults.operations || defaults.operation || [], {caseMode: 'lower'});
  const stores = normalizeStoreList(rule.stores || rule.storeKeys || rule.store || rule.allowedStores || defaults.stores || defaults.store || []);
  const users = normalizeTokenList(rule.allowedUsers || rule.users || rule.usernames || rule.allowedUsernames || rule.username || [], {caseMode: 'raw'});
  const ownerKeys = normalizeTokenList(rule.allowedOwnerKeys || rule.ownerKeys || rule.ownerKey || [], {caseMode: 'raw'});
  const roles = normalizeTokenList(rule.allowedRoles || rule.roles || [], {caseMode: 'lower'});
  return {
    id: String(rule.id || defaults.id || `${stores.join(',')}:${operations.join(',')}`).trim(),
    enabledByRule: rule.enabled !== false,
    realSubmit: rule.realSubmit === true || rule.allowRealSubmit === true,
    operations,
    stores,
    users,
    ownerKeys,
    roles,
  };
}

function normalizeWhitelist(config, knownStores) {
  const source = config && typeof config === 'object' ? config : {};
  const rawRules = [];
  if (Array.isArray(source.rules)) {
    rawRules.push(...source.rules.map((rule, index) => normalizeWhitelistRule(rule, {id: `rules[${index}]`})));
  }
  for (const [storeKey, operations] of Object.entries(source)) {
    const store = String(storeKey || '').trim().toUpperCase();
    if (!knownStores.has(store) || !operations || typeof operations !== 'object' || Array.isArray(operations)) continue;
    for (const [operation, rule] of Object.entries(operations)) {
      rawRules.push(normalizeWhitelistRule(rule, {
        id: `${store}.${operation}`,
        stores: [store],
        operations: [operation],
      }));
    }
  }
  const globallyEnabled = source.enabled === true;
  const rules = rawRules.map(rule => ({
    ...rule,
    enabled: globallyEnabled && rule.enabledByRule && rule.realSubmit,
  }));
  return {
    enabled: globallyEnabled,
    rules,
    enabledRules: rules.filter(rule => rule.enabled),
  };
}

function relativeIfInsideRoot(file) {
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

function gitTrackedFiles(files) {
  const rels = files.map(relativeIfInsideRoot).filter(Boolean);
  if (!rels.length || !fssync.existsSync(path.join(ROOT, '.git'))) return new Set();
  const result = spawnSync('git', ['ls-files', '--', ...rels], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return new Set();
  return new Set(String(result.stdout || '').split(/\r?\n/).filter(Boolean));
}

function hasToken(list, token) {
  return Array.isArray(list) && (list.includes('*') || list.includes(token));
}

function summarizeRule(rule) {
  return {
    id: rule.id,
    stores: rule.stores,
    operations: rule.operations,
    users: rule.users,
    ownerKeys: rule.ownerKeys,
    roles: rule.roles,
  };
}

function auditConfig({safeWrite, whitelist, knownStores, tracked, openapiFile, whitelistFile, expect, requireStores, requireOperations, requireUsers}) {
  const errors = [];
  const warnings = [];
  const notes = [];

  const openapiRel = relativeIfInsideRoot(openapiFile);
  const whitelistRel = relativeIfInsideRoot(whitelistFile);
  for (const rel of [openapiRel, whitelistRel].filter(Boolean)) {
    if (/\.local\.json$/i.test(rel) && tracked.has(rel)) {
      errors.push(`${rel} 是私有生产配置，不能被 Git 跟踪。`);
    }
  }

  if (safeWrite.valid !== true) errors.push('safeWriteOperations.allowedOperationsByStore is malformed');
  if (!safeWrite.enabled) {
    notes.push('safeWriteOperations.enabled=false；平台动作真实写总闸门关闭。');
  } else {
    if (!safeWrite.requireDryRun) errors.push('safeWriteOperations.requireDryRun=false；真实写必须保留 dry-run payload 锁定。');
    if (!safeWrite.allowedStores.length) errors.push('safeWriteOperations.allowedStores 为空；启用真实写时必须明确店铺。');
    if (safeWrite.allowedStores.includes('*')) errors.push('safeWriteOperations.allowedStores 不能使用 *，必须列出具体店铺。');
    const unknownSafeStores = safeWrite.allowedStores.filter(store => store !== '*' && knownStores.size && !knownStores.has(store));
    if (unknownSafeStores.length) errors.push(`safeWriteOperations.allowedStores 包含未知店铺：${unknownSafeStores.join(',')}`);
    if (!safeWrite.allowedOperations.length) errors.push('safeWriteOperations.allowedOperations 为空；启用真实写时必须明确动作。');
    if (safeWrite.allowedOperations.includes('*')) errors.push('safeWriteOperations.allowedOperations 不能使用 *，必须列出具体动作。');
    const unsupportedSafeOps = safeWrite.allowedOperations.filter(op => !ALLOWED_REAL_SUBMIT_OPERATIONS.has(op));
    if (unsupportedSafeOps.length) errors.push(`safeWriteOperations.allowedOperations 包含尚未实现真实提交适配器的动作：${unsupportedSafeOps.join(',')}`);
  }

  if (whitelist.enabled || whitelist.enabledRules.length) {
    notes.push('旧 bi_ops_write_whitelist 配置仍存在，但已退出人员授权链路；人员权限只认 BI 账号 writeStores。');
  }

  for (const store of requireStores) {
    if (!hasToken(safeWrite.allowedStores, store)) errors.push(`--require-store ${store} 未进入 safeWriteOperations.allowedStores。`);
  }
  for (const op of requireOperations) {
    if (!hasToken(safeWrite.allowedOperations, op)) errors.push(`--require-operation ${op} 未进入 safeWriteOperations.allowedOperations。`);
  }
  for (const store of requireStores) for (const operation of requireOperations) {
    if (!safeWriteOperationAllowed({safeWriteOperations: safeWrite}, {storeKey: store, operation}).allowed) errors.push(`Requested store/operation is not enabled: ${store}/${operation}`);
  }
  if (requireUsers.length) warnings.push('--require-user 已废弃；人员权限请用 BI 账号 writeStores 和权限矩阵 smoke 验证。');

  let state = 'locked';
  if (safeWrite.enabled) state = 'pilot_ready';
  if (errors.length) state = 'unsafe';

  if (expect === 'locked' && state !== 'locked') errors.push(`期望 locked，但当前状态是 ${state}。`);
  if (expect === 'pilot' && state !== 'pilot_ready') errors.push(`期望 pilot_ready，但当前状态是 ${state}。`);

  const ok = errors.length === 0;
  return {
    ok,
    state: ok ? state : 'unsafe',
    errors,
    warnings,
    notes,
    pilotRules: [],
  };
}

function printPretty(report) {
  console.log(`BI Ops 生产真实写安全检查：${report.ok ? '通过' : '未通过'} · state=${report.state}`);
  console.log(`OpenAPI 配置：${report.files.openapi.exists ? '存在' : '不存在'} · ${report.files.openapi.path}`);
  console.log(`旧人员白名单（已退出授权）：${report.files.whitelist.exists ? '存在' : '不存在'} · ${report.files.whitelist.path}`);
  console.log(`safeWrite：enabled=${report.safeWrite.enabled} requireDryRun=${report.safeWrite.requireDryRun} stores=${report.safeWrite.allowedStores.join(',') || '-'} operations=${report.safeWrite.allowedOperations.join(',') || '-'}`);
  console.log('人员权限：按 BI 账号 writeStores 校验');
  if (report.pilotRules.length) {
    for (const rule of report.pilotRules) {
      console.log(`- rule ${rule.id}: stores=${rule.stores.join(',')} ops=${rule.operations.join(',')} users=${rule.users.join(',') || '-'} ownerKeys=${rule.ownerKeys.join(',') || '-'} roles=${rule.roles.join(',') || '-'}`);
    }
  }
  for (const note of report.notes) console.log(`note: ${note}`);
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
  for (const error of report.errors) console.log(`error: ${error}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(help());
    return;
  }
  const knownStores = loadKnownStores();
  const openapi = await readJsonFile(args.openapiConfigFile);
  const whitelistFile = await readJsonFile(args.whitelistFile);
  const safeWrite = normalizeSafeWriteOperations(openapi.json);
  const whitelist = normalizeWhitelist(whitelistFile.json, knownStores);
  const tracked = gitTrackedFiles([args.openapiConfigFile, args.whitelistFile]);
  const audit = auditConfig({
    safeWrite,
    whitelist,
    knownStores,
    tracked,
    openapiFile: args.openapiConfigFile,
    whitelistFile: args.whitelistFile,
    expect: args.expect,
    requireStores: args.requireStores,
    requireOperations: args.requireOperations,
    requireUsers: args.requireUsers,
  });
  const report = {
    ok: audit.ok,
    state: audit.state,
    generatedAt: new Date().toISOString(),
    expect: args.expect,
    files: {
      openapi: {path: args.openapiConfigFile, exists: openapi.exists},
      whitelist: {path: args.whitelistFile, exists: whitelistFile.exists},
    },
    safeWrite,
    whitelist: {
      enabled: whitelist.enabled,
      ruleCount: whitelist.rules.length,
      enabledRuleCount: whitelist.enabledRules.length,
    },
    trackedLocalConfigFiles: [...tracked],
    pilotRules: audit.pilotRules,
    notes: audit.notes,
    warnings: audit.warnings,
    errors: audit.errors,
    nextStep: audit.ok
      ? (audit.state === 'pilot_ready'
        ? '平台动作总闸门已通过：仍需账号 writeStores、系统检查快照、确认、审计和回读。'
        : '当前真实写保持锁定；如需开放动作，先准备明确的 safeWriteOperations 店铺与动作范围。')
      : '不要启动或重启真实写试点；先修复 errors，再重新运行本检查。',
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printPretty(report);
  if (!audit.ok) process.exitCode = 1;
}

main().catch(err => {
  console.error(JSON.stringify({ok: false, error: err?.message || String(err), stack: err?.stack || ''}, null, 2));
  process.exitCode = 1;
});
