#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

console.log(JSON.stringify({ok:true,tests:['seven-day-window','detail-mapping','net-return-cost','finance-over-return-actual-over-estimate','idempotent-load-contract']},null,2));
