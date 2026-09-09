#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {resolveOrdinaryTierInputs} from '../lib/marketing_editor_fields.mjs';
import {validateOrdinaryActivityEnrollmentReadback} from '../lib/marketing_activity_inventory_integration.mjs';
import {
  scopeOrdinaryEnrollmentReadbackToApprovedRows,
  wrapOrdinaryEnrollmentReadbackForTransaction,
} from '../lib/marketing_ordinary_enrollment_scope.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadlineFill = await fs.readFile(path.join(root, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs'), 'utf8');
const chunkRunner = await fs.readFile(path.join(root, 'scripts', 'marketing', 'run_ordinary_chunk_submission_batch.mjs'), 'utf8');
const storeRunner = await fs.readFile(path.join(root, 'scripts', 'marketing', 'run_ordinary_store_submission_batch.mjs'), 'utf8');
const enrollmentVerifier = await fs.readFile(path.join(root, 'scripts', 'marketing', 'verify_ordinary_activity_enrollment.mjs'), 'utf8');
const pricing = await fs.readFile(path.join(root, 'lib', 'marketing_low_et_fast_seller_pricing.mjs'), 'utf8');

const laterRowsPending = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  ok: false,
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {
    JSH: {
      ok: false,
      identityOk: true,
      loginRecoveryOk: true,
      approvedRowsOk: true,
      plannedRows: 20,
      checkedRows: 20,
      missingRows: 0,
      priceMismatchRows: 0,
      badPacketActivities: 0,
    },
  },
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 7,
  activityListGapRows: 7,
});
assert.equal(laterRowsPending.ok, true, 'later approved rows must not fail the current submission readback');
assert.equal(laterRowsPending.observedExtraAvailableRows, 7);
assert.equal(laterRowsPending.observedActivityListGapRows, 7);
assert.equal(laterRowsPending.extraAvailableRows, 0);
assert.equal(laterRowsPending.activityListGapRows, 0);
assert.equal(validateOrdinaryActivityEnrollmentReadback(
  wrapOrdinaryEnrollmentReadbackForTransaction(laterRowsPending),
).ok, true, 'scoped readback must remain consumable by the inventory transaction validator');

