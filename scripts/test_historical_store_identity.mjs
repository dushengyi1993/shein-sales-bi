#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  resolveHistoricalStoreIdentity,
  storeIdentityCorrectionEvidence,
  validateHistoricalStoreIdentityConfig,
} from '../lib/historical_store_identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'historical_store_identity_corrections.json'), 'utf8'));
const stores = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8')).stores;

const corrections = validateHistoricalStoreIdentityConfig(config, stores);
assert.equal(corrections.length, 3);
assert.equal(corrections.reduce((sum, row) => sum + row.expectedItemRows, 0), 110);

const before = resolveHistoricalStoreIdentity({sourceStoreKey: 'QY', date: '2026-05-13', config, stores});
assert.equal(before.corrected, false);
assert.equal(before.effectiveStoreKey, 'QY');

const during = resolveHistoricalStoreIdentity({sourceStoreKey: 'QY', date: '2026-05-24', config, stores});
assert.equal(during.corrected, true);
assert.equal(during.effectiveStoreKey, 'YJ');
assert.equal(during.groupKey, 'LGM');
assert.equal(during.shopName, 'GS8146729');
assert.deepEqual(storeIdentityCorrectionEvidence(during), {
  incidentId: 'profile-cycle-2026-05-14-2026-06-02',
  correctionId: 'profile-cycle-qy-to-yj',
  sourceStoreKey: 'QY',
  effectiveStoreKey: 'YJ',
  date: '2026-05-24',
  range: '2026-05-14..2026-06-02',
});

assert.equal(resolveHistoricalStoreIdentity({sourceStoreKey: 'XL', date: '2026-05-14', config, stores}).effectiveStoreKey, 'QY');
assert.equal(resolveHistoricalStoreIdentity({sourceStoreKey: 'YJ', date: '2026-06-02', config, stores}).effectiveStoreKey, 'XL');
assert.equal(resolveHistoricalStoreIdentity({sourceStoreKey: 'YJ', date: '2026-06-03', config, stores}).effectiveStoreKey, 'YJ');

assert.throws(() => validateHistoricalStoreIdentityConfig({
  corrections: [
    {id: 'a', sourceStoreKey: 'QY', effectiveStoreKey: 'YJ', startDate: '2026-05-01', endDate: '2026-05-20'},
    {id: 'b', sourceStoreKey: 'QY', effectiveStoreKey: 'XL', startDate: '2026-05-20', endDate: '2026-05-30'},
  ],
}, stores), /Overlapping historical store corrections/);

console.log(JSON.stringify({ok: true, corrections: corrections.length}));
