#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root=path.resolve(import.meta.dirname,'..');
const clientPath=path.join(root,'scripts','bi_app','client.js');
const stylesPath=path.join(root,'scripts','bi_app','styles.css');
const shellPath=path.join(root,'scripts','generate_bi_portal_shell.mjs');
const client=fs.readFileSync(clientPath,'utf8');
const styles=fs.readFileSync(stylesPath,'utf8');
const shell=fs.readFileSync(shellPath,'utf8');

function lineFunction(name){
  const line=client.split(/\r?\n/).find(x=>x.startsWith(`function ${name}(`));
  assert.ok(line,`missing ${name}`);
  return line;
}

const context={S:{start:'2026-08-11',end:'2026-08-11',rangePreset:'today'}};
vm.createContext(context);
vm.runInContext([
  "const pad2=v=>String(v).padStart(2,'0');",
  lineFunction('parseDateOnly'),lineFunction('isoDate'),lineFunction('addDateDays'),
  lineFunction('periodDayCount'),lineFunction('periodComparisonContext'),lineFunction('periodDelta'),
  'this.periodDayCount=periodDayCount;this.periodComparisonContext=periodComparisonContext;this.periodDelta=periodDelta;'
].join('\n'),context);

const snapshot=JSON.stringify(context.S);
assert.deepEqual({...context.periodComparisonContext('2026-08-11','2026-08-11')},{start:'2026-08-11',end:'2026-08-11',days:1,previousStart:'2026-08-10',previousEnd:'2026-08-10',currentText:'2026-08-11',previousText:'2026-08-10',isToday:true});
assert.deepEqual({...context.periodComparisonContext('2026-03-01','2026-03-03')},{start:'2026-03-01',end:'2026-03-03',days:3,previousStart:'2026-02-26',previousEnd:'2026-02-28',currentText:'2026-03-01~2026-03-03',previousText:'2026-02-26~2026-02-28',isToday:true});
assert.equal(context.periodComparisonContext('2024-03-01','2024-03-01').previousStart,'2024-02-29');
assert.deepEqual({...context.periodComparisonContext('2026-05-07','2026-05-13')},{start:'2026-05-07',end:'2026-05-13',days:7,previousStart:'2026-04-30',previousEnd:'2026-05-06',currentText:'2026-05-07~2026-05-13',previousText:'2026-04-30~2026-05-06',isToday:true});
assert.equal(JSON.stringify(context.S),snapshot,'period comparison must not mutate global S');

assert.equal(context.periodDelta(0,0).label,'持平');
assert.equal(context.periodDelta(8,0).label,'新增');
assert.equal(context.periodDelta(-1,2,{profit:true}).label,'转亏');
assert.equal(context.periodDelta(1,-2,{profit:true}).label,'转盈');
assert.equal(context.periodDelta(.264,.2,{kind:'rate'}).label,'↑ 6.4个百分点');
assert.equal(context.periodDelta(3,null).label,'','missing previous value must not become zero');

const aggregate={
  S:{q:'',scope:'ALL'},D:{liveSalesToday:{date:'2026-08-11',items:[{}]},rankings:{}},
  A:v=>Array.isArray(v)?v:[],ISO:v=>String(v||'').slice(0,10),
  dt:r=>String(r.date||'').slice(0,10),scopeSearchOk:()=>true,
  salesRows:[
    {date:'2026-08-09',store_key:'A',product:'P0',net:90,gross:100,orders:9,grossOrders:10,qty:9,grossQty:10},
    {date:'2026-08-10',store_key:'A',product:'P1',net:180,gross:200,orders:18,grossOrders:20,qty:18,grossQty:20,is_cod:true},
    {date:'2026-08-11',store_key:'A',product:'P2',net:270,gross:300,orders:27,grossOrders:30,qty:27,grossQty:30,is_cod:true},
  ],
};
Object.assign(aggregate,{
  salesBaseRows:()=>aggregate.salesRows,rankingProductRows:()=>aggregate.salesRows,
  uniq:xs=>[...new Set(xs)],pkey:r=>r.product,netSales:r=>r.net,grossSales:r=>r.gross,
  netOrders:r=>r.orders,grossOrders:r=>r.grossOrders,netQty:r=>r.qty,grossQty:r=>r.grossQty,
  isCodLike:r=>Boolean(r.is_cod),
});
aggregate.D.rankings.dailyPaymentSummary=aggregate.salesRows;
aggregate.D.rankings.dailyStoreProductPaymentSummary=aggregate.salesRows;
vm.createContext(aggregate);
vm.runInContext([lineFunction('rowInRange'),lineFunction('rowsInRange'),lineFunction('explicitLiveZero'),lineFunction('salesSummaryForRange'),lineFunction('paymentSummaryForRange'),'this.rowsInRange=rowsInRange;this.salesSummaryForRange=salesSummaryForRange;this.paymentSummaryForRange=paymentSummaryForRange;'].join('\n'),aggregate);
const previousSales=aggregate.salesSummaryForRange('2026-08-10','2026-08-10');
assert.equal(previousSales.net,180,'previous sales must exclude the current live day');
assert.equal(previousSales.gross,200);
assert.equal(previousSales.active,1);
const previousPayment=aggregate.paymentSummaryForRange('2026-08-10','2026-08-10');
assert.equal(previousPayment.cod.sales,180,'COD comparison must use the previous payment slice');
assert.equal(previousPayment.cod.grossOrders,20);

