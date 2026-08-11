#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CLOUD_TIMER_UNITS} from '../lib/cloud_runtime_inventory.mjs';

const script = fs.readFileSync(new URL('./cloud_disk_maintenance.sh', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-disk-maintenance.service', import.meta.url), 'utf8');
const timer = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-disk-maintenance.timer', import.meta.url), 'utf8');
const journal = fs.readFileSync(new URL('../infra/systemd/90-shein-bi-journald-disk-cap.conf', import.meta.url), 'utf8');
const watchdog = fs.readFileSync(new URL('./cloud_ops_watchdog.mjs', import.meta.url), 'utf8');

assert.match(script, /PROFILE_CACHE_THRESHOLD_PERCENT:-80/);
assert.match(script, /OUTPUT_RETENTION_DAYS:-30/);
assert.match(script, /TMP_RETENTION_DAYS:-7/);
assert.match(script, /readBrowserLeases[\s\S]*filter\(x=>x\.valid\)/);
assert.match(script, /pgrep -f 'chrome\|chromium\|playwright'/);
assert.match(script, /CacheStorage/);
assert.doesNotMatch(script, /['"](?:Cookies|Local Storage|IndexedDB)['"]/,
  'login and durable browser state must never be cleanup targets');
assert.match(script, /mountpoint -q "\$COS_MOUNT"/);
assert.match(script, /gzip -t "\$partial_archive"/);
assert.match(script, /tarfile\.open[\s\S]*actual != expected/);
assert.match(script, /changed_since_archive/);
assert.match(script, /target\.relative_to\(outputs\)/);
assert.ok(script.indexOf('mv -- "$partial_archive" "$archive"') < script.indexOf('target.unlink()'),
  'verified COS archive must exist before local output deletion');

assert.match(service, /^User=root$/m);
assert.match(service, /^Group=sheinops$/m);
assert.match(service, /^IOSchedulingClass=idle$/m);
assert.match(service, /^NoNewPrivileges=true$/m);
assert.match(service, /SHEIN_BI_PROFILE_CACHE_THRESHOLD_PERCENT=75/);
assert.match(service, /^Slice=shein-host-heavy-bi\.slice$/m);
assert.match(service, /^ExecStart=.*run_host_heavy_job\.sh.*--deadline-at 00:27.*cloud_disk_maintenance\.sh$/m);
assert.match(timer, /^OnCalendar=\*-\*-\* 00:10:00 Asia\/Shanghai$/m);
assert.match(timer, /^Persistent=false$/m);
assert.match(journal, /^SystemMaxUse=1G$/m);
assert.match(journal, /^SystemKeepFree=5G$/m);
assert.ok(CLOUD_TIMER_UNITS.includes('shein-bi-cloud-disk-maintenance.timer'));
assert.match(watchdog, /usedPercent >= 93/);
assert.match(watchdog, /usedPercent >= 88/);
assert.match(watchdog, /usedPercent >= 80/);
assert.match(watchdog, /服务器硬盘快满了/);

console.log(JSON.stringify({ok: true, checks: 27}, null, 2));
