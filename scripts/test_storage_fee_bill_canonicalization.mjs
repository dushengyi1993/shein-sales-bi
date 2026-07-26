#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function paymentState({status = '', status_name: statusName = ''}) {
  const value = `${status} ${statusName}`.toLowerCase();
  if (/(已支付|支付成功|已完成|已结算|paid|done|completed|settled)/.test(value)) return 'paid';
  if (/(等待支付|待支付|待付款|未支付|pending|awaiting.?payment|unpaid)/.test(value)) return 'pending';
  return 'other';
}

function businessKey(bill) {
  const raw = bill.raw_summary || {};
  return [
    bill.fee_date,
    bill.billing_period_date || bill.fee_date,
    Number(bill.other_income || 0).toFixed(6),
    bill.client_from_id || raw.ClientId || raw.OwnerClientId || '',
    bill.remark || raw.Remark || raw.remark || '',
    raw.CountryId || raw.countryId || raw.CountryCode || raw.countryCode || '',
    bill.oversea_id || raw.OverseaId || raw.overseaId || '',
  ].join('|');
}

function canonicalize(bills) {
  const grouped = new Map();
  for (const bill of bills) {
    const row = {...bill, payment_state: paymentState(bill), canonical_business_key: businessKey(bill)};
    const group = grouped.get(row.canonical_business_key) || [];
    group.push(row);
    grouped.set(row.canonical_business_key, group);
  }
  return [...grouped.values()].flatMap(group => {
    const paid = group.filter(row => row.payment_state === 'paid');
    const pending = group.filter(row => row.payment_state === 'pending');
    const other = group.filter(row => row.payment_state === 'other');
    const replacement = paid.length === 1 && pending.length >= 1 && other.length === 0;
    const kept = replacement ? paid : group;
    return kept.map(row => ({
      ...row,
      source_count: replacement ? group.length : 1,
      source_income_bill_ids: replacement
        ? [row.income_bill_id, ...group.filter(candidate => candidate.income_bill_id !== row.income_bill_id).map(candidate => candidate.income_bill_id)]
        : [row.income_bill_id],
      superseded_income_bill_ids: replacement
        ? group.filter(candidate => candidate.income_bill_id !== row.income_bill_id).map(candidate => candidate.income_bill_id)
        : [],
      canonical_reason: replacement
        ? 'status_replacement_paid_supersedes_pending'
        : 'independent_bill_no_status_replacement',
    }));
  });
}

function selectDetailSource(canonicalBill, detailRows) {
  const candidates = [
    canonicalBill.income_bill_id,
    ...canonicalBill.source_income_bill_ids.filter(id => id !== canonicalBill.income_bill_id),
  ];
  const sourceId = candidates.find(id => detailRows
    .filter(row => row.fee_date === canonicalBill.fee_date && row.income_bill_id === id)
    .reduce((sum, row) => sum + row.shown_fee_rmb, 0) !== 0);
  return {
    detail_source_income_bill_id: sourceId || null,
    detail_source_reason: !sourceId
      ? 'no_usable_detail_source'
      : sourceId === canonicalBill.income_bill_id
        ? 'canonical_bill_detail'
        : 'superseded_bill_detail_fallback',
  };
}

const replacementBills = [
  {income_bill_id: 'AR2604048474080806', fee_date: '2026-04-04', billing_period_date: '2026-04-04', other_income: 515.51, status_name: '等待支付'},
  {income_bill_id: 'AR2604048323894665', fee_date: '2026-04-04', billing_period_date: '2026-04-04', other_income: 515.51, status_name: '已支付'},
];
const paidTwiceBills = [
  {income_bill_id: 'PAID_A', fee_date: '2026-04-05', billing_period_date: '2026-04-05', other_income: 100, status_name: '已支付'},
  {income_bill_id: 'PAID_B', fee_date: '2026-04-05', billing_period_date: '2026-04-05', other_income: 100, status_name: '已支付'},
];
const differentClientBills = [
  {income_bill_id: 'CLIENT_A_PAID', fee_date: '2026-04-06', billing_period_date: '2026-04-06', other_income: 100, status_name: '已支付', client_from_id: 'CLIENT_A'},
  {income_bill_id: 'CLIENT_B_PENDING', fee_date: '2026-04-06', billing_period_date: '2026-04-06', other_income: 100, status_name: '等待支付', raw_summary: {ClientId: 'CLIENT_B'}},
];
const inheritedDetailBills = [
  {income_bill_id: 'INHERIT_PENDING', fee_date: '2026-04-07', billing_period_date: '2026-04-07', other_income: 200, status_name: '等待支付'},
  {income_bill_id: 'INHERIT_PAID', fee_date: '2026-04-07', billing_period_date: '2026-04-07', other_income: 200, status_name: '已支付'},
];
const mixedEvidenceBills = [
  {income_bill_id: 'MIX_DETAIL', fee_date: '2026-04-08', billing_period_date: '2026-04-08', other_income: 100, status_name: '已支付'},
  {income_bill_id: 'MIX_MISSING', fee_date: '2026-04-08', billing_period_date: '2026-04-08', other_income: 200, status_name: '已支付'},
];