const returns={
  A:v=>Array.isArray(v)?v:[],ISO:v=>String(v||'').slice(0,10),
  rowsInRange:aggregate.rowsInRange,
  returnRows:[
    {request_time:'2026-08-11',order_created_date:'2026-08-10',id:'R1',amount:30,is_cod:true},
    {request_time:'2026-08-10',order_created_date:'2026-08-09',id:'R2',amount:20,is_cod:false},
  ],
  returnScopeRows:()=>returns.returnRows,
  returnDate:(r,mode)=>mode==='order'?r.order_created_date:r.request_time,
  isCodLike:r=>Boolean(r.is_cod),
  returnSummaryFromRows:rows=>({orders:new Set(rows.map(r=>r.id)).size,amount:rows.reduce((a,r)=>a+r.amount,0),rows}),
};
vm.createContext(returns);
vm.runInContext(`${lineFunction('returnSummaryForRange')}\nthis.returnSummaryForRange=returnSummaryForRange;`,returns);
assert.equal(returns.returnSummaryForRange('2026-08-10','2026-08-10','request').amount,20,'request-time comparison must not use order-created date');
assert.equal(returns.returnSummaryForRange('2026-08-10','2026-08-10','order',true).amount,30,'COD cohort must use order-created date and COD filter');

const traffic={
  A:v=>Array.isArray(v)?v:[],homeTrafficRows:()=>traffic.rows,trafficLooseByScope:x=>x,
  trafficRowsInRange:(rows,start,end)=>rows.filter(r=>r.date>=start&&r.date<=end),
  uniqueDatesFromRows:rows=>[...new Set(rows.map(r=>r.date))].sort(),
  periodDayCount:context.periodDayCount,
  sumFirst:(rows,fields)=>rows.reduce((sum,r)=>sum+Number(fields.map(f=>r[f]).find(v=>v!=null)||0),0),
  rows:[{date:'2026-08-08',eps_uv:100,goods_uv:20,sale_cnt:2},{date:'2026-08-10',eps_uv:200,goods_uv:40,sale_cnt:4}],
};
vm.createContext(traffic);
vm.runInContext(`${lineFunction('trafficSummaryForRange')}\nthis.trafficSummaryForRange=trafficSummaryForRange;`,traffic);
assert.equal(traffic.trafficSummaryForRange('2026-08-08','2026-08-10').available,false,'a missing traffic day must not be filled with zero');
assert.equal(traffic.trafficSummaryForRange('2026-08-10','2026-08-10').available,true);
assert.equal(traffic.trafficSummaryForRange('2026-08-10','2026-08-10').pay,.1);

assert.match(client,/今日累计，仅作进度参考/);
assert.match(client,/previousStart=days\?addDateDays\(previousEnd,-days\+1\)/);
assert.match(client,/returnSummaryForRange\(ctx\.previousStart,ctx\.previousEnd,'request'\)/);
assert.match(client,/returnSummaryForRange\(ctx\.previousStart,ctx\.previousEnd,'order',true\)/);
assert.match(client,/previousProfit\.loss\/previousProfit\.revenue/);
assert.match(client,/previousProfit\.riskProfit\/previousProfit\.riskRevenue/);
assert.match(client,/previousTraffic\.available&&tr\.exactDateCount===trafficDays/);
assert.match(client,/前期暂无可核验快照/);
assert.match(client,/不会拿当前库存倒推/);
assert.match(client,/previous==null\?'—'/,'missing comparison must render an em dash');

for(const name of ['homeRankList','storeRanks','storeQtyRanks','productRanks','productQtyRanks']){
  const source=lineFunction(name);
  assert.doesNotMatch(source,/periodCompare|previousPeriod|previousRank/,`${name} must remain comparison-free until ranking design is approved`);
}

assert.match(styles,/\.period-compare\{/);
assert.match(styles,/\.period-delta\.up/);
assert.match(styles,/@media\(max-width:1180px\)/);
assert.match(styles,/@media\(max-width:820px\)/);
assert.match(styles,/@media\(max-width:720px\)/,'390px layout must use the <=720px rules');
assert.match(styles,/height:auto;min-height:76px/,'comparison rows must grow instead of clipping');
assert.match(shell,/bi_app[\\/]client\.js|client\.js/);
assert.match(shell,/bi_app[\\/]styles\.css|styles\.css/);

console.log('BI home period comparison contract: ok');
