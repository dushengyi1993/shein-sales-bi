#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const exporter = await fs.readFile(new URL('./export_shein_browser_session.mjs', import.meta.url), 'utf8');
const restore = await fs.readFile(new URL('./restore_shein_store_session.mjs', import.meta.url), 'utf8');
const manager = await fs.readFile(new URL('./cloud_shein_session_manager.mjs', import.meta.url), 'utf8');
const timer = await fs.readFile(new URL('../infra/systemd/shein-bi-cloud-session-manager.timer', import.meta.url), 'utf8');

assert.match(exporter, /state', 'shein_webapi_sessions/);
assert.match(exporter, /validateWebApiSession\(webApiPayload\)/);
assert.match(exporter, /writeJsonAtomic\(webApiFile, webApiPayload\)/);
assert.match(exporter, /exported_webapi_session_probe_failed/);
assert.match(exporter, /webApiProbe/);
assert.doesNotMatch(exporter, /console\.(?:log|error)\([^)]*cookieHeader/);

assert.match(restore, /webApiFile: r\.webApiFile/);
assert.match(restore, /webApiProbe: r\.webApiProbe/);

assert.match(manager, /webApiSessionFresh/);
assert.match(manager, /webApiProbeOk/);
assert.match(manager, /stale_webapi_session_export/);
assert.match(manager, /webapi_session_probe_not_verified/);
assert.match(manager, /res\.ok && okFromParsed && webApiSessionFresh && webApiProbeOk/);

assert.match(timer, /OnCalendar=\*-\*-\* 00:45:00/);
assert.match(timer, /Persistent=false/);

console.log('session_manager_webapi_export_contract: daily profile login now refreshes and verifies reusable WebAPI sessions');