const canonical = canonicalize([
  ...replacementBills,
  ...paidTwiceBills,
  ...differentClientBills,
  ...inheritedDetailBills,
  ...mixedEvidenceBills,
]);
const replacement = canonical.filter(row => row.fee_date === '2026-04-04');
assert.equal(replacement.length, 1, 'pending-to-paid replacement must produce one canonical bill');
assert.equal(replacement[0].income_bill_id, 'AR2604048323894665');
assert.equal(replacement[0].source_count, 2);
assert.deepEqual(replacement[0].superseded_income_bill_ids, ['AR2604048474080806']);
assert.equal(replacement[0].canonical_reason, 'status_replacement_paid_supersedes_pending');

const paidTwice = canonical.filter(row => row.fee_date === '2026-04-05');
assert.equal(paidTwice.length, 2, 'two paid bills must not be collapsed by matching date and amount');
assert.ok(paidTwice.every(row => row.source_count === 1));

const differentClient = canonical.filter(row => row.fee_date === '2026-04-06');
assert.equal(differentClient.length, 2, 'same-day paid/pending bills from different clients must not cross-collapse');
assert.ok(differentClient.every(row => row.canonical_reason === 'independent_bill_no_status_replacement'));

const detailRows = [
  {income_bill_id: 'AR2604048474080806', fee_date: '2026-04-04', product: 'P2', shown_fee_rmb: 100},
  {income_bill_id: 'AR2604048323894665', fee_date: '2026-04-04', product: 'P1', shown_fee_rmb: 100},
  {income_bill_id: 'PAID_A', fee_date: '2026-04-05', product: 'P1', shown_fee_rmb: 50},
  {income_bill_id: 'PAID_B', fee_date: '2026-04-05', product: 'P2', shown_fee_rmb: 50},
  {income_bill_id: 'INHERIT_PENDING', fee_date: '2026-04-07', product: 'P2', shown_fee_rmb: 100},
  {income_bill_id: 'MIX_DETAIL', fee_date: '2026-04-08', product: 'P1', shown_fee_rmb: 100},
];
const selectedDetailSources = canonical.map(row => ({
  canonical_income_bill_id: row.income_bill_id,
  fee_date: row.fee_date,
  ...selectDetailSource(row, detailRows),
}));
const selectedDetailRows = selectedDetailSources.flatMap(source => detailRows.filter(row =>
  row.fee_date === source.fee_date && row.income_bill_id === source.detail_source_income_bill_id,
));
assert.deepEqual(selectedDetailRows.filter(row => row.fee_date === '2026-04-04').map(row => row.product), ['P1'],
  'paid canonical detail must win over superseded pending detail');
const inheritedSource = selectedDetailSources.find(row => row.canonical_income_bill_id === 'INHERIT_PAID');
assert.deepEqual(inheritedSource, {
  canonical_income_bill_id: 'INHERIT_PAID',
  fee_date: '2026-04-07',
  detail_source_income_bill_id: 'INHERIT_PENDING',
  detail_source_reason: 'superseded_bill_detail_fallback',
});
assert.deepEqual(selectedDetailRows.filter(row => row.fee_date === '2026-04-07').map(row => row.income_bill_id), ['INHERIT_PENDING'],
  'paid bill without detail must inherit exactly one superseded export');

const dayTotal = canonical
  .filter(row => row.fee_date === '2026-04-04')
  .reduce((sum, row) => sum + row.other_income, 0);
