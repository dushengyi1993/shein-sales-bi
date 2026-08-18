#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const hook = await fs.readFile(path.join(root, '.githooks', 'pre-push'), 'utf8');
const installer = await fs.readFile(path.join(scriptDir, 'install_local_repo_hygiene.ps1'), 'utf8');
const cleanup = await fs.readFile(path.join(scriptDir, 'cleanup_local_workspace_hygiene.ps1'), 'utf8');
const taskInstaller = await fs.readFile(path.join(scriptDir, 'install_local_workspace_hygiene_task.ps1'), 'utf8');
const ciWorkflow = await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const partnerCliReleaseWorkflow = await fs.readFile(path.join(root, '.github', 'workflows', 'partner-cli-release.yml'), 'utf8');
const productDraftMapper = await fs.readFile(path.join(root, 'lib', 'link_ops_product_draft_mapper.mjs'), 'utf8');
const productExecutor = await fs.readFile(path.join(scriptDir, 'link_ops_hl_openapi_executor.mjs'), 'utf8');
const testSources = await Promise.all((await fs.readdir(scriptDir))
  .filter(name => /^test_.*\.mjs$/u.test(name))
  .map(async name => ({name, source: await fs.readFile(path.join(scriptDir, name), 'utf8')})));

assert.match(hook, /refs\/heads\/main/);
assert.match(hook, /SHEIN_BI_ALLOW_MAIN_PUSH/);
assert.match(hook, /codex\/\*/);
assert.match(installer, /core\.hooksPath\s+\.githooks/);
assert.match(installer, /fetch\.prune\s+true/);
assert.match(installer, /pull\.ff\s+only/);
assert.match(cleanup, /cloud-marketing-\(workers\|local-runtime\)/);
assert.match(cleanup, /Test-ProcessReferencesPath/);
assert.match(cleanup, /AllowedJunctionTargets/);
assert.match(cleanup, /worktree prune/);
assert.match(cleanup, /cleanup_local_shein_browser_profile_cache\.mjs/);
assert.match(cleanup, /--apply --json/);
assert.match(taskInstaller, /SHEIN-BI-Local-Workspace-Hygiene/);
assert.match(taskInstaller, /StartWhenAvailable/);
assert.match(taskInstaller, /MinimumAgeDays 3/);
assert.match(taskInstaller, /-File/);
assert.match(taskInstaller, /-OutputPath/);
assert.doesNotMatch(taskInstaller, /-Command/);
assert.match(cleanup, /Write-AtomicJsonReport/);
assert.match(cleanup, /errorType/);
assert.match(cleanup, /Console\]::OutputEncoding/);
assert.match(cleanup, /\$OutputEncoding\s*=\s*\$Utf8NoBom/);
assert.match(ciWorkflow, /deterministic-shards:[\s\S]*?timeout-minutes:\s*45\b/);
assert.match(partnerCliReleaseWorkflow, /timeout-minutes:\s*45\b/);
assert.match(productDraftMapper, /export function resolveLinkOpsOutputDir\(\)[\s\S]*?process\.env\.SHEIN_BI_OUTPUT_DIR/);
assert.match(productExecutor, /resolveLinkOpsOutputDir/);
assert.doesNotMatch(productExecutor, /path\.join\(ROOT,\s*['"]outputs['"],\s*['"]bi-portal['"]/u);
for (const {name, source} of testSources) {
  assert.doesNotMatch(source, /path\.join\(ROOT,\s*['"]outputs['"],\s*['"]shein_(?:links|links_raw|openapi_products)['"]/u,
    `${name} must use an isolated SHEIN_BI_OUTPUT_DIR fixture root`);
}

console.log(JSON.stringify({ok: true}));
