#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {buildFinanceArtifactSql, buildFinanceEnsureSql} from './load_shein_openapi_finance_warehouse.mjs';
import {
  dateWindows,
  mapFinanceCheckOrder,
  selectReturnCost,
} from '../lib/shein_finance_check_orders.mjs';

assert.deepEqual(dateWindows('2026-07-01','2026-07-18'), [
  {start:'2026-07-01',end:'2026-07-07'},
  {start:'2026-07-08',end:'2026-07-14'},
  {start:'2026-07-15',end:'2026-07-18'},
]);

const mapped = mapFinanceCheckOrder({
  store:{storeKey:'DL',groupKey:'DSY',shopName:'DL店'},
  listRow:{checkOrderNo:'B1',bzOrderNo:'G1',checkStatus:3,secondOrderType:2},
  detail:{checkOrderNo:'B1',bzOrderNo:'G1',checkStatus:3,itemList:[
    {skuCode:'SKU1',returnExpense:18.5,returnFreightSubsidy:3.5,incomeAmount:50},
    {skuCode:'SKU2',returnExpense:0,returnFreightSubsidy:0,incomeAmount:60},
  ]},
  fetchedAt:'2026-07-18T00:00:00Z',sourceWindow:{start:'2026-07-12',end:'2026-07-18'},
});
assert.equal(mapped.order.check_order_key,'DL__B1');
assert.equal(mapped.items.length,2);
assert.equal(mapped.items[0].net_return_cost_sar,15);
assert.notEqual(mapped.items[0].check_order_item_key,mapped.items[1].check_order_item_key);
assert.deepEqual(selectReturnCost({actualNetReturnCost:15,isReturnPackage:true}),{amount:15,source:'finance_check_order_actual',settled:true});
assert.deepEqual(selectReturnCost({actualNetReturnCost:null,returnPerformanceActual:16.77,isReturnPackage:true}),{amount:16.77,source:'return_order_performance_price_actual',settled:false});
assert.deepEqual(selectReturnCost({actualNetReturnCost:null,isReturnPackage:true}),{amount:13.88,source:'package_estimate',settled:false});

const fetchScript = await fs.readFile(new URL('./fetch_shein_openapi_finance_check_orders.mjs', import.meta.url),'utf8');
const loadScript = await fs.readFile(new URL('./load_shein_openapi_finance_warehouse.mjs', import.meta.url),'utf8');
assert.match(fetchScript,/get-check-order-list/);
assert.match(fetchScript,/get-check-order-detail/);
assert.match(loadScript,/DELETE FROM fact\.openapi_finance_check_order_item WHERE check_order_key IN/);
assert.match(loadScript,/ON CONFLICT/);

const artifactSql = buildFinanceArtifactSql({orders: [mapped.order], items: mapped.items});
const ensureSql = buildFinanceEnsureSql();
const emptySql = buildFinanceArtifactSql({orders: [], items: []});
for (const sql of [artifactSql, ensureSql, emptySql]) {
  assert.match(sql, /^BEGIN;\nSELECT pg_advisory_xact_lock\(hashtextextended\('shein-bi:finance-warehouse-load:v1', 0\)\);\n/);
  assert(sql.indexOf('pg_advisory_xact_lock') < sql.indexOf('CREATE TABLE'));
  assert.equal((sql.match(/pg_advisory_xact_lock/g) || []).length, 1);
  assert.match(sql, /COMMIT;\n$/);
  assert.doesNotMatch(sql, /pg_advisory_lock\(/, 'the lock must release on transaction end, including rollback');
}
assert(artifactSql.indexOf('pg_advisory_xact_lock') < artifactSql.indexOf('DELETE FROM'));
assert.match(artifactSql, /DL__B1/);
assert.doesNotMatch(ensureSql, /DELETE FROM|COPY /);

// Simulate PostgreSQL rejecting COPY before stdin has drained; no process is spawned.
{
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = () => setImmediate(() => {
    child.stderr.emit('data', Buffer.from('ERROR: deadlock detected'));
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}));
    child.emit('close', 3);
  });
  const context = vm.createContext({
    spawn: () => child, ROOT: '/', Buffer, process: {platform: 'linux', env: {}},
  });
  const run = loadScript.slice(loadScript.indexOf('async function runPsql('), loadScript.indexOf('const DDL ='));
  vm.runInContext(run + '\nthis.run = runPsql;', context);
  await assert.rejects(context.run({}, 'fixture SQL'), /psql failed \(3\): ERROR: deadlock detected/);
}

console.log(JSON.stringify({ok:true,tests:['seven-day-window','detail-mapping','net-return-cost','finance-over-return-actual-over-estimate','idempotent-load-contract']},null,2));