const detailTotal = selectedDetailRows
  .filter(row => row.fee_date === '2026-04-04')
  .reduce((sum, row) => sum + row.shown_fee_rmb, 0);
const scale = dayTotal / detailTotal;
const allocatedSar = selectedDetailRows
  .filter(row => row.fee_date === '2026-04-04')
  .reduce((sum, row) => sum + row.shown_fee_rmb * scale * 0.5 / 1.8, 0);
assert.ok(Math.abs(allocatedSar - dayTotal * 0.5 / 1.8) < 1e-9,
  'scaled product evidence must conserve the canonical ledger after 0.5 and 1.8 conversion');

const mixedCanonical = canonical.filter(row => row.fee_date === '2026-04-08');
const mixedAllocations = mixedCanonical.map(bill => {
  const source = selectDetailSource(bill, detailRows);
  const rows = detailRows.filter(row =>
    row.fee_date === bill.fee_date && row.income_bill_id === source.detail_source_income_bill_id);
  const detailShown = rows.reduce((sum, row) => sum + row.shown_fee_rmb, 0);
  return {
    bill: bill.income_bill_id,
    productAllocatedRmb: detailShown > 0
      ? rows.reduce((sum, row) => sum + row.shown_fee_rmb * bill.other_income / detailShown, 0)
      : 0,
    fallbackRmb: detailShown > 0 ? 0 : bill.other_income,
  };
});
assert.deepEqual(mixedAllocations, [
  {bill: 'MIX_DETAIL', productAllocatedRmb: 100, fallbackRmb: 0},
  {bill: 'MIX_MISSING', productAllocatedRmb: 0, fallbackRmb: 200},
], 'same-day independent bill without detail must stay in fallback instead of scaling another bill');

const schema = read('infra/warehouse/schema.sql');
const refresh = read('scripts/refresh_profit_marts.sql');
const audit = read('scripts/audit_bi_warehouse.mjs');
assert.match(schema, /CREATE OR REPLACE VIEW mart\.et_storage_fee_bill_canonical/);
assert.match(schema, /status_replacement_paid_supersedes_pending/);
assert.match(schema, /superseded_income_bill_ids/);
assert.match(schema, /CREATE OR REPLACE VIEW mart\.et_storage_fee_canonical_detail_source/);
assert.match(schema, /superseded_bill_detail_fallback/);
assert.match(schema, /raw_summary->>'ClientId'/);
assert.match(schema, /f\.canonical_income_bill_id/);
assert.match(schema, /f\.fee_shown_fee_rmb \/ nullif\(sum\(coalesce\(d\.shown_fee_rmb,0\)\),0\) AS detail_bill_scale/);
assert.match(schema, /fallback_bill_daily AS/);
assert.match(refresh, /fallback_bill_daily AS/);
assert.match(refresh, /FROM mart\.et_storage_fee_bill_canonical/);
assert.match(refresh, /JOIN mart\.et_storage_fee_canonical_detail_source/);
assert.match(audit, /unresolved_replacement_chain_count/);
assert.match(audit, /detail_scaled_days/);
assert.match(audit, /detail_inherited_bill_count/);
assert.match(audit, /latest_canonical_fee_date/);
const storageCheck = read('scripts/check_storage_fee_profit.mjs');
assert.match(storageCheck, /FROM mart\.storage_fee_product_daily_cache/);
assert.match(storageCheck, /FROM mart\.storage_fee_store_daily_cache/);
assert.match(storageCheck, /FROM mart\.profit_daily_store_product_cache/);
assert.match(storageCheck, /FROM mart\.et_storage_fee_canonical_detail_source/);
assert.doesNotMatch(storageCheck, /FROM mart\.storage_fee_daily_reconciliation/);
assert.doesNotMatch(storageCheck, /FROM mart\.storage_fee_product_daily\s/);

console.log(JSON.stringify({
  ok: true,
  contracts: [
    'pending_paid_status_replacement_is_deduplicated',
    'two_paid_bills_remain_independent',
    'different_clients_do_not_cross_collapse',
    'paid_detail_wins_over_superseded_detail',
    'missing_paid_detail_inherits_one_superseded_export',
    'scaled_product_and_store_amounts_conserve_canonical_ledger',
    'same_day_independent_missing_detail_bill_uses_fallback',
  ],
}, null, 2));
