#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('./cloud_db_backup.sh', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../infra/systemd/shein-bi-db-backup.service', import.meta.url), 'utf8');

assert.match(script, /BACKUP_RETENTION_DAYS:-7/);
assert.match(script, /--prune-only/);
assert.match(script, /SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY:-\/srv\/shein-bi\/runtime\/marketing_manual_limited_discount_overrides\.json/);
assert.match(script, /marketing_manual_limited_discount_overrides\.json/);
assert.match(script, /mountpoint -q "\$COS_MOUNT"/);
assert.match(script, /sha256sum -c "\$source_dir\/SHA256SUMS\.txt"/);
assert.match(script, /gzip -t "\$archive"/);
assert.match(script, /tar -tzf "\$archive"/);
assert.match(script, /sha256sum -c "\$\(basename "\$checksum"\)"/);
assert.ok(
  script.indexOf('sha256sum -c "$(basename "$checksum")"') < script.indexOf('rm -rf -- "$source_dir"'),
  'COS readback verification must finish before local backup deletion',
);
assert.match(script, /retention skipped: COS unavailable; local backups preserved/);
assert.match(service, /SHEIN_BI_BACKUP_RETENTION_DAYS=7/);
assert.match(service, /SHEIN_BI_BACKUP_COS_MOUNT=\/lhcos-data/);
assert.match(service, /SHEIN_BI_BACKUP_COS_ARCHIVE_ROOT=\/lhcos-data\/shein-bi-db-backups/);

console.log(JSON.stringify({ok: true, checks: 14}, null, 2));