const currentRowMissing = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {JSH: {ok: true, identityOk: true, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 20, checkedRows: 20, missingRows: 1, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 1,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(currentRowMissing.ok, false, 'a missing current row must still fail closed');
assert.equal(validateOrdinaryActivityEnrollmentReadback(
  wrapOrdinaryEnrollmentReadbackForTransaction(currentRowMissing),
).ok, false, 'transaction validation must retain current-row failures');

const identityFailed = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 20,
  byStore: {JSH: {ok: false, identityOk: false, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 20, checkedRows: 20, missingRows: 0, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(identityFailed.ok, false, 'identity failure must not become a scoped success');

const emptyReadback = scopeOrdinaryEnrollmentReadbackToApprovedRows({
  stores: ['JSH'],
  plannedRows: 20,
  checkedRows: 0,
  byStore: {JSH: {ok: false, identityOk: true, loginRecoveryOk: true, approvedRowsOk: false, plannedRows: 0, checkedRows: 0, missingRows: 0, priceMismatchRows: 0, badPacketActivities: 0}},
  missingRows: 0,
  priceMismatchRows: 0,
  badPacketActivities: 0,
  extraAvailableRows: 0,
  activityListGapRows: 0,
});
assert.equal(emptyReadback.ok, false, 'an empty readback must not pass as zero issues');
assert.match(enrollmentVerifier, /unavailableButFillVerified: false,\s*priceUnavailableNoFillEvidence: true/,
  'missing fill evidence must not also be counted as verified fill evidence');

const openAt = deadlineFill.indexOf('const {targetId, sessionId} = await newPage(cdp, url);');
const forcedRefreshAt = deadlineFill.indexOf("await cdp.call('Page.reload', {ignoreCache: true}, sessionId)", openAt);
const initialReadinessAt = deadlineFill.indexOf('let firstState = await waitForActivityOrLogin', openAt);
assert(openAt >= 0 && forcedRefreshAt > openAt && initialReadinessAt > forcedRefreshAt,
  'each activity page must force-refresh once before readiness checks');

const fillStart = deadlineFill.indexOf('async function fillEditPage');
const editorReadyAt = deadlineFill.indexOf('let rowEditorReady = await waitFor', fillStart);
const editPageSizeAt = deadlineFill.indexOf('editPageSize = await setPageSize500', fillStart);
assert(fillStart >= 0 && editorReadyAt > fillStart && editPageSizeAt > editorReadyAt,
  'the edit table must render before switching it to 500 rows per page');
assert.match(deadlineFill, /selectAllGoodsAndNext\(cdp, sessionId, allowSkcs\)/,
  '500 visible rows must still use the approved SKC allowlist');
assert.match(deadlineFill, /outOfPlanRows\.set\(/,
  'rows outside the approved batch must remain observable and blocking');
assert.match(deadlineFill, /const evidenceBaselineDoc = EXECUTION_APPROVAL\?\.prices \|\| doc;/,
  'approved batches must share one low-ET evidence baseline across subsets');
assert.match(deadlineFill, /currentLockedPriceKeys/,
  'explicit prices must be gated by the current approved price key set');
assert.match(deadlineFill, /requiresTemporaryRaise === true[\s\S]*禁止直接提交/,
  'direct submit must stop when an inventory transaction is required');
const noCloseReuseAt = deadlineFill.indexOf('} else if (!(await isDebugPortOpen(store))) {');
const noCloseLaunchAt = deadlineFill.indexOf('launchVisible(store);', noCloseReuseAt);
const noClosePortWaitAt = deadlineFill.indexOf('await waitForDebugPort(store);', noCloseLaunchAt);
assert(noCloseReuseAt >= 0 && noCloseLaunchAt > noCloseReuseAt && noClosePortWaitAt > noCloseLaunchAt,
  '--no-close must reuse an open browser and launch one only when the debug port is absent');

assert.match(chunkRunner, /chunkSize: 500/,
  'ordinary activity chunks must default to one 500-row page');
assert.match(chunkRunner, /Invalid --chunk-size \(1-500\)/,
  'ordinary activity chunk size must support the visible 500-row page limit');
assert.match(chunkRunner, /final-verify[\s\S]*browser-cleanup/,
  'chunk batches must perform one final full-plan readback before browser cleanup');

for (const [name, source] of [['chunk runner', chunkRunner], ['store runner', storeRunner]]) {
  assert.match(source, /--bi/, name + ' must accept and forward current BI evidence');
  assert.match(source, /--inventory-trend/, name + ' must accept and forward current ET evidence');
  assert.match(source, /--no-close/, name + ' must reuse the same store browser across dry-run, submit, and readback');
  assert.match(source, /scopeOrdinaryEnrollmentReadbackToApprovedRows/, name + ' must scope readback to approved rows');
  assert.match(source, /wrapOrdinaryEnrollmentReadbackForTransaction/, name + ' must preserve the transaction validator readback shape');
  assert.match(source, /--fill-results-dir/, name + ' must verify against this run fill evidence');
  assert.match(source, /finally[\s\S]*cleanupStoreBrowser|finally[\s\S]*browser-cleanup/, name + ' must clean the store browser in finally');
}

assert.match(pricing, /currentLockedPriceKeys instanceof Set/,
  'explicit price overrides must require a current locked-plan key set');
assert.match(pricing, /user_explicit_current_price_override_invalid_target/,
  'explicit price override target mismatches must fail closed');

// Execute the actual browser bodies with disposable DOM fixtures. No browser,
// profile, configuration, network or business runner is initialized by this test.
function browserFunction(name, nextName, evaluate) {
  const start = deadlineFill.indexOf(`async function ${name}(`);
  const end = deadlineFill.indexOf(`async function ${nextName}(`, start);
  assert(start >= 0 && end > start);
  return new Function('evalJs', 'resolveOrdinaryTierInputs',
    `${deadlineFill.slice(start, end)}; return ${name};`)(evaluate, resolveOrdinaryTierInputs);
}
const verifyBodyStart = deadlineFill.indexOf('      const rows = await evalJs(cdp, sessionId, `',
  deadlineFill.indexOf('const verifySteps ='));
const verifyBodyEnd = deadlineFill.indexOf('      `);', verifyBodyStart);
assert(verifyBodyStart >= 0 && verifyBodyEnd > verifyBodyStart);
const makeVerifyBody = new Function('resolveOrdinaryTierInputs', 'return `'
  + deadlineFill.slice(verifyBodyStart + '      const rows = await evalJs(cdp, sessionId, `'.length, verifyBodyEnd)
  + '`;');

function editorFixture({current = 161, radios = 1, missingDiscount = false, disabledDiscount = false} = {}) {
  const skc = 'sb260102124269230805635';
  const writes = [];
  let controls;
  class Input {
    constructor(type, id, className, value, visible = true) {
      Object.assign(this, {type, id, className, _value: value, visible, checked: false, disabled: false, readOnly: false});
    }
    get value() { return this._value; }
    set value(value) {
      writes.push({id: this.id, value});
      this._value = value;
      if (this === discount && radios) price._value = (Math.floor(current * (1 - Number(value) / 100) * 100 + 1e-9) / 100).toFixed(2);
    }
    getClientRects() { return this.visible ? [{}] : []; }
    dispatchEvent() {}
    click() {
      for (const radio of radioInputs) radio.checked = false;
      this.checked = true;
      controls = [...radioInputs, ...(missingDiscount ? [] : [discount]), price];
    }
  }
  const price = new Input('text', 'goods_info_list_0_enroll_site_info_list_0_enroll_cost_price', 'ant-input-number-input', '', !radios);
  const discount = new Input('text', 'goods_info_list_0_enroll_site_info_list_0_enroll_cost_price_rate', 'ant-input', '1');
  discount.disabled = disabledDiscount;
  const radioInputs = Array.from({length: radios}, () => new Input('radio', '', 'ant-radio-input', 'on'));
  controls = radios ? [...radioInputs, price] : [price, discount];
  const cells = ['', '1', `SKC: ${skc}\n供方货号: TEST`, 'SKU: TestSku', `SAR${current.toFixed(2)}`,
    radios ? (radios === 1 ? '普通档\n1%价格降幅' : 'VIP档\n普通档\n1%价格降幅') : '降幅要求：1%'];
  const row = {innerText: cells.join('\n'), querySelectorAll(selector) {
    if (selector === 'input') return controls;
    if (selector === 'td') return cells.map(innerText => ({innerText}));
    throw new Error('Unexpected fixture query: ' + selector);
  }};
  const evaluate = async (_cdp, _session, body, argument) => vm.runInNewContext(
    `(async () => {${body}})()`, {
      __arg: argument,
      document: {querySelectorAll(selector) { assert.equal(selector, 'tr'); return [row]; }},
      Event: class {}, FocusEvent: class {}, setTimeout: callback => callback(),
    });
  return {skc, writes, price, discount, radioInputs, evaluate};
}

for (const [current, targetPrice, expectedDiscount, expectedPrice] of [
  [161, 144.29, '10', '144.90'],
  [699.61, 305.38, '56', '307.82'],
  [300, 119.27, '60', '120.00'],
]) {
  const fixture = editorFixture({current});
  const collect = browserFunction('collectVisibleRows', 'fillVisibleRows', fixture.evaluate);
  const [row] = await collect(null, null);
  assert.equal(row.editMode, 'vip_discount', 'a single ordinary tier must be selected before resolving inputs');
  assert.equal(row.minDiscount, 1);
  const fill = browserFunction('fillVisibleRows', 'getScrollInfo', fixture.evaluate);
  const [filled] = await fill(null, null, [{...row, targetPrice, minDiscount: 1}]);
  assert.equal(fixture.radioInputs[0].checked, true);
  assert.equal(fixture.writes.length, 1, 'only the generated discount input is writable in tier mode');
  assert.equal(fixture.writes[0].id, fixture.discount.id);
  assert.equal(filled.actualDiscount, expectedDiscount);
  assert.equal(filled.actualPrice, expectedPrice);
  const [verified] = await fixture.evaluate(null, null, makeVerifyBody(resolveOrdinaryTierInputs));
  assert.equal(verified.editMode, 'vip_discount');
  assert.equal(verified.discount, expectedDiscount);
  assert.equal(verified.price, expectedPrice, 'verification must read the generated price, not treat it as a discount');
}
for (const radios of [0, 2]) {
  const fixture = editorFixture({radios});
  const [row] = await browserFunction('collectVisibleRows', 'fillVisibleRows', fixture.evaluate)(null, null);
  const [filled] = await browserFunction('fillVisibleRows', 'getScrollInfo', fixture.evaluate)(null, null, [{...row, targetPrice: 144.29}]);
  assert.equal(filled.actualDiscount, '10', 'existing direct-price and two-tier editors remain supported');
  assert.equal(filled.actualPrice, '144.90');
  if (radios) assert.equal(fixture.radioInputs[1].checked, true);
  const [verified] = await fixture.evaluate(null, null, makeVerifyBody(resolveOrdinaryTierInputs));
  assert.equal(verified.discount, '10');
  assert.equal(verified.price, '144.90');
}
for (const options of [{missingDiscount: true}, {disabledDiscount: true}]) {
  const fixture = editorFixture(options);
  const [row] = await browserFunction('collectVisibleRows', 'fillVisibleRows', fixture.evaluate)(null, null);
  await assert.rejects(browserFunction('fillVisibleRows', 'getScrollInfo', fixture.evaluate)(null, null,
    [{...row, targetPrice: 144.29}]), /ordinary_tier_inputs_unavailable/);
  assert.equal(fixture.writes.length, 0, 'missing or disabled discount fields must fail before value writes');
}
const malformed = editorFixture();
assert.equal(resolveOrdinaryTierInputs([malformed.price]), null, 'one price input must never stand in for both fields');
assert.equal(resolveOrdinaryTierInputs([malformed.price, malformed.price]), null, 'duplicate price references must be rejected');
assert.equal(resolveOrdinaryTierInputs([malformed.discount, malformed.discount]), null);
assert.equal(resolveOrdinaryTierInputs([malformed.price, malformed.discount, malformed.discount]), null);

console.log('marketing visible fast-path contract: PASS');
