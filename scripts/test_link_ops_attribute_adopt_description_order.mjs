import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  hasPublishDescriptionState,
  validateCopyProductDescriptionPolicy,
} from '../lib/link_ops_product_descriptions.mjs';

// SK-185 (lot_20260914132556_543ce3d4) deadlocked: the attribute gate blocked
// prepare-descriptions, and prepare-product-attribute --adopt-existing demanded
// a fully valid description lock that only prepare-descriptions could create.
// Adoption provably does not touch the payload, so when no description state
// exists yet the description lock has nothing to protect and must not be a
// precondition. Execution still validates both gates independently.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };

// 1. No description state: nothing to protect, and the policy is genuinely
//    blocked, so the adopt guard is load-bearing rather than decorative.
const bareTask = {id: 'lot_fixture', openapiPublishPayload: {skc_list: [{skc_name: 'sv1'}]}};
const barePayload = {skc_list: [{skc_name: 'sv1'}]};
assert.equal(hasPublishDescriptionState(bareTask, barePayload), false);
const barePolicy = validateCopyProductDescriptionPolicy(bareTask, barePayload);
assert.equal(barePolicy.ok, false, 'the description policy itself must still block a description-less payload');
assert.equal(barePolicy.mode, 'blocked');
ok('a description-less payload has no description state and is still blocked by the policy');

// 2. Any description state re-enables the strict requirement.
assert.equal(hasPublishDescriptionState({...bareTask, descriptionMaterialBinding: {schemaVersion: 'x'}}, barePayload), true);
assert.equal(hasPublishDescriptionState({...bareTask, emptyDescriptionAuthorization: {schemaVersion: 'x'}}, barePayload), true);
assert.equal(hasPublishDescriptionState(bareTask, {...barePayload, multi_language_desc_list: [{language: 'en', name: 'x'}]}), true);
ok('a description binding, empty authorization or payload description all count as state');

// 3. Contract: only the adopt path is relaxed, and it is relaxed at exactly the
//    two adopt sites. The execution gate itself is untouched.
const portal = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
const guarded = portal.match(/hasPublishDescriptionState\(/gu) || [];
assert.equal(guarded.length, 2, `expected exactly the two adopt guards, saw ${guarded.length}`);
assert.match(portal, /^\s*hasPublishDescriptionState,\s*$/mu, 'the helper must be imported from the descriptions module');
assert.match(portal, /if \(hasPublishDescriptionState\(task, originalPayload\) && !descriptionPolicy\.ok\)/);
assert.match(portal, /if \(!resignExistingBinding && hasPublishDescriptionState\(operationTask, payload\) && !adoptDescriptionPolicy\.ok\)/);
assert.doesNotMatch(portal, /if \(!descriptionPolicy\.ok\)/, 'the unconditional adopt description requirement must be gone');
ok('only the two adopt sites are relaxed and the execution gate is unchanged');

// 4. The execution gate still requires the binding for a whitelisted row.
const gateSource = portal.slice(portal.indexOf('function productAttributeExecutionGate'));
assert.match(gateSource.slice(0, 2200), /PRODUCT_ATTRIBUTE_UNBOUND_ROWS/,
  'an unbound whitelisted attribute row must still be refused at execution');
ok('an unbound whitelisted attribute row is still refused at execution');

console.log(JSON.stringify({ok: true, checks}, null, 2));
