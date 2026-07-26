#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'repair_historical_store_identity.mjs'), 'utf8');

assert.match(source, /Default mode is read-only/);
assert.match(source, /--execute --confirm-hash/);
assert.match(source, /uniqueSkcOwnerContradictions/);
assert.match(source, /source_file LIKE 'outputs\/shein_fetch\/'/);
assert.match(source, /inventory cost event references require a dedicated ledger rebuild/);
assert.match(source, /DELETE FROM ops\.order_status_recheck_state old_state/);
assert.match(source, /UPDATE fact\.order_item item/);
assert.match(source, /UPDATE fact\.order_header header/);
assert.match(source, /UPDATE fact\.order_payment_flag payment/);
assert.match(source, /historical-store-identity-repair/);
assert.match(source, /cross-store after-sales matches remain/);
assert.match(source, /daily sales reconciliation failed/);
assert.match(source, /ops\.order_store_reassignment_audit/);

console.log(JSON.stringify({ok: true}));
