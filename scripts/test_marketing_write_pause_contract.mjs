import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  CANONICAL_MARKETING_WRITE_PAUSE_FILE,
  clearMarketingWritePause,
  marketingWritePauseAuditFile,
  marketingWritePauseFile,
  pruneExpiredMarketingWritePause,
  readMarketingWritePause,
  setMarketingWritePause,
  validateMarketingWritePauseReason,
} from './manage_marketing_write_pause.mjs';

// The 2026-09-11 incident: a root-created, reasonless marker in /run silently
// stopped the whole cloud marketing write chain for three days, then vanished
// on reboot. The pause must stay persistent, always carry a real reason, and
// leave an audit trail.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const tempParent = path.resolve(process.env.SHEIN_TEST_TMP_ROOT || os.tmpdir());
const tempRoot = await fsp.mkdtemp(path.join(tempParent, 'marketing-write-pause-'));
const controlDir = path.join(tempRoot, 'control');
const CLI = path.join(ROOT, 'scripts', 'manage_marketing_write_pause.mjs');
let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };
const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], {encoding: 'utf8'});
const pausePath = marketingWritePauseFile(controlDir);

try {
  const GOOD_REASON = 'incident 2026-09-14: two-core host saturated, pausing repair writes';
  const CLEAR_REASON = 'capacity restored for the fnOS migration cutover';

  // 1. The drop-in and the CLI must agree on one persistent marker path.
  const dropIn = await fsp.readFile(path.join(ROOT, 'infra', 'systemd', 'shein-bi-cloud-marketing-write-pause.conf'), 'utf8');
  assert.equal(CANONICAL_MARKETING_WRITE_PAUSE_FILE, '/var/lib/shein-bi-control/marketing-write-pause.json',
    'the canonical marker path must live in the root-owned control directory');
  assert.ok(dropIn.includes(`ConditionPathExists=!${CANONICAL_MARKETING_WRITE_PAUSE_FILE}`),
    'the drop-in must pause on the persistent marker, not on a /run file');
  assert.match(dropIn, /shein-bi-cloud-marketing-repair\.service\.d\/60-marketing-write-pause\.conf/,
    'the drop-in must name its persistent install target');
  assert.match(dropIn, /99-main-7032-pause\.conf/, 'the drop-in must tell the operator to delete the transient form');
  assert.equal(path.basename(marketingWritePauseFile()), 'marketing-write-pause.json');
  ok('drop-in and CLI share one persistent control-directory marker path');

  // 2. The legacy transient form must not come back anywhere in the repo.
  const scanned = ['scripts', 'infra', 'lib', 'docs']
    .flatMap(dir => fs.readdirSync(path.join(ROOT, dir), {recursive: true, withFileTypes: false}).map(rel => path.join(dir, String(rel))))
    .map(entry => String(entry))
    .filter(rel => /\.(?:mjs|cjs|js|sh|conf|md)$/u.test(rel))
    .filter(rel => !rel.includes('node_modules') && !rel.includes('outputs') && !rel.includes('tmp') && !rel.includes('archive'))
    .filter(rel => path.resolve(ROOT, rel) !== path.resolve(SELF));
  const offenders = [];
  for (const rel of scanned) {
    const absolute = path.join(ROOT, rel);
    let text;
    try { text = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
    if (/shein-marketing-7032-paused/u.test(text) || /ConditionPathExists=!\/run\//u.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'no tracked file may re-introduce the transient /run pause switch');
  ok('the transient /run pause switch is gone from the repo');

  // 3. Reasons are mandatory and cannot be placeholders or secrets.
  for (const bad of ['', '   ', 'todo', 'TBD', 'n/a', '---', 'token=abcdef123456', 'a'.repeat(501)]) {
    assert.throws(() => validateMarketingWritePauseReason(bad), /pause reason|placeholder|secret/u,
      `reason ${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(validateMarketingWritePauseReason(`  ${GOOD_REASON}  `), GOOD_REASON);
  ok('empty, placeholder, over-long and secret-like reasons are rejected');

  // 4. A rejected set never creates a marker.
  const emptySet = cli('set', '--control-dir', controlDir, '--reason', '');
  assert.equal(emptySet.status, 64, `empty reason must exit 64, got ${emptySet.status}`);
  assert.equal(fs.existsSync(pausePath), false, 'a rejected pause must not create the marker');
  const placeholderSet = cli('set', '--control-dir', controlDir, '--reason', 'todo');
  assert.equal(placeholderSet.status, 64);
  assert.equal(fs.existsSync(pausePath), false);
  ok('a reasonless pause is refused and writes nothing');

  // 5. set -> status -> clear round trip with an audit trail.
  const set = cli('set', '--control-dir', controlDir, '--reason', GOOD_REASON, '--actor', 'ops-audit');
  assert.equal(set.status, 0, set.stderr);
  const marker = JSON.parse(await fsp.readFile(pausePath, 'utf8'));
  assert.equal(marker.paused, true);
  assert.equal(marker.reason, GOOD_REASON);
  assert.equal(marker.actor, 'ops-audit');
  assert.ok(Number.isFinite(Date.parse(marker.setAt)));

  const pausedStatus = cli('status', '--control-dir', controlDir);
  assert.equal(pausedStatus.status, 1, 'status must exit 1 while the lane is paused');
  const pausedJson = JSON.parse(pausedStatus.stdout);
  assert.equal(pausedJson.paused, true);
  assert.equal(pausedJson.reason, GOOD_REASON);

  const clear = cli('clear', '--control-dir', controlDir, '--reason', CLEAR_REASON, '--actor', 'ops-audit');
  assert.equal(clear.status, 0, clear.stderr);
  assert.equal(fs.existsSync(pausePath), false, 'clear must remove the marker so the drop-in stops pausing');
  const runningStatus = cli('status', '--control-dir', controlDir);
  assert.equal(runningStatus.status, 0, 'status must exit 0 once the lane is running');
  assert.equal(JSON.parse(runningStatus.stdout).paused, false);

  const auditLines = (await fsp.readFile(marketingWritePauseAuditFile(controlDir), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(auditLines.map(entry => entry.action), ['set', 'clear']);
  assert.equal(auditLines[0].reason, GOOD_REASON);
  assert.equal(auditLines[1].reason, CLEAR_REASON);
  assert.equal(auditLines[1].previousReason, GOOD_REASON, 'the clear record must keep what it resumed from');
  ok('set/clear round trip is persisted with reason, actor and audit trail');

  // 6. An expiry in the past is refused; an expired marker can be pruned.
  const pastSet = cli('set', '--control-dir', controlDir, '--reason', GOOD_REASON, '--expires-at', '2020-01-01T00:00:00.000Z');
  assert.equal(pastSet.status, 64, 'an expiry in the past must be refused');
  assert.equal(fs.existsSync(pausePath), false);

  const base = new Date('2026-09-14T12:00:00.000Z');
  const expiry = '2026-09-14T13:00:00.000Z';
  await setMarketingWritePause({controlDir, reason: GOOD_REASON, actor: 'ops-audit', expiresAt: expiry, now: base});
  const stillPaused = await readMarketingWritePause(controlDir, {now: new Date('2026-09-14T12:30:00.000Z')});
  assert.equal(stillPaused.paused, true);
  assert.equal(stillPaused.expired, false);
  const expired = await readMarketingWritePause(controlDir, {now: new Date('2026-09-14T13:30:00.000Z')});
  assert.equal(expired.expired, true, 'an elapsed expiry must be reported as expired');
  assert.equal(expired.paused, false);
  const pruned = await pruneExpiredMarketingWritePause({controlDir, now: new Date('2026-09-14T13:30:00.000Z')});
  assert.equal(pruned.pruned, true);
  assert.equal(fs.existsSync(pausePath), false, 'prune must remove an expired marker');
  const pruneAgain = cli('prune', '--control-dir', controlDir);
  assert.equal(pruneAgain.status, 1, 'prune reports 1 when there is nothing expired to remove');
  ok('an expiry in the past is refused and an expired pause can be pruned');

  // 7. A corrupt marker fails closed instead of silently reading as "running".
  await fsp.mkdir(controlDir, {recursive: true});
  await fsp.writeFile(pausePath, '{not json', 'utf8');
  const corrupt = cli('status', '--control-dir', controlDir);
  assert.equal(corrupt.status, 64, 'a corrupt marker must fail closed with the configuration exit code');
  await fsp.rm(pausePath, {force: true});
  ok('a corrupt marker fails closed instead of reading as running');

  await clearMarketingWritePause({controlDir, reason: CLEAR_REASON}).catch(() => {});
  console.log(JSON.stringify({ok: true, checks}, null, 2));
} finally {
  await fsp.rm(tempRoot, {recursive: true, force: true});
}
