#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'fetch_shein_business_domains.mjs'), 'utf8');

assert.match(source, /import fssync from 'node:fs';/, 'zero-row overwrite guard needs the synchronous fs import');
assert.match(source, /fssync\.existsSync\(file\)/, 'existing-result preservation guard must remain enabled');

console.log('business_domain_fetch_contract: synchronous file guard dependency is present');
