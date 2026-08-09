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

console.log(JSON.stringify({ok: true}));
